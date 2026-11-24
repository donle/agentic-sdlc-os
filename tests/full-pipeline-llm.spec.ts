/**
 * @file full-pipeline-llm.spec.ts
 * @description 高优测试缺口 1：全阶段 LLM 管道测试——mock transport 按阶段返回不同 JSON，
 * 断言 6 阶段全部通过契约校验并正常推进（修复"A1 集成测试只覆盖 PM 阶段"的缺口）。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';
import { createTestWorkspace, type TestIsolatedWorkspace } from './helpers/testIsolation.ts';

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
  let workspace: TestIsolatedWorkspace | null = null;

  afterEach(() => {
    if (orchestrator) {
      orchestrator.modelRouter.setHttpTransport(null);
    }
    if (workspace) {
      workspace.cleanup();
      workspace = null;
    }
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
  });

  it('1. 6 阶段全部由 LLM JSON 驱动 → 正常推进到 QA 终审门禁', async () => {
    workspace = createTestWorkspace('full-pipe-1-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
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
    workspace = createTestWorkspace('full-pipe-2-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
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
    workspace = createTestWorkspace('full-pipe-3-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
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

  it('4. 在线 LLM 模式下 Stage 3b/4 必须执行真实沙箱落盘与单测，且拦截 QA 谎报（A1↔E1/E2 闭环）', async () => {
    workspace = createTestWorkspace('full-pipe-4-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    let capturedEngineerUserPrompt = '';
    let capturedQaUserPrompt = '';
    let qaAttempt = 0;

    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      const userPrompt = payload.messages?.[1]?.content ?? '';

      if (systemPrompt.includes('Engineer Agent')) {
        capturedEngineerUserPrompt = userPrompt;
        return makeResponse(STAGE_JSON.STAGE_3B_ENGINEER);
      }
      if (systemPrompt.includes('QA Agent')) {
        qaAttempt += 1;
        capturedQaUserPrompt = userPrompt;
        if (qaAttempt === 1) {
          // 第一次故意谎报：passedCases (1) < totalCases (2)，但声称 allAcceptanceCriteriaMet=true
          return makeResponse(
            JSON.stringify({
              summary: 'QA 谎报测试全部通过',
              coreRequirementIds: ['R1', 'R2'],
              testSuitesExecuted: [
                {
                  suiteName: 'r1.sandbox.spec.ts',
                  totalCases: 2,
                  passedCases: 1,
                  coveragePercent: 50,
                },
              ],
              securityIssuesFound: 0,
              allAcceptanceCriteriaMet: true,
            }),
          );
        }
        return makeResponse(STAGE_JSON.STAGE_4_QA);
      }
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-FULL-PIPE-SANDBOX-004',
      title: '在线 LLM 真实沙箱落盘与防谎报校验',
      summary: '验证 3b 真实写文件、4 注入真实测试结果并拦截谎报',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '沙箱闭环测试',
    });

    // 3a 门禁签核放行以推进到 3b 与 Stage 4
    await orchestrator.submitHumanGateDecision({
      runId: runState.runId,
      snapshotId: runState.getLatestSnapshotOnActiveBranch()!.snapshotId,
      reviewerActor: '架构师',
      verdict: 'APPROVE' as never,
      comment: '放行进入 3b 与 4',
    });

    // 1) 验证 Stage 3b 在线模式下物理沙箱已真实创建并落盘代码文件
    const workspaceSummary = orchestrator.sandboxManager.getWorkspaceSummary(
      runState.runId,
      runState.getActiveBranchId(),
    );
    assert.ok(
      workspaceSummary.generatedFiles.length >= 4,
      `在线 LLM 模式下 Stage 3b 必须真实落盘业务类与单测文件（实际 ${workspaceSummary.generatedFiles.length} 个）`,
    );
    assert.ok(
      capturedEngineerUserPrompt.includes('"sandboxVerification"'),
      'Stage 3b Prompt 必须注入真实沙箱分支与自测结果 sandboxVerification',
    );

    // 2) 验证 Stage 4 Prompt 注入了真实 node:test 沙箱结果，且首次谎报被拦截触发了自愈重试
    assert.ok(
      capturedQaUserPrompt.includes('"sandboxVerification"'),
      'Stage 4 QA Prompt 必须注入真实沙箱测试结果 sandboxVerification',
    );
    assert.equal(qaAttempt, 2, 'QA 首次谎报 passedCases < totalCases 应触发契约校验违规并自愈重试');
  });

  it('5. C3 总管自然语言回退在 Facade 中已接线 modelRouter（同义词 LLM 解析 + 流水线阶段白名单）', async () => {
    workspace = createTestWorkspace('full-pipe-5-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    let supervisorLlmCalled = false;
    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('研发流水线总管 Agent')) {
        supervisorLlmCalled = true;
        return makeResponse(
          JSON.stringify({
            targetStageId: 'STAGE_1_PM',
            cleanInstruction: '重新梳理产品经理阶段的业务验收指标',
          }),
        );
      }
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-C3-SUPERVISOR-005',
      title: 'C3 总管 LLM 解析接线验证',
      summary: '不含 PM/需求/PRD 关键词的同义指令由 LLM 解析回退至 STAGE_1_PM',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '总管测试',
    });

    // 指令不含 "PM" / "需求" / "PRD"（若走 keywordParse 会默认落到 STAGE_3B_ENGINEER）
    await orchestrator.invokeSupervisorConversationalRollback({
      runId: runState.runId,
      humanActor: '项目总监',
      dialogueInstruction: '请退回到最初的产品经理规划环节，补充多币种清分指标',
    });

    assert.equal(supervisorLlmCalled, true, 'Facade 中的 SupervisorAgent 必须调用 LLM 解析指令');
    assert.ok(
      runState.getActiveBranchId().includes('STAGE_1_PM'),
      `应由 LLM 解析回退至 STAGE_1_PM（实际分支 ${runState.getActiveBranchId()}）`,
    );
  });

  it('6. B1 受限协商在线 LLM 多轮演进：首轮分歧、次轮达成共识，且 Token 计入运行实例', async () => {
    workspace = createTestWorkspace('full-pipe-6-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    let negTurnCalls = 0;
    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('受限协商')) {
        negTurnCalls += 1;
        return makeResponse(
          JSON.stringify({
            responseResolution:
              negTurnCalls === 1
                ? '第 1 轮：PM 暂不同意直接砍掉三维拓扑视图'
                : '第 2 轮：双方同意采用渐进式双栏抽屉降级方案',
            consensusReached: negTurnCalls >= 2,
            optionAProposal: 'LLM 方案 A：渐进式双栏抽屉',
            optionBProposal: 'LLM 方案 B：定制 WebGL 视图',
          }),
        );
      }
      if (systemPrompt.includes('PD Agent')) {
        return makeResponse(
          JSON.stringify({
            ...JSON.parse(STAGE_JSON.STAGE_2_PD),
            designChallengeNote: 'PD 质询：三维画布超出首屏渲染预算',
          }),
        );
      }
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-B1-MULTITURN-006',
      title: 'B1 多轮协商演进测试',
      summary: '非强制死锁下 LLM 第 1 轮分歧、第 2 轮达成共识',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '协商测试',
    });

    assert.equal(negTurnCalls, 2, '首轮未达成共识时应继续推进至第 2 轮协商');
    const history = orchestrator.negotiationMediator.getNegotiationHistory(runState.runId);
    assert.equal(history.length, 2);
    assert.equal(history[0].consensusReached, false);
    assert.equal(history[1].consensusReached, true);
    assert.equal(history[1].escalatedToSupervisor, false);
  });

  it('7. P1-3：Stage 3b LLM filePatches 真实落盘 Worktree 并触发重跑验证与 A2 自愈修复', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-filepatches-'));
    try {
      orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
      });
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      let engineerCalls = 0;
      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        const systemPrompt = payload.messages?.[0]?.content ?? '';
        if (systemPrompt.includes('Engineer Agent')) {
          engineerCalls += 1;
          const base3b = JSON.parse(STAGE_JSON.STAGE_3B_ENGINEER) as Record<string, unknown>;
          if (engineerCalls === 1) {
            return makeResponse(
              JSON.stringify({
                ...base3b,
                summary: '首次补丁写入带缺陷的测试用例',
                selfTestPassed: true,
                filePatches: [
                  {
                    filePath: 'src/modules/r1/CustomRule.ts',
                    content:
                      'export function computeFee(amount: number): number {\n  return amount - 10;\n}\n',
                  },
                  {
                    filePath: 'tests/custom_rule.spec.ts',
                    content: [
                      "import * as assert from 'node:assert/strict';",
                      "import test from 'node:test';",
                      "import { computeFee } from '../src/modules/r1/CustomRule.ts';",
                      '',
                      "test('computeFee 计算 10% 服务费', () => {",
                      '  assert.equal(computeFee(100), 10);',
                      '});',
                      '',
                    ].join('\n'),
                  },
                ],
              }),
            );
          }
          return makeResponse(
            JSON.stringify({
              ...base3b,
              summary: '自愈重试补丁修复 computeFee 实现并通过重跑',
              selfTestPassed: true,
              filePatches: [
                {
                  filePath: 'src/modules/r1/CustomRule.ts',
                  content:
                    'export function computeFee(amount: number): number {\n  return amount * 0.1;\n}\n',
                },
              ],
            }),
          );
        }
        for (const [stageId, json] of Object.entries(STAGE_JSON)) {
          if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
            return makeResponse(json);
          }
        }
        return makeResponse(STAGE_JSON.STAGE_1_PM);
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-P13-PATCH-007',
        title: 'Stage 3b 真实 filePatches 闭环验证',
        summary: '验证 LLM filePatches 落盘后重跑 node:test 拦截失败补丁并在重试修复后全通过',
        requirements: { R1: '计算费用规则', R2: '费率审计' },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: 'P1-3 沙箱测试',
      });
      await orchestrator.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: runState.getLatestSnapshotOnActiveBranch()!.snapshotId,
        reviewerActor: '架构师-张工',
        verdict: 'APPROVE' as never,
        comment: 'DDL 签核通过，进入 3b',
      });

      assert.equal(engineerCalls, 2, '首轮补丁单测失败应触发 A2 自愈重试，次轮补丁修复后通过');
      const wsPath = orchestrator.sandboxManager.resolveWorkspacePath(
        runState.runId,
        runState.getActiveBranchId(),
      );
      const customRuleDisk = fs.readFileSync(
        path.join(wsPath, 'src/modules/r1/CustomRule.ts'),
        'utf-8',
      );
      assert.ok(customRuleDisk.includes('return amount * 0.1;'), '修复后源码应真实落盘 Worktree');

      const verifyRes = orchestrator.sandboxManager.executeSandboxVerification({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        requirementIds: ['R1', 'R2'],
        runSubprocessNodeTest: true,
      });
      assert.equal(verifyRes.failedTestCases, 0);
      assert.ok(verifyRes.totalTestCases >= 5, '应运行脚手架 + LLM 新增的 custom_rule.spec.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
