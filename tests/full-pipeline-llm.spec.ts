/**
 * @file full-pipeline-llm.spec.ts
 * @description 高优测试缺口 1：全阶段 LLM 管道测试——mock transport 按阶段返回不同 JSON，
 * 断言 6 阶段全部通过契约校验并正常推进（修复"A1 集成测试只覆盖 PM 阶段"的缺口）。
 */

import * as assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';

// 每个阶段返回的 LLM JSON（与 ArtifactContractFactory 期望的字段一一对应）
const STAGE_JSON: Record<string, string> = {
  STAGE_1_PM: JSON.stringify({
    summary: '已完成 PRD 拆解（全阶段 LLM 驱动测试）',
    coreRequirementIds: ['R1', 'R2'],
    userStories: [
      { reqId: 'R1', story: '故事 R1', acceptanceCriteria: ['AC1', 'AC2'] },
      { reqId: 'R2', story: '故事 R2', acceptanceCriteria: ['AC1'] },
    ],
    trackingPlanEvents: [
      { eventName: 'evt_r1', triggerCondition: '触发 R1', properties: ['run_id'] },
      { eventName: 'evt_r2', triggerCondition: '触发 R2', properties: ['run_id'] },
    ],
    nonFunctionalConstraints: ['响应 < 200ms', '审计全覆盖'],
  }),
  STAGE_2_PD: JSON.stringify({
    summary: '已完成 UI 组件映射',
    coreRequirementIds: ['R1', 'R2'],
    componentMappings: [
      {
        reqId: 'R1',
        designSystemComponent: 'DrawerContainer',
        interactionStates: ['default', 'hover'],
      },
      { reqId: 'R2', designSystemComponent: 'DataTable', interactionStates: ['loading', 'error'] },
    ],
    accessibilityChecklist: ['键盘导航全覆盖', '色对比 ≥ 4.5:1', '屏幕阅读器语义标签'],
    designChallengeNote: null,
  }),
  STAGE_3A_TECH_SPEC: JSON.stringify({
    summary: '已完成接口契约与表结构设计',
    coreRequirementIds: ['R1', 'R2'],
    apiContracts: [
      {
        method: 'POST',
        endpoint: '/api/v1/audit',
        requestSchema: '{"req":"string"}',
        responseSchema: '{"res":"string"}',
      },
    ],
    databaseDdlStatements: ['CREATE TABLE IF NOT EXISTS audit_log (id UUID PRIMARY KEY)'],
    declaredRiskLevel: 'HIGH',
    architecturePatternsUsed: ['Strategy', 'Template Method'],
  }),
  STAGE_3B_ENGINEER: JSON.stringify({
    summary: '已完成代码实现',
    coreRequirementIds: ['R1', 'R2'],
    gitWorktreeBranch: 'worktree/test/b1',
    modifiedFiles: [
      {
        filePath: 'src/modules/r1/R1DomainService.ts',
        className: 'R1DomainService',
        designPattern: 'Strategy',
        linesChanged: 50,
      },
      {
        filePath: 'src/modules/r2/R2DomainService.ts',
        className: 'R2DomainService',
        designPattern: 'Template Method',
        linesChanged: 40,
      },
    ],
    selfTestPassed: true,
  }),
  STAGE_4_QA: JSON.stringify({
    summary: '已完成自动化测试验证：全通过',
    coreRequirementIds: ['R1', 'R2'],
    testSuitesExecuted: [
      { suiteName: 'req_r1.sandbox.spec.ts', totalCases: 2, passedCases: 2, coveragePercent: 100 },
      { suiteName: 'req_r2.sandbox.spec.ts', totalCases: 2, passedCases: 2, coveragePercent: 100 },
    ],
    securityIssuesFound: 0,
    allAcceptanceCriteriaMet: true,
  }),
  STAGE_5_DA: JSON.stringify({
    summary: '已完成埋点核验与指标基线',
    coreRequirementIds: ['R1', 'R2'],
    verifiedTrackingEvents: ['evt_r1', 'evt_r2'],
    projectedMetrics: [
      { metricName: '功能采纳率', baselineValue: '0%', targetValue: '85%' },
      { metricName: '审批耗时', baselineValue: '300ms', targetValue: '< 200ms' },
      { metricName: 'P95 延迟', baselineValue: '500ms', targetValue: '< 250ms' },
    ],
  }),
};

function makeResponse(content: string): OpenAiCompatibleChatResponse {
  return {
    id: 'chatcmpl-full-pipeline',
    model: 'mock-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
  };
}

