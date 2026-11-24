/**
 * @file PromptCacheManager.ts
 * @description 面向成本控制的双层缓存管理器（L1 精确上下文签名缓存 + L2 语义意图向量缓存）。
 *
 * 复盘核心指标 (a)：缓存命中率 (Cache Hit Rate)
 * - 当相同或语义等价的阶段上下文 + 角色意图再次请求时，直接命中缓存返回结构化契约产物，实现零 Token 消耗。
 * - 实时统计：总检索次数、L1 精确命中数、L2 语义命中数、未命中数、累计节省 Tokens 与累计节省成本（USD）。
 *
 * G1 改造（BACKEND_TODO_DESIGN）：L2 命中从"归一化键相等"改为"意图文本 embedding 余弦 ≥
 * SEMANTIC_CACHE_THRESHOLD(0.86)"——相同需求条数但语义不同的意图不再误命中，措辞不同的相似意图不再漏命中。
 * D-2 边界：embedding 端点不可用（embed 返回 null）→ 本次检索仅走 L1，记账 embeddingUnavailable。
 */

import type { IDomainArtifactContract } from '../domain/contracts.ts';
import { AgentRole, WorkflowStageId } from '../domain/enums.ts';
import type { EmbeddingProvider } from './EmbeddingProvider.ts';
import { cosineSimilarity } from './EmbeddingProvider.ts';

/** L2 语义命中的最低余弦相似度（设计定稿 0.86；可用环境变量 SEMANTIC_CACHE_THRESHOLD 调参） */
export const SEMANTIC_CACHE_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? 0.86);

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

export interface CacheLookupOptions {
  /** 请求方模型最低能力等级：拒绝命中低排名模型产出的缓存（防质量倒挂） */
  readonly minQualityRank?: number;
  /** 当前阶段 Prompt 规格摘要：模板升级后自动隔离旧缓存 */
  readonly promptSpecHash?: string;
  /** 所属阶段 ID：防止跨阶段语义误命中 */
  readonly stageId?: WorkflowStageId;
}

export interface PersistedCacheTelemetrySnapshot {
  readonly totalLookups: number;
  readonly l1ExactHits: number;
  readonly l2SemanticHits: number;
  readonly cacheMisses: number;
  readonly savedTokensTotal: number;
  readonly savedCostUsdTotal: number;
  readonly embeddingUnavailableLookups?: number;
  readonly qualityUpgradeBypasses?: number;
  readonly crossSpaceSkips?: number;
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
  /** G1：embedding 端点不可用导致的 L2 降级检索次数（诚实口径） */
  public readonly embeddingUnavailableLookups: number;
  /** Pillar 2：因当前请求模型质量等级高于缓存条目而绕过的次数（防弱模型污染强模型） */
  public readonly qualityUpgradeBypasses: number;
  /** Pillar 2：因 Embedding 向量空间 / Prompt 版本 / 阶段不一致而跳过的条目数 */
  public readonly crossSpaceSkips: number;

  public constructor(params: {
    totalLookups: number;
    l1ExactHits: number;
    l2SemanticHits: number;
    cacheMisses: number;
    savedTokensTotal: number;
    savedCostUsdTotal: number;
    embeddingUnavailableLookups?: number;
    qualityUpgradeBypasses?: number;
    crossSpaceSkips?: number;
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
    this.embeddingUnavailableLookups = params.embeddingUnavailableLookups ?? 0;
    this.qualityUpgradeBypasses = params.qualityUpgradeBypasses ?? 0;
    this.crossSpaceSkips = params.crossSpaceSkips ?? 0;
  }
}

interface CacheEntryRecord {
  readonly artifact: IDomainArtifactContract;
  readonly estimatedTokens: number;
  readonly estimatedCostUsd: number;
  readonly modelQualityRank: number;
  readonly modelIdentifier?: string;
  readonly promptSpecHash?: string;
}

/** L2 语义条目：意图文本 + 所属向量空间 + 向量（embedding 失败时不产生条目） */
interface L2SemanticEntry {
  readonly intentText: string;
  readonly embedding: ReadonlyArray<number>;
  readonly embeddingSpaceId: string;
  readonly stageId?: WorkflowStageId;
  readonly entry: CacheEntryRecord;
}

export class PromptCacheManager {
  private readonly l1ExactStore: Map<string, CacheEntryRecord>;
  private readonly l2SemanticEntries: L2SemanticEntry[];
  private totalLookups = 0;
  private l1ExactHits = 0;
  private l2SemanticHits = 0;
  private cacheMisses = 0;
  private embeddingUnavailableLookups = 0;
  private qualityUpgradeBypasses = 0;
  private crossSpaceSkips = 0;
  private savedTokensTotal = 0;
  private savedCostUsdTotal = 0;
  private readonly cacheEnabled: boolean;
  private readonly embeddingProvider: EmbeddingProvider | null;

