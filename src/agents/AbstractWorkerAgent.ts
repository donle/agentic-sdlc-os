/**
 * @file AbstractWorkerAgent.ts
 * @description 抽象职能 Agent 基类 —— 模板方法模式固化 7 步标准生命周期（BACKEND_TODO_DESIGN A1/A2/A3 定稿）。
 *
 * 相比仿真内核的关键变化：
 * 1. 【A1】步骤 4 通过 `ModelRouterGateway.invokeChatCompletion` 生成产物：
 *    Prompt 由 `StagePromptSpecs`（角色纪律 + 任务 + JSON Schema 提示）+ 结构化输入组装；
 *    LLM JSON 经 `JsonExtractor` 提取、`ArtifactContractFactory` 反序列化为强类型契约；
 *    原模板实现降级为 `fallbackContentGenerator`（网关不可达时平滑回落，结果带 usedFallbackTemplate 标记）。
 * 2. 【A2】自愈重试真实化：契约校验违规/JSON 解析失败会收集 violations，构造修复提示词重试；
 *    超限抛 `StageContractError`，由编排器捕获并暂停（禁止打穿 HTTP）。
 * 3. 【A3】Token/成本使用网关返回的真实 usage（缺失时长度估算并标记 usageEstimated）。
 * 4. 【B3】每次 attempt 前检查 `tokenBudgetRemaining`，超预算抛 `TokenBudgetExceededError`（不重试）。
 */

