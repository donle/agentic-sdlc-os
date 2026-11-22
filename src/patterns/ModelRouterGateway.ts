/**
 * @file ModelRouterGateway.ts
 * @description 策略与适配器模式 (Strategy & Adapter Pattern) 实现的 BYOM 混合模型路由网关。
 *
 * 对应《系统设计报告》4.2 节与《工程落地架构草案》：
 * 1. 多模型分级路由：支持配置本地私有大模型（Ollama / vLLM）与企业混合高阶推理模型（LiteLLM / OpenAI 兼容网关）；
 * 2. 敏感数据脱敏中间件 (`PayloadDesensitizer`)：发往外部/混合模型前自动脱敏 API Key、数据库连接串、内网 IP 等敏感信息；
 * 3. 真实 OpenAI/LiteLLM `/v1/chat/completions` 协议调用适配器 (`invokeChatCompletion`) 与离线确定性回退；
 * 4. 模型能力基线体检 (`evaluateEndpointBaseline`)：校验接入模型的 JSON Schema 遵循能力与推理稳定性。
 */

import { ModelRoutingTier } from '../domain/enums.ts';

export interface DesensitizationResult {
  readonly sanitizedText: string;
  readonly redactedCount: number;
  readonly redactedCategories: ReadonlyArray<string>;
}

/**
 * 企业敏感数据自动脱敏中间件
 */
export class PayloadDesensitizer {
  private static readonly RULES: ReadonlyArray<{
    readonly category: string;
    readonly pattern: RegExp;
    readonly replacement: string;
  }> = [
    {
      category: 'DATABASE_CREDENTIAL',
      pattern: /\b(postgres(?:ql)?|mysql|mongodb|redis):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
      replacement: '$1://[REDACTED_DB_USER]:[REDACTED_DB_PASSWORD]@[REDACTED_DB_HOST]',
    },
    {
      category: 'API_SECRET_KEY',
      pattern: /\b(sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
      replacement: '[REDACTED_API_KEY]',
    },
    {
      category: 'BEARER_JWT_TOKEN',
      pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
      replacement: '[REDACTED_JWT_TOKEN]',
    },
    {
      category: 'INTERNAL_IPV4',
      pattern:
        /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g,
      replacement: '[REDACTED_INTERNAL_IP]',
    },
  ];

  public desensitize(rawInput: string): DesensitizationResult {
    let current = rawInput;
    let totalRedacted = 0;
    const hitCategories = new Set<string>();

    for (const rule of PayloadDesensitizer.RULES) {
      const matches = current.match(rule.pattern);
      if (matches && matches.length > 0) {
        totalRedacted += matches.length;
        hitCategories.add(rule.category);
        current = current.replace(rule.pattern, rule.replacement);
      }
    }

    return {
      sanitizedText: current,
      redactedCount: totalRedacted,
      redactedCategories: Array.from(hitCategories),
    };
  }
}

export class ModelEndpointDescriptor {
  public readonly tier: ModelRoutingTier;
  public readonly providerName: string;
  public readonly modelIdentifier: string;
  public readonly costPer1kTokensUsd: number;
  public readonly isLocalPrivateModel: boolean;
  public readonly baseUrl: string;

  public constructor(params: {
    tier: ModelRoutingTier;
    providerName: string;
    modelIdentifier: string;
    costPer1kTokensUsd: number;
    isLocalPrivateModel: boolean;
    baseUrl?: string;
  }) {
    this.tier = params.tier;
    this.providerName = params.providerName;
    this.modelIdentifier = params.modelIdentifier;
    this.costPer1kTokensUsd = params.costPer1kTokensUsd;
    this.isLocalPrivateModel = params.isLocalPrivateModel;
    this.baseUrl =
      params.baseUrl ??
      (params.isLocalPrivateModel
        ? (process.env.OLLAMA_API_BASE ?? 'http://localhost:11434')
        : (process.env.LITELLM_GATEWAY_URL ?? 'http://localhost:4000'));
  }
}

export class ModelInvocationReceipt {
  public readonly modelIdentifier: string;
  public readonly providerName: string;
  public readonly tier: ModelRoutingTier;
  public readonly promptTokens: number;
  public readonly completionTokens: number;
  public readonly totalTokens: number;
  public readonly estimatedCostUsd: number;
  public readonly redactedCount: number;
  public readonly redactedCategories: ReadonlyArray<string>;
  /** A3：true = 网关未返回 usage，按长度估算；false = 真实账单口径 */
  public readonly usageEstimated: boolean;

