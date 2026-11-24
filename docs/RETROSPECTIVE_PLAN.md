# 复盘任务与成本控制指标检测规范 (`src/telemetry/` & `src/retrospective/`)

为了避免多智能体系统在企业落地中出现“Token 账单失控”、“无限重试死循环”或“意图偏离”，系统内置了独立的复盘与成本控制检测引擎。

---

## 一、 核心复盘指标定义

### 1. 指标 (a)：双层缓存命中率 (`PromptCacheManager.ts`)

- **设计机制**：
  - **L1 精确上下文签名缓存 (`L1_EXACT`)**：按 `阶段 + Agent 角色 + 提案标题 + 核心需求集合 + 人类回退指令` 精确匹配。在总管 Agent 触发局部回退重跑或相同分支回归时实现 100% 拦截。
  - **L2 语义意图向量缓存 (`L2_SEMANTIC_INTENT`，G1 已实现)**：意图文本（含需求**描述**而非仅 ID）经网关 `/v1/embeddings` 向量化，命中条件为余弦相似度 ≥ 0.86（`SEMANTIC_CACHE_THRESHOLD`）。措辞不同的相似意图命中、同条数不同语义的需求不再误命中；embedding 端点不可用时本次检索降级为仅 L1（`embeddingUnavailableLookups` 如实记账）。实现细节见 `G1_SEMANTIC_CACHE_EMBEDDING.md`。
  - 附加层：**L0 提供商侧前缀缓存**（免费）——6 个职能 Agent 的 systemPrompt 共享逐字节相同的公共纪律前缀（`COMMON_DISCIPLINE` 前置），命中 LLM 提供商的 KV 前缀缓存。
- **核心公式**：
  $$\text{Cache Hit Rate} = \frac{\text{L1 Hits} + \text{L2 Hits}}{\text{Total Lookups}} \times 100\%$$
- **SLA 目标基线**：`>= 30.0%`，并实时统计 `savedTokensTotal`（累计节省 Tokens）、`savedCostUsdTotal`（累计节省成本）、`costSavingsRatioPercent`（缓存节流比）与 `embeddingUnavailableLookups`（embedding 降级计数）。

### 2. 指标 (b)：意图识别到最终执行结果达成率 & 重试分布 (`IntentFulfillmentTracker.ts`)

- **设计机制**：
  每次 Agent 调用从 `resolveStageIntent()`（优先复用 A4 捕获的作用域级 `__intent`，首次/不同需求/离线回落子类 `recognizeStageIntent()`）开始建立追踪链路（`IntentExecutionTraceRecord`），记录：
  - 首次生成即通过契约校验（`FULFILLED_ON_FIRST_TRY`）
  - 命中缓存直通（`FULFILLED_VIA_CACHE`）
  - 经过 $1 \sim N$ 次自愈重试后通过契约校验（`FULFILLED_AFTER_RETRY`）
  - 契约彻底失败（`FAILED_CONTRACT`；注：`ESCALATED_TO_HUMAN` 已保留在枚举与汇总结构 `escalatedToHumanCount` 中，但当前协商熔断记录写入 `NegotiationTurnRecord` / `WorkflowEventBus`，未覆盖原 `IntentExecutionTraceRecord`）
- **核心统计项**：
  1. **意图最终达成率 (`fulfillmentRatePercent`)**：目标基线 `>= 85.0%`
  2. **首次直通率 (`firstPassSuccessRatePercent`)**：衡量无重试一次成活的比例
  3. **平均重试次数 (`averageRetriesPerInvocation`)**：目标基线 `<= 0.65 次/调用`
  4. **重试次数分布直方图 (`retryDistribution`)**：分别统计 `0 次重试`、`1 次重试`、`>=2 次重试` 的调用分布，以及因重试额外损耗的 `totalRetryOverheadTokens`。

### 3. 指标 (c)：成本控制效能 (`RetrospectiveTaskRunner.ts`)

- **核心统计项**：
  1. **重试 Token 损耗占比 (`retryTokenWasteRatioPercent`)**：目标基线 `<= 20.0%`（`maxRetryTokenOverheadRatioPercent`），避免自愈循环成为隐性 Token 黑洞。
  2. **缓存节省比例 (`costSavingsRatioPercent`) 与总成本 (`totalCostUsd`)**：汇总每次运行真实消耗与双层缓存节流成效。

---

## 二、 独立复盘评测任务执行方式

在命令行运行以下命令即可启动多场景基准复盘任务（`src/retrospective/runRetrospective.ts`）：

```bash
npm run retrospective:eval
```

该任务依次编排冷启动自愈重试、PM-PD 协商熔断裁决、总管对话式 DAG 分叉回退，以及同构 `proposalB` 复用缓存——其中离线模式下主要验证 **L1 精确缓存**（L2 语义向量命中需启用在线 `/v1/embeddings` 端点，或参见 `tests/concurrency-and-cache.spec.ts` 中的独立单元测试），并输出包含 4 项 SLA 诊断结论与优化建议的报告。

> 注：2026-11-24 已完成 `P0-6` 修复（见 [`P0_6_RETROSPECTIVE_RUNNER_FIX.md`](./P0_6_RETROSPECTIVE_RUNNER_FIX.md)）：`src/retrospective/runRetrospective.ts` 全部 6 处异步 `await` 已补齐，默认模式优先只读调用 `evaluatePersistedHistory()` 评估真实持久化历史运行，无历史数据时在 `os.tmpdir()` 隔离目录执行合成基准（亦可传 `--benchmark` / `--history-only`），不再污染工作区 `.runtime-data/`。
