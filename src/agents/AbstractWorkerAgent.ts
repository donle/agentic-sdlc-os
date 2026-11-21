/**
 * @file AbstractWorkerAgent.ts
 * @description 抽象职能 Agent 基类 —— 采用【模板方法模式 (Template Method Pattern)】定义所有专业 Agent 的统一执行骨架。
 *
 * ============================================================================
 * 【Agent 模块核心工作流程详细说明 (7-Step Lifecycle)】
 * ============================================================================
 * 任何一个专业职能 Agent（PM / PD / TechLead / Engineer / QA / DA）在被状态机调度时，
 * 严禁直接裸调大模型或跳过校验，必须严格执行本基类固化在 `executeStagePipeline()` 中的 7 个标准步骤：
 *
 *   [步骤 1] 上下文组装与负向经验注入 (Context Assembly & Negative RAG)
 *            - 读取上游已批准快照的交付物契约 (Upstream Artifacts)
 *            - 从审计账本检索历史上人类驳回同类方案的批注 (Rejected History Lessons)，防止重犯
 *
 *   [步骤 2] 意图识别与目标对齐 (Intent Recognition & Alignment)
 *            - 调用子类 `recognizeStageIntent()` 解析本次任务的具体工程意图与置信度
 *            - 通过 EventBus 向前端实时广播 `RECOGNIZING_INTENT` 状态，让用户看到 AI 当前正在识别什么意图
 *
 *   [步骤 3] 双层缓存前置拦截 (Two-Tier Cache Lookup — 成本控制第一道防线)
 *            - 计算 L1 精确上下文签名与 L2 归一化语义意图指纹
 *            - 查询 `PromptCacheManager`：若命中缓存，立即广播 `CACHE_HIT` 状态，零 Token 返回产物，
 *              并在复盘追踪器记为 `FULFILLED_VIA_CACHE`
 *
 *   [步骤 4] 混合模型路由与自愈重试循环 (BYOM Routing & Self-Healing Retry Loop)
 *            - 根据该 Agent 绑定的 `ModelRoutingTier`（本地私有模型 vs 高阶推理模型）选择推理端点
 *            - 调用子类 `synthesizeArtifact()` 生成结构化领域契约对象 (`IDomainArtifactContract`)
 *            - 执行契约完整性自检 (`validateContractIntegrity()`)：
 *              若校验失败或触发模拟瞬态异常，且未超过 `maxExecutionRetries` 上限，
 *              则递增 `retryCount`，向前端广播 `RETRYING` 状态，附带自愈修正提示词重新执行
 *
 *   [步骤 5] 防“虚假共识”与需求范围篡改校验 (False Consensus & Scope Diff Guard)
 *            - 调用 `FalseConsensusGuard` 比对原始提案的 `coreRequirementIds` 与当前交付物的需求列表
 *            - 若发现 Agent 在协商或生成中擅自砍掉了原始核心需求，立即生成 `ScopeDiffReport` 告警
 *
 *   [步骤 6] 优质契约产物缓存回填 (Verified Artifact Cache Write-Back)
 *            - 若契约完整性通过且无未授权范围篡改，将产物回填至 L1 与 L2 缓存池，供后续分支回退或相似需求复用
 *
 *   [步骤 7] 复盘遥测与成本记账上报 (Telemetry & Intent Fulfillment Recording)
 *            - 将本次调用的 `recognizedIntentCode`、`retryCount`、`cacheHit`、`tokensConsumed`、`costUsd`
 *              以及最终达成状态 (`FULFILLED_ON_FIRST_TRY` / `FULFILLED_AFTER_RETRY` / `FAILED_CONTRACT`)
 *              写入 `IntentFulfillmentTracker`，支撑自动化复盘任务。
 * ============================================================================
 */