  public constructor(params: {
    endpoint: ModelEndpointDescriptor;
    promptTokens: number;
    completionTokens: number;
    redactedCount?: number;
    redactedCategories?: ReadonlyArray<string>;
    usageEstimated?: boolean;
  }) {
    this.modelIdentifier = params.endpoint.modelIdentifier;
    this.providerName = params.endpoint.providerName;
    this.tier = params.endpoint.tier;
    this.promptTokens = params.promptTokens;
    this.completionTokens = params.completionTokens;
    this.totalTokens = params.promptTokens + params.completionTokens;
    this.estimatedCostUsd = Number(
      ((this.totalTokens / 1000) * params.endpoint.costPer1kTokensUsd).toFixed(6),
    );
    this.redactedCount = params.redactedCount ?? 0;
    this.redactedCategories = params.redactedCategories ? [...params.redactedCategories] : [];
    this.usageEstimated = params.usageEstimated ?? true;
  }
}

export interface OpenAiCompatibleChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly temperature?: number;
  readonly response_format?: { readonly type: 'json_object' | 'text' };
}

export interface OpenAiCompatibleChatResponse {
  readonly id: string;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly role: string;
      readonly content: string;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export type ModelHttpTransport = (
  url: string,
  payload: OpenAiCompatibleChatRequest,
  headers: Record<string, string>,
) => Promise<OpenAiCompatibleChatResponse>;

/** G1：OpenAI 兼容 `/v1/embeddings` 请求体 */
export interface OpenAiCompatibleEmbeddingRequest {
  readonly model: string;
  readonly input: string;
}

export interface OpenAiCompatibleEmbeddingResponse {
  readonly data: ReadonlyArray<{ readonly embedding: ReadonlyArray<number> }>;
  readonly usage?: { readonly prompt_tokens: number; readonly total_tokens: number };
}

export type EmbeddingHttpTransport = (
  url: string,
  payload: OpenAiCompatibleEmbeddingRequest,
  headers: Record<string, string>,
) => Promise<OpenAiCompatibleEmbeddingResponse>;

export interface ModelBaselineEvalReport {
  readonly tier: ModelRoutingTier;
  readonly modelIdentifier: string;
  readonly jsonSchemaAdherencePassed: boolean;
  readonly requiredKeysVerified: ReadonlyArray<string>;
  readonly missingKeys: ReadonlyArray<string>;
  readonly desensitizationActive: boolean;
  readonly recommendation: string;
  /** A4：产生该报告的体检任务名（单任务评估时缺省） */
  readonly taskName?: string;
}

export class ModelRouterGateway {
  private readonly endpoints: Map<ModelRoutingTier, ModelEndpointDescriptor>;
  private readonly desensitizer: PayloadDesensitizer;
  private customHttpTransport: ModelHttpTransport | null;
  private customEmbeddingTransport: EmbeddingHttpTransport | null;

  public constructor(customHttpTransport?: ModelHttpTransport) {
    this.endpoints = new Map<ModelRoutingTier, ModelEndpointDescriptor>();
    this.desensitizer = new PayloadDesensitizer();
    this.customHttpTransport = customHttpTransport ?? null;
    this.customEmbeddingTransport = null;

    // 默认注册企业单机私有化双层模型路由配置
    this.registerEndpoint(
      new ModelEndpointDescriptor({
        tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
        providerName: 'Local-vLLM-OnPremise',
        modelIdentifier: 'qwen2.5-coder-32b-instruct-local',
        costPer1kTokensUsd: 0.0002,
        isLocalPrivateModel: true,
      }),
    );
    this.registerEndpoint(
      new ModelEndpointDescriptor({
        tier: ModelRoutingTier.HIGH_REASONING_HYBRID,
        providerName: 'Enterprise-Desensitized-Gateway',
        modelIdentifier: 'claude-3-7-sonnet-enterprise',
        costPer1kTokensUsd: 0.003,
        isLocalPrivateModel: false,
      }),
    );
    // G1/G2：embedding 层（单机私有化默认指向本地 Ollama/vLLM 兼容端点）
    this.registerEndpoint(
      new ModelEndpointDescriptor({
        tier: ModelRoutingTier.EMBEDDING,
        providerName: 'Local-Embedding-OnPremise',
        modelIdentifier: process.env.EMBEDDING_MODEL ?? 'bge-m3-local',
        costPer1kTokensUsd: 0.00002,
        isLocalPrivateModel: true,
      }),
    );
  }

