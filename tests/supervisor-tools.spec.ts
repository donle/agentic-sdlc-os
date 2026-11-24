/**
 * @file supervisor-tools.spec.ts
 * @description C2 总管四工具契约测试：验证四个工具函数的可调用性与返回结构。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { EscalateConflictToHumanCommand, SupervisorAgent } from '../src/agents/SupervisorAgent.ts';
import { ProjectProposalContract, PrdArtifactContract } from '../src/domain/contracts.ts';
import {
  AgentRole,
  BusinessRiskLevel,
  DecisionVerdict,
  GateActionType,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../src/domain/enums.ts';
import {
  NegotiationTurnRecord,
  ScopeDiffReport,
  StageSnapshotMemento,
} from '../src/domain/models.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { WorkflowEventBus } from '../src/patterns/EventBus.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';
import {
  getRunOverview,
  summarizeConflict,
  overrideGate,
  SUPERVISOR_TOOL_SCHEMAS,
} from '../src/agents/supervisorTools.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

async function dispatchToolsReq(
  server: WorkbenchHttpServer,
  opts: { method: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : '';
  const req = Readable.from(
    payload ? [Buffer.from(payload, 'utf-8')] : [],
  ) as unknown as http.IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    ...(opts.headers ?? {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
  };

  let statusCode = 200;
  let bodyText = '';
  const fakeRes = {
    writeHead: (code: number): unknown => {
      statusCode = code;
      return fakeRes;
    },
    end: (chunk?: string | Buffer): void => {
      if (chunk) {
        bodyText += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      }
    },
  } as unknown as http.ServerResponse;

  await server.handleHttpRequest(req, fakeRes);
  return {
    statusCode,
    json: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
  };
}

describe('C2 — 总管四工具契约测试', () => {
  it('1. get_run_overview 应返回完整运行状态摘要', async () => {
    await withTestWorkspace('sup-tool-1-', async (ws) => {
      const facade = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const runState = await facade.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-C2-001',
          title: '工具测试项目',
          summary: '验证 getRunOverview',
          requirements: { R1: '需求 1' },
        }),
        initiatorActor: '工具测试',
      });

      const overview = getRunOverview(facade, runState.runId);
      assert.equal(overview.runId, runState.runId);
      assert.equal(overview.title, '工具测试项目');
      assert.equal(overview.status, 'PAUSED_AT_HUMAN_GATE');
      assert.ok(overview.branches.length > 0);
      assert.ok(overview.completedStages > 0);
      assert.ok(overview.pendingGateCount > 0, '应有待人工门禁');
    });
  });

  it('2. summarizeConflict 应从协商日志提炼裁决卡', async () => {
    await withTestWorkspace('sup-tool-2-', async (ws) => {
      const facade = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const runState = await facade.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-C2-002',
          title: '协商冲突工具测试',
          summary: 'PM-PD 熔断后测试冲突提炼',
          requirements: { R1: '需求 1', R2: '需求 2' },
        }),
        initiatorActor: '工具测试',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      // 协商熔断后应有 NegotiationLog
      const logs = facade.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.ok(logs.length > 0, '应有协商记录');
      const negId = logs[logs.length - 1].negotiationId;

      const card = summarizeConflict(facade, runState.runId, negId);
      assert.ok(card);
      assert.ok(card.challengePoint.length > 0, '应有分歧焦点');
      assert.ok(card.optionA.length > 0, '应有方案 A');
      assert.ok(card.optionB.length > 0, '应有方案 B');
      assert.equal(card.escalated, true, '应有熔断标记');
    });
  });

  it('3. override_gate 应通过 RBAC 后正常推进', async () => {
    await withTestWorkspace('sup-tool-3-', async (ws) => {
      const facade = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const runState = await facade.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-C2-003',
          title: '门禁覆写工具测试',
          summary: '验证 overrideGate 推进',
          requirements: { R1: '需求 1' },
        }),
        initiatorActor: '工具测试',
      });

      const snapshot = runState.getLatestSnapshotOnActiveBranch();
      assert.ok(snapshot);

      const result = (await overrideGate(facade, {
        runId: runState.runId,
        snapshotId: snapshot.snapshotId,
        reviewerActor: '王总管',
        verdict: DecisionVerdict.APPROVE,
        reason: '工具覆写测试',
      })) as { getStatus(): string };

      assert.notEqual(result.getStatus(), 'ABORTED');
    });
  });

  it('4. 工具 schema 应包含 4 个工具定义', () => {
    assert.equal(SUPERVISOR_TOOL_SCHEMAS.length, 4);
    const names = SUPERVISOR_TOOL_SCHEMAS.map((s) => s.name);
    assert.deepEqual(names, [
      'get_run_overview',
      'summarize_conflict',
      'override_gate',
      'rollback_and_fork',
    ]);
  });

  it('5. P1-3：EscalateConflictToHumanCommand 选项标签动态读取协商记录而非硬编码 PD 文案', () => {
    const bus = new WorkflowEventBus();
    const snap = new StageSnapshotMemento({
      snapshotId: 'SNAP-QA-CONFLICT',
      runId: 'RUN-QA-C',
      parentSnapshotId: null,
      branchId: 'branch-v1',
      stageId: WorkflowStageId.STAGE_4_QA,
      agentRole: AgentRole.QUALITY_ASSURANCE,
      modelUsed: 'mock',
      artifact: new PrdArtifactContract({
        summary: 'QA/Eng 分歧',
        coreRequirementIds: ['R1'],
        userStories: [{ reqId: 'R1', story: 's', acceptanceCriteria: ['ac'] }],
        trackingPlanEvents: [{ eventName: 'e', triggerCondition: 'c', properties: ['p'] }],
        nonFunctionalConstraints: ['nf1', 'nf2'],
      }),
      riskScore: 75,
      riskLevel: BusinessRiskLevel.HIGH,
      riskReasons: ['协商熔断'],
      gateAction: GateActionType.BLOCK_FOR_CONFLICT_ARBITRATION,
      scopeDiffReport: new ScopeDiffReport(['R1'], ['R1']),
      cacheHit: false,
      retryCount: 0,
      tokensConsumed: 0,
      initialState: SnapshotLifecycleState.PENDING_HUMAN_GATE,
    });
    const turn = new NegotiationTurnRecord({
      negotiationId: 'NEG-QA-1',
      runId: 'RUN-QA-C',
      branchId: 'branch-v1',
      topic: 'QA_REPAIR',
      turnIndex: 3,
      maxTurnsAllowed: 3,
      challengerRole: AgentRole.QUALITY_ASSURANCE,
      responderRole: AgentRole.SOFTWARE_ENGINEER,
      challengePoint: '分布式锁重试策略分歧',
      responseResolution: '需人工裁决锁粒度',
      consensusReached: false,
      escalatedToSupervisor: true,
      optionAProposal: '采用乐观版本号CAS方案（吞吐更高）',
      optionBProposal: '采用Redis RedLock强锁方案（强一致）',
    });

    const notif = new EscalateConflictToHumanCommand({
      eventBus: bus,
      snapshot: snap,
      deadlockedTurn: turn,
    }).execute();

    assert.ok(notif.actionOptions[0].label.includes('乐观版本号CAS'));
    assert.ok(notif.actionOptions[1].label.includes('Redis RedLock'));
    assert.equal(notif.actionOptions[0].label.includes('标准组件降级'), false);
    assert.equal(notif.actionOptions[1].label.includes('扩展定制组件'), false);
  });

  it('6. P1-3：explicitTargetStageId 必须受 allowedStages 白名单约束', async () => {
    const supervisor = new SupervisorAgent(new WorkflowEventBus());
    await assert.rejects(
      supervisor.parseNaturalLanguageRollback('回退到 UI 设计', WorkflowStageId.STAGE_2_PD, [
        WorkflowStageId.STAGE_1_PM,
        WorkflowStageId.STAGE_3A_TECH_SPEC,
      ]),
      /不在当前工作流允许的阶段范围内/,
    );

    const valid = await supervisor.parseNaturalLanguageRollback(
      '回退到架构阶段',
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      [WorkflowStageId.STAGE_1_PM, WorkflowStageId.STAGE_3A_TECH_SPEC],
    );
    assert.equal(valid.targetStageId, WorkflowStageId.STAGE_3A_TECH_SPEC);
  });

  it('7. P1-3：SupervisorAgent.executeTool 与 GET/POST /api/supervisor/tools 端到端接线与 RBAC 校验', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-srv-tools-'));
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
      });
      await server.waitUntilReady();

      const listRes = await dispatchToolsReq(server, {
        method: 'GET',
        url: '/api/supervisor/tools',
        headers: { 'x-actor-id': 'user-admin-01' },
      });
      assert.equal(listRes.statusCode, 200);
      const schemas = (listRes.json.data as { tools: Array<{ name: string }> }).tools;
      assert.equal(schemas.length, 4);

      const unknownRes = await dispatchToolsReq(server, {
        method: 'POST',
        url: '/api/supervisor/tools',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: { toolName: 'unknown_tool' },
      });
      assert.equal(unknownRes.statusCode, 400);

      const overviewRes = await dispatchToolsReq(server, {
        method: 'POST',
        url: '/api/supervisor/tools',
        headers: { 'x-actor-id': 'user-pm-01' },
        body: { toolName: 'get_run_overview' },
      });
      assert.equal(overviewRes.statusCode, 200);
      const overview = (overviewRes.json.data as { result: { runId: string; status: string } })
        .result;
      assert.ok(overview.runId);
      assert.equal(overview.status, 'PAUSED_AT_HUMAN_GATE');

      // 非授权角色（DA）调用 override_gate 被 RBAC 拦截 403
      const state = server
        .getOrchestrator()
        .buildWorkbenchDashboardState(overview.runId, 'user-admin-01') as {
        run: { snapshots: Array<{ snapshotId: string; state: string }> };
      };
      const pendingSnap = state.run.snapshots.find((s) => s.state === 'PENDING_HUMAN_GATE');
      assert.ok(pendingSnap);

      const daForbidden = await dispatchToolsReq(server, {
        method: 'POST',
        url: '/api/supervisor/tools',
        headers: { 'x-actor-id': 'user-da-01' },
        body: {
          toolName: 'override_gate',
          runId: overview.runId,
          snapshotId: pendingSnap.snapshotId,
          verdict: DecisionVerdict.ARBITRATE_OPTION_A,
          reason: '越权测试',
        },
      });
      assert.equal(daForbidden.statusCode, 403);

      // 管理员通过 /api/supervisor/tools 调用 rollback_and_fork 成功分叉
      const rbRes = await dispatchToolsReq(server, {
        method: 'POST',
        url: '/api/supervisor/tools',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          toolName: 'rollback_and_fork',
          runId: overview.runId,
          directive: '回退到 PM 补充合规说明',
          targetStageId: WorkflowStageId.STAGE_1_PM,
        },
      });
      assert.equal(rbRes.statusCode, 200);
      const rbResult = (rbRes.json.data as { result: { activeBranchId: string } }).result;
      assert.ok(rbResult.activeBranchId.includes('STAGE_1_PM'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
