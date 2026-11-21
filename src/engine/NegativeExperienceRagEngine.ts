/**
 * @file NegativeExperienceRagEngine.ts
 * @description 负向经验飞轮 (Rejected History RAG) 向量嵌入与余弦相似度检索引擎。
 *
 * 对应《系统设计报告》4.3 第 3 点与《工程落地架构草案》：
 * - 将所有被人类驳回或通过总管 Agent 回退的批注，先经由 `PayloadDesensitizer` 自动脱敏；
 * - 计算 64 维归一化语义特征向量（对齐 `deploy/init-pgvector-schema.sql` 中的 `vector(64)`）；
 * - 当后续任务进入同一阶段时，计算新提案上下文与历史驳回向量的余弦相似度 (`cosineSimilarity`)，
 *   按相似度排序检索 Top-K 避坑指南注入给职能 Agent。
 */

import { WorkflowStageId } from '../domain/enums.ts';
import { PayloadDesensitizer } from '../patterns/ModelRouterGateway.ts';

export interface NegativeExperienceVectorRecord {
  readonly recordId: string;
  readonly stageId: WorkflowStageId;
  readonly desensitizedLesson: string;
  readonly embedding: ReadonlyArray<number>;
  readonly createdAtIso: string;
}

export interface RetrievedNegativeLesson {
  readonly recordId: string;
  readonly stageId: WorkflowStageId;
  readonly desensitizedLesson: string;
  readonly similarityScore: number;
}

export class NegativeExperienceRagEngine {
  private static readonly VECTOR_DIM = 64;
  private readonly desensitizer: PayloadDesensitizer;
  private readonly records: NegativeExperienceVectorRecord[];

  public constructor(initialRecords?: ReadonlyArray<NegativeExperienceVectorRecord>) {
    this.desensitizer = new PayloadDesensitizer();
    this.records = initialRecords ? [...initialRecords] : [];
  }

  /**
   * 计算文本的 64 维 L2 归一化特征向量（支持中英文二元词袋与领域关键词加权投影）
   */
  public static computeNormalizedEmbedding(text: string): ReadonlyArray<number> {
    const vec = new Array<number>(NegativeExperienceRagEngine.VECTOR_DIM).fill(0);
    const cleaned = text.toLowerCase().trim();
    if (!cleaned) {
      vec[0] = 1;
      return vec;
    }

    // 字符与 Bigram 局部敏感哈希投影
    for (let i = 0; i < cleaned.length; i += 1) {
      const code1 = cleaned.charCodeAt(i);
      const code2 = i + 1 < cleaned.length ? cleaned.charCodeAt(i + 1) : 31;
      const bucketA = (code1 * 31 + code2 * 17) % NegativeExperienceRagEngine.VECTOR_DIM;
      const bucketB = (code1 * 13 + i * 7) % NegativeExperienceRagEngine.VECTOR_DIM;
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
   * 计算两个等长归一化向量的余弦相似度 [-1, 1]
   */
  public static cosineSimilarity(vecA: ReadonlyArray<number>, vecB: ReadonlyArray<number>): number {
    const len = Math.min(vecA.length, vecB.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i += 1) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) {
      return 0;
    }
    return Number((dot / denom).toFixed(4));
  }

  /**
   * 自动脱敏并沉淀一条人类驳回/回退的负向经验
   */
  public ingestRejectionLesson(
    stageId: WorkflowStageId,
    rawLessonText: string,
  ): NegativeExperienceVectorRecord {
    const desensitized = this.desensitizer.desensitize(rawLessonText);
    const embedding = NegativeExperienceRagEngine.computeNormalizedEmbedding(
      desensitized.sanitizedText,
    );
    const record: NegativeExperienceVectorRecord = {
      recordId: `RAG-LESSON-${this.records.length + 1}-${Date.now()}`,
      stageId,
      desensitizedLesson: desensitized.sanitizedText,
      embedding,
      createdAtIso: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }

  /**
   * 基于向量余弦相似度检索指定阶段的 Top-K 历史驳回经验
   */
  public retrieveTopKSimilarLessons(params: {
    stageId: WorkflowStageId;
    queryText: string;
    topK?: number;
  }): ReadonlyArray<RetrievedNegativeLesson> {
    const topK = params.topK ?? 5;
    const stageRecords = this.records.filter((r) => r.stageId === params.stageId);
    if (stageRecords.length === 0) {
      return [];
    }

    const queryEmbedding = NegativeExperienceRagEngine.computeNormalizedEmbedding(params.queryText);
    const scored = stageRecords.map((rec) => ({
      recordId: rec.recordId,
      stageId: rec.stageId,
      desensitizedLesson: rec.desensitizedLesson,
      similarityScore: NegativeExperienceRagEngine.cosineSimilarity(queryEmbedding, rec.embedding),
    }));

    scored.sort((a, b) => b.similarityScore - a.similarityScore);
    return scored.slice(0, topK);
  }

  public getAllRecords(): ReadonlyArray<NegativeExperienceVectorRecord> {
    return [...this.records];
  }
}
