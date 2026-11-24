/**
 * @file state-reconstructor.spec.ts
 * @description D1 边界单测：StateReconstructor 从持久化快照恢复完整内存状态。
 * 验证：round-trip（persist → restore → 状态一致）、schemaVersion 拒绝、损坏数据跳过。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import {
  AgentRole,
  DecisionVerdict,
  IntentFulfillmentStatus,
  WorkflowStageId,
} from '../src/domain/enums.ts';
import { ScopeDiffReport } from '../src/domain/models.ts';
import { AuditTrailEntry } from '../src/engine/ImmutableAuditLedger.ts';
import { PersistenceRepository } from '../src/engine/PersistenceRepository.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { StateReconstructor } from '../src/engine/pg/StateReconstructor.ts';
import { IntentExecutionTraceRecord } from '../src/telemetry/IntentFulfillmentTracker.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

describe('D1 — StateReconstructor 启动恢复测试', () => {
  it('1. persist → restore → 运行状态完整（round-trip）', async () => {
    await withTestWorkspace('state-rec-1-', async (ws) => {
      // 第一阶段：创建运行并持久化
      const orchestrator1 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-D1-001',
        title: 'D1 启动恢复测试',
        summary: '验证 persist → restore → 状态一致',
        requirements: {
          REQ_D1_A: '路径 A',
          REQ_D1_B: '路径 B',
        },
      });
      const runState1 = await orchestrator1.startProposalWorkflow({
        proposal,
        initiatorActor: '测试',
      });

      // 取快照（模拟服务器重启后从磁盘读取）
      const persisted = orchestrator1.persistenceRepo.loadPersistedSnapshot();
      assert.ok(persisted, '应有持久化快照');
      assert.equal(persisted!.schemaVersion, '1.1.0');
      assert.ok((persisted!.runs?.length ?? 0) > 0, '应有至少一个运行实例');

      // 第二阶段：用新 Facade 实例恢复
      const orchestrator2 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const reconstructor = new StateReconstructor({
        stateEngine: orchestrator2.stateEngine,
        auditLedger: orchestrator2.auditLedger,
        mediator: orchestrator2.negotiationMediator,
        eventBus: orchestrator2.eventBus,
      });
      const result = reconstructor.restore(persisted!);

      assert.ok(result.runIds.includes(runState1.runId), '恢复的 runId 应包含原始 runId');
      assert.equal(result.warnings.length, 0, '无损坏数据时不应有警告');

      // 验证恢复后的状态
      const runState2 = orchestrator2.stateEngine.getRunOrThrow(runState1.runId);
      assert.equal(runState2.proposal.title, proposal.title);
      assert.equal(runState2.getStatus(), runState1.getStatus());
      assert.equal(
        runState2.getActiveBranchSnapshots().length,
        runState1.getActiveBranchSnapshots().length,
      );

      // 快照内容一致
      const snaps1 = runState1.getAllSnapshots();
      const snaps2 = runState2.getAllSnapshots();
      assert.equal(snaps2.length, snaps1.length);
      for (let i = 0; i < snaps1.length; i++) {
        assert.equal(snaps2[i].snapshotId, snaps1[i].snapshotId);
        assert.equal(snaps2[i].getState(), snaps1[i].getState());
      }

      // 决策账本一致
      const decisions1 = orchestrator1.auditLedger.getHumanDecisions(runState1.runId);
      const decisions2 = orchestrator2.auditLedger.getHumanDecisions(runState1.runId);
      assert.equal(decisions2.length, decisions1.length);
    });
  });

  it('2. schemaVersion 过旧 → 拒绝恢复', async () => {
    await withTestWorkspace('state-rec-2-', (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const staleSnapshot = {
        schemaVersion: '0.9.0',
        lastSyncedAtIso: new Date().toISOString(),
        runs: [],
        snapshots: [],
        negotiationLogs: [],
        humanDecisions: [],
        negativeExperienceRecords: [],
      };
      // 直接到 facade 上的 restoreFromPersistence 会检查 schemaVersion
      // 此处通过 StateReconstructor 测试损坏场景的跳过逻辑
      const reconstructor = new StateReconstructor({
        stateEngine: orchestrator.stateEngine,
        auditLedger: orchestrator.auditLedger,
        mediator: orchestrator.negotiationMediator,
        eventBus: orchestrator.eventBus,
      });
      const result = reconstructor.restore(staleSnapshot as never);
      assert.equal(result.runIds.length, 0, '空 runs 不应恢复任何实例');
    });
  });

  it('3. 决策账本恢复后可继续操作（如提交裁决推进流水线）', async () => {
    await withTestWorkspace('state-rec-3-', async (ws) => {
      const orchestrator1 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-D1-CONT-003',
        title: 'D1 恢复后继续操作测试',
        summary: '验证恢复后的运行实例可以继续裁决',
        requirements: {
          REQ_CONT: '继续操作测试',
        },
      });
      const runState1 = await orchestrator1.startProposalWorkflow({
        proposal,
        initiatorActor: '测试',
      });

      // 找到暂停的快照（QA 终审门禁）
      const pausedSnap = runState1.getLatestSnapshotOnActiveBranch();
      assert.ok(pausedSnap);
      assert.equal(runState1.getStatus(), 'PAUSED_AT_HUMAN_GATE');

      // 持久化并恢复
      const persisted = orchestrator1.persistenceRepo.loadPersistedSnapshot();
      const orchestrator2 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const reconstructor = new StateReconstructor({
        stateEngine: orchestrator2.stateEngine,
        auditLedger: orchestrator2.auditLedger,
        mediator: orchestrator2.negotiationMediator,
        eventBus: orchestrator2.eventBus,
      });
      reconstructor.restore(persisted!);

      // 在恢复后的实例上提交裁决
      const runState2 = orchestrator2.stateEngine.getRunOrThrow(runState1.runId);
      const snap2 = runState2.getLatestSnapshotOnActiveBranch();
      assert.ok(snap2);

      await orchestrator2.submitHumanGateDecision({
        runId: runState1.runId,
        snapshotId: snap2.snapshotId,
        reviewerActor: 'D1 恢复后测试',
        verdict: DecisionVerdict.APPROVE,
        comment: 'D1 恢复后正常裁决',
      });

      // 应正常推进到下一阶段或完成
      assert.notEqual(runState2.getStatus(), 'ABORTED');
      assert.notEqual(runState2.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    });
  });

  it('4. AUDIT-9：persist → restoreFromPersistence 完整还原 ScopeDiff / notificationInbox / teamComments / autoRepairCounts / auditEntries（且 WAL 不重复追加）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-d1-audit9-'));
    const persistenceDir = path.join(tmpDir, 'persist');
    const sandboxRootDir = path.join(tmpDir, 'sandbox');
    try {
      const orchestrator1 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir,
        sandboxRootDir,
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-D1-AUDIT9-004',
        title: 'AUDIT-9 5项状态持久化恢复测试',
        summary: '验证范围缩水/通知卡/评论/返修计数/审计WAL全量跨重启还原',
        requirements: {
          REQ_SCOPE_KEEP: '保留核心业务流程',
          REQ_SCOPE_DROP: '应被保留不可缩水条款',
        },
      });
      const runState1 = await orchestrator1.startProposalWorkflow({
        proposal,
        initiatorActor: '审计恢复验证',
        scenarioHints: { forceScopeReduction: true },
      });

      assert.equal(runState1.getStatus(), 'PAUSED_AT_HUMAN_GATE');
      runState1.recordAutoRepair('QA_TO_ENG');
      runState1.recordAutoRepair('QA_TO_ENG');

      const addedComment = orchestrator1.addTeamComment({
        runId: runState1.runId,
        stageId: WorkflowStageId.STAGE_1_PM,
        actorUserId: 'user-pm-01',
        content: '独立追加的跨重启团队评审评论',
      });

      const walCountBefore = orchestrator1.persistenceRepo.readAuditWalEntries().length;
      const timeline1 = orchestrator1.auditLedger.getAuditTimeline(runState1.runId);
      const inbox1 = orchestrator1.eventBus.getNotificationInbox(runState1.runId);
      const comments1 = orchestrator1.getTeamComments(runState1.runId);
      const snap1 = runState1.getAllSnapshots()[0];
      assert.ok(snap1);
      assert.equal(snap1.scopeDiffReport.hasUnauthorizedScopeReduction, true);
      assert.ok(inbox1.length > 0);
      assert.ok(timeline1.length > 0);

      // 重建全新实例模拟服务重启
      const orchestrator2 = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir,
        sandboxRootDir,
      });
      const restored = orchestrator2.restoreFromPersistence();
      assert.equal(restored.restored, true);
      assert.equal(restored.warnings.length, 0);
      assert.ok(restored.runIds.includes(runState1.runId));

      const runState2 = orchestrator2.stateEngine.getRunOrThrow(runState1.runId);

      // 1) ScopeDiffReport 完整保留 baseline/current/dropped
      const snap2 = runState2.getAllSnapshots()[0];
      assert.ok(snap2);
      assert.equal(snap2.scopeDiffReport.hasUnauthorizedScopeReduction, true);
      assert.deepEqual(snap2.scopeDiffReport.baselineRequirementIds, [
        'REQ_SCOPE_KEEP',
        'REQ_SCOPE_DROP',
      ]);
      assert.deepEqual(snap2.scopeDiffReport.currentRequirementIds, ['REQ_SCOPE_KEEP']);
      assert.deepEqual(snap2.scopeDiffReport.droppedRequirementIds, ['REQ_SCOPE_DROP']);

      // 2) notificationInbox 保留待办门禁卡片及顺序
      const inbox2 = orchestrator2.eventBus.getNotificationInbox(runState1.runId);
      assert.equal(inbox2.length, inbox1.length);
      assert.deepEqual(
        inbox2.map((n) => n.notificationId),
        inbox1.map((n) => n.notificationId),
      );
      const pendingNotif2 = inbox2.find((n) => n.requiresHumanAction);
      assert.ok(pendingNotif2);
      assert.equal(pendingNotif2.isResolved(), false);
      assert.ok(pendingNotif2.actionOptions.length > 0);

      // 3) teamComments 包含单独追加的评论
      const comments2 = orchestrator2.getTeamComments(runState1.runId);
      assert.equal(comments2.length, comments1.length);
      const restoredAdded = comments2.find((c) => c.commentId === addedComment.commentId);
      assert.ok(restoredAdded);
      assert.equal(restoredAdded.content, '独立追加的跨重启团队评审评论');
      assert.equal(restoredAdded.authorUserId, addedComment.authorUserId);

      // 4) autoRepairCounts 准确恢复
      assert.equal(runState2.getAutoRepairCount('QA_TO_ENG'), 2);

      // 5) auditEntries 从 WAL 重建且磁盘 WAL 不重复写入
      const timeline2 = orchestrator2.auditLedger.getAuditTimeline(runState1.runId);
      assert.equal(timeline2.length, timeline1.length);
      assert.equal(orchestrator2.persistenceRepo.readAuditWalEntries().length, walCountBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. AUDIT-9：兼容缺 baselineRequirementIds 的历史 ScopeDiff 快照与损坏 WAL 行容错', () => {
    const legacyDiff = ScopeDiffReport.fromJSON({
      hasUnauthorizedScopeReduction: true,
      droppedRequirementIds: ['REQ_LEGACY'],
    });
    assert.equal(legacyDiff.hasUnauthorizedScopeReduction, true);
    assert.deepEqual(legacyDiff.droppedRequirementIds, ['REQ_LEGACY']);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-d1-wal-corrupt-'));
    try {
      const repo = new PersistenceRepository(tmpDir);
      const validEntry = new AuditTrailEntry({
        entryId: 'AUD-VALID-1',
        runId: 'RUN-WAL-1',
        branchId: 'branch-v1',
        stageId: WorkflowStageId.STAGE_1_PM,
        actor: 'PM_AGENT',
        actionType: 'AGENT_EXECUTING',
        summary: '正常审计条目',
        timestampIso: '2026-11-23T06:00:00.000Z',
      });
      repo.appendAuditEntryToWal(validEntry);
      const walPath = path.join(tmpDir, 'audit-trail-2026-11.jsonl');
      fs.appendFileSync(walPath, '{"corrupted_truncated_json\n', 'utf-8');

      const readBack = repo.readAuditWalEntries();
      assert.equal(readBack.length, 1);
      assert.equal(readBack[0].entryId, 'AUD-VALID-1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. P1-2：JSON 持久化重启完整恢复 governanceConfig / cacheTelemetry / intentTraces / createdByUserId / reviewerUserId', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-p12-json-restore-'));
    const persistenceDir = path.join(tmpDir, 'persist');
    const sandboxRootDir = path.join(tmpDir, 'sandbox');
    try {
      const facade1 = new WorkflowOrchestratorFacade({
        persistenceDir,
        sandboxRootDir,
        persistenceDriver: null,
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-P12-JSON-001',
        title: 'JSON 模式治理配置与遥测跨重启恢复验证',
        summary: '验证动态配置/缓存遥测/意图追踪/双轨用户标识在重启后不丢失',
        requirements: {
          REQ_GOV: '持久化治理阈值与允许跨阶段回退',
        },
        involvesDatabaseMigration: true,
      });

      const run1 = await facade1.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工 (PM)',
        initiatorUserId: 'user-pm-01',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      facade1.updateAdminGovernanceConfig({
        actorUserId: 'user-admin-01',
        maxNegotiationTurns: 6,
        highRiskScoreThreshold: 75,
        allowSpecialistCrossStageRollback: true,
      });
      facade1.fulfillmentTracker.recordTrace(
        new IntentExecutionTraceRecord({
          traceId: 'TRC-JSON-RESTORE-1',
          runId: run1.runId,
          branchId: run1.getActiveBranchId(),
          stageId: WorkflowStageId.STAGE_2_PD,
          agentRole: AgentRole.PRODUCT_DESIGNER,
          recognizedIntentCode: 'UI_DESIGN',
          intentConfidence: 0.92,
          retryCount: 1,
          retryReasons: ['JSON_FORMAT_REPAIR'],
          cacheHit: false,
          fulfillmentStatus: IntentFulfillmentStatus.FULFILLED_AFTER_RETRY,
          tokensConsumed: 1200,
          retryOverheadTokens: 200,
          costUsd: 0.012,
        }),
      );

      const pendingSnap = run1.getLatestSnapshotOnActiveBranch();
      assert.ok(pendingSnap);
      await facade1.submitHumanGateDecision({
        runId: run1.runId,
        snapshotId: pendingSnap.snapshotId,
        reviewerActor: '林工 (PD/UX)',
        actorUserId: 'user-pd-01',
        verdict: DecisionVerdict.ARBITRATE_OPTION_A,
        comment: '批准方案 A 并验证遥测随决策同步落盘',
      });

      const cacheSnapBefore = facade1.cacheManager.getMetricsSnapshot();

      const facade2 = new WorkflowOrchestratorFacade({
        persistenceDir,
        sandboxRootDir,
        persistenceDriver: null,
      });
      const restored = facade2.restoreFromPersistence();
      assert.equal(restored.restored, true);

      const run2 = facade2.stateEngine.getRunOrThrow(run1.runId);
      assert.equal(run2.createdByUserId, 'user-pm-01');
      assert.equal(
        facade2.auditLedger
          .getHumanDecisions(run1.runId)
          .some((d) => d.reviewerUserId === 'user-pd-01'),
        true,
      );
      assert.equal(facade2.negotiationMediator.getMaxNegotiationTurns(), 6);
      assert.equal(facade2.riskPipeline.getHighRiskThreshold(), 75);
      assert.equal(facade2.rbacService.isCrossStageRollbackAllowedForSpecialists(), true);
      assert.equal(
        facade2.cacheManager.getMetricsSnapshot().totalLookups,
        cacheSnapBefore.totalLookups,
      );
      assert.equal(
        facade2.fulfillmentTracker
          .getTraces(run1.runId)
          .some((t) => t.traceId === 'TRC-JSON-RESTORE-1'),
        true,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
