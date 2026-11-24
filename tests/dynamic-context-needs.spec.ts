/**
 * @file dynamic-context-needs.spec.ts
 * @description 步骤 4（意图分析）测试：轻量 LLM 规划器推断动态上下文需求——
 * 端到端注入（动态类型 → ToolRegistry 预取 → Agent prompt externalContext）、
 * 目录白名单注入拦截、离线零调用回归。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';
import { createTestWorkspace, type TestIsolatedWorkspace } from './helpers/testIsolation.ts';

// 与 ArtifactContractFactory 期望字段一一对应的各阶段 JSON（同 full-pipeline-llm.spec）
const STAGE_JSON: Record<string, string> = {
  STAGE_1_PM: JSON.stringify({
    summary: '已完成 PRD 拆解（动态上下文测试）',
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
      { reqId: 'R1', designSystemComponent: 'DrawerContainer', interactionStates: ['default'] },
      { reqId: 'R2', designSystemComponent: 'DataTable', interactionStates: ['loading'] },
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
    databaseDdlStatements: [],
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

function makeResponse(content: string): OpenAiCompatibleChatResponse {
  return {
    id: 'chatcmpl-dynamic-ctx',
    model: 'mock-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('步骤 4 — LLM 意图分析驱动的动态上下文需求', () => {
  let orchestrator: WorkflowOrchestratorFacade | null = null;
  let tempRepoDir: string | null = null;
  let workspace: TestIsolatedWorkspace | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(keys: string[]): void {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
    }
  }

  afterEach(() => {
    if (orchestrator) {
      orchestrator.modelRouter.setHttpTransport(null);
      orchestrator = null;
    }
    if (workspace) {
      workspace.cleanup();
      workspace = null;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (tempRepoDir) {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
      tempRepoDir = null;
    }
  });

  it('1. 在线规划器推断动态需求 → 预取 → 注入阶段 prompt（端到端）', async () => {
    // 临时"真实仓库"：GitContextProvider 读取 code_structure
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-ctx-repo-'));
    fs.writeFileSync(
      path.join(tempRepoDir, 'package.json'),
      JSON.stringify({ name: 'demo-repo', version: '1.0.0' }),
    );
    fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempRepoDir, 'src', 'index.ts'), 'export {};');

    saveEnv(['GIT_REPO_PATH', 'LITELLM_ENABLE_LIVE_HTTP']);
    process.env.GIT_REPO_PATH = tempRepoDir;
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    workspace = createTestWorkspace('dyn-ctx-1-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
    const stageRequests: Array<{ system: string; user: string }> = [];

    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('上下文规划器')) {
        // 含 1 条合法动态需求 + 1 条目录外注入尝试
        return makeResponse(
          JSON.stringify({
            needs: [
              { type: 'code_structure', reason: '拆解 PRD 前需了解真实代码库结构' },
              { type: '__import__evil', reason: '注入尝试' },
            ],
          }),
        );
      }
      for (const [stageId, json] of Object.entries(STAGE_JSON)) {
        if (systemPrompt.includes(stageId) || systemPrompt.includes(stageMetaRole(stageId))) {
          stageRequests.push({
            system: systemPrompt,
            user: payload.messages?.[1]?.content ?? '',
          });
          return makeResponse(json);
        }
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-DYN-CTX-1',
      title: '动态上下文需求测试项目',
      summary: '验证 LLM 规划器动态注入外部知识',
      requirements: { R1: '需求一：审批流', R2: '需求二：归档' },
    });
    await orchestrator.startProposalWorkflow({ proposal, initiatorActor: '测试员' });

    const pmRequest = stageRequests.find((r) => r.system.includes('PM Agent'));
    assert.ok(pmRequest, '应捕获 PM 阶段的 LLM 请求');
    assert.ok(
      pmRequest.user.includes('"externalContext"'),
      '动态需求经 ToolRegistry 预取后应注入 externalContext',
    );
    assert.ok(
      pmRequest.user.includes('directoryTree'),
      'code_structure 应来自 GitContextProvider 的真实仓库读取',
    );
    assert.equal(
      pmRequest.user.includes('__import__evil'),
      false,
      '目录外类型必须在 Facade 白名单处丢弃（注入拦截）',
    );
  });

  it('2. 离线环境 → 规划器零调用（动态推断被跳过），静态声明路径不受影响', async () => {
    saveEnv(['GIT_REPO_PATH', 'LITELLM_ENABLE_LIVE_HTTP']);
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    delete process.env.GIT_REPO_PATH;

    workspace = createTestWorkspace('dyn-ctx-2-');
    orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: workspace.persistenceDir,
      sandboxRootDir: workspace.sandboxRootDir,
    });
    let plannerCalls = 0;
    let stageCalls = 0;
    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('上下文规划器')) {
        plannerCalls += 1;
      } else {
        stageCalls += 1;
      }
      return makeResponse(STAGE_JSON.STAGE_1_PM);
    });

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-DYN-CTX-2',
      title: '离线动态需求回归项目',
      summary: '验证离线时规划器不发起 LLM 调用',
      requirements: { R1: '需求一' },
    });
    await orchestrator.startProposalWorkflow({ proposal, initiatorActor: '测试员' });

    assert.equal(plannerCalls, 0, 'LITELLM_ENABLE_LIVE_HTTP 未开启时规划器必须被完全跳过');
    assert.ok(stageCalls > 0, '静态流水线照常执行（transport 注入即视为在线，阶段调用正常发起）');
  });
});
