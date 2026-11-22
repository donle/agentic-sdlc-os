/**
 * @file a1-llm-integration.spec.ts
 * @description A1/A2/A3/B3 集成测试：使用 mock HTTP transport 验证
 * "LLM 输出 → JSON 提取 → 契约工厂 → 自愈重试 → Token 计量 → 预算熔断"完整数据流。
 */

import * as assert from 'node:assert/strict';
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
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
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
    // 启用 LLM HTTP
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-A1-001',
      title: 'A1 集成测试项目',
      summary: '验证 LLM 生成 → 解析 → 契约 → Token 计量',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    await orchestrator.startProposalWorkflow({ proposal, initiatorActor: 'A1 测试' });

    // LLM 被调用了
    assert.ok(callCount > 0, 'LLM transport 应被调用');
    // Token 计量来自真实 usage
    const traces = orchestrator.fulfillmentTracker.getMetricsSnapshot();
    assert.ok(traces.totalTokensConsumed > 0, '应有真实 Token 消耗');
    // usageEstimated = false（网关返回了 usage）
    // usageEstimated 由 receipt 级别追踪（当前 metrics 无聚合字段，通过 runState 快照验证）

    // 恢复环境
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    orchestrator.modelRouter.setHttpTransport(null);
  });

  it.skip('2. LLM 返回缺字段的 JSON → 自愈重试 → 第二次成功（transport 需按阶段路由，待 C1 完善后启用）', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    let callCount = 0;
    orchestrator.modelRouter.setHttpTransport(
      async (
        _url: string,
        payload: import('../src/patterns/ModelRouterGateway.ts').OpenAiCompatibleChatRequest,
      ) => {
        callCount++;
        // 检测阶段：PM 阶段走自愈重试场景，其他阶段返回模板可解析的 JSON
        const systemPrompt = payload.messages?.[0]?.content ?? '';
        const isPmStage = systemPrompt.includes('PM Agent');
        if (isPmStage && callCount === 1) {
          return makeLlmResponse(BAD_PRD_JSON); // 第一次缺字段
        }
        if (isPmStage) {
          return makeLlmResponse(GOOD_PRD_JSON); // 第二次正确
        }
        // 其他阶段：返回一个通用 JSON（会走模板降级，因为字段不匹配）
        return makeLlmResponse('{}');
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

    // 自愈重试：LLM 被调用 ≥2 次（PM 阶段至少 2 次）
    assert.ok(callCount >= 2, `自愈重试应调用 LLM ≥2 次（实际 ${callCount}）`);
    // 最终成功
    assert.notEqual(runState.getStatus(), 'ABORTED');

    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    orchestrator.modelRouter.setHttpTransport(null);
  });

  it('3. LLM 返回纯散文 → 重试耗尽 → StageContractError → ABORTED + 通知', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 1 });
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

    // 契约失败 → ABORTED（不是 throw）
    assert.equal(runState.getStatus(), 'ABORTED');
    // 通知中心有 STAGE_CONTRACT_FAILED 通知
    const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
    assert.ok(
      inbox.some((n) => n.category === 'STAGE_CONTRACT_FAILED'),
      '应有 STAGE_CONTRACT_FAILED 通知',
    );

    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    orchestrator.modelRouter.setHttpTransport(null);
  });

  it('4. 网关不可达 → 平滑降级到模板（D-2）', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    // 不设置 transport，LITELLM_ENABLE_LIVE_HTTP=true → fetch 到不存在的地址 → 降级
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

    // 降级后模板产物仍然通过契约校验并推进流水线
    assert.notEqual(runState.getStatus(), 'ABORTED');
    assert.ok(runState.getAllSnapshots().length > 0, '应有阶段快照（模板产物）');

    delete process.env.LITELLM_GATEWAY_URL;
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    orchestrator.modelRouter.setHttpTransport(null);
  });
});

describe('B3 — Token 预算熔断测试', () => {
  it.skip('5. 预算极低 → 首 Agent 即熔断 → ABORTED_TOKEN_BUDGET（需 C1 异步化后才能精确控制估算）', async () => {
    // 创建一个使用极低预算的 DSL 的 Facade
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
`;
    // 直接用 facade 默认 DSL，但修改 guardrails
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    // 通过重新加载 DSL 来注入低预算
    orchestrator.reloadWorkflowDsl(lowBudgetYaml);

    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-B3-001',
      title: 'B3 Token 预算熔断测试',
      summary: '预算 1000 → 首 Agent 即超限',
      requirements: { R1: '需求 1', R2: '需求 2' },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: 'B3 测试',
    });

    // 预算熔断 → ABORTED_TOKEN_BUDGET
    assert.equal(runState.getStatus(), 'ABORTED_TOKEN_BUDGET');
    // 通知中心有 TOKEN_BUDGET_EXCEEDED
    const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
    assert.ok(
      inbox.some((n) => n.category === 'TOKEN_BUDGET_EXCEEDED'),
      '应有 TOKEN_BUDGET_EXCEEDED 通知',
    );
  });
});
