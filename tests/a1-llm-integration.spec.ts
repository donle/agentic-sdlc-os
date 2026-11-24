/**
 * @file a1-llm-integration.spec.ts
 * @description A1/A2/A3/B3 集成测试：使用 mock HTTP transport 验证
 * "LLM 输出 → JSON 提取 → 契约工厂 → 自愈重试 → Token 计量 → 预算熔断"完整数据流。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';

function makeLlmResponse(content: string): OpenAiCompatibleChatResponse {
  return {
    id: 'chatcmpl-mock',
    model: 'mock-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

const GOOD_PD_JSON = JSON.stringify({
  summary: '已完成 UI 组件映射',
  coreRequirementIds: ['R1', 'R2'],
  componentMappings: [
    { reqId: 'R1', designSystemComponent: 'Card', interactionStates: ['default'] },
    { reqId: 'R2', designSystemComponent: 'Table', interactionStates: ['default'] },
  ],
  accessibilityChecklist: ['WCAG AA'],
  designChallengeNote: null,
});

const GOOD_TECH_DDL_JSON = JSON.stringify({
  summary: '已完成技术架构契约（含 DDL 高风险门禁）',
  coreRequirementIds: ['R1', 'R2'],
  apiContracts: [
    { method: 'POST', endpoint: '/api/v1/items', requestSchema: '{}', responseSchema: '{}' },
  ],
  databaseDdlStatements: ['CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)'],
  declaredRiskLevel: 'HIGH',
  architecturePatternsUsed: ['Repository', 'Facade'],
});

const GOOD_PRD_JSON = JSON.stringify({
  summary: '已完成 PRD 拆解',
  coreRequirementIds: ['R1', 'R2'],
  userStories: [
    { reqId: 'R1', story: '故事 R1', acceptanceCriteria: ['AC1'] },
    { reqId: 'R2', story: '故事 R2', acceptanceCriteria: ['AC1'] },
  ],
  trackingPlanEvents: [
    { eventName: 'evt_r1', triggerCondition: '触发 R1', properties: ['run_id'] },
    { eventName: 'evt_r2', triggerCondition: '触发 R2', properties: ['run_id'] },
  ],
  nonFunctionalConstraints: ['响应 < 200ms', '审计全覆盖'],
});

const BAD_PRD_JSON = JSON.stringify({
  summary: '缺少 userStories 和 trackingPlanEvents',
  coreRequirementIds: ['R1', 'R2'],
  userStories: [],
  trackingPlanEvents: [],
  nonFunctionalConstraints: [],
});

const PROSE_OUTPUT = '抱歉，我无法生成 JSON 格式的 PRD。以下是我的分析：\n\n这个需求比较复杂...';

describe('A1/A2/A3 — LLM 集成测试（mock transport）', () => {
  it('1. LLM 返回正确 JSON → 契约生成成功且 Token 真实计量', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-t1-'));
    const prevLive = process.env.LITELLM_ENABLE_LIVE_HTTP;
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    try {
      // 注入 mock transport（让 PM 阶段走 LLM 路径）
      let callCount = 0;
      orchestrator.modelRouter.setHttpTransport(
        async (
          _url: string,
          payload: import('../src/patterns/ModelRouterGateway.ts').OpenAiCompatibleChatRequest,
        ) => {
          callCount++;
          const systemPrompt = payload.messages?.[0]?.content ?? '';
          const isPmStage = systemPrompt.includes('PM Agent');
          if (isPmStage) {
            return makeLlmResponse(GOOD_PRD_JSON);
          }
          return makeLlmResponse('{}');
        },
      );
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-A1-001',
        title: 'A1 集成测试项目',
        summary: '验证 LLM 生成 → 解析 → 契约 → Token 计量',
        requirements: { R1: '需求 1', R2: '需求 2' },
      });

      await orchestrator.startProposalWorkflow({ proposal, initiatorActor: 'A1 测试' });

      assert.ok(callCount > 0, 'LLM transport 应被调用');
      const traces = orchestrator.fulfillmentTracker.getMetricsSnapshot();
      assert.ok(traces.totalTokensConsumed > 0, '应有真实 Token 消耗');
    } finally {
      orchestrator.modelRouter.setHttpTransport(null);
      if (prevLive === undefined) {
        delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      } else {
        process.env.LITELLM_ENABLE_LIVE_HTTP = prevLive;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. P1-3 激活：LLM 返回缺字段 JSON → 按阶段路由自愈重试 → 第二次成功（非 skip）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-t2-'));
    const prevLive = process.env.LITELLM_ENABLE_LIVE_HTTP;
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    try {
      let pmCalls = 0;
      orchestrator.modelRouter.setHttpTransport(
        async (
          _url: string,
          payload: import('../src/patterns/ModelRouterGateway.ts').OpenAiCompatibleChatRequest,
        ) => {
          const systemPrompt = payload.messages?.[0]?.content ?? '';
          if (systemPrompt.includes('PM Agent')) {
            pmCalls += 1;
            return makeLlmResponse(pmCalls === 1 ? BAD_PRD_JSON : GOOD_PRD_JSON);
          }
          if (systemPrompt.includes('PD Agent')) {
            return makeLlmResponse(GOOD_PD_JSON);
          }
          if (systemPrompt.includes('Tech Lead Agent')) {
            return makeLlmResponse(GOOD_TECH_DDL_JSON);
          }
          return makeLlmResponse(GOOD_PRD_JSON);
        },
      );
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-A2-001',
        title: 'A2 自愈重试测试',
        summary: '验证 LLM 输出违规 → 修复提示词 → 重试成功',
        requirements: { R1: '需求 1', R2: '需求 2' },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: 'A2 测试',
      });

      assert.ok(pmCalls >= 2, `PM 阶段自愈重试应调用 LLM >=2 次（实际 ${pmCalls}）`);
      assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    } finally {
      orchestrator.modelRouter.setHttpTransport(null);
      if (prevLive === undefined) {
        delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      } else {
        process.env.LITELLM_ENABLE_LIVE_HTTP = prevLive;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. LLM 返回纯散文 → 重试耗尽 → StageContractError → ABORTED + 通知', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-t3-'));
    const prevLive = process.env.LITELLM_ENABLE_LIVE_HTTP;
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 1,
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    try {
      orchestrator.modelRouter.setHttpTransport(
        async (
          _url: string,
          payload: import('../src/patterns/ModelRouterGateway.ts').OpenAiCompatibleChatRequest,
        ) => {
          const systemPrompt = payload.messages?.[0]?.content ?? '';
          const isPmStage = systemPrompt.includes('PM Agent');
          if (isPmStage) {
            return makeLlmResponse(PROSE_OUTPUT);
          }
          return makeLlmResponse('{}');
        },
      );
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-A2-FAIL-001',
        title: 'A2 重试耗尽测试',
        summary: 'LLM 永远返回散文 → 自愈耗尽 → ABORTED',
        requirements: { R1: '需求 1' },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: 'A2 失败测试',
      });

      assert.equal(runState.getStatus(), 'ABORTED');
      const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
      assert.ok(
        inbox.some((n) => n.category === 'STAGE_CONTRACT_FAILED'),
        '应有 STAGE_CONTRACT_FAILED 通知',
      );
    } finally {
      orchestrator.modelRouter.setHttpTransport(null);
      if (prevLive === undefined) {
        delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      } else {
        process.env.LITELLM_ENABLE_LIVE_HTTP = prevLive;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. 网关不可达 → 平滑降级到模板（D-2）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-t4-'));
    const prevUrl = process.env.LITELLM_GATEWAY_URL;
    const prevLive = process.env.LITELLM_ENABLE_LIVE_HTTP;
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    try {
      process.env.LITELLM_GATEWAY_URL = 'http://localhost:1'; // 不可达端口
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-D2-001',
        title: 'D-2 降级测试',
        summary: '网关不可达时平滑降级到模板',
        requirements: { R1: '需求 1', R2: '需求 2' },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: 'D-2 测试',
      });

      assert.notEqual(runState.getStatus(), 'ABORTED');
      assert.ok(runState.getAllSnapshots().length > 0, '应有阶段快照（模板产物）');
    } finally {
      orchestrator.modelRouter.setHttpTransport(null);
      if (prevUrl === undefined) {
        delete process.env.LITELLM_GATEWAY_URL;
      } else {
        process.env.LITELLM_GATEWAY_URL = prevUrl;
      }
      if (prevLive === undefined) {
        delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      } else {
        process.env.LITELLM_ENABLE_LIVE_HTTP = prevLive;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('B3 — Token 预算熔断测试', () => {
  it('5. P1-3 激活：通过临时 YAML 文件配置极低预算 → 首 Agent 即熔断 → ABORTED_TOKEN_BUDGET', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-b3-'));
    try {
      const lowBudgetYaml = `
workflow:
  id: "low_budget_test"
  name: "低预算测试流"
  guardrails:
    maxNegotiationTurns: 3
    maxExecutionRetries: 2
    tokenBudgetLimit: 1000
    highRiskScoreThreshold: 60
  stages:
    - stageId: "STAGE_1_PM"
      agentRole: "PM_AGENT"
`.trimStart();
      const yamlPath = path.join(tmpDir, 'low-budget.yaml');
      fs.writeFileSync(yamlPath, lowBudgetYaml, 'utf-8');

      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
      });
      orchestrator.reloadWorkflowDsl(yamlPath);

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-B3-001',
        title: 'B3 Token 预算熔断测试',
        summary: '超长提案触发 1000 Token 预算上限熔断：' + '详'.repeat(1200),
        requirements: {
          R1: '需求说明 1：' + 'A'.repeat(400),
          R2: '需求说明 2：' + 'B'.repeat(400),
        },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: 'B3 测试',
      });

      assert.equal(runState.getStatus(), 'ABORTED_TOKEN_BUDGET');
      const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
      assert.ok(
        inbox.some((n) => n.category === 'TOKEN_BUDGET_EXCEEDED'),
        '应有 TOKEN_BUDGET_EXCEEDED 通知',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