import { type IDomainArtifactContract, ProjectProposalContract } from '../domain/contracts.ts';
import {
  AgentRole,
  IntentFulfillmentStatus,
  ModelRoutingTier,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../domain/enums.ts';
import { ScopeDiffReport } from '../domain/models.ts';
import { WorkflowDomainEvent, WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import {
  IntentExecutionTraceRecord,
  IntentFulfillmentTracker,
} from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';

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
  public readonly forceTransientRetryOnce: boolean;

  public constructor(params: {
    runId: string;
    branchId: string;
    proposal: ProjectProposalContract;
    upstreamArtifacts: ReadonlyMap<WorkflowStageId, IDomainArtifactContract>;
    historicalRejectionLessons?: ReadonlyArray<string>;
    humanFeedbackDirective?: string | null;
    forceTransientRetryOnce?: boolean;
  }) {
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.proposal = params.proposal;
    this.upstreamArtifacts = params.upstreamArtifacts;
    this.historicalRejectionLessons = params.historicalRejectionLessons
      ? [...params.historicalRejectionLessons]
      : [];
    this.humanFeedbackDirective = params.humanFeedbackDirective ?? null;
    this.forceTransientRetryOnce = Boolean(params.forceTransientRetryOnce);
  }
}

/**
 * 意图识别结果值对象
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

  /**
   * 【模板方法 (Template Method)】
   * 固化 Agent 7 步标准工作流，子类不得覆盖本方法，仅实现受保护的钩子方法。
   */
  public executeStagePipeline(
    context: AgentExecutionInputContext,
  ): AgentExecutionOutcome<TArtifact> {
    const endpoint = this.modelRouter.resolveEndpoint(this.modelTier);

    // 步骤 1 & 2：意图识别并向前端实时广播交互状态
    const recognizedIntent = this.recognizeStageIntent(context);
    this.broadcastProgress(
      context,
      SnapshotLifecycleState.RECOGNIZING_INTENT,
      `[${this.role}] 正在识别阶段意图：${recognizedIntent.intentDescription} (置信度 ${(recognizedIntent.confidenceScore * 100).toFixed(0)}%)`,
      {
        intentCode: recognizedIntent.intentCode,
        historicalLessonsLoaded: context.historicalRejectionLessons.length,
      },
    );

    // 步骤 3：双层缓存检索（L1 精确签名 + L2 语义意图指纹）
    const exactKey = this.cacheManager.buildExactCacheKey({
      stageId: this.stageId,
      agentRole: this.role,
      proposalTitle: context.proposal.title,
      requirementIds: context.proposal.coreRequirementIds,
      feedbackInstruction: context.humanFeedbackDirective ?? undefined,
    });
    const semanticKey = this.cacheManager.buildSemanticIntentKey({
      stageId: this.stageId,
      agentRole: this.role,
      intentCode: recognizedIntent.intentCode,
      requirementIds: context.proposal.coreRequirementIds,
      feedbackInstruction: context.humanFeedbackDirective ?? undefined,
    });

    const cacheOutcome = this.cacheManager.lookup<TArtifact>(exactKey, semanticKey);
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
        scopeDiffReport: scopeDiff,
        recognizedIntent,
      });
    }

    // 步骤 4：未命中缓存，进入模型路由调用与自愈重试循环
    let attemptIndex = 0;
    let retryCount = 0;
    const retryReasons: string[] = [];
    let totalTokensConsumed = 0;
    let retryOverheadTokens = 0;
    let totalCostUsd = 0;
    let synthesizedArtifact: TArtifact | null = null;

    while (attemptIndex <= this.maxExecutionRetries) {
      const isRetryAttempt = attemptIndex > 0;
      if (isRetryAttempt) {
        this.broadcastProgress(
          context,
          SnapshotLifecycleState.RETRYING,
          `[${this.role}] 执行第 ${attemptIndex}/${this.maxExecutionRetries} 次自愈重试：修正契约 Schema 约束...`,
          { attemptIndex, retryReasons },
        );
      } else {
        this.broadcastProgress(
          context,
          SnapshotLifecycleState.EXECUTING,
          `[${this.role}] 正在通过模型 [${endpoint.modelIdentifier}] 生成结构化阶段契约...`,
          { model: endpoint.modelIdentifier, tier: this.modelTier },
        );
      }

      const tokenEstimate = this.estimateTokenUsage(context, attemptIndex);
      const receipt = this.modelRouter.MeterInvocation(
        this.modelTier,
        tokenEstimate.promptTokens,
        tokenEstimate.completionTokens,
      );
      totalTokensConsumed += receipt.totalTokens;
      totalCostUsd += receipt.estimatedCostUsd;
      if (isRetryAttempt) {
        retryOverheadTokens += receipt.totalTokens;
      }

      // 若外部注入了“模拟首次瞬态契约格式偏差”以测试重试自愈能力
      if (context.forceTransientRetryOnce && attemptIndex === 0) {
        retryCount += 1;
        retryReasons.push('首次生成 JSON 契约缺少必填验收字段，触发自动 Schema 修复重试');
        attemptIndex += 1;
        continue;
      }

      const candidate = this.synthesizeArtifact(context, attemptIndex);
      const validation = candidate.validateContractIntegrity();

      if (validation.isValid()) {
        synthesizedArtifact = candidate;
        break;
      }

      retryCount += 1;
      retryReasons.push(validation.getViolations().join('; '));
      attemptIndex += 1;
    }

    if (synthesizedArtifact === null) {
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
      throw new Error(
        `[${this.role}] 在重试 ${retryCount} 次后仍未通过阶段契约校验：${retryReasons.join(' | ')}`,
      );
    }

    // 步骤 5：防“虚假共识”与需求范围缩减校验
    const scopeDiffReport = this.falseConsensusGuard.evaluateScopeIntegrity(
      context.proposal,
      synthesizedArtifact,
    );

    // 步骤 6：若未发生非法范围阉割，则将合格契约产物写入双层缓存
    if (!scopeDiffReport.hasUnauthorizedScopeReduction) {
      this.cacheManager.storeVerifiedArtifact({
        exactKey,
        semanticKey,
        artifact: synthesizedArtifact,
        estimatedTokens: totalTokensConsumed - retryOverheadTokens,
        estimatedCostUsd: totalCostUsd,
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
      artifact: synthesizedArtifact,
      modelUsed: endpoint.modelIdentifier,
      cacheHit: false,
      cacheLayer: 'MISS',
      retryCount,
      tokensConsumed: totalTokensConsumed,
      costUsd: Number(totalCostUsd.toFixed(6)),
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
   * 子类钩子 1：识别当前阶段的专业意图编码与描述
   */
  protected abstract recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent;

  /**
   * 子类钩子 2：执行该职能角色的核心契约构建逻辑
   */
  protected abstract synthesizeArtifact(
    context: AgentExecutionInputContext,
    attemptIndex: number,
  ): TArtifact;

  /**
   * 子类钩子 3：估算该角色的 Prompt 与 Completion Token 消耗
   */
  protected abstract estimateTokenUsage(
    context: AgentExecutionInputContext,
    attemptIndex: number,
  ): { promptTokens: number; completionTokens: number };
}