  public constructor(cacheEnabled = true, embeddingProvider?: EmbeddingProvider | null) {
    this.l1ExactStore = new Map<string, CacheEntryRecord>();
    this.l2SemanticEntries = [];
    this.cacheEnabled = cacheEnabled;
    this.embeddingProvider = embeddingProvider ?? null;
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
   * G1：生成用于 embedding 的自然语言意图文本。
   * 关键改进：包含需求**描述**（而非仅 ID）——"相同条数、不同语义"的需求列表产生不同向量，
   * "措辞不同、语义相同"的意图产生相近向量。
   */
  public buildSemanticIntentText(params: {
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    intentDescription: string;
    requirementDescriptions: Readonly<Record<string, string>>;
    feedbackInstruction?: string;
  }): string {
    const requirements = Object.entries(params.requirementDescriptions)
      .sort(([idA], [idB]) => idA.localeCompare(idB))
      .map(([id, desc]) => `${id}: ${desc}`)
      .join('；');
    const directive = (params.feedbackInstruction ?? '').trim();
    return [
      `阶段 ${params.stageId}`,
      `角色 ${params.agentRole}`,
      `意图 ${params.intentDescription}`,
      requirements ? `需求 ${requirements}` : '需求 无',
      directive ? `回退指令 ${directive}` : '回退指令 无',
    ].join(' | ');
  }

  /**
   * 检索双层缓存并自动记账（G1/Pillar 2：跨模型防质量倒挂 + Embedding 空间与 Prompt 版本隔离）
   */
  public async lookup<T extends IDomainArtifactContract>(
    exactKey: string,
    semanticIntentText: string,
    options?: CacheLookupOptions,
  ): Promise<CacheLookupOutcome<T>> {
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
      if (options?.promptSpecHash && l1Match.promptSpecHash !== options.promptSpecHash) {
        this.crossSpaceSkips += 1;
      } else if (
        options?.minQualityRank !== undefined &&
        l1Match.modelQualityRank < options.minQualityRank
      ) {
        this.qualityUpgradeBypasses += 1;
      } else {
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
    }

    // L2 语义向量检索：embedding 不可用 → 仅 L1（D-2 降级，如实记账）
    const queryEmbedding = await this.embedOrNull(semanticIntentText);
    if (queryEmbedding === null) {
      this.embeddingUnavailableLookups += 1;
      this.cacheMisses += 1;
      return new CacheLookupOutcome<T>({
        isHit: false,
        cacheLayer: 'MISS',
        cachedArtifact: null,
        savedTokensEstimate: 0,
      });
    }

    const activeSpaceId = this.getActiveEmbeddingSpaceId();
    let bestEntry: L2SemanticEntry | null = null;
    let bestScore = 0;
    for (const candidate of this.l2SemanticEntries) {
      if (
        candidate.embeddingSpaceId !== activeSpaceId ||
        (options?.promptSpecHash && candidate.entry.promptSpecHash !== options.promptSpecHash) ||
        (options?.stageId && candidate.stageId && candidate.stageId !== options.stageId)
      ) {
        this.crossSpaceSkips += 1;
        continue;
      }
      if (
        options?.minQualityRank !== undefined &&
        candidate.entry.modelQualityRank < options.minQualityRank
      ) {
        this.qualityUpgradeBypasses += 1;
        continue;
      }
      const score = cosineSimilarity(queryEmbedding, candidate.embedding);
      if (score >= SEMANTIC_CACHE_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestEntry = candidate;
      }
    }

    if (bestEntry) {
      this.l2SemanticHits += 1;
      this.savedTokensTotal += bestEntry.entry.estimatedTokens;
      this.savedCostUsdTotal += bestEntry.entry.estimatedCostUsd;
      return new CacheLookupOutcome<T>({
        isHit: true,
        cacheLayer: 'L2_SEMANTIC_INTENT',
        cachedArtifact: bestEntry.entry.artifact as T,
        savedTokensEstimate: bestEntry.entry.estimatedTokens,
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
   * （G1：L2 需先 embedding 意图文本；失败则仅写 L1；Pillar 2：高能力产物不被同版本低能力条目覆写）
   */
  public async storeVerifiedArtifact(params: {
    exactKey: string;
    semanticIntentText: string;
    artifact: IDomainArtifactContract;
    estimatedTokens: number;
    estimatedCostUsd: number;
    modelQualityRank?: number;
    modelIdentifier?: string;
    promptSpecHash?: string;
    stageId?: WorkflowStageId;
  }): Promise<void> {
    if (!this.cacheEnabled) {
      return;
    }
    const modelQualityRank = params.modelQualityRank ?? 70;
    const entry: CacheEntryRecord = {
      artifact: params.artifact,
      estimatedTokens: params.estimatedTokens,
      estimatedCostUsd: params.estimatedCostUsd,
      modelQualityRank,
      modelIdentifier: params.modelIdentifier,
      promptSpecHash: params.promptSpecHash,
    };
    const existing = this.l1ExactStore.get(params.exactKey);
    const sameSpec = existing?.promptSpecHash === params.promptSpecHash;
    if (!existing || !sameSpec || modelQualityRank >= existing.modelQualityRank) {
      this.l1ExactStore.set(params.exactKey, entry);
    }

    const embedding = await this.embedOrNull(params.semanticIntentText);
    if (embedding !== null) {
      this.l2SemanticEntries.push({
        intentText: params.semanticIntentText,
        embedding,
        embeddingSpaceId: this.getActiveEmbeddingSpaceId(),
        stageId: params.stageId,
        entry,
      });
    }
  }

  /** L2 当前条目数（观测/测试用） */
  public getL2EntryCount(): number {
    return this.l2SemanticEntries.length;
  }

  /** P1-2：从持久化快照恢复累计缓存遥测计数（供重启后复盘报表延续统计） */
  public restoreTelemetryCounters(metrics: Partial<PersistedCacheTelemetrySnapshot>): void {
    const pickNonNegInt = (val: unknown, fallback: number): number =>
      typeof val === 'number' && Number.isFinite(val) && val >= 0 ? Math.floor(val) : fallback;
    const pickNonNegFloat = (val: unknown, fallback: number): number =>
      typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : fallback;

    this.totalLookups = pickNonNegInt(metrics.totalLookups, this.totalLookups);
    this.l1ExactHits = pickNonNegInt(metrics.l1ExactHits, this.l1ExactHits);
    this.l2SemanticHits = pickNonNegInt(metrics.l2SemanticHits, this.l2SemanticHits);
    this.cacheMisses = pickNonNegInt(metrics.cacheMisses, this.cacheMisses);
    this.savedTokensTotal = pickNonNegInt(metrics.savedTokensTotal, this.savedTokensTotal);
    this.savedCostUsdTotal = pickNonNegFloat(metrics.savedCostUsdTotal, this.savedCostUsdTotal);
    this.embeddingUnavailableLookups = pickNonNegInt(
      metrics.embeddingUnavailableLookups,
      this.embeddingUnavailableLookups,
    );
    this.qualityUpgradeBypasses = pickNonNegInt(
      metrics.qualityUpgradeBypasses,
      this.qualityUpgradeBypasses,
    );
    this.crossSpaceSkips = pickNonNegInt(metrics.crossSpaceSkips, this.crossSpaceSkips);
  }

  public getMetricsSnapshot(): CacheTelemetrySnapshot {
    return new CacheTelemetrySnapshot({
      totalLookups: this.totalLookups,
      l1ExactHits: this.l1ExactHits,
      l2SemanticHits: this.l2SemanticHits,
      cacheMisses: this.cacheMisses,
      savedTokensTotal: this.savedTokensTotal,
      savedCostUsdTotal: this.savedCostUsdTotal,
      embeddingUnavailableLookups: this.embeddingUnavailableLookups,
      qualityUpgradeBypasses: this.qualityUpgradeBypasses,
      crossSpaceSkips: this.crossSpaceSkips,
    });
  }

  private getActiveEmbeddingSpaceId(): string {
    if (!this.embeddingProvider) {
      return 'NONE';
    }
    return `${this.embeddingProvider.providerName}::${this.embeddingProvider.modelIdentifier ?? 'default'}`;
  }

  private async embedOrNull(text: string): Promise<number[] | null> {
    if (!this.embeddingProvider || !text.trim()) {
      return null;
    }
    return this.embeddingProvider.embed(text);
  }
}