  public setHttpTransport(transport: ModelHttpTransport | null): void {
    this.customHttpTransport = transport;
  }

  /** G1/G2：注入 embedding 专用传输适配器（测试 mock 用）；null 恢复默认 fetch */
  public setEmbeddingTransport(transport: EmbeddingHttpTransport | null): void {
    this.customEmbeddingTransport = transport;
  }

  public getDesensitizer(): PayloadDesensitizer {
    return this.desensitizer;
  }

  public registerEndpoint(descriptor: ModelEndpointDescriptor): void {
    this.endpoints.set(descriptor.tier, descriptor);
  }

  public resolveEndpoint(tier: ModelRoutingTier): ModelEndpointDescriptor {
    const endpoint = this.endpoints.get(tier);
    if (!endpoint) {
      throw new Error(`未找到模型路由层级 [${tier}] 对应的模型端点配置`);
    }
    return endpoint;
  }

  /**
   * 准备发往指定模型层级的 Prompt（若目标非本地私有模型，强制执行敏感词与密钥脱敏）
   */
  public preparePromptForTier(tier: ModelRoutingTier, rawPrompt: string): DesensitizationResult {
    const endpoint = this.resolveEndpoint(tier);
    if (endpoint.isLocalPrivateModel) {
      return {
        sanitizedText: rawPrompt,
        redactedCount: 0,
        redactedCategories: [],
      };
    }
    return this.desensitizer.desensitize(rawPrompt);
  }

  /**
   * 计量模型推理并生成 Token 成本与脱敏凭据
   */
  public MeterInvocation(
    tier: ModelRoutingTier,
    promptTokens: number,
    completionTokens: number,
    rawPromptSample?: string,
  ): ModelInvocationReceipt {
    const endpoint = this.resolveEndpoint(tier);
    const desensitized = rawPromptSample
      ? this.preparePromptForTier(tier, rawPromptSample)
      : { sanitizedText: '', redactedCount: 0, redactedCategories: [] };

    return new ModelInvocationReceipt({
      endpoint,
      promptTokens,
      completionTokens,
      redactedCount: desensitized.redactedCount,
      redactedCategories: desensitized.redactedCategories,
    });
  }

