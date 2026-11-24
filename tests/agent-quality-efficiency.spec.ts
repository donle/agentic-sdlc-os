/**
 * @file agent-quality-efficiency.spec.ts
 * @description 第十轮验收测试：对应 docs/AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md 中 AC-1 至 AC-11。
 * 覆盖：多模型 json_schema 与能力画像、非代码阶段确定性校验、跨模型 L1/L2 缓存治理、
 * 停滞自动升舱与提前熔断、靶向修复提示、ToolCallLoopGuard 防死循环、对抗式双上下文协商与盲审裁判。
 */

import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  AbstractWorkerAgent,
  type AgentExecutionInputContext,
  AgentExecutionInputContext as InputContext,
  RecognizedStageIntent,
  StageContractError,
} from '../src/agents/AbstractWorkerAgent.ts';
import { BoundedNegotiationMediator } from '../src/agents/BoundedNegotiationMediator.ts';
import { ProductManagerAgent } from '../src/agents/ProductManagerAgent.ts';
import { TechLeadAgent } from '../src/agents/TechLeadAgent.ts';
import { ToolRegistry } from '../src/agents/context/ToolRegistry.ts';
import type { ContextNeed, ContextProvider, ContextQuery } from '../src/agents/context/types.ts';
import {
  PrdArtifactContract,
  ProjectProposalContract,
  QaVerificationArtifactContract,
  TechSpecArtifactContract,
} from '../src/domain/contracts.ts';
import {
  AgentRole,
  BusinessRiskLevel,
  ModelRoutingTier,
  NotificationCategory,
  WorkflowStageId,
} from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { WorkflowEventBus } from '../src/patterns/EventBus.ts';
import { FalseConsensusGuard } from '../src/patterns/FalseConsensusGuard.ts';
import {
  ModelEndpointDescriptor,
  ModelRouterGateway,
  type OpenAiCompatibleChatRequest,
  type OpenAiCompatibleChatResponse,
} from '../src/patterns/ModelRouterGateway.ts';
import type { EmbeddingProvider } from '../src/telemetry/EmbeddingProvider.ts';
import { IntentFulfillmentTracker } from '../src/telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../src/telemetry/PromptCacheManager.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

function chatResponse(
  content: string,
  opts?: { totalTokens?: number; cachedTokens?: number; model?: string },
): OpenAiCompatibleChatResponse {
  const total = opts?.totalTokens ?? 150;
  return {
    id: `cmpl-${Math.random().toString(36).slice(2, 7)}`,
    model: opts?.model ?? 'mock-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: Math.floor(total * 0.6),
      completion_tokens: Math.ceil(total * 0.4),
      total_tokens: total,
      ...(opts?.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: opts.cachedTokens } }
        : {}),
    },
  };
}

class LocalThenHighEscalationPmAgent extends AbstractWorkerAgent<PrdArtifactContract> {
  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
    modelTier: ModelRoutingTier;
    maxExecutionRetries: number;
  }) {
    super({
      role: AgentRole.PRODUCT_MANAGER,
      stageId: WorkflowStageId.STAGE_1_PM,
      ...deps,
    });
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    return new RecognizedStageIntent(
      `PM_INTENT_${context.proposal.coreRequirementIds.length}`,
      '测试意图识别',
      0.95,
    );
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
  ): PrdArtifactContract {
    return new PrdArtifactContract({
      summary: '离线兜底 PRD',
      coreRequirementIds: context.proposal.coreRequirementIds,
      userStories: context.proposal.coreRequirementIds.map((reqId) => ({
        reqId,
        story: `完成 ${reqId}`,
        acceptanceCriteria: ['响应 < 200ms'],
      })),
      trackingPlanEvents: [
        { eventName: 'evt_fallback', triggerCondition: '完成触发', properties: ['run_id'] },
      ],
      nonFunctionalConstraints: ['零外部依赖'],
    });
  }
}

