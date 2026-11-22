# G1 实现文档：L2 语义缓存 embedding 化

> 对应 `BACKEND_TODO_DESIGN.md` §"G1/G2 语义缓存与 RAG embedding 化"，2026-11-23 完成。
> 实施日志同步条目见 `BACKEND_TODO_IMPL_LOG.md`。

## 问题背景

旧 L2 缓存命中条件是 `intentCode` 归一化字符串相等，而 intentCode 是规则拼串（如 `PRD_SYNTHESIS_AND_TRACKING_PLAN_2_REQS`），导致：

- **误命中**：相同需求条数、语义完全不同的两次请求 → 命中（复用错误产物）
- **漏命中**：语义相同、措辞不同的相似需求 → 不命中（浪费 Token）

## 实现方案

### 1. 网关增加 EMBEDDING 路由层（`src/patterns/ModelRouterGateway.ts`）

- `ModelRoutingTier` 新增 `EMBEDDING`（`src/domain/enums.ts`）。
- 默认端点：`providerName: 'Local-Embedding-OnPremise'`，模型 `process.env.EMBEDDING_MODEL ?? 'bge-m3-local'`，本地私有（baseUrl 走 `OLLAMA_API_BASE`）。
- 新增 `invokeEmbedding({text})`：调用 OpenAI 兼容 `POST {baseUrl}/v1/embeddings`，先过 `preparePromptForTier` 脱敏，返回向量 + `ModelInvocationReceipt`（usage 缺失时如实标记 `usageEstimated=true`）。
- 新增 `EmbeddingHttpTransport` 注入口（`setEmbeddingTransport`），与 chat 传输适配器分离，互不干扰既有 mock 契约。
- **不可用时抛错**（`EMBEDDING_UNAVAILABLE`，带 `cause`），降级由调用方负责（D-2）。

### 2. EmbeddingProvider 抽象（新增 `src/telemetry/EmbeddingProvider.ts`）

- `EmbeddingProvider { readonly providerName: string; embed(text): Promise<number[] | null> }`——`null` 表示端点不可用。
- `GatewayEmbeddingProvider`：包装网关调用，catch 后返回 null（平滑降级）。
- `cosineSimilarity(a, b)`：维度不一致按 `min(len)` 截断计算（兼容旧哈希向量过渡期）。

### 3. PromptCacheManager L2 改造（`src/telemetry/PromptCacheManager.ts`）

| 旧行为                               | 新行为                                                                                                                                                                    |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L2 键 = 归一化拼串，命中条件键相等   | L2 条目 = `{intentText, embedding, entry}`，命中条件 **余弦 ≥ 0.86**（`SEMANTIC_CACHE_THRESHOLD`，模块加载时读取环境变量；需传合法数值，未额外做 `Number.isFinite` 兜底） |
| `lookup(exactKey, semanticKey)` 同步 | `lookup(exactKey, semanticIntentText)` **异步**（L1 路径不触碰 embedding，仍零开销）                                                                                      |
| `storeVerifiedArtifact` 同步写两键   | **异步**：L2 先 embedding 意图文本，**失败则只写 L1，不产生伪向量**                                                                                                       |
| —                                    | 新增 `buildSemanticIntentText()`：包含需求**描述**（非仅 ID）+ 意图描述 + 回退指令的自然语言文本                                                                          |
| —                                    | 遥测新增 `embeddingUnavailableLookups`（降级次数诚实记账）                                                                                                                |

意图文本样例：`阶段 STAGE_1_PM | 角色 PM_AGENT | 意图 PRD 拆解与埋点规划 | 需求 R1: 采购审批数字化；R2: 合同归档 | 回退指令 无`

### 4. 接线

- `WorkflowOrchestratorFacade`：`modelRouter` 提前构造，`PromptCacheManager` 注入 `GatewayEmbeddingProvider`。
- `AbstractWorkerAgent.executeStagePipeline`：`buildSemanticIntentText` + `await lookup` / `await storeVerifiedArtifact`。

## 边界处理

1. **embedding 端点不可用**（未开 `LITELLM_ENABLE_LIVE_HTTP` / 超时 / 报错）→ 查询侧仅走 L1、写入侧只写 L1，`embeddingUnavailableLookups` 如实累加——离线单机环境零网络调用、行为与旧 L1 完全一致。
2. **维度不一致的旧向量**（哈希伪向量 vs 真 embedding 共存）→ `cosineSimilarity` 按 `min(len)` 截断，不崩溃；G2 的后台重嵌队列会逐步收敛。
3. **空意图文本** → 直接返回 null，不做无意义 embedding 调用。
4. **缓存开关关闭** → 完全跳过 L2 条目生成（`getL2EntryCount() === 0`）。

## 验证（`tests/concurrency-and-cache.spec.ts` 中 `PromptCacheManager` 套件 7 项；该文件共 9 项）

1. L1 精确命中（不依赖 embedding）
2. L2 语义命中：不同精确键、措辞不同语义等价（stub 向量余弦 ≈ 0.9998 ≥ 0.86）→ 命中
3. **误命中修复**：相同需求条数、语义无关（正交向量）→ MISS（旧实现会误命中）
4. embedding 不可用 → 仅 L1 + `embeddingUnavailableLookups > 0` + 无伪 L2 条目
5. 缓存关闭 → 永远 MISS 且零 L2 条目
6. savedTokens 如实记账（A3 口径）
7. `buildSemanticIntentText`：相同 ID 不同描述 → 文本不同

**完成时测试基线**：95 项（91 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：143 项 / 45 套件，139 过 / 4 既有 skip）

## 遗留

- L0 前缀缓存已另行完成（`StagePromptSpecs.ts` 公共纪律前置）。
- L3 增量缓存（回退指令 diff → 局部重生成）未实现，需产物粒度依赖追踪，暂缓。
