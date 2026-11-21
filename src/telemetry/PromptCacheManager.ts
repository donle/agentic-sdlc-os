/**
 * @file PromptCacheManager.ts
 * @description 面向成本控制的双层缓存管理器（L1 精确上下文签名缓存 + L2 归一化语义意图指纹缓存）。
 *
 * 复盘核心指标 (a)：缓存命中率 (Cache Hit Rate)
 * - 当相同或语义等价的阶段上下文 + 角色意图再次请求时，直接命中缓存返回结构化契约产物，实现零 Token 消耗。
 * - 实时统计：总检索次数、L1 精确命中数、L2 语义命中数、未命中数、累计节省 Tokens 与累计节省成本（USD）。
 */

import type { IDomainArtifactContract } from '../domain/contracts.ts';
import { AgentRole, WorkflowStageId } from '../domain/enums.ts';

export class CacheLookupOutcome<T extends IDomainArtifactContract = IDomainArtifactContract> {
  public readonly isHit: boolean;
  public readonly cacheLayer: 'L1_EXACT' | 'L2_SEMANTIC_INTENT' | 'MISS';
  public readonly cachedArtifact: T | null;
  public readonly savedTokensEstimate: number;

  public constructor(params: {
    isHit: boolean;
    cacheLayer: 'L1_EXACT' | 'L2_SEMANTIC_INTENT' | 'MISS';
    cachedArtifact: T | null;
    savedTokensEstimate: number;
  }) {
    this.isHit = params.isHit;
    this.cacheLayer = params.cacheLayer;
    this.cachedArtifact = params.cachedArtifact;
    this.savedTokensEstimate = params.savedTokensEstimate;
  }
}

export class CacheTelemetrySnapshot {
  public readonly totalLookups: number;
  public readonly l1ExactHits: number;
  public readonly l2SemanticHits: number;
  public readonly totalHits: number;
  public readonly cacheMisses: number;
  public readonly cacheHitRatePercent: number;
  public readonly savedTokensTotal: number;
  public readonly savedCostUsdTotal: number;

  public constructor(params: {
    totalLookups: number;
    l1ExactHits: number;
    l2SemanticHits: number;
    cacheMisses: number;
    savedTokensTotal: number;
    savedCostUsdTotal: number;
  }) {
    this.totalLookups = params.totalLookups;
    this.l1ExactHits = params.l1ExactHits;
    this.l2SemanticHits = params.l2SemanticHits;
    this.totalHits = params.l1ExactHits + params.l2SemanticHits;
    this.cacheMisses = params.cacheMisses;
    this.cacheHitRatePercent =
      params.totalLookups === 0
        ? 0
        : Number(((this.totalHits / params.totalLookups) * 100).toFixed(2));
    this.savedTokensTotal = params.savedTokensTotal;
    this.savedCostUsdTotal = Number(params.savedCostUsdTotal.toFixed(6));
  }
}

interface CacheEntryRecord {
  readonly artifact: IDomainArtifactContract;
  readonly estimatedTokens: number;
  readonly estimatedCostUsd: number;
}

export class PromptCacheManager {
  private readonly l1ExactStore: Map<string, CacheEntryRecord>;
  private readonly l2SemanticIntentStore: Map<string, CacheEntryRecord>;
  private totalLookups = 0;
  private l1ExactHits = 0;
  private l2SemanticHits = 0;
  private cacheMisses = 0;
  private savedTokensTotal = 0;
  private savedCostUsdTotal = 0;
  private readonly cacheEnabled: boolean;

  public constructor(cacheEnabled = true) {
    this.l1ExactStore = new Map<string, CacheEntryRecord>();
    this.l2SemanticIntentStore = new Map<string, CacheEntryRecord>();
    this.cacheEnabled = cacheEnabled;
  }