const BASE_STAGE_JSON: Record<string, string> = {
  STAGE_1_PM: JSON.stringify({
    summary: '完成多端看板 PRD 拆解',
    coreRequirementIds: ['R1', 'R2'],
    userStories: [
      { reqId: 'R1', story: '用户查看看板', acceptanceCriteria: ['首屏 < 300ms'] },
      { reqId: 'R2', story: '用户导出报表', acceptanceCriteria: ['导出无乱码'] },
    ],
    trackingPlanEvents: [
      { eventName: 'board_viewed', triggerCondition: '打开看板页', properties: ['run_id'] },
      { eventName: 'report_exported', triggerCondition: '点击导出', properties: ['run_id'] },
    ],
    nonFunctionalConstraints: ['P99 延迟 < 300ms', '审计追踪全覆盖'],
  }),
  STAGE_2_PD: JSON.stringify({
    summary: '完成 UI 组件规范映射（存在交互可行性质询）',
    coreRequirementIds: ['R1', 'R2'],
    componentMappings: [
      { reqId: 'R1', designSystemComponent: 'DataTable', interactionStates: ['default', 'empty'] },
      { reqId: 'R2', designSystemComponent: 'Button', interactionStates: ['default', 'loading'] },
    ],
    accessibilityChecklist: ['WCAG AA 对比度', '键盘导航支持', 'ARIA 标签完备'],
    designChallengeNote: 'PD 质询：手机端表格要求横向 15 列不折叠超出当前规范',
  }),
  STAGE_3A_TECH_SPEC: JSON.stringify({
    summary: '完成技术架构契约',
    coreRequirementIds: ['R1', 'R2'],
    apiContracts: [
      { method: 'GET', endpoint: '/api/v1/boards', requestSchema: '{}', responseSchema: '{}' },
    ],
    databaseDdlStatements: [],
    declaredRiskLevel: 'LOW',
    architecturePatternsUsed: ['Repository', 'Template Method'],
  }),
  STAGE_3B_ENGINEER: JSON.stringify({
    summary: '完成沙箱实现',
    coreRequirementIds: ['R1', 'R2'],
    gitWorktreeBranch: 'worktree/test/b1',
    modifiedFiles: [
      {
        filePath: 'src/modules/r1/R1Service.ts',
        className: 'R1Service',
        designPattern: 'Repository',
        linesChanged: 30,
      },
    ],
    selfTestPassed: true,
  }),
  STAGE_4_QA: JSON.stringify({
    summary: '完成 QA 测试验收',
    coreRequirementIds: ['R1', 'R2'],
    testSuitesExecuted: [
      { suiteName: 'board.sandbox.spec.ts', totalCases: 2, passedCases: 2, coveragePercent: 100 },
    ],
    securityIssuesFound: 0,
    allAcceptanceCriteriaMet: true,
  }),
  STAGE_5_DA: JSON.stringify({
    summary: '完成埋点核验与基线预测',
    coreRequirementIds: ['R1', 'R2'],
    verifiedTrackingEvents: ['board_viewed', 'report_exported'],
    projectedMetrics: [
      { metricName: '采用率', baselineValue: '0%', targetValue: '80%' },
      { metricName: '加载耗时', baselineValue: '500ms', targetValue: '250ms' },
      { metricName: '导出成功率', baselineValue: '95%', targetValue: '99.9%' },
    ],
  }),
};

