/**
 * @file architecture.spec.ts
 * @description 面向对象架构、Agent 7步生命周期、受限协商熔断、总管 DAG 分叉回退、风险动态门禁与复盘指标自动化测试套件。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import {
  DecisionVerdict,
  GateActionType,
  NotificationCategory,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { RetrospectiveBenchmarkSuite } from '../src/retrospective/runRetrospective.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

describe('Agentic SDLC OS — 面向对象多智能体协同框架核心测试套件', () => {
  it('1. 低风险提案应自动通过前序阶段并强制留存审计追踪痕迹，直达 Stage 4 QA 终审门禁', async () => {
    await withTestWorkspace('arch-low-risk-', async (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const lowRiskProposal = new ProjectProposalContract({
        proposalId: 'TEST-LOW-001',
        title: '运营看板文案与筛选按钮微调',
        summary: '纯前端低风险需求，不含 DDL 与权限变更',
        requirements: {
          REQ_UI_TEXT: '调整筛选栏标题文案',
          REQ_BTN_STYLE: '统一导出按钮圆角规范',
        },
        involvesDatabaseMigration: false,
        involvesPermissionOrPayment: false,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: lowRiskProposal,
        initiatorActor: '测试发起人-小李',
      });

      // 应自动放行 Stage 1 (PM), Stage 2 (PD), Stage 3a (Tech), Stage 3b (Engineer)，并在 Stage 4 (QA) 暂停等待人工终审
      assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
      assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_4_QA);

      const activeSnaps = runState.getActiveBranchSnapshots();
      assert.equal(activeSnaps.length, 5);
      assert.equal(activeSnaps[0].getState(), SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK);
      assert.equal(activeSnaps[0].gateAction, GateActionType.AUTO_PASS_WITH_AUDIT);
      assert.equal(activeSnaps[4].getState(), SnapshotLifecycleState.PENDING_HUMAN_GATE);

      // 验证低风险自动放行同样写入了不可变审计账本
      const decisions = orchestrator.auditLedger.getHumanDecisions(runState.runId);
      assert.equal(decisions.length, 4);
      assert.equal(decisions[0].verdict, DecisionVerdict.AUTO_PASS_LOW_RISK);
    });
  });

  it('2. PM 与 PD 协商超出最大讨论限制 (Max Turns = 3) 时应触发熔断，由总管 Agent 接管并推送待裁决提醒', async () => {
    await withTestWorkspace('arch-conflict-', async (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        highRiskThreshold: 60,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const conflictProposal = new ProjectProposalContract({
        proposalId: 'TEST-CONFLICT-002',
        title: '实时三维拓扑监控大屏',
        summary: '包含复杂交互冲突与 DDL 迁移',
        requirements: {
          REQ_3D_CANVAS: '支持移动端三维实时节点拖拽',
          REQ_DDL_AUDIT: '新增拓扑节点审计表',
        },
        involvesDatabaseMigration: true,
        involvesPermissionOrPayment: true,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: conflictProposal,
        initiatorActor: '产品经理-周工',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      // 应在 Stage 2 (PD) 触发 3 轮协商熔断并暂停
      assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
      assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_2_PD);

      const negHistory = orchestrator.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.equal(negHistory.length, 3);
      assert.equal(negHistory[2].escalatedToSupervisor, true);

      // 验证前端通知收件箱收到了总管 Agent 发出的【待人工拍板裁决】提醒
      const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
      const conflictNotif = inbox.find(
        (n) => n.category === NotificationCategory.CONFLICT_ARBITRATION_REQUIRED,
      );
      assert.ok(conflictNotif, '应当收到总管 Agent 推送的冲突裁决提醒');
      assert.equal(conflictNotif.requiresHumanAction, true);
    });
  });

  it('3. 通过与总管 Agent 自然语言对话回退时，应 Fork 出新 DAG 分支并将旧分支下游快照标记为 SUPERSEDED', async () => {
    await withTestWorkspace('arch-rollback-', async (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-ROLLBACK-003',
        title: '工单流转引擎开发',
        summary: '验证总管 Agent 对话回退与脏数据隔离',
        requirements: {
          REQ_TICKET_FLOW: '支持工单状态流转',
        },
        involvesDatabaseMigration: false,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '研发主管-孙工',
      });

      // 此时已到达 Stage 4 QA，用户对总管 Agent 说：“回退到 PD Agent，把弹窗改为侧边抽屉”
      const previousBranch = runState.getActiveBranchId();
      await orchestrator.invokeSupervisorConversationalRollback({
        runId: runState.runId,
        humanActor: '研发主管-孙工',
        dialogueInstruction: '回退到 PD Agent，把弹窗交互改为双栏折叠抽屉布局',
      });

      const newBranch = runState.getActiveBranchId();
      assert.notEqual(newBranch, previousBranch, '回退后必须分叉生成新的 DAG 分支');
      assert.equal(runState.getBranches().length, 2);

      // 检查旧分支上 Stage 2 PD 及下游快照是否已被标记为 SUPERSEDED
      const oldBranchSuperseded = runState
        .getAllSnapshots()
        .filter(
          (s) =>
            s.branchId === previousBranch && s.getState() === SnapshotLifecycleState.SUPERSEDED,
        );
      assert.ok(
        oldBranchSuperseded.length >= 3,
        '旧分支上被回退阶段及下游快照必须标记为 SUPERSEDED 以隔离脏数据',
      );
    });
  });

  it('4. 复盘任务应准确统计 (a) 双层缓存命中率 与 (b) 意图达成率及重试次数分布', async () => {
    const benchmark = new RetrospectiveBenchmarkSuite();
    const report = await benchmark.runFullSuite();

    assert.equal(report.overallHealthy, true, '基准复盘任务所有成本与质量 SLA 应全部达标');
    assert.ok(
      report.cacheMetrics.cacheHitRatePercent >= 30,
      `缓存命中率应 >= 30%，实测为 ${report.cacheMetrics.cacheHitRatePercent}%`,
    );
    assert.ok(report.cacheMetrics.savedTokensTotal > 0, '缓存命中必须实际节省 Token 消耗');
    assert.equal(
      report.fulfillmentMetrics.fulfillmentRatePercent,
      100,
      '含自愈重试后的意图最终达成率应为 100%',
    );
    assert.equal(
      report.fulfillmentMetrics.retryDistribution.oneRetry,
      1,
      '应精确捕获到 1 次瞬态契约自愈重试',
    );
  });
});