  /**
   * 执行真实的 LiteLLM / Ollama / OpenAI 兼容 `/v1/chat/completions` 请求（自动脱敏 + 离线平滑降级）
   */
  public async invokeChatCompletion(params: {
    tier: ModelRoutingTier;
    systemPrompt: string;
    userPrompt: string;
    fallbackContentGenerator: () => string;
  }): Promise<{
    readonly content: string;
    readonly receipt: ModelInvocationReceipt;
    readonly usedLiveGateway: boolean;
  }> {
    const endpoint = this.resolveEndpoint(params.tier);
    const sanitizedSystem = this.preparePromptForTier(params.tier, params.systemPrompt);
    const sanitizedUser = this.preparePromptForTier(params.tier, params.userPrompt);
    const totalRedacted = sanitizedSystem.redactedCount + sanitizedUser.redactedCount;
    const mergedCategories = Array.from(
      new Set([...sanitizedSystem.redactedCategories, ...sanitizedUser.redactedCategories]),
    );

    const requestPayload: OpenAiCompatibleChatRequest = {
      model: endpoint.modelIdentifier,
      messages: [
        { role: 'system', content: sanitizedSystem.sanitizedText },
        { role: 'user', content: sanitizedUser.sanitizedText },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    };

    const targetUrl = `${endpoint.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? 'sk-local-onpremise'}`,
    };

    const shouldTryLive =
      this.customHttpTransport !== null || process.env.LITELLM_ENABLE_LIVE_HTTP === 'true';

    if (shouldTryLive) {
      try {
        const transport: ModelHttpTransport =
          this.customHttpTransport ??
          (async (url, payload, hdrs) => {
            const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 60000);
            const response = await fetch(url, {
              method: 'POST',
              headers: hdrs,
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            return (await response.json()) as OpenAiCompatibleChatResponse;
          });

        const apiRes = await transport(targetUrl, requestPayload, headers);
        const content = apiRes.choices[0]?.message?.content ?? params.fallbackContentGenerator();
        const usageEstimated = !apiRes.usage;
        const promptTokens =
          apiRes.usage?.prompt_tokens ?? Math.ceil(sanitizedUser.sanitizedText.length / 3);
        const completionTokens = apiRes.usage?.completion_tokens ?? Math.ceil(content.length / 3);

        return {
          content,
          receipt: new ModelInvocationReceipt({
            endpoint,
            promptTokens,
            completionTokens,
            redactedCount: totalRedacted,
            redactedCategories: mergedCategories,
            usageEstimated,
          }),
          usedLiveGateway: true,
        };
      } catch {
        // 单机离线或网关不可达时平滑回退到确定性引擎
      }
    }

    const fallbackContent = params.fallbackContentGenerator();
    const estimatedPromptTokens = Math.max(
      120,
      Math.ceil((sanitizedSystem.sanitizedText.length + sanitizedUser.sanitizedText.length) / 3),
    );
    const estimatedCompletionTokens = Math.max(80, Math.ceil(fallbackContent.length / 3));

    return {
      content: fallbackContent,
      receipt: new ModelInvocationReceipt({
        endpoint,
        promptTokens: estimatedPromptTokens,
        completionTokens: estimatedCompletionTokens,
        redactedCount: totalRedacted,
        redactedCategories: mergedCategories,
      }),
      usedLiveGateway: false,
    };
  }

  /**
   * G1/G2：调用 OpenAI 兼容 `/v1/embeddings` 获取文本向量（自动脱敏；不可达时抛错由调用方降级）
   */
  public async invokeEmbedding(params: { text: string; tier?: ModelRoutingTier }): Promise<{
    readonly embedding: ReadonlyArray<number>;
    readonly receipt: ModelInvocationReceipt;
    readonly usedLiveGateway: boolean;
  }> {
    const tier = params.tier ?? ModelRoutingTier.EMBEDDING;
    const endpoint = this.resolveEndpoint(tier);
    const sanitized = this.preparePromptForTier(tier, params.text);

    const requestPayload: OpenAiCompatibleEmbeddingRequest = {
      model: endpoint.modelIdentifier,
      input: sanitized.sanitizedText,
    };
    const targetUrl = `${endpoint.baseUrl.replace(/\/$/, '')}/v1/embeddings`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? 'sk-local-onpremise'}`,
    };

    const shouldTryLive =
      this.customEmbeddingTransport !== null || process.env.LITELLM_ENABLE_LIVE_HTTP === 'true';
    if (!shouldTryLive) {
      throw new Error('EMBEDDING_UNAVAILABLE: 未启用 embedding 在线端点');
    }

    try {
      const transport: EmbeddingHttpTransport =
        this.customEmbeddingTransport ??
        (async (url, payload, hdrs) => {
          const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 60000);
          const response = await fetch(url, {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return (await response.json()) as OpenAiCompatibleEmbeddingResponse;
        });

      const apiRes = await transport(targetUrl, requestPayload, headers);
      const embedding = apiRes.data[0]?.embedding;
      if (!embedding || embedding.length === 0) {
        throw new Error('EMBEDDING_EMPTY_RESPONSE');
      }

      const promptTokens =
        apiRes.usage?.prompt_tokens ?? Math.ceil(sanitized.sanitizedText.length / 3);
      return {
        embedding,
        receipt: new ModelInvocationReceipt({
          endpoint,
          promptTokens,
          completionTokens: 0,
          redactedCount: sanitized.redactedCount,
          redactedCategories: sanitized.redactedCategories,
          usageEstimated: !apiRes.usage,
        }),
        usedLiveGateway: true,
      };
    } catch (err) {
      throw new Error(
        `EMBEDDING_UNAVAILABLE: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`,
        { cause: err },
      );
    }
  }

  /**
   * 模型能力基线体检（Eval）：校验候选模型的 JSON Schema 遵循度与必选契约字段完整性
   */
  public evaluateEndpointBaseline(params: {
    tier: ModelRoutingTier;
    sampleJsonOutput: string;
    requiredKeys: ReadonlyArray<string>;
    taskName?: string;
  }): ModelBaselineEvalReport {
    const endpoint = this.resolveEndpoint(params.tier);
    const verifiedKeys: string[] = [];
    const missingKeys: string[] = [];
    let jsonValid = false;

    try {
      const parsed = JSON.parse(params.sampleJsonOutput) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of params.requiredKeys) {
          if (key in parsed && parsed[key] !== undefined && parsed[key] !== null) {
            verifiedKeys.push(key);
          } else {
            missingKeys.push(key);
          }
        }
        jsonValid = missingKeys.length === 0;
      }
    } catch {
      jsonValid = false;
      missingKeys.push(...params.requiredKeys);
    }

    return {
      tier: params.tier,
      modelIdentifier: endpoint.modelIdentifier,
      jsonSchemaAdherencePassed: jsonValid,
      requiredKeysVerified: verifiedKeys,
      missingKeys,
      desensitizationActive: !endpoint.isLocalPrivateModel,
      recommendation: jsonValid
        ? `模型 [${endpoint.modelIdentifier}] 通过 JSON 契约遵循度基线体检，可挂载至生产节点`
        : `警告：模型 [${endpoint.modelIdentifier}] 输出缺失必填契约字段 [${missingKeys.join(', ')}]，建议开启 Schema 自愈重试或降级至本地结构化模板`,
      ...(params.taskName ? { taskName: params.taskName } : {}),
    };
  }

  /**
   * A4：对两级对话端点各发 3 个固定 JSON 体检任务 → evaluateEndpointBaseline 汇总报告。
   * 离线（未启用 live HTTP 且无注入 transport）→ 返回 offline 标记，不做任何网络调用。
   */
  public async runModelBaselineCheck(): Promise<{
    offline: boolean;
    reports: ModelBaselineEvalReport[];
  }> {
    const live =
      this.customHttpTransport !== null || process.env.LITELLM_ENABLE_LIVE_HTTP === 'true';
    if (!live) {
      return { offline: true, reports: [] };
    }

    const benchmarkTasks = [
      {
        name: 'FLAT_OBJECT',
        prompt: '仅输出一个 JSON 对象：{"summary":"基线体检样例","count":3}',
        requiredKeys: ['summary', 'count'],
      },
      {
        name: 'NESTED_ARRAY',
        prompt: '仅输出一个 JSON 对象：{"total":2,"items":[{"id":"a1"},{"id":"b2"}]}',
        requiredKeys: ['total', 'items'],
      },
      {
        name: 'ENUM_FIELD',
        prompt:
          '仅输出一个 JSON 对象：{"status":"PASS","detail":"基线体检"}，status 只能取 PASS 或 FAIL',
        requiredKeys: ['status', 'detail'],
      },
    ] as const;

    const chatTiers: ReadonlyArray<ModelRoutingTier> = [
      ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      ModelRoutingTier.HIGH_REASONING_HYBRID,
    ];
    const reports: ModelBaselineEvalReport[] = [];
    for (const tier of chatTiers) {
      for (const task of benchmarkTasks) {
        try {
          const result = await this.invokeChatCompletion({
            tier,
            systemPrompt: '你是模型能力基线体检器。严格遵守任务指令。',
            userPrompt: task.prompt,
            fallbackContentGenerator: () => '',
          });
          if (!result.usedLiveGateway || !result.content.trim()) {
            continue;
          }
          reports.push(
            this.evaluateEndpointBaseline({
              tier,
              sampleJsonOutput: result.content,
              requiredKeys: task.requiredKeys,
              taskName: task.name,
            }),
          );
        } catch {
          // 单任务失败不阻断其余任务（报告缺失即该任务未通过）
        }
      }
    }
    return { offline: false, reports };
  }
}