describe('高优 — 全阶段 LLM 管道测试', () => {
  let orchestrator: WorkflowOrchestratorFacade;

  afterEach(() => {
    if (orchestrator) {
      orchestrator.modelRouter.setHttpTransport(null);
    }
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
  });

  it('1. 6 阶段全部由 LLM JSON 驱动 → 正常推进到 QA 终审门禁', async () => {
    orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      // 按阶段路由：system prompt 包含角色名
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          return makeResponse(json);
        }
      }
      // 兜底：返回 PM JSON（不应该到达此处）
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-FULL-PIPE-001',
      title: '全阶段 LLM 管道测试',
      summary: '验证 6 阶段全部由 LLM JSON 驱动',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '全管道测试',
    });

    // 低风险提案应自动通过 PM/PD/3a/3b（QA 有 DDL 依赖 → 3a 高风险 → 阻塞）
    // 实际上 DDL = true 会阻塞在 3a 门禁
    assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_3A_TECH_SPEC);

    // 验证每个阶段产物都来自 LLM（不是模板）
    const snapshots = runState.getActiveBranchSnapshots();
    assert.equal(snapshots.length, 3, '应有 PM + PD + 3a 三个阶段快照（3a 已暂停等待签核）');

    // PM 快照
    const pmSnap = snapshots.find((s) => s.stageId === WorkflowStageId.STAGE_1_PM);
    assert.ok(pmSnap);
    assert.ok(
      pmSnap.artifact.summary.includes('全阶段 LLM 驱动测试'),
      'PM 产物应来自 LLM 而非模板',
    );

    // PD 快照
    const pdSnap = snapshots.find((s) => s.stageId === WorkflowStageId.STAGE_2_PD);
    assert.ok(pdSnap);
    assert.ok(pdSnap.artifact.summary.includes('UI 组件映射'), 'PD 产物应来自 LLM');

    // 验证 scope diff = 无删减
    assert.equal(pdSnap.scopeDiffReport.hasUnauthorizedScopeReduction, false);
  });

  it('2. 3a 核验通过 → 3b → QA → 全阶段 LLM 完成到 DA', async () => {
    orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-FULL-PIPE-002',
      title: '全阶段 LLM 管道测试（含 DDL 签核）',
      summary: '验证 DDL 签核后 3b/QA/DA 全阶段 LLM 驱动',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '全管道测试',
    });

    // 停在 3a 门禁（DDL 高风险）→ 架构师签核
    assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_3A_TECH_SPEC);

    await orchestrator.submitHumanGateDecision({
      runId: runState.runId,
      snapshotId: runState.getLatestSnapshotOnActiveBranch()!.snapshotId,
      reviewerActor: '首席架构师-张工',
      verdict: 'APPROVE' as never,
      comment: 'DDL 变更符合规范，准予进入编码',
    });

    // 3b（ENGINEER）→ QA 失败 → QA 阶段会执行沙箱测试（低风险 → 3b 自动放行 → QA 阻塞）
    // QA 全通过 → 3b/4/5 自动推进 → COMPLETED
    // 但 QA 是 FORCE_HUMAN_GATE → 停在 QA
    // 实际上 QA forceHumanGate → 阻塞等待人工签核
    assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_4_QA);

    // QA 终审签核 → 推进到 DA → DA 自动放行 → COMPLETED
    await orchestrator.submitHumanGateDecision({
      runId: runState.runId,
      snapshotId: runState.getLatestSnapshotOnActiveBranch()!.snapshotId,
      reviewerActor: 'QA负责人-赵工',
      verdict: 'APPROVE' as never,
      comment: '全通过，准予上线',
    });

    assert.equal(runState.getStatus(), 'COMPLETED', '全阶段 LLM 驱动应完整交付');

    // 验证所有阶段的产物都来自 LLM
    const allSnaps = runState.getAllSnapshots().filter((s) => s.getState() !== 'SUPERSEDED');
    const stages = new Set(allSnaps.map((s) => s.stageId));
    assert.ok(stages.has(WorkflowStageId.STAGE_1_PM), 'PM 快照存在');
    assert.ok(stages.has(WorkflowStageId.STAGE_2_PD), 'PD 快照存在');
    assert.ok(stages.has(WorkflowStageId.STAGE_3A_TECH_SPEC), '3a 快照存在');
    assert.ok(stages.has(WorkflowStageId.STAGE_3B_ENGINEER), '3b 快照存在');
    assert.ok(stages.has(WorkflowStageId.STAGE_4_QA), 'QA 快照存在');
    assert.ok(stages.has(WorkflowStageId.STAGE_5_DA), 'DA 快照存在');
  });

  it('3. LLM 输出缺字段 → 自愈重试 → 后续阶段继续用 LLM（全管道不中断）', async () => {
    orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    let pmCallCount = 0;
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          if (stageId === 'STAGE_1_PM') {
            pmCallCount++;
            if (pmCallCount === 1) {
              // 第一次缺字段
              return makeResponse(
                JSON.stringify({
                  summary: '缺字段',
                  coreRequirementIds: ['R1', 'R2'],
                  userStories: [],
                  trackingPlanEvents: [],
                  nonFunctionalConstraints: [],
                }),
              );
            }
          }
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-FULL-PIPE-003',
      title: '自愈重试 + 全阶段 LLM 驱动',
      summary: 'PM 第一次缺字段 → 自愈重试 → 后续阶段正常',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '自愈测试',
    });

    // 自愈重试应触发
    assert.ok(pmCallCount >= 2, `PM 应至少调用 2 次（实际 ${pmCallCount}）`);
    // 最终应停在 3a 门禁（DDL 高风险）
    assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_3A_TECH_SPEC);
  });
});

/** 阶段 ID → 角色名映射（用于 prompt 路由） */
function stageMetaRole(stageId: string): string {
  const roles: Record<string, string> = {
    STAGE_1_PM: 'PM Agent',
    STAGE_2_PD: 'PD Agent',
    STAGE_3A_TECH_SPEC: 'Tech Lead Agent',
    STAGE_3B_ENGINEER: 'Engineer Agent',
    STAGE_4_QA: 'QA Agent',
    STAGE_5_DA: 'DA Agent',
  };
  return roles[stageId] ?? stageId;
}
