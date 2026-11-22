# 实现文档：LLM 意图分析驱动的动态上下文需求

> 对应上下文介入实施方案步骤 4，2026-11-23 完成。前置：步骤 1-3（ToolRegistry / GitProvider / MCP + stub）已就绪。

## 问题背景

`STAGE_CONTEXT_NEEDS` 是静态声明表——同一阶段对所有提案请求同样的外部知识。实际上不同提案需要的知识不同
（如"涉及库存扣减的提案才需要查现有幂等实现"）。步骤 4 用轻量 LLM 调用按提案推断动态需求。

## 实现方案

### 1. Facade 规划器（`WorkflowOrchestratorFacade.inferDynamicContextNeeds`）

- 输入：`stageId + 提案可序列化记录 + 可选知识类型目录`，要求输出 `{needs: [{type, reason}]}`。
- 模型层：`ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL`（本地私有 + 低成本），JSON 输出经 `JsonExtractor` 稳健提取。
- 三道防线：
  1. **离线零调用**：`LITELLM_ENABLE_LIVE_HTTP !== 'true'` 时直接返回空数组（不发起任何请求）；
  2. **目录白名单**：type 必须命中 `ALL_CONTEXT_NEED_TYPES`（由 STAGE_CONTEXT_NEEDS 全表派生），枚举外一律丢弃——注入拦截，与 C3 NL 解析同哲学；
  3. **轻量上限**：先截取前 3 条（`slice(0, 3)`）再按白名单过滤（因此最终有效动态需求 `≤ 3` 条）、一律 `required: false` + `maxTokens: 800`——动态增强永不阻塞流水线。

### 2. 需求合并与预取

- Facade 每阶段执行前：`动态推断（LLM）→ 与静态声明按 type 去重合并 → ToolRegistry.resolve 预取 runCache`。
- `AgentExecutionInputContext` 新增 `dynamicContextNeeds` 字段传递给 Agent。
- `AbstractWorkerAgent.buildStagePrompt`：读取缓存时合并静态 + 动态需求（动态仅补充静态没有的类型），注入 `externalContext`。

## 数据流

```
Facade
  ├─ inferDynamicContextNeeds(LLM, 离线→[])          ← 白名单过滤 + 上限 3
  ├─ ToolRegistry.resolve(static ∪ dynamic)          ← 预取入 runCache（stub/MCP/Git）
  └─ AgentExecutionInputContext.dynamicContextNeeds ─→ Agent.buildStagePrompt
                                                        └─ getCached(static ∪ dynamic) → externalContext 注入
```

## 边界处理

1. 规划器 LLM 失败/超时/输出散文 → 空数组（静态声明兜底，D-2）。
2. 动态需求无 Provider 可解析 → optional 静默降级 + WARN（ToolRegistry 既有边界）。
3. 动态需求与静态声明同 type → 静态优先（保留其 required/maxTokens 语义）。
4. 离线环境：规划器完全跳过，管道行为与步骤 4 之前完全一致（零回归）。

## 验证（tests/dynamic-context-needs.spec.ts，2 项）

1. **端到端注入**：在线 mock 规划器返回合法动态需求（`code_structure`）+ 注入尝试（`__import__evil`）→
   临时真实仓库（GIT_REPO_PATH）→ PM 阶段 prompt 含 `externalContext` + `directoryTree`（真实 Git 读取），
   注入类型被白名单丢弃。
2. **离线回归**：`LITELLM_ENABLE_LIVE_HTTP` 未开启 → 规划器零调用（transport 捕获 0 次规划请求），静态流水线照常执行。

**完成时测试基线**：107 项（103 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：143 项 / 45 套件，139 过 / 4 既有 skip）

## 遗留

- 规划器目前每次在线执行会额外发起 1 次 `PRIVACY_SENSITIVE_LOCAL` LLM 调用；与之不同，A4（6 个 Worker Agent 的阶段意图识别 `__intent`）已通过随主阶段 `invokeChatCompletion` 返回实现零额外往返（而总管自然语言回退解析为 C3，仅在人类主动发起对话回退时独立调用 LLM）。若成本敏感，后续也可考虑进一步复用或缓存动态需求。
