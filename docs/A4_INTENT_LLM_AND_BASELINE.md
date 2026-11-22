# A4 实现文档：意图识别 LLM 化 + 模型体检端点

> 对应 `BACKEND_TODO_DESIGN.md` §A4（P1），2026-11-23 完成。替代最后一个 Mockup（M5 规则意图）。
> 至此 6 个职能 Agent 的 M1-M7 Mockup 全部替代完毕。

## 问题背景

`recognizeStageIntent` 为规则拼串（如 `PRD_SYNTHESIS_AND_TRACKING_PLAN_2_REQS`）——意图编码不反映提案语义，
且 L2 缓存键依赖它（语义质量有限）。A4 的设计约束：**保持同步签名**（缓存键依赖），避免单独一次 LLM 往返。

## 实现方案

### 1. `__intent` 随主调用返回（零额外 LLM 往返）

- `buildStagePrompt` 在 JSON Schema 提示后追加固定指令：顶层必须包含
  `"__intent": { intentCode, intentDescription, confidenceScore }`。
- `executeStagePipeline` 解析主输出后、契约工厂解析前捕获 `__intent`（工厂忽略未知字段，互不影响）：
  - `captureLlmIntent`：intentCode 非空校验（空/缺失静默忽略）、截断（code ≤64 字符、描述 ≤120）、置信度边界处理；
  - 存入 Agent 实例级 `llmIntentByScope`（按 `stageId + 核心需求 ID/描述签名 + 回退指令` 作用域隔离——同构需求跨 run 零额外往返复用，不同业务提案互不串味）。
- `resolveStageIntent`（基类新增，替代调用点直调抽象方法）：优先匹配当前需求作用域下的 `llmIntentByScope`，未命中则回落子类规则实现。
  6 个子类的规则实现原样保留 = 兜底路径。

### 2. 模型体检端点

- `ModelRouterGateway.runModelBaselineCheck()`：
  - 3 个固定 JSON 任务（FLAT_OBJECT / NESTED_ARRAY / ENUM_FIELD，各带 requiredKeys）；
  - 对两级对话端点（`PRIVACY_SENSITIVE_LOCAL` + `HIGH_REASONING_HYBRID`）各发 3 次 `invokeChatCompletion`
    → `evaluateEndpointBaseline`（新增可选 `taskName` 字段）→ 汇总报告；
  - 离线（无 live HTTP 且无注入 transport）→ `{offline: true, reports: []}`，零网络调用；
  - 单任务失败不阻断其余任务（报告缺失即未通过）。
- `POST /api/admin/model-baseline`（admin-only，沿用既有 tier 校验模式）——替换原先只评估一份
  硬编码样例的占位实现。

### 3. 治理视图"模型体检"按钮（React）

- `WorkbenchApiClient.runModelBaseline()` + `ModelBaselineCheckDto/ModelBaselineReportDto` 类型。
- `AdminGovernanceView` 流程规则面板新增按钮：非 admin 禁用（🔒 提示）；执行中显示 ⏳；
  结果按层级一行化（`3/3 通过` pill + 模型名 + 缺失字段汇总），离线时 banner 提示。

## 边界处理

1. **首个 run 只能用规则意图**：意图识别发生在 LLM 调用之前（同步签名约束）——run 1 用规则、
   run 2 起复用（测试 1 断言了该时序）。
2. **非法 `__intent`**（空 code / 缺字段 / 非对象）→ 静默忽略，不污染意图缓存（测试 2）。
3. **离线模板模式**：fallback 产物不含 `__intent` → 永远规则意图（与旧行为一致）。
4. **体检端点离线**：返回 offline 标记而非伪造报告（诚实口径）；默认模式（未开启 `AUTH_REQUIRED`/`AUTH_DISABLED`）下未认证/非管理员请求返回 `403`，开启 `AUTH_REQUIRED=true` 时无有效会话将在全局会话守卫层拦截返回 `401`。

## 验证（tests/a4-intent-and-baseline.spec.ts，5 项）

1. `__intent` 捕获时序与作用域隔离：run 1 规则意图（LLM 调用前）→ run 2 同构需求复用 `PRD_LLM_INTENT_E2E` → run 3 不同需求集合不串味，回落规则意图 `PRD_SYNTHESIS_AND_TRACKING_PLAN_1_REQS`
2. 空 `intentCode` → 回落规则意图（`PRD_SYNTHESIS_AND_TRACKING_PLAN_1_REQS`）
3. 体检端点离线 → `offline:true` + 零报告
4. 体检端点在线（mock transport）→ 2 层级 × 3 任务 = 6 份报告全通过、含 taskName
5. 默认模式下无会话 → 403

**完成时测试基线**：112 项（108 过 / 4 既有 skip / 0 失败）；typecheck（含前端）+ eslint + prettier 全绿；UI bundle 已构建。（当前全库基线：143 项 / 45 套件，139 过 / 4 既有 skip）

## 遗留

- `llmIntentByScope` 为 Agent 实例级缓存，未持久化（D1 恢复后首个 run 回落规则意图——语义无损，暂不处理）。