import { type IDomainArtifactContract, ProjectProposalContract } from '../domain/contracts.ts';
import {
  AgentRole,
  IntentFulfillmentStatus,
  ModelRoutingTier,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../domain/enums.ts';
import type { ScenarioHints } from '../domain/scenario.ts';
import { ScopeDiffReport } from '../domain/models.ts';
import { WorkflowDomainEvent, WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import { ArtifactContractFactory } from './deserialize/ArtifactContractFactory.ts';
import { JsonExtractor } from './prompt/JsonExtractor.ts';
import { computePromptSpecHash, STAGE_PROMPT_SPECS } from './prompt/StagePromptSpecs.ts';
import {
  IntentExecutionTraceRecord,
  IntentFulfillmentTracker,
} from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import { UpstreamCompressor } from './context/UpstreamCompressor.ts';
import type { TrimmedContext } from './context/ContextBudgetTrimmer.ts';
import { ToolRegistry } from './context/ToolRegistry.ts';
import { STAGE_CONTEXT_NEEDS } from './context/types.ts';
import type { ContextNeed } from './context/types.ts';

/** 契约生成失败（可重试）——编排器捕获后暂停流水线并推送人工通知（D-5） */
export class StageContractError extends Error {
  public readonly stageId: WorkflowStageId;
  public readonly violations: ReadonlyArray<string>;
  public readonly retryCount: number;

  public constructor(
    stageId: WorkflowStageId,
    violations: ReadonlyArray<string>,
    retryCount: number,
  ) {
    super(`[${stageId}] 在 ${retryCount} 次自愈重试后仍未通过契约校验：${violations.join(' | ')}`);
    this.name = 'StageContractError';
    this.stageId = stageId;
    this.violations = [...violations];
    this.retryCount = retryCount;
  }
}

/** Token 预算超限（不重试，直接暂停流水线） */
export class TokenBudgetExceededError extends Error {
  public readonly stageId: WorkflowStageId;
  public readonly budgetRemaining: number;

  public constructor(stageId: WorkflowStageId, budgetRemaining: number) {
    super(`[${stageId}] Token 预算不足（剩余 ${budgetRemaining}），执行已按守卫策略熔断`);
    this.name = 'TokenBudgetExceededError';
    this.stageId = stageId;
    this.budgetRemaining = budgetRemaining;
  }
}

/**
 * 传入职能 Agent 执行管道的上下文对象
 */
export class AgentExecutionInputContext {
  public readonly runId: string;
  public readonly branchId: string;
  public readonly proposal: ProjectProposalContract;
  public readonly upstreamArtifacts: ReadonlyMap<WorkflowStageId, IDomainArtifactContract>;
  public readonly historicalRejectionLessons: ReadonlyArray<string>;
  public readonly humanFeedbackDirective: string | null;
  /** 演示/测试场景开关（J1：自提案契约迁出） */
  public readonly scenarioHints: ScenarioHints;
  /** B3：本 run 的剩余 Token 预算（-1 = 未启用预算守卫） */
  public readonly tokenBudgetRemaining: number;
  /** 步骤 4：Facade 侧 LLM 意图分析推断的动态上下文需求（类型已过目录白名单；离线为空） */
  public readonly dynamicContextNeeds: ReadonlyArray<ContextNeed>;
  /** P1-3：经 ContextBudgetTrimmer 裁剪后的外部上下文预算包（非 null 时优先使用，替代未裁剪 runCache） */
  public readonly trimmedExternalContext: TrimmedContext | null;

  public constructor(params: {
    runId: string;
    branchId: string;
    proposal: ProjectProposalContract;
    upstreamArtifacts: ReadonlyMap<WorkflowStageId, IDomainArtifactContract>;
    historicalRejectionLessons?: ReadonlyArray<string>;
    humanFeedbackDirective?: string | null;
    scenarioHints?: ScenarioHints;
    tokenBudgetRemaining?: number;
    dynamicContextNeeds?: ReadonlyArray<ContextNeed>;
    trimmedExternalContext?: TrimmedContext | null;
  }) {
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.proposal = params.proposal;
    this.upstreamArtifacts = params.upstreamArtifacts;
    this.historicalRejectionLessons = params.historicalRejectionLessons
      ? [...params.historicalRejectionLessons]
      : [];
    this.humanFeedbackDirective = params.humanFeedbackDirective ?? null;
    this.scenarioHints = params.scenarioHints ?? {};
    this.tokenBudgetRemaining = params.tokenBudgetRemaining ?? -1;
    this.dynamicContextNeeds = params.dynamicContextNeeds ?? [];
    this.trimmedExternalContext = params.trimmedExternalContext ?? null;
  }
}

/**
 * 意图识别结果值对象（A4 计划 LLM 化，当前保持规则实现以支撑缓存键）
 */
export class RecognizedStageIntent {
  public readonly intentCode: string;
  public readonly intentDescription: string;
  public readonly confidenceScore: number;

  public constructor(intentCode: string, intentDescription: string, confidenceScore = 0.96) {
    this.intentCode = intentCode;
    this.intentDescription = intentDescription;
    this.confidenceScore = confidenceScore;
  }
}

/**
 * Agent 执行完成后的封装结果值对象
 */
export class AgentExecutionOutcome<T extends IDomainArtifactContract = IDomainArtifactContract> {
  public readonly artifact: T;
  public readonly modelUsed: string;
  public readonly cacheHit: boolean;
  public readonly cacheLayer: string;
  public readonly retryCount: number;
  public readonly tokensConsumed: number;
  public readonly costUsd: number;
  public readonly usageEstimated: boolean;
  public readonly usedFallbackTemplate: boolean;
  public readonly scopeDiffReport: ScopeDiffReport;
  public readonly recognizedIntent: RecognizedStageIntent;

  public constructor(params: {
    artifact: T;
    modelUsed: string;
    cacheHit: boolean;
    cacheLayer: string;
    retryCount: number;
    tokensConsumed: number;
    costUsd: number;
    usageEstimated: boolean;
    usedFallbackTemplate: boolean;
    scopeDiffReport: ScopeDiffReport;
    recognizedIntent: RecognizedStageIntent;
  }) {
    this.artifact = params.artifact;
    this.modelUsed = params.modelUsed;
    this.cacheHit = params.cacheHit;
    this.cacheLayer = params.cacheLayer;
    this.retryCount = params.retryCount;
    this.tokensConsumed = params.tokensConsumed;
    this.costUsd = params.costUsd;
    this.usageEstimated = params.usageEstimated;
    this.usedFallbackTemplate = params.usedFallbackTemplate;
    this.scopeDiffReport = params.scopeDiffReport;
    this.recognizedIntent = params.recognizedIntent;
  }
}

/**
 * 抽象职能 Agent 基类 (Template Method Pattern)
 */
export abstract class AbstractWorkerAgent<
  TArtifact extends IDomainArtifactContract = IDomainArtifactContract,
> {
  public readonly role: AgentRole;
  public readonly stageId: WorkflowStageId;
  public readonly modelTier: ModelRoutingTier;
  protected readonly eventBus: WorkflowEventBus;
  protected readonly cacheManager: PromptCacheManager;
  protected readonly fulfillmentTracker: IntentFulfillmentTracker;
  protected readonly modelRouter: ModelRouterGateway;
  protected readonly falseConsensusGuard: FalseConsensusGuard;
  protected readonly maxExecutionRetries: number;
  protected contextRegistry: ToolRegistry | null = null;
  /**
   * A4：按需求集合与回退指令签名隔离的 LLM 意图缓存
   * （同构需求跨 run 复用零额外 LLM 往返；不同业务提案互不串味，回落子类规则兜底）
   */
  private readonly llmIntentByScope = new Map<string, RecognizedStageIntent>();

  protected constructor(params: {
    role: AgentRole;
    stageId: WorkflowStageId;
    modelTier: ModelRoutingTier;
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
    maxExecutionRetries?: number;
  }) {
    this.role = params.role;
    this.stageId = params.stageId;
    this.modelTier = params.modelTier;
    this.eventBus = params.eventBus;
    this.cacheManager = params.cacheManager;
    this.fulfillmentTracker = params.fulfillmentTracker;
    this.modelRouter = params.modelRouter;
    this.falseConsensusGuard = params.falseConsensusGuard;
    this.maxExecutionRetries = params.maxExecutionRetries ?? 2;
  }

  /** C1：注入 ToolRegistry（外部知识预取） */
  public setContextRegistry(registry: ToolRegistry): void {
    this.contextRegistry = registry;
  }

  /**
   * 计算意图缓存的作用域签名（阶段 + 核心需求 ID/描述 + 回退指令），防止不同业务提案跨 run 污染意图
   */
  private buildIntentScopeSignature(context: AgentExecutionInputContext): string {
    const reqPart = Object.entries(context.proposal.requirementDescriptions)
      .sort(([idA], [idB]) => idA.localeCompare(idB))
      .map(([id, desc]) => `${id}:${desc.trim()}`)
      .join('|');
    const directive = (context.humanFeedbackDirective ?? '').trim();
    return `${this.stageId}::${reqPart}::${directive}`;
  }

  /**
   * A4：意图解析入口（同步签名，缓存键依赖）——优先复用同需求作用域下 LLM 顺带输出的 `__intent`，
   * 无匹配缓存/离线时回落到子类规则实现（M5 兜底）。
   */
  private resolveStageIntent(context: AgentExecutionInputContext): RecognizedStageIntent {
    const scopeKey = this.buildIntentScopeSignature(context);
    const cached = this.llmIntentByScope.get(scopeKey);
    if (cached) {
      return cached;
    }
    return this.recognizeStageIntent(context);
  }

  /**
   * A4：从 LLM 主输出的 JSON 顶层捕获 `__intent` 并按需求作用域缓存（校验失败静默忽略 → 继续用规则意图）。
   */
  private captureLlmIntent(
    raw: Record<string, unknown>,
    context: AgentExecutionInputContext,
  ): void {
    const intent = raw['__intent'] as
      { intentCode?: unknown; intentDescription?: unknown; confidenceScore?: unknown } | undefined;
    if (!intent || typeof intent.intentCode !== 'string' || intent.intentCode.trim().length === 0) {
      return;
    }
    const description =
      typeof intent.intentDescription === 'string' && intent.intentDescription.trim().length > 0
        ? intent.intentDescription.trim()
        : 'LLM 识别的阶段意图';
    const confidence =
      typeof intent.confidenceScore === 'number' &&
      intent.confidenceScore > 0 &&
      intent.confidenceScore <= 1
        ? intent.confidenceScore
        : 0.99;
    const scopeKey = this.buildIntentScopeSignature(context);
    this.llmIntentByScope.set(
      scopeKey,
      new RecognizedStageIntent(
        intent.intentCode.trim().slice(0, 64),
        description.slice(0, 120),
        confidence,
      ),
    );
  }

  /**
   * 【模板方法 (Template Method)】固化 Agent 7 步标准工作流（异步：LLM 调用为 IO）。
   */
  public async executeStagePipeline(
    context: AgentExecutionInputContext,
  ): Promise<AgentExecutionOutcome<TArtifact>> {
    const endpoint = this.modelRouter.resolveEndpoint(this.modelTier);
    const promptSpecHash = computePromptSpecHash(this.stageId);

    // 步骤 1 & 2：意图识别并向前端实时广播交互状态
    const recognizedIntent = this.resolveStageIntent(context);
    this.broadcastProgress(
      context,
      SnapshotLifecycleState.RECOGNIZING_INTENT,
      `[${this.role}] 正在识别阶段意图：${recognizedIntent.intentDescription} (置信度 ${(recognizedIntent.confidenceScore * 100).toFixed(0)}%)`,
      {
        intentCode: recognizedIntent.intentCode,
        historicalLessonsLoaded: context.historicalRejectionLessons.length,
      },
    );

    // 步骤 3：双层缓存检索（L1 精确签名 + L2 语义意图向量；Pillar 2 跨模型防质量倒挂 + 向量空间隔离）
    const exactKey = this.cacheManager.buildExactCacheKey({
      stageId: this.stageId,
      agentRole: this.role,
      proposalTitle: context.proposal.title,
      requirementIds: context.proposal.coreRequirementIds,
      feedbackInstruction: context.humanFeedbackDirective ?? undefined,
    });
    const semanticIntentText = this.cacheManager.buildSemanticIntentText({
      stageId: this.stageId,
      agentRole: this.role,
      intentDescription: recognizedIntent.intentDescription,
      requirementDescriptions: context.proposal.requirementDescriptions,
      feedbackInstruction: context.humanFeedbackDirective ?? undefined,
    });

    const cacheOutcome = await this.cacheManager.lookup<TArtifact>(exactKey, semanticIntentText, {
      minQualityRank: endpoint.capabilities.qualityRank,
      promptSpecHash,
      stageId: this.stageId,
    });
    if (cacheOutcome.isHit && cacheOutcome.cachedArtifact !== null) {
      this.broadcastProgress(
        context,
        SnapshotLifecycleState.CACHE_HIT,
        `[${this.role}] 命中 ${cacheOutcome.cacheLayer} 缓存！直接复用已校验契约产物，节省 ${cacheOutcome.savedTokensEstimate} Tokens`,
        {
          cacheLayer: cacheOutcome.cacheLayer,
          savedTokens: cacheOutcome.savedTokensEstimate,
        },
      );

      const scopeDiff = this.falseConsensusGuard.evaluateScopeIntegrity(
        context.proposal,
        cacheOutcome.cachedArtifact,
      );

      this.fulfillmentTracker.recordTrace(
        new IntentExecutionTraceRecord({
          traceId: `TRACE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          runId: context.runId,
          branchId: context.branchId,
          stageId: this.stageId,
          agentRole: this.role,
          recognizedIntentCode: recognizedIntent.intentCode,
          intentConfidence: recognizedIntent.confidenceScore,
          retryCount: 0,
          retryReasons: [],
          cacheHit: true,
          fulfillmentStatus: IntentFulfillmentStatus.FULFILLED_VIA_CACHE,
          tokensConsumed: 0,
          retryOverheadTokens: 0,
          costUsd: 0,
        }),
      );

      return new AgentExecutionOutcome<TArtifact>({
        artifact: cacheOutcome.cachedArtifact,
        modelUsed: `${endpoint.modelIdentifier} (${cacheOutcome.cacheLayer}_CACHE)`,
        cacheHit: true,
        cacheLayer: cacheOutcome.cacheLayer,
        retryCount: 0,
        tokensConsumed: 0,
        costUsd: 0,
        usageEstimated: false,
        usedFallbackTemplate: false,
        scopeDiffReport: scopeDiff,
        recognizedIntent,
      });
    }

    // 步骤 4：物理环境准备（Stage 3b Worktree 创建与自测 / Stage 4 真实沙箱验证）+ LLM 生成（含停滞检测与自动升舱）
    const stageEnvironment = this.prepareStageEnvironment(context);
    let activeTier: ModelRoutingTier = this.modelTier;
    let previousViolationSignature: string | null = null;
    let lastRawCandidate: Record<string, unknown> | null = null;
    let violations: string[] = [];
    let attemptIndex = 0;
    let retryCount = 0;
    const retryReasons: string[] = [];
    let totalTokensConsumed = 0;
    let retryOverheadTokens = 0;
    let totalCostUsd = 0;
    let usageEstimated = false;
    let usedFallbackTemplate = false;
    let candidate: TArtifact | null = null;

    while (attemptIndex <= this.maxExecutionRetries) {
      const isRetryAttempt = attemptIndex > 0;
      const activeEndpoint = this.modelRouter.resolveEndpoint(activeTier);
      let attemptUsedLiveGateway = false;

      // B3：预算守卫（每次 attempt 前检查；估算按输入长度保守估计）
      if (context.tokenBudgetRemaining >= 0) {
        const estimatedInputTokens = Math.ceil(this.estimatePromptChars(context, violations) / 1.5);
        const estimatedTotal = estimatedInputTokens + 400; // 400 = 输出保守余量
        if (estimatedTotal > context.tokenBudgetRemaining) {
          this.fulfillmentTracker.recordTrace(
            new IntentExecutionTraceRecord({
              traceId: `TRACE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              runId: context.runId,
              branchId: context.branchId,
              stageId: this.stageId,
              agentRole: this.role,
              recognizedIntentCode: recognizedIntent.intentCode,
              intentConfidence: recognizedIntent.confidenceScore,
              retryCount,
              retryReasons: [...retryReasons, 'TOKEN_BUDGET_EXCEEDED'],
              cacheHit: false,
              fulfillmentStatus: IntentFulfillmentStatus.FAILED_CONTRACT,
              tokensConsumed: totalTokensConsumed,
              retryOverheadTokens,
              costUsd: totalCostUsd,
            }),
          );
          throw new TokenBudgetExceededError(this.stageId, context.tokenBudgetRemaining);
        }
      }

      if (isRetryAttempt) {
        this.broadcastProgress(
          context,
          SnapshotLifecycleState.RETRYING,
          `[${this.role}] 执行第 ${attemptIndex}/${this.maxExecutionRetries} 次自愈重试（${activeEndpoint.modelIdentifier}）：修正契约违规...`,
          { attemptIndex, violations, activeTier },
        );
      } else {
        this.broadcastProgress(
          context,
          SnapshotLifecycleState.EXECUTING,
          `[${this.role}] 正在通过模型 [${activeEndpoint.modelIdentifier}] 生成结构化阶段契约...`,
          { model: activeEndpoint.modelIdentifier, tier: activeTier },
        );
      }

      // J1 演示开关：Stage 1 首次执行注入瞬态契约偏差，验证自愈重试（离线模板模式下有效）
      if (
        context.scenarioHints?.forceTransientRetry === true &&
        this.stageId === WorkflowStageId.STAGE_1_PM &&
        attemptIndex === 0
      ) {
        retryCount += 1;
        violations = ['首次生成 JSON 契约缺少必填验收字段，触发自动 Schema 修复重试'];
        retryReasons.push(...violations);
        attemptIndex += 1;
        continue;
      }

      try {
        const stageSpec = STAGE_PROMPT_SPECS[this.stageId];
        const prompt = this.buildStagePrompt(
          context,
          attemptIndex,
          violations,
          stageEnvironment,
          activeEndpoint.capabilities.preferFewShotExample,
          lastRawCandidate,
        );
        const llm = await this.modelRouter.invokeChatCompletion({
          tier: activeTier,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          fallbackContentGenerator: () =>
            JSON.stringify(this.synthesizeTemplateArtifact(context, attemptIndex)),
          jsonSchema: stageSpec?.jsonSchema
            ? {
                name: `${this.stageId.toLowerCase()}_contract`,
                schema: stageSpec.jsonSchema,
              }
            : undefined,
          temperature: activeEndpoint.capabilities.recommendedTemperature,
        });
        attemptUsedLiveGateway = llm.usedLiveGateway;
        totalTokensConsumed += llm.receipt.totalTokens;
        totalCostUsd += llm.receipt.estimatedCostUsd;
        usageEstimated = usageEstimated || llm.receipt.usageEstimated;
        usedFallbackTemplate = usedFallbackTemplate || !llm.usedLiveGateway;
        if (isRetryAttempt) {
          retryOverheadTokens += llm.receipt.totalTokens;
        }

        const extracted = JsonExtractor.extract(llm.content);
        if (!extracted.ok) {
          violations = [`OUTPUT_NOT_JSON: ${extracted.error ?? ''}`];
        } else {
          lastRawCandidate = extracted.value as Record<string, unknown>;
          // A4：先捕获 LLM 顺带输出的 __intent（工厂解析忽略未知字段，互不影响）
          this.captureLlmIntent(lastRawCandidate, context);
          const parsed = ArtifactContractFactory.parse(this.stageId, lastRawCandidate);
          if (!parsed.ok) {
            violations = [...parsed.violations];
          } else {
            const parsedCandidate = parsed.artifact as TArtifact;
            const validation = parsedCandidate.validateContractIntegrity();
            const postViolations = this.applyLlmPostProcessing(
              parsedCandidate,
              lastRawCandidate,
              context,
            );
            const stageViolations = this.validateStageSpecificConstraints(parsedCandidate, context);
            const allViolations = [
              ...validation.getViolations(),
              ...postViolations,
              ...stageViolations,
            ];
            if (
              validation.isValid() &&
              postViolations.length === 0 &&
              stageViolations.length === 0
            ) {
              candidate = parsedCandidate;
              violations = [];
              break;
            }
            violations = allViolations;
          }
        }
      } catch (err) {
        if (err instanceof TokenBudgetExceededError) {
          throw err; // 预算超限不重试（B3）
        }
        violations = [err instanceof Error ? err.message.slice(0, 200) : String(err)];
      }

      const normalizedSig = [...violations]
        .map((v) => v.trim())
        .sort()
        .join('||');
      retryReasons.push(...violations);
      retryCount += 1;

      if (
        normalizedSig.length > 0 &&
        previousViolationSignature !== null &&
        normalizedSig === previousViolationSignature
      ) {
        if (
          activeTier === ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL &&
          attemptUsedLiveGateway &&
          attemptIndex < this.maxExecutionRetries
        ) {
          activeTier = ModelRoutingTier.HIGH_REASONING_HYBRID;
          previousViolationSignature = null;
          retryReasons.push(
            'STAGNATION_MODEL_ESCALATED: 连续两轮触发相同契约违规，已自动升舱至高阶推理模型破局',
          );
          attemptIndex += 1;
          continue;
        }
        retryReasons.push(
          'STAGNATION_CIRCUIT_BREAKER: 连续两轮触发相同契约违规，提前熔断避免无效 Token 消耗',
        );
        break;
      }

      previousViolationSignature = normalizedSig;
      attemptIndex += 1;
    }

    if (candidate === null) {
      this.fulfillmentTracker.recordTrace(
        new IntentExecutionTraceRecord({
          traceId: `TRACE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          runId: context.runId,
          branchId: context.branchId,
          stageId: this.stageId,
          agentRole: this.role,
          recognizedIntentCode: recognizedIntent.intentCode,
          intentConfidence: recognizedIntent.confidenceScore,
          retryCount,
          retryReasons,
          cacheHit: false,
          fulfillmentStatus: IntentFulfillmentStatus.FAILED_CONTRACT,
          tokensConsumed: totalTokensConsumed,
          retryOverheadTokens,
          costUsd: totalCostUsd,
        }),
      );
      throw new StageContractError(this.stageId, retryReasons, retryCount);
    }

    // 步骤 5：防“虚假共识”与需求范围缩减校验（演示开关走 ScenarioHints，J1）
    const scopeDiffReport = this.falseConsensusGuard.evaluateScopeIntegrity(
      context.proposal,
      candidate,
    );
    const finalEndpoint = this.modelRouter.resolveEndpoint(activeTier);

    // 步骤 6：若未发生非法范围阉割，则将合格契约产物写入双层缓存（带模型等级与 Prompt 版本元数据）
    if (!scopeDiffReport.hasUnauthorizedScopeReduction) {
      await this.cacheManager.storeVerifiedArtifact({
        exactKey,
        semanticIntentText,
        artifact: candidate,
        estimatedTokens: totalTokensConsumed - retryOverheadTokens,
        estimatedCostUsd: totalCostUsd,
        modelQualityRank: finalEndpoint.capabilities.qualityRank,
        modelIdentifier: finalEndpoint.modelIdentifier,
        promptSpecHash,
        stageId: this.stageId,
      });
    }

    // 步骤 7：记录意图达成率与重试次数遥测指标
    const fulfillmentStatus =
      retryCount === 0
        ? IntentFulfillmentStatus.FULFILLED_ON_FIRST_TRY
        : IntentFulfillmentStatus.FULFILLED_AFTER_RETRY;

    this.fulfillmentTracker.recordTrace(
      new IntentExecutionTraceRecord({
        traceId: `TRACE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        runId: context.runId,
        branchId: context.branchId,
        stageId: this.stageId,
        agentRole: this.role,
        recognizedIntentCode: recognizedIntent.intentCode,
        intentConfidence: recognizedIntent.confidenceScore,
        retryCount,
        retryReasons,
        cacheHit: false,
        fulfillmentStatus,
        tokensConsumed: totalTokensConsumed,
        retryOverheadTokens,
        costUsd: totalCostUsd,
      }),
    );

    return new AgentExecutionOutcome<TArtifact>({
      artifact: candidate,
      modelUsed: finalEndpoint.modelIdentifier,
      cacheHit: false,
      cacheLayer: 'MISS',
      retryCount,
      tokensConsumed: totalTokensConsumed,
      costUsd: Number(totalCostUsd.toFixed(6)),
      usageEstimated,
      usedFallbackTemplate,
      scopeDiffReport,
      recognizedIntent,
    });
  }

  protected broadcastProgress(
    context: AgentExecutionInputContext,
    state: SnapshotLifecycleState,
    headline: string,
    detailPayload?: Record<string, unknown>,
  ): void {
    this.eventBus.publishEvent(
      new WorkflowDomainEvent({
        eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        runId: context.runId,
        branchId: context.branchId,
        stageId: this.stageId,
        agentRole: this.role,
        lifecycleState: state,
        headline,
        detailPayload,
      }),
    );
  }

  /**
   * 组装阶段 Prompt（A1 改进版）：
   * 1. 上游产物走 UpstreamCompressor 压缩（省 Token：只发关键决策字段，不发全文）
   * 2. 外部上下文走 ToolRegistry 预取（Agent 可看到代码结构/DB Schema/组件清单等外部知识）
   * 3. rejectionLessons / humanDirective 保持不变
   */
  protected buildStagePrompt(
    context: AgentExecutionInputContext,
    attemptIndex: number,
    violations: ReadonlyArray<string>,
    stageEnvironment?: Record<string, unknown> | null,
    includeCompactExample = false,
    previousCandidate?: Record<string, unknown> | null,
  ): { systemPrompt: string; userPrompt: string } {
    const spec = STAGE_PROMPT_SPECS[this.stageId] ?? {
      systemPrompt: `你是研发流水线职能 Agent（${this.role}）。仅输出一个 JSON 对象。`,
      taskInstruction: '依据输入的结构化上下文完成本阶段契约产出。',
      jsonSchemaHint: '输出 JSON 需包含 summary 与 coreRequirementIds 字段。',
    };

    // 省 Token：上游产物压缩（关键决策字段而非全文）
    const compressor = new UpstreamCompressor();
    const upstreamDigests = compressor.compress(
      [...context.upstreamArtifacts.entries()].map(([stageId, artifact]) => ({
        stageId,
        artifact,
      })),
    );

    // 外部上下文注入（P1-3：优先消费 Facade 经 ContextBudgetTrimmer 裁剪后的 trimmedExternalContext；无注入时回落 runCache）
    const staticNeeds = STAGE_CONTEXT_NEEDS[this.stageId] ?? [];
    const seenTypes = new Set(staticNeeds.map((n) => n.type));
    const dynamicExtras = context.dynamicContextNeeds.filter((n) => !seenTypes.has(n.type));
    const contextNeeds: ReadonlyArray<ContextNeed> = [...staticNeeds, ...dynamicExtras];
    let externalContexts: Array<{ type: string; content: string; source: string }>;
    let contextBudgetSummary:
      | { totalTokens: number; truncated: ReadonlyArray<{ type: string; reason: string }> }
      | undefined;

    if (context.trimmedExternalContext !== null) {
      externalContexts = context.trimmedExternalContext.included
        .filter((item) => item.result !== null)
        .map((item) => ({
          type: item.need.type,
          content: item.result!.content,
          source: item.result!.source,
        }));
      if (context.trimmedExternalContext.truncated.length > 0) {
        contextBudgetSummary = {
          totalTokens: context.trimmedExternalContext.totalTokens,
          truncated: context.trimmedExternalContext.truncated,
        };
      }
    } else {
      externalContexts = contextNeeds
        .map((need) => {
          const cachedResult = this.contextRegistry?.getCached(
            context.runId,
            need.type,
            this.stageId,
          );
          if (cachedResult) {
            return { type: need.type, content: cachedResult.content, source: cachedResult.source };
          }
          return null;
        })
        .filter((c): c is { type: string; content: string; source: string } => c !== null);
    }

    const repairMode = attemptIndex > 0 && previousCandidate ? 'TARGETED_PATCH' : undefined;
    const previousValidKeys =
      repairMode === 'TARGETED_PATCH' && previousCandidate
        ? Object.keys(previousCandidate).filter((k) => k !== '__intent')
        : undefined;

    const payload = {
      task: spec.taskInstruction,
      proposal: context.proposal.toSerializableRecord(),
      upstreamDigests, // 压缩后的上游摘要（非全文）
      externalContext: externalContexts.length > 0 ? externalContexts : undefined,
      contextBudgetSummary,
      sandboxVerification: stageEnvironment ?? undefined,
      rejectionLessons: context.historicalRejectionLessons.slice(0, 5),
      humanDirective: context.humanFeedbackDirective,
      attemptIndex,
      priorViolations: violations.slice(0, 5),
      repairMode,
      previousValidKeys,
    };

    const exampleSegment =
      includeCompactExample && attemptIndex === 0 && spec.compactExampleJson
        ? `\n\n标准参考样例（仅格式锚点，内容须严格依据输入重新生成）：\n${spec.compactExampleJson}`
        : '';
    const patchSegment =
      repairMode === 'TARGETED_PATCH'
        ? '\n\n注意：当前为靶向局部修复模式（TARGETED_PATCH），请尽量保留 previousValidKeys 中已合法字段，仅针对 priorViolations 中列出的违规字段做局部修正。'
        : '';

    return {
      systemPrompt: spec.systemPrompt,
      userPrompt: `${spec.jsonSchemaHint}${exampleSegment}${patchSegment}\n\n另外必须在 JSON 顶层包含 "__intent" 字段：{ "intentCode": "稳定的英文大写下划线意图编码", "intentDescription": "一句话中文意图描述", "confidenceScore": 0到1之间的小数 }。\n\n以下为本阶段的全部结构化输入（JSON）：\n${JSON.stringify(payload)}`,
    };
  }

  /** 降级/预算估算用：粗估 prompt 字符量 */
  private estimatePromptChars(
    context: AgentExecutionInputContext,
    violations: ReadonlyArray<string>,
  ): number {
    return (
      JSON.stringify(context.proposal.toSerializableRecord()).length +
      [...context.upstreamArtifacts.values()].reduce(
        (acc, a) => acc + JSON.stringify(a).length,
        0,
      ) +
      violations.join('').length +
      (context.humanFeedbackDirective?.length ?? 0)
    );
  }

  /**
   * 子类钩子（可选）：在进入 LLM 推理/降级模板前执行物理环境准备（如 Stage 3b 创建真实 Git Worktree 沙箱并自测、
   * Stage 4 执行真实沙箱 node:test / Docker 验证），返回的数据将注入 buildStagePrompt 的 sandboxVerification 字段，
   * 并供 synthesizeTemplateArtifact 复用（避免离线降级时重复执行子进程）。
   */
  protected prepareStageEnvironment(
    _context: AgentExecutionInputContext,
  ): Record<string, unknown> | null {
    return null;
  }

  /**
   * P0-4：为多 run 并发隔离构造阶段准备缓存键（runId + branchId + humanFeedbackDirective）
   */
  protected buildPreparedContextKey(context: AgentExecutionInputContext): string {
    return `${context.runId}::${context.branchId}::${context.humanFeedbackDirective ?? ''}`;
  }

  /**
   * P0-4：有界 Map 写入辅助（避免并发执行多 run 时以单实例字段互相覆盖或无限增长）
   */
  protected saveBoundedPreparedState<TValue>(
    store: Map<string, TValue>,
    key: string,
    value: TValue,
    maxEntries = 64,
  ): TValue {
    if (store.has(key)) {
      store.delete(key);
    }
    store.set(key, value);
    while (store.size > maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      store.delete(oldestKey);
    }
    return value;
  }

  /**
   * 子类钩子（可选）：在 LLM 输出解析完成后执行后置副作用（如 Stage 3b 将 `filePatches` 写入 Worktree 并重跑自测），
   * 返回违规描述数组（空数组 = 后置处理通过）。
   */
  protected applyLlmPostProcessing(
    _candidate: TArtifact,
    _rawCandidate: Record<string, unknown>,
    _context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    return [];
  }

  /**
   * 子类钩子（可选）：针对特定阶段的物理环境真实性交叉校验（如 QA/Engineer 阶段核对 LLM 产出的通过状态与真实沙箱结果是否矛盾）。
   * 返回违规描述数组（空数组 = 校验通过）。
   */
  protected validateStageSpecificConstraints(
    _candidate: TArtifact,
    _context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    return [];
  }

  /**
   * 子类钩子 1：识别当前阶段的专业意图编码与描述（A4 计划 LLM 化）
   */
  protected abstract recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent;

  /**
   * 子类钩子 2：离线降级模板产物（D-2）。LLM 在线时不再走此路径；
   * 保留理由：断网/无 Key 的单机演示与测试确定性。
   */
  protected abstract synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    attemptIndex: number,
  ): TArtifact;
}
