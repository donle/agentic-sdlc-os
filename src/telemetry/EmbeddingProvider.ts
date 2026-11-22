/**
 * @file EmbeddingProvider.ts
 * @description G1/G2 共用的文本向量提供者抽象：经 BYOM 网关调用 OpenAI 兼容 `/v1/embeddings`。
 *
 * D-2 降级约定：embed() 返回 null 表示 embedding 端点不可用（未启用/超时/报错），
 * 调用方（PromptCacheManager / NegativeExperienceRagEngine）必须平滑回落：
 * - G1：L2 语义缓存仅在向量可用时启用，失败退化为仅 L1 精确缓存；
 * - G2：RAG 记录失败时保留哈希伪向量（M7 兼容），并标记待重嵌。
 */

import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';

export interface EmbeddingProvider {
  readonly providerName: string;
  /** 返回 L2 归一化与否均可——比较统一走 cosineSimilarity（内部再归一化）；null = 端点不可用 */
  embed(text: string): Promise<number[] | null>;
}

/** 网关-backed 实现：单机私有化默认指向本地 Ollama/vLLM 兼容 `/v1/embeddings` */
export class GatewayEmbeddingProvider implements EmbeddingProvider {
  public readonly providerName = 'gateway-embeddings';
  private readonly gateway: ModelRouterGateway;

  public constructor(gateway: ModelRouterGateway) {
    this.gateway = gateway;
  }

  public async embed(text: string): Promise<number[] | null> {
    try {
      const result = await this.gateway.invokeEmbedding({ text });
      return [...result.embedding];
    } catch {
      return null;
    }
  }
}

/**
 * 余弦相似度（维度不一致时按 min(len) 截断计算——兼容旧哈希向量与真实 embedding 共存的过渡期）
 */
export function cosineSimilarity(vecA: ReadonlyArray<number>, vecB: ReadonlyArray<number>): number {
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
