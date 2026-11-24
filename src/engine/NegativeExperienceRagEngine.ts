/**
 * @file NegativeExperienceRagEngine.ts
 * @description 负向经验飞轮 (Rejected History RAG) 向量嵌入与余弦相似度检索引擎。
 *
 * 对应《系统设计报告》4.3 第 3 点与《工程落地架构草案》：
 * - 将所有被人类驳回或通过总管 Agent 回退的批注，先经由 `PayloadDesensitizer` 自动脱敏；
 * - 计算归一化语义特征向量（对齐 `deploy/init-pgvector-schema.sql` 中的 `vector(1536)`）；
 * - 当后续任务进入同一阶段时，计算新提案上下文与历史驳回向量的余弦相似度 (`cosineSimilarity`)，
 *   按相似度排序检索 Top-K 避坑指南注入给职能 Agent。
 *
 * G2 改造（BACKEND_TODO_DESIGN）：
 * - `ingestRejectionLesson` 保留**同步哈希向量落库**（离线/单机零依赖，M7 兼容）；
 * - 注入 `EmbeddingProvider` 后，后台队列异步升级为真实 embedding（失败保持哈希并标记待重嵌）；
 * - 检索时查询向量同样优先真实 embedding、失败回落哈希；混合向量空间按 `min(len)` 余弦兼容，
 *   命中结果带 `matchDegraded` 标记（诚实口径）。
 */

import { WorkflowStageId } from '../domain/enums.ts';
import { PayloadDesensitizer } from '../patterns/ModelRouterGateway.ts';
import type { EmbeddingProvider } from '../telemetry/EmbeddingProvider.ts';
import { cosineSimilarity as sharedCosineSimilarity } from '../telemetry/EmbeddingProvider.ts';

export type RagEmbeddingSource = 'HASH_FALLBACK' | 'REAL_EMBEDDING';

export interface NegativeExperienceVectorRecord {
  readonly recordId: string;
  readonly stageId: WorkflowStageId;
  readonly desensitizedLesson: string;
  readonly embedding: ReadonlyArray<number>;
  readonly createdAtIso: string;
  /** G2：向量来源（旧持久化记录无此字段 → 视为哈希降级） */
  readonly embeddingSource?: RagEmbeddingSource;
  /** G2：embeddingProvider 在位但后台升级失败 → true（等待下次升级） */
  readonly needsReembedding?: boolean;
}

export interface RetrievedNegativeLesson {
  readonly recordId: string;
  readonly stageId: WorkflowStageId;
  readonly desensitizedLesson: string;
  readonly similarityScore: number;
  /** G2：查询向量与记录向量来源不一致（哈希 vs 真实 embedding 混检），相似度仅供参考 */
  readonly matchDegraded?: boolean;
}

export class NegativeExperienceRagEngine {
  /** 默认哈希降级向量维度：未显式配置 RAG_VECTOR_DIM 时保持 1536 维向后兼容 */
  private static readonly DEFAULT_VECTOR_DIM = 1536;
  private readonly desensitizer: PayloadDesensitizer;
  private readonly records: NegativeExperienceVectorRecord[];
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly vectorDim: number;
  /** 后台升级队列：串行链，避免并发写 records */
  private upgradeChain: Promise<void> = Promise.resolve();
  private pendingUpgradeCount = 0;

  public constructor(
    initialRecords?: ReadonlyArray<NegativeExperienceVectorRecord>,
    embeddingProvider?: EmbeddingProvider | null,
    vectorDim?: number,
  ) {
    this.desensitizer = new PayloadDesensitizer();
    this.records = initialRecords ? [...initialRecords] : [];
    this.embeddingProvider = embeddingProvider ?? null;
    this.vectorDim =
      vectorDim !== undefined && Number.isFinite(vectorDim) && Math.floor(vectorDim) >= 8
        ? Math.floor(vectorDim)
        : NegativeExperienceRagEngine.resolveDefaultVectorDim();
  }