  /**
   * 生成 L1 精确缓存键（包含阶段、Agent 角色、完整提案标识与需求列表、负向经验约束）
   */
  public buildExactCacheKey(params: {
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    proposalTitle: string;
    requirementIds: ReadonlyArray<string>;
    feedbackInstruction?: string;
  }): string {
    const reqPart = [...params.requirementIds].sort().join('|');
    const feedbackPart = (params.feedbackInstruction ?? 'NONE').trim();
    return `L1::${params.stageId}::${params.agentRole}::${params.proposalTitle.trim()}::${reqPart}::${feedbackPart}`;
  }

  /**
   * 生成 L2 归一化语义意图缓存键（忽略标点、空格与非关键修饰词，按核心意图与需求指纹匹配）
   */
  public buildSemanticIntentKey(params: {
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    intentCode: string;
    requirementIds: ReadonlyArray<string>;
    feedbackInstruction?: string;
  }): string {
    const normalizedReq = [...params.requirementIds]
      .map((id) => id.trim().toUpperCase())
      .sort()
      .join('|');
    const normalizedFeedback = (params.feedbackInstruction ?? 'NONE')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
    return `L2::${params.stageId}::${params.agentRole}::${params.intentCode}::${normalizedReq}::${normalizedFeedback}`;
  }

  /**
   * 检索双层缓存并自动记账
   */
  public lookup<T extends IDomainArtifactContract>(
    exactKey: string,
    semanticKey: string,
  ): CacheLookupOutcome<T> {
    this.totalLookups += 1;

    if (!this.cacheEnabled) {
      this.cacheMisses += 1;
      return new CacheLookupOutcome<T>({
        isHit: false,
        cacheLayer: 'MISS',
        cachedArtifact: null,
        savedTokensEstimate: 0,
      });
    }

    const l1Match = this.l1ExactStore.get(exactKey);
    if (l1Match) {
      this.l1ExactHits += 1;
      this.savedTokensTotal += l1Match.estimatedTokens;
      this.savedCostUsdTotal += l1Match.estimatedCostUsd;
      return new CacheLookupOutcome<T>({
        isHit: true,
        cacheLayer: 'L1_EXACT',
        cachedArtifact: l1Match.artifact as T,
        savedTokensEstimate: l1Match.estimatedTokens,
      });
    }

    const l2Match = this.l2SemanticIntentStore.get(semanticKey);
    if (l2Match) {
      this.l2SemanticHits += 1;
      this.savedTokensTotal += l2Match.estimatedTokens;
      this.savedCostUsdTotal += l2Match.estimatedCostUsd;
      return new CacheLookupOutcome<T>({
        isHit: true,
        cacheLayer: 'L2_SEMANTIC_INTENT',
        cachedArtifact: l2Match.artifact as T,
        savedTokensEstimate: l2Match.estimatedTokens,
      });
    }

    this.cacheMisses += 1;
    return new CacheLookupOutcome<T>({
      isHit: false,
      cacheLayer: 'MISS',
      cachedArtifact: null,
      savedTokensEstimate: 0,
    });
  }

  /**
   * 将经过契约校验的优质 Agent 交付物写入 L1 与 L2 缓存
   */
  public storeVerifiedArtifact(params: {
    exactKey: string;
    semanticKey: string;
    artifact: IDomainArtifactContract;
    estimatedTokens: number;
    estimatedCostUsd: number;
  }): void {
    if (!this.cacheEnabled) {
      return;
    }
    const entry: CacheEntryRecord = {
      artifact: params.artifact,
      estimatedTokens: params.estimatedTokens,
      estimatedCostUsd: params.estimatedCostUsd,
    };
    this.l1ExactStore.set(params.exactKey, entry);
    this.l2SemanticIntentStore.set(params.semanticKey, entry);
  }

  public getMetricsSnapshot(): CacheTelemetrySnapshot {
    return new CacheTelemetrySnapshot({
      totalLookups: this.totalLookups,
      l1ExactHits: this.l1ExactHits,
      l2SemanticHits: this.l2SemanticHits,
      cacheMisses: this.cacheMisses,
      savedTokensTotal: this.savedTokensTotal,
      savedCostUsdTotal: this.savedCostUsdTotal,
    });
  }
}