describe('Agent 质量、跨模型缓存、Token/防死循环与反迎合协商验收套件（AC-1 ~ AC-11）', () => {
  afterEach(() => {
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
  });

  it('AC-1: ModelRouterGateway 下发 strict json_schema / 不支持时回落 json_object，并记录 cachedPromptTokens', async () => {
    const gateway = new ModelRouterGateway();
    gateway.registerEndpoint(
      new ModelEndpointDescriptor({
        tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
        providerName: 'Legacy-Ollama',
        modelIdentifier: 'legacy-7b',
        costPer1kTokensUsd: 0.0001,
        isLocalPrivateModel: true,
        capabilities: { supportsJsonSchema: false, preferFewShotExample: true },
      }),
    );

    const capturedFormats: Array<OpenAiCompatibleChatRequest['response_format']> = [];
    gateway.setHttpTransport(async (_url, payload) => {
      capturedFormats.push(payload.response_format);
      return chatResponse('{"ok":true}', { totalTokens: 200, cachedTokens: 320 });
    });

    const highRes = await gateway.invokeChatCompletion({
      tier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fallbackContentGenerator: () => '{}',
      jsonSchema: {
        name: 'pm_contract',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    });
    assert.equal(highRes.receipt.cachedPromptTokens, 320);
    assert.deepEqual(capturedFormats[0], {
      type: 'json_schema',
      json_schema: {
        name: 'pm_contract',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    });

    await gateway.invokeChatCompletion({
      tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      systemPrompt: 'sys',
      userPrompt: 'usr',
      fallbackContentGenerator: () => '{}',
      jsonSchema: {
        name: 'pm_contract',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    });
    assert.deepEqual(capturedFormats[1], { type: 'json_object' });
  });

  it('AC-2: 模型自适应 Prompt 与 PM/TechLead 非代码阶段确定性校验（保留 forceScopeReduction 路径）', async () => {
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    const gateway = new ModelRouterGateway();
    gateway.registerEndpoint(
      new ModelEndpointDescriptor({
        tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
        providerName: 'Local-Small',
        modelIdentifier: 'qwen-7b-local',
        costPer1kTokensUsd: 0.0001,
        isLocalPrivateModel: true,
        capabilities: { preferFewShotExample: true },
      }),
    );
    const deps = {
      eventBus: new WorkflowEventBus(),
      cacheManager: new PromptCacheManager(false),
      fulfillmentTracker: new IntentFulfillmentTracker(),
      modelRouter: gateway,
      falseConsensusGuard: new FalseConsensusGuard(),
    };

    const proposal = new ProjectProposalContract({
      proposalId: 'AC2-001',
      title: '订单支付权限表升级',
      summary: '新增支付幂等表并优化风控',
      requirements: { R1: '订单幂等锁', R2: '支付流水审计' },
      involvesDatabaseMigration: true,
      involvesPermissionOrPayment: true,
    });

    // 1) PM 阶段：首次含 TBD 占位词被确定性拦截，重试后通过
    let pmCalls = 0;
    gateway.setHttpTransport(async () => {
      pmCalls += 1;
      if (pmCalls === 1) {
        return chatResponse(
          JSON.stringify({
            summary: 'PRD 初稿',
            coreRequirementIds: ['R1', 'R2'],
            userStories: [
              { reqId: 'R1', story: '实现幂等', acceptanceCriteria: ['TBD'] },
              { reqId: 'R2', story: '记录流水', acceptanceCriteria: ['毫秒级审计'] },
            ],
            trackingPlanEvents: [
              { eventName: 'pay_ok', triggerCondition: '支付完成', properties: ['order_id'] },
            ],
            nonFunctionalConstraints: ['可用性 99.9%', '审计留痕'],
          }),
        );
      }
      return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
    });

    const pmAgent = new ProductManagerAgent(deps);
    const pmOutcome = await pmAgent.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC2',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
      }),
    );
    assert.equal(pmOutcome.retryCount, 1);

    // 2) forceScopeReduction 在离线模板下仍穿透到 Step 5 由 FalseConsensusGuard 检出
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    gateway.setHttpTransport(null);
    const scopeReduceOutcome = await pmAgent.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC2-SCOPE',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
        scenarioHints: { forceScopeReduction: true },
      }),
    );
    assert.equal(scopeReduceOutcome.scopeDiffReport.hasUnauthorizedScopeReduction, true);

    // 3) TechLead 阶段：拦截非法 HTTP 动词 / 非法 DDL / 高危低报 LOW
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    let techCalls = 0;
    gateway.setHttpTransport(async () => {
      techCalls += 1;
      if (techCalls === 1) {
        return chatResponse(
          JSON.stringify({
            summary: '架构设计',
            coreRequirementIds: ['R1', 'R2'],
            apiContracts: [
              { method: 'FETCH', endpoint: 'no-slash', requestSchema: '{}', responseSchema: '{}' },
            ],
            databaseDdlStatements: ['SELECT * FROM bad_ddl'],
            declaredRiskLevel: 'LOW',
            architecturePatternsUsed: ['Strategy', 'Memento'],
          }),
        );
      }
      return chatResponse(
        JSON.stringify({
          summary: '修正后的架构设计',
          coreRequirementIds: ['R1', 'R2'],
          apiContracts: [
            {
              method: 'POST',
              endpoint: '/api/v1/pay',
              requestSchema: 'PayReq',
              responseSchema: 'PayRes',
            },
          ],
          databaseDdlStatements: ['CREATE TABLE pay_audit (id VARCHAR(64) PRIMARY KEY);'],
          declaredRiskLevel: 'HIGH',
          architecturePatternsUsed: ['Strategy', 'Memento'],
        }),
      );
    });
    const techAgent = new TechLeadAgent(deps);
    const techOutcome = await techAgent.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC2-TECH',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
      }),
    );
    assert.equal(techOutcome.retryCount, 1);
    assert.equal(techOutcome.artifact.declaredRiskLevel, BusinessRiskLevel.HIGH);

    // 4) 小模型 1-shot 示例注入验证
    let capturedLocalPrompt = '';
    gateway.setHttpTransport(async (_url, payload) => {
      capturedLocalPrompt = payload.messages[1].content;
      return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
    });
    const localPm = new LocalThenHighEscalationPmAgent({
      ...deps,
      modelTier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      maxExecutionRetries: 1,
    });
    await localPm.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC2-FEWSHOT',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
      }),
    );
    assert.ok(capturedLocalPrompt.includes('标准参考样例'));
  });

  it('AC-3: L1 跨模型单向质量治理（强模型可供弱模型复用；弱模型不得拦截/覆盖强模型）', async () => {
    const cache = new PromptCacheManager(true);
    const strongArtifact = new PrdArtifactContract({
      summary: '高阶模型产出 PRD',
      coreRequirementIds: ['R1'],
      userStories: [{ reqId: 'R1', story: '强', acceptanceCriteria: ['< 100ms'] }],
      trackingPlanEvents: [{ eventName: 'e1', triggerCondition: 'click', properties: ['id'] }],
      nonFunctionalConstraints: ['强约束'],
    });
    const weakArtifact = new PrdArtifactContract({
      summary: '本地弱模型产出 PRD',
      coreRequirementIds: ['R1'],
      userStories: [{ reqId: 'R1', story: '弱', acceptanceCriteria: ['可运行'] }],
      trackingPlanEvents: [{ eventName: 'e1', triggerCondition: 'click', properties: ['id'] }],
      nonFunctionalConstraints: ['基础约束'],
    });

    const keyStrong = cache.buildExactCacheKey({
      stageId: WorkflowStageId.STAGE_1_PM,
      agentRole: AgentRole.PRODUCT_MANAGER,
      proposalTitle: '提案 A',
      requirementIds: ['R1'],
    });
    await cache.storeVerifiedArtifact({
      exactKey: keyStrong,
      semanticIntentText: '意图 A',
      artifact: strongArtifact,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
      modelQualityRank: 90,
      promptSpecHash: 'spec_v1',
    });

    // 低等级模型（65）命中高等级（90）缓存
    const hitByWeak = await cache.lookup<PrdArtifactContract>(keyStrong, '意图 A', {
      minQualityRank: 65,
      promptSpecHash: 'spec_v1',
    });
    assert.equal(hitByWeak.isHit, true);
    assert.equal(hitByWeak.cachedArtifact?.summary, '高阶模型产出 PRD');

    // 低等级存储不能覆写同版本高等级条目
    await cache.storeVerifiedArtifact({
      exactKey: keyStrong,
      semanticIntentText: '意图 A',
      artifact: weakArtifact,
      estimatedTokens: 300,
      estimatedCostUsd: 0.001,
      modelQualityRank: 65,
      promptSpecHash: 'spec_v1',
    });
    const checkStrongIntact = await cache.lookup<PrdArtifactContract>(keyStrong, '意图 A', {
      minQualityRank: 90,
      promptSpecHash: 'spec_v1',
    });
    assert.equal(checkStrongIntact.isHit, true);
    assert.equal(checkStrongIntact.cachedArtifact?.summary, '高阶模型产出 PRD');

    // 新键仅有低等级条目（65）时，高等级请求（90）必须绕过（防止弱模型污染）
    const keyWeak = cache.buildExactCacheKey({
      stageId: WorkflowStageId.STAGE_1_PM,
      agentRole: AgentRole.PRODUCT_MANAGER,
      proposalTitle: '提案 B',
      requirementIds: ['R1'],
    });
    await cache.storeVerifiedArtifact({
      exactKey: keyWeak,
      semanticIntentText: '意图 B',
      artifact: weakArtifact,
      estimatedTokens: 300,
      estimatedCostUsd: 0.001,
      modelQualityRank: 65,
      promptSpecHash: 'spec_v1',
    });
    const bypassed = await cache.lookup<PrdArtifactContract>(keyWeak, '意图 B', {
      minQualityRank: 90,
      promptSpecHash: 'spec_v1',
    });
    assert.equal(bypassed.isHit, false);
    assert.equal(cache.getMetricsSnapshot().qualityUpgradeBypasses, 1);
  });

  it('AC-4: L2 按 Embedding 向量空间与 Prompt 版本哈希严格隔离分桶', async () => {
    class MutableEmbeddingStub implements EmbeddingProvider {
      public readonly providerName = 'stub-embedder';
      public modelIdentifier = 'bge-m3-local';
      public async embed(): Promise<number[] | null> {
        return [1, 0, 0]; // 恒返回单位向量：若未隔离必然 1.0 命中
      }
    }
    const embedder = new MutableEmbeddingStub();
    const cache = new PromptCacheManager(true, embedder);
    const artifact = new PrdArtifactContract({
      summary: 'PRD',
      coreRequirementIds: ['R1'],
      userStories: [{ reqId: 'R1', story: 's', acceptanceCriteria: ['ac'] }],
      trackingPlanEvents: [{ eventName: 'ev', triggerCondition: 'c', properties: ['p'] }],
      nonFunctionalConstraints: ['c'],
    });

    await cache.storeVerifiedArtifact({
      exactKey: 'k1',
      semanticIntentText: '审批流',
      artifact,
      estimatedTokens: 100,
      estimatedCostUsd: 0.001,
      modelQualityRank: 80,
      promptSpecHash: 'hash_v1',
      stageId: WorkflowStageId.STAGE_1_PM,
    });

    // 切换 Embedding 模型后，即使向量数值相同也禁止跨空间匹配
    embedder.modelIdentifier = 'text-embedding-3-small';
    const crossModel = await cache.lookup('k2', '审批流', {
      minQualityRank: 80,
      promptSpecHash: 'hash_v1',
      stageId: WorkflowStageId.STAGE_1_PM,
    });
    assert.equal(crossModel.isHit, false);
    assert.ok(cache.getMetricsSnapshot().crossSpaceSkips >= 1);

    // 切回原 Embedding 模型但更换 Prompt 版本哈希 -> 同样隔离跳过
    embedder.modelIdentifier = 'bge-m3-local';
    const crossPrompt = await cache.lookup('k2', '审批流', {
      minQualityRank: 80,
      promptSpecHash: 'hash_v2',
      stageId: WorkflowStageId.STAGE_1_PM,
    });
    assert.equal(crossPrompt.isHit, false);
    assert.ok(cache.getMetricsSnapshot().crossSpaceSkips >= 2);

    // 空间、版本与阶段完全匹配 -> L2 语义命中
    const matched = await cache.lookup('k2', '审批流', {
      minQualityRank: 80,
      promptSpecHash: 'hash_v1',
      stageId: WorkflowStageId.STAGE_1_PM,
    });
    assert.equal(matched.isHit, true);
    assert.equal(matched.cacheLayer, 'L2_SEMANTIC_INTENT');
  });

  it('AC-5: 连续同错停滞自动将本地小模型升舱高阶模型；高阶仍同错则提前触发 STAGNATION_CIRCUIT_BREAKER', async () => {
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    const gateway = new ModelRouterGateway();
    const deps = {
      eventBus: new WorkflowEventBus(),
      cacheManager: new PromptCacheManager(false),
      fulfillmentTracker: new IntentFulfillmentTracker(),
      modelRouter: gateway,
      falseConsensusGuard: new FalseConsensusGuard(),
    };
    const proposal = new ProjectProposalContract({
      proposalId: 'AC5-001',
      title: '停滞检测测试',
      summary: '连续同错时升舱与提前熔断',
      requirements: { R1: '需求 R1', R2: '需求 R2' },
    });

    const badPrd = JSON.stringify({
      summary: 'bad',
      coreRequirementIds: ['R1', 'R2'],
      userStories: [],
      trackingPlanEvents: [],
      nonFunctionalConstraints: [],
    });

    // 场景 A：本地模型连续 2 次同样违规 -> 自动升舱至 HIGH_REASONING_HYBRID 成功
    const seenModels: string[] = [];
    gateway.setHttpTransport(async (_url, payload) => {
      seenModels.push(payload.model);
      if (payload.model.includes('local')) {
        return chatResponse(badPrd, { model: payload.model });
      }
      return chatResponse(BASE_STAGE_JSON.STAGE_1_PM, { model: payload.model });
    });
    const localAgent = new LocalThenHighEscalationPmAgent({
      ...deps,
      modelTier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      maxExecutionRetries: 3,
    });
    const outcome = await localAgent.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC5-ESC',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
      }),
    );
    assert.deepEqual(seenModels, [
      'qwen2.5-coder-32b-instruct-local',
      'qwen2.5-coder-32b-instruct-local',
      'claude-3-7-sonnet-enterprise',
    ]);
    assert.equal(outcome.modelUsed, 'claude-3-7-sonnet-enterprise');

    // 场景 B：高阶模型连续 2 次同错 -> 未跑满 maxExecutionRetries=4 即提前熔断
    let highAttempts = 0;
    gateway.setHttpTransport(async () => {
      highAttempts += 1;
      return chatResponse(badPrd);
    });
    const highAgent = new LocalThenHighEscalationPmAgent({
      ...deps,
      modelTier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      maxExecutionRetries: 4,
    });
    await assert.rejects(
      () =>
        highAgent.executeStagePipeline(
          new InputContext({
            runId: 'RUN-AC5-BREAK',
            branchId: 'B1',
            proposal,
            upstreamArtifacts: new Map(),
          }),
        ),
      (err: unknown) =>
        err instanceof StageContractError &&
        err.retryCount === 2 &&
        err.violations.some((v) => v.includes('STAGNATION_CIRCUIT_BREAKER')),
    );
    assert.equal(highAttempts, 2, '应在 2 次连续同错后提前熔断，避免跑满 5 次重试');
  });

  it('AC-6: 部分校验失败进入重试时自动注入 TARGETED_PATCH 与 previousValidKeys', async () => {
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    const gateway = new ModelRouterGateway();
    let calls = 0;
    let secondUserPrompt = '';
    gateway.setHttpTransport(async (_url, payload) => {
      calls += 1;
      if (calls === 1) {
        return chatResponse(
          JSON.stringify({
            summary: '缺少埋点列表的半成品',
            coreRequirementIds: ['R1', 'R2'],
            userStories: [
              { reqId: 'R1', story: 's1', acceptanceCriteria: ['ac1'] },
              { reqId: 'R2', story: 's2', acceptanceCriteria: ['ac2'] },
            ],
            trackingPlanEvents: [],
            nonFunctionalConstraints: ['约束 1', '约束 2'],
          }),
        );
      }
      secondUserPrompt = payload.messages[1].content;
      return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
    });

    const pm = new ProductManagerAgent({
      eventBus: new WorkflowEventBus(),
      cacheManager: new PromptCacheManager(false),
      fulfillmentTracker: new IntentFulfillmentTracker(),
      modelRouter: gateway,
      falseConsensusGuard: new FalseConsensusGuard(),
    });
    const proposal = new ProjectProposalContract({
      proposalId: 'AC6-001',
      title: '靶向修复测试',
      summary: 's',
      requirements: { R1: '需求1', R2: '需求2' },
    });
    await pm.executeStagePipeline(
      new InputContext({
        runId: 'RUN-AC6',
        branchId: 'B1',
        proposal,
        upstreamArtifacts: new Map(),
      }),
    );
    assert.ok(secondUserPrompt.includes('"repairMode":"TARGETED_PATCH"'));
    assert.ok(secondUserPrompt.includes('"previousValidKeys"'));
    assert.ok(secondUserPrompt.includes('userStories'));
  });

  it('AC-7: ToolRegistry 集成 ToolCallLoopGuard 实现参数去重、单阶段次数拦截与超长截断', async () => {
    const counts = { p1: 0, p2: 0, p3: 0 };
    const makeStubProvider = (key: 'p1' | 'p2' | 'p3', content: string): ContextProvider => ({
      name: `stub-${key}`,
      canResolve: (n: ContextNeed) => n.type === key,
      resolve: async () => {
        counts[key] += 1;
        return { type: key, content, tokenEstimate: 10, source: key, isReal: false };
      },
    });

    const registry = new ToolRegistry(10000, { maxCallsPerStage: 2, maxCharsPerResult: 80 });
    registry.register(makeStubProvider('p1', 'X'.repeat(150)));
    registry.register(makeStubProvider('p2', '正常短结果'));
    registry.register(makeStubProvider('p3', '应被预算熔断拦截'));

    const proposal = new ProjectProposalContract({
      proposalId: 'AC7',
      title: 't',
      summary: 's',
      requirements: { R1: 'r1' },
    });
    const query: ContextQuery = {
      runId: 'RUN-AC7',
      stageId: WorkflowStageId.STAGE_1_PM,
      proposal,
      upstreamSummaries: [],
    };

    // 第 1 次调 p1（执行并截断至 80 字符内+后缀）
    await registry.resolve([{ type: 'p1', required: true, maxTokens: 500 }], query);
    const cachedP1 = registry.getCached('RUN-AC7', 'p1', WorkflowStageId.STAGE_1_PM);
    assert.equal(cachedP1?.truncated, true);
    assert.ok(cachedP1!.content.includes('[TRUNCATED_BY_TOOL_LOOP_GUARD]'));

    // 再次批量请求 p1（去重不计预算）、p2（计数第 2 次）、p3（超出上限 2 被阻断）
    const secondOutcome = await registry.resolve(
      [
        { type: 'p1', required: true, maxTokens: 500 },
        { type: 'p2', required: false, maxTokens: 500 },
        { type: 'p3', required: true, maxTokens: 500 },
      ],
      query,
    );
    assert.equal(counts.p1, 1);
    assert.equal(counts.p2, 1);
    assert.equal(counts.p3, 0);
    assert.ok(secondOutcome.truncated.some((t) => t.type === 'p3'));

    const stats = registry.getGuardStats();
    assert.equal(stats.deduplicatedCalls, 1);
    assert.equal(stats.budgetBlockedCalls, 1);
    assert.equal(stats.truncatedResults, 1);
  });

  it('AC-8: 对抗式协商触发 ESCALATE_TRADEOFF 时在第 1 轮即时熔断上报人类（不白烧后续轮次）', async () => {
    await withTestWorkspace('aqe-ac8-', async (ws) => {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      let responderCalls = 0;
      let challengerOrJudgeCalls = 0;

      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        const sys = payload.messages[0].content;
        if (sys.includes('受限协商中的响应方')) {
          responderCalls += 1;
          return chatResponse(
            JSON.stringify({
              action: 'ESCALATE_TRADEOFF',
              responseResolution: '涉及工期与移动端交互体验的业务取舍，需人类拍板',
              concretePatch: '',
              optionAProposal: '方案 A：表格自动转卡片折叠（0 额外工期）',
              optionBProposal: '方案 B：投入 3 人日研发虚拟横滑网格',
            }),
          );
        }
        if (sys.includes('挑战方独立复核者') || sys.includes('独立盲审裁判')) {
          challengerOrJudgeCalls += 1;
        }
        for (const [stageId, json] of Object.entries(BASE_STAGE_JSON)) {
          if (sys.includes(stageId) || sys.includes(roleKeyword(stageId))) {
            return chatResponse(json);
          }
        }
        return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'AC8-001',
          title: 'ESCALATE_TRADEOFF 即时熔断测试',
          summary: '权衡类分歧不应空转 3 轮',
          requirements: { R1: '需求1', R2: '需求2' },
        }),
        initiatorActor: 'AC8',
      });

      assert.equal(responderCalls, 1, 'ESCALATE_TRADEOFF 应在第 1 轮立即结束协商');
      assert.equal(challengerOrJudgeCalls, 0, '即时上交权衡无需再浪费挑战/盲审 Token');
      const history = orchestrator.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.equal(history.length, 1);
      assert.equal(history[0].escalatedToSupervisor, true);
      assert.ok(history[0].optionAProposal.includes('方案 A'));
      const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
      assert.ok(
        inbox.some((n) => n.category === NotificationCategory.CONFLICT_ARBITRATION_REQUIRED),
      );
    });
  });

  it('AC-9: 挑战方独立否决阻止第 1 轮伪共识，并将 previousTurns 传至第 2 轮达成真共识', async () => {
    await withTestWorkspace('aqe-ac9-', async (ws) => {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      let responderCalls = 0;
      let turn2UserPrompt = '';

      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        const sys = payload.messages[0].content;
        const usr = payload.messages[1].content;
        if (sys.includes('受限协商中的响应方')) {
          responderCalls += 1;
          if (responderCalls === 1) {
            return chatResponse(
              JSON.stringify({
                action: 'ACCEPT_AND_PATCH',
                responseResolution: '第 1 轮：简单调整表头宽度',
                concretePatch: '略微压缩列宽',
                optionAProposal: '方案 A',
                optionBProposal: '方案 B',
              }),
            );
          }
          turn2UserPrompt = usr;
          return chatResponse(
            JSON.stringify({
              action: 'ACCEPT_AND_PATCH',
              responseResolution: '第 2 轮：依据挑战意见补充响应式折叠卡片',
              concretePatch: '小于 768px 自动切换 CollapsibleCard 并保留全部 15 字段导出',
              optionAProposal: '方案 A',
              optionBProposal: '方案 B',
            }),
          );
        }
        if (sys.includes('挑战方独立复核者')) {
          if (usr.includes('略微压缩列宽')) {
            return chatResponse(
              JSON.stringify({
                accepted: false,
                critique: '压缩列宽仍无法在 375px 手机屏可读，拒绝妥协',
                containsImplicitScopeCut: false,
              }),
            );
          }
          return chatResponse(
            JSON.stringify({
              accepted: true,
              critique: '响应式卡片方案满足规范且未丢失字段',
              containsImplicitScopeCut: false,
            }),
          );
        }
        if (sys.includes('独立盲审裁判')) {
          return chatResponse(
            JSON.stringify({ hasImplicitDowngrade: false, reason: '无功能缩水' }),
          );
        }
        for (const [stageId, json] of Object.entries(BASE_STAGE_JSON)) {
          if (sys.includes(stageId) || sys.includes(roleKeyword(stageId))) {
            return chatResponse(json);
          }
        }
        return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'AC9-001',
          title: '双上下文独立对抗协商测试',
          summary: '挑战方否决后第 2 轮带历史修正并通过',
          requirements: { R1: '需求1', R2: '需求2' },
        }),
        initiatorActor: 'AC9',
      });

      const history = orchestrator.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.equal(history.length, 2);
      assert.equal(history[0].consensusReached, false);
      assert.ok(history[0].responseResolution.includes('挑战方独立复核否决'));
      assert.ok(turn2UserPrompt.includes('拒绝妥协'), '第 2 轮响应方必须收到第 1 轮挑战方否决历史');
      assert.equal(history[1].consensusReached, true);
      assert.equal(history[1].escalatedToSupervisor, false);
    });
  });

  it('AC-10: 双方迎合达成共识时，无历史盲审裁判识破软降级并否决伪共识', async () => {
    await withTestWorkspace('aqe-ac10-', async (ws) => {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 2,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      let judgeSawHistory = false;

      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        const sys = payload.messages[0].content;
        const usr = payload.messages[1].content;
        if (sys.includes('受限协商中的响应方')) {
          return chatResponse(
            JSON.stringify({
              action: 'ACCEPT_AND_PATCH',
              responseResolution: '双方一致同意先用前端按钮防抖替代并发分布式锁以快速上线',
              concretePatch: '移除后端锁检查，改用 500ms 防抖',
              optionAProposal: '方案 A：保分布式锁',
              optionBProposal: '方案 B：仅前端防抖',
            }),
          );
        }
        if (sys.includes('挑战方独立复核者')) {
          // 故意模拟双方共谋迎合
          return chatResponse(
            JSON.stringify({
              accepted: true,
              critique: '可以接受，先上线再说',
              containsImplicitScopeCut: false,
            }),
          );
        }
        if (sys.includes('独立盲审裁判')) {
          if (usr.includes('历史交锋记录')) {
            judgeSawHistory = true;
          }
          return chatResponse(
            JSON.stringify({
              hasImplicitDowngrade: true,
              reason: '将后端分布式并发锁软降级为前端防抖，实质阉割核心一致性要求',
            }),
          );
        }
        for (const [stageId, json] of Object.entries(BASE_STAGE_JSON)) {
          if (sys.includes(stageId) || sys.includes(roleKeyword(stageId))) {
            return chatResponse(json);
          }
        }
        return chatResponse(BASE_STAGE_JSON.STAGE_1_PM);
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'AC10-001',
          title: '防迎合盲审拦截测试',
          summary: '盲审裁判不看聊天记录直接抓出隐性软降级',
          requirements: { R1: '需求1', R2: '需求2' },
        }),
        initiatorActor: 'AC10',
      });

      assert.equal(judgeSawHistory, false, '盲审裁判输入不得混入双方协商历史');
      const history = orchestrator.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.equal(history.length, 2);
      assert.equal(history[0].consensusReached, false);
      assert.equal(history[1].consensusReached, false);
      assert.equal(history[1].escalatedToSupervisor, true);
      assert.ok(history[1].responseResolution.includes('防伪共识盲审否决'));
    });
  });

  it('AC-11: FalseConsensusGuard.evaluateSemanticInvariants 拦截未删 ID 但软阉割/低报风险/自相矛盾产物', () => {
    const guard = new FalseConsensusGuard();
    const proposal = new ProjectProposalContract({
      proposalId: 'AC11-001',
      title: '核心资金转账需求',
      summary: '要求数据库事务与强风控',
      requirements: { R1: '幂等扣款', R2: '强一致性' },
      involvesDatabaseMigration: true,
      involvesPermissionOrPayment: true,
    });

    // 1) coreRequirementIds 完好但包含 "暂不实现" 软阉割
    const softCutPrd = new PrdArtifactContract({
      summary: 'PRD 已对齐',
      coreRequirementIds: ['R1', 'R2'],
      userStories: [
        { reqId: 'R1', story: '扣款', acceptanceCriteria: ['强一致性暂不实现，待定二期'] },
        { reqId: 'R2', story: '幂等', acceptanceCriteria: ['唯一索引'] },
      ],
      trackingPlanEvents: [{ eventName: 'ev', triggerCondition: 'done', properties: ['id'] }],
      nonFunctionalConstraints: ['约束'],
    });
    const softReport = guard.evaluateSemanticInvariants(proposal, softCutPrd);
    assert.equal(softReport.scopeDiff.hasUnauthorizedScopeReduction, false);
    assert.equal(softReport.hasSemanticViolation, true);

    // 2) 高危 DDL 提案却自报 LOW 风险
    const downplayedTech = new TechSpecArtifactContract({
      summary: '技术契约',
      coreRequirementIds: ['R1', 'R2'],
      apiContracts: [
        { method: 'POST', endpoint: '/api/v1/pay', requestSchema: 'a', responseSchema: 'b' },
      ],
      databaseDdlStatements: ['ALTER TABLE acct ADD COLUMN ver INT;'],
      declaredRiskLevel: BusinessRiskLevel.LOW,
      architecturePatternsUsed: ['Saga', 'Outbox'],
    });
    const riskReport = guard.evaluateSemanticInvariants(proposal, downplayedTech);
    assert.equal(riskReport.hasSemanticViolation, true);
    assert.ok(riskReport.violationReasons.some((r) => r.includes('LOW')));

    // 3) QA 存在漏洞却宣称 allAcceptanceCriteriaMet=true
    const dishonestQa = new QaVerificationArtifactContract({
      summary: 'QA 通过',
      coreRequirementIds: ['R1', 'R2'],
      testSuitesExecuted: [{ suiteName: 's', totalCases: 2, passedCases: 2, coveragePercent: 90 }],
      securityIssuesFound: 2,
      allAcceptanceCriteriaMet: true,
    });
    const qaReport = guard.evaluateSemanticInvariants(proposal, dishonestQa);
    assert.equal(qaReport.hasSemanticViolation, true);
    assert.ok(qaReport.violationReasons.some((r) => r.includes('安全漏洞')));

    // 验证 BoundedNegotiationMediator 导出类型保持兼容
    assert.equal(typeof BoundedNegotiationMediator, 'function');
  });
});

function roleKeyword(stageId: string): string {
  const map: Record<string, string> = {
    STAGE_1_PM: 'PM Agent',
    STAGE_2_PD: 'PD Agent',
    STAGE_3A_TECH_SPEC: 'Tech Lead Agent',
    STAGE_3B_ENGINEER: 'Engineer Agent',
    STAGE_4_QA: 'QA Agent',
    STAGE_5_DA: 'DA Agent',
  };
  return map[stageId] ?? stageId;
}