  /** P1-2：读取 RAG_VECTOR_DIM 环境变量（>=8 的合法整数），默认返回 1536 */
  public static resolveDefaultVectorDim(): number {
    const raw = process.env.RAG_VECTOR_DIM;
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && Math.floor(parsed) >= 8) {
        return Math.floor(parsed);
      }
    }
    return NegativeExperienceRagEngine.DEFAULT_VECTOR_DIM;
  }

  /**
   * 计算文本的哈希降级特征向量（L2 归一化，字符/bigram 局部敏感哈希投影）。
   * 纯确定性、零依赖——离线环境的检索质量底线（M7 兼容路径）。
   */
  public static computeNormalizedEmbedding(
    text: string,
    vectorDim?: number,
  ): ReadonlyArray<number> {
    const dim =
      vectorDim !== undefined && Number.isFinite(vectorDim) && Math.floor(vectorDim) >= 8
        ? Math.floor(vectorDim)
        : NegativeExperienceRagEngine.resolveDefaultVectorDim();
    const vec = new Array<number>(dim).fill(0);
    const cleaned = text.toLowerCase().trim();
    if (!cleaned) {
      vec[0] = 1;
      return vec;
    }

    // 字符与 Bigram 局部敏感哈希投影
    for (let i = 0; i < cleaned.length; i += 1) {
      const code1 = cleaned.charCodeAt(i);
      const code2 = i + 1 < cleaned.length ? cleaned.charCodeAt(i + 1) : 31;
      const bucketA = (code1 * 31 + code2 * 17) % dim;
      const bucketB = (code1 * 13 + i * 7) % dim;
      vec[bucketA] += 1.0;
      vec[bucketB] += 0.5;
    }

    // L2 归一化，便于直接计算余弦相似度
    let normSq = 0;
    for (const val of vec) {
      normSq += val * val;
    }
    const norm = Math.sqrt(normSq);
    if (norm === 0) {
      vec[0] = 1;
      return vec;
    }
    return vec.map((v) => Number((v / norm).toFixed(6)));
  }

  /**
   * 计算两个向量的余弦相似度 [-1, 1]（维度不一致按 min(len) 截断——新旧向量共存过渡期兼容）
   */
  public static cosineSimilarity(vecA: ReadonlyArray<number>, vecB: ReadonlyArray<number>): number {
    return sharedCosineSimilarity(vecA, vecB);
  }

  /**
   * 自动脱敏并沉淀一条人类驳回/回退的负向经验。
   * G2：同步写入哈希向量保证落库零延迟；若注入了 EmbeddingProvider，则入后台队列异步升级。
   */
  public ingestRejectionLesson(
    stageId: WorkflowStageId,
    rawLessonText: string,
  ): NegativeExperienceVectorRecord {
    const desensitized = this.desensitizer.desensitize(rawLessonText);
    const embedding = NegativeExperienceRagEngine.computeNormalizedEmbedding(
      desensitized.sanitizedText,
      this.vectorDim,
    );
    const record: NegativeExperienceVectorRecord = {
      recordId: `RAG-LESSON-${this.records.length + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stageId,
      desensitizedLesson: desensitized.sanitizedText,
      embedding,
      createdAtIso: new Date().toISOString(),
      embeddingSource: 'HASH_FALLBACK',
      needsReembedding: false,
    };
    this.records.push(record);

    if (this.embeddingProvider) {
      this.enqueueEmbeddingUpgrade(record.recordId, desensitized.sanitizedText);
    }
    return record;
  }

  /**
   * 基于向量余弦相似度检索指定阶段的 Top-K 历史驳回经验。
   * G2：查询向量优先真实 embedding（异步），失败回落哈希（确定性，与旧行为一致）。
   */
  public async retrieveTopKSimilarLessons(params: {
    stageId: WorkflowStageId;
    queryText: string;
    topK?: number;
  }): Promise<ReadonlyArray<RetrievedNegativeLesson>> {
    const topK = params.topK ?? 5;
    const stageRecords = this.records.filter((r) => r.stageId === params.stageId);
    if (stageRecords.length === 0) {
      return [];
    }

    let queryEmbedding: ReadonlyArray<number>;
    let queryIsReal = false;
    if (this.embeddingProvider) {
      const realVector = await this.embeddingProvider.embed(params.queryText);
      if (realVector !== null) {
        queryEmbedding = realVector;
        queryIsReal = true;
      } else {
        queryEmbedding = NegativeExperienceRagEngine.computeNormalizedEmbedding(
          params.queryText,
          this.vectorDim,
        );
      }
    } else {
      queryEmbedding = NegativeExperienceRagEngine.computeNormalizedEmbedding(
        params.queryText,
        this.vectorDim,
      );
    }

    const scored = stageRecords.map((rec) => {
      const recIsReal = rec.embeddingSource === 'REAL_EMBEDDING';
      return {
        recordId: rec.recordId,
        stageId: rec.stageId,
        desensitizedLesson: rec.desensitizedLesson,
        similarityScore: NegativeExperienceRagEngine.cosineSimilarity(
          queryEmbedding,
          rec.embedding,
        ),
        // 哈希 ↔ 真实 embedding 混检时 min(len) 余弦语义无效，如实标记
        matchDegraded: recIsReal !== queryIsReal,
      };
    });

    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    return scored.slice(0, topK);
  }

  /** D1：恢复持久化的 RAG 记录（不重新脱敏/嵌入）；G2：哈希旧记录若 provider 在位则排入升级队列 */
  public restoreRecord(record: NegativeExperienceVectorRecord): void {
    this.records.push(record);
    const source = record.embeddingSource ?? 'HASH_FALLBACK';
    if (this.embeddingProvider && source !== 'REAL_EMBEDDING') {
      this.enqueueEmbeddingUpgrade(record.recordId, record.desensitizedLesson);
    }
  }

  /** 等待全部后台 embedding 升级完成（测试与优雅关停用） */
  public async flushPendingEmbeddingUpgrades(): Promise<void> {
    await this.upgradeChain;
  }

  /** 后台升级队列长度（观测用） */
  public getPendingUpgradeCount(): number {
    return this.pendingUpgradeCount;
  }

  public getAllRecords(): ReadonlyArray<NegativeExperienceVectorRecord> {
    return [...this.records];
  }

  /** 后台队列：串行升级单条记录的向量为真实 embedding；失败保持哈希并标记待重嵌 */
  private enqueueEmbeddingUpgrade(recordId: string, lessonText: string): void {
    this.pendingUpgradeCount += 1;
    const task = async (): Promise<void> => {
      try {
        const vector = await this.embeddingProvider?.embed(lessonText);
        if (vector !== null && vector !== undefined) {
          this.replaceRecord(recordId, (rec) => ({
            ...rec,
            embedding: vector,
            embeddingSource: 'REAL_EMBEDDING',
            needsReembedding: false,
          }));
        } else {
          this.markNeedsReembedding(recordId);
        }
      } catch {
        this.markNeedsReembedding(recordId);
      } finally {
        this.pendingUpgradeCount -= 1;
      }
    };
    this.upgradeChain = this.upgradeChain.then(task, task).catch(() => {
      // 链条不断：单条失败已标记待重嵌，后续升级照常
    });
  }

  private replaceRecord(
    recordId: string,
    mapper: (rec: NegativeExperienceVectorRecord) => NegativeExperienceVectorRecord,
  ): void {
    const index = this.records.findIndex((r) => r.recordId === recordId);
    if (index >= 0) {
      this.records[index] = mapper(this.records[index]);
    }
  }

  private markNeedsReembedding(recordId: string): void {
    this.replaceRecord(recordId, (rec) => ({ ...rec, needsReembedding: true }));
  }
}
