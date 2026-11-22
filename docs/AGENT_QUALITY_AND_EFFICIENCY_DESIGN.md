# Agent 质量、跨模型缓存、Token/死循环治理与反迎合协商设计及验收标准

> 状态：2026-11-23 定稿（第十轮实施规范与验收基线）。  
> 本文针对多智能体协同研发流水线落地中的 4 个核心工程问题——**多模型准确率稳定性**、**跨模型缓存命中治理**、**Token 经济性与工具/重试防死循环**、**对抗式协商与防虚假共识**——给出落地方案、正式交付标准（DS-1 ~ DS-4）及量化验收标准（AC-1 ~ AC-12）。

---

## 一、 四大工程问题与系统落地方案

### 1.1 Pillar 1：多模型准确率稳定性（`ModelRouterGateway` + `StagePromptSpecs` + 确定性校验）

| 痛点                    | 现有缺口                                                                         | 本轮工程方案                                                                                                                                                                                                                                                                                                                                                           |
| :---------------------- | :------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仅靠自然语言要求 JSON   | 未利用推理网关底层约束解码，中小模型易漏字段/套围栏                              | `ModelEndpointDescriptor` 新增 **`ModelCapabilityProfile`**（`qualityRank`、`supportsJsonSchema`、`recommendedTemperature`、`preferFewShotExample`、`supportsPromptPrefixCache`）；支持 `json_schema` 的端点由 `invokeChatCompletion()` 下发 `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }`，不支持时平滑回落 `json_object`。 |
| 强弱模型共用一套 Prompt | 7B–32B 本地模型缺少结构化 1-shot 锚点                                            | `StagePromptSpecs` 为 6 个核心阶段补充精确 `jsonSchema` 与精简 `compactExampleJson`；当激活端点 `preferFewShotExample === true` 时在首次尝试自动附带 compact 1-shot 示例，并将采样 `temperature` 绑定至端点画像（默认 `0`）。                                                                                                                                          |
| 非代码阶段缺少语义兜底  | PM/PD/TechLead 仅校验"非空"，无法拦截占位符（`TBD`/`待定`/`...`）或非法 HTTP/DDL | 在 `ProductManagerAgent`、`ProductDesignerAgent`、`TechLeadAgent` 实现 **`validateStageSpecificConstraints()`**，用确定性规则拦截占位符、未覆盖的 Story/Tracking/UI Mapping、非法 HTTP 方法/非 `/` 路径、非法 SQL DDL 动词，以及涉 DDL/权限/支付需求却自报 `LOW` 风险。                                                                                                |
| L0 前缀缓存命中不可观测 | 网关未记录 `prompt_tokens_details.cached_tokens`                                 | `ModelInvocationReceipt` 新增 `cachedPromptTokens`，实时观测提供商侧 KV 前缀缓存收益。                                                                                                                                                                                                                                                                                 |

---

### 1.2 Pillar 2：跨模型缓存治理（`PromptCacheManager` + `EmbeddingProvider`）

不同对话模型与不同 Embedding 模型在混合路由下的缓存必须遵循**“防质量倒挂、空间严隔离、版本可失效”**三项铁律：

1. **L0 推理引擎 KV 前缀缓存（同模型粘性复用）**
   - `StagePromptSpecs` 维持 `COMMON_DISCIPLINE` 等静态纪律前缀前置、动态载荷后置的排序；单次 Run 内按绑定层级的端点粘性路由，并通过 `cachedPromptTokens` 计量命中量。
2. **L1 精确产物缓存（可跨对话模型，但禁止弱污染强）**
   - 每个 `CacheEntryRecord` 记录 **`modelQualityRank`、`modelIdentifier`、`promptSpecHash`、`embeddingSpaceId`**。
   - **单向复用规则**：允许**高能力模型（如 `qualityRank = 90`）**产出的已验证契约被**低能力模型（如 `qualityRank = 65`）**直接命中复用（省钱、提质）；**禁止低能力模型缓存拦截高能力模型请求**（当检索方 `minQualityRank > entry.modelQualityRank` 时主动绕过 L1 并累计 `qualityUpgradeBypasses`）。
   - **禁止降级覆写**：同 `promptSpecHash` 下，`storeVerifiedArtifact()` 若发现已有更高 `modelQualityRank` 的条目，低排名条目不得反向覆写。
   - **Prompt 版本隔离**：`computePromptSpecHash(stageId)` 基于 `STAGE_PROMPT_VERSION` 与阶段规范生成摘要，Prompt 模板或 Schema 演进后旧版本缓存自动隔离（累计 `crossSpaceSkips`），不污染新输出。
3. **L2 语义意图缓存（按 Embedding 空间 + Prompt 版本 + 阶段严密分桶）**
   - `EmbeddingProvider` 暴露 `modelIdentifier`，`PromptCacheManager` 以 `embeddingSpaceId`（如 `gateway-embeddings::bge-m3-local`）绑定每条 `L2SemanticEntry`。
   - **严格同空间比对**：仅当 `candidate.embeddingSpaceId === activeSpaceId`、`candidate.stageId === stageId` 且 `promptSpecHash` 一致时才计算余弦相似度；切换 Embedding 模型（如 `bge-m3` → `text-embedding-3-small`）时自动隔离旧向量并累计 `crossSpaceSkips`，杜绝跨向量空间乱算余弦引发误命中。

---

### 1.3 Pillar 3：Token 节省与防工具/重试死循环（`AbstractWorkerAgent` + `ToolRegistry`）

1. **违规签名停滞检测与自动升舱/提前熔断（Stagnation Breaker & Model Escalation）**
   - `AbstractWorkerAgent` 在步骤 4 自愈重试循环中记录上一轮归一化违规签名 `previousViolationSignature`。
   - 若连续两轮出现**完全相同的违规签名**（陷入停滞）：
     - 若当前处于本地小模型（`PRIVACY_SENSITIVE_LOCAL`）且仍在离线模板之外的真实模型调用、`attemptIndex < maxExecutionRetries`：自动将 `activeTier` **升舱至 `HIGH_REASONING_HYBRID`**（强模型破局），重置违规签名并携带先验违规重试一次；
     - 若已处于高阶模型或模板路径：立即注入 `STAGNATION_CIRCUIT_BREAKER` 退出循环，避免在无进展状态白烧剩余重试次数。
2. **局部靶向修复提示（`TARGETED_PATCH`）**
   - 当首轮 JSON 已被成功解析但触犯部分约束时，次轮 Prompt 注入 `repairMode: 'TARGETED_PATCH'` 与 `previousValidKeys`，指导模型保留已合法字段、仅修正报错字段，压缩无效重试思考与修正开销。
3. **工具调用防环三件套（`ToolCallLoopGuard` + `ToolRegistry`）**
   - 独立可复用的 **`ToolCallLoopGuard`** 强制执行三道护栏：
     1. **参数级去重（`deduplicatedCalls`）**：同作用域内相同 `(toolName, args)` 直接复用缓存并阻止重复外部调用；
     2. **单阶段调用次数上限（`maxCallsPerStage`，默认 `8`）**：超出即阻断并记入 `budgetBlockedCalls`；
     3. **单次结果体积截断（`maxCharsPerResult`，默认 `6000`）**：超长外部输出自动截断并标记 `truncated: true`、`truncatedResults + 1`，防止单工具结果撑爆上下文窗口。

---

### 1.4 Pillar 4：反迎合对抗式协商与语义防伪共识（`BoundedNegotiationMediator` + `WorkflowOrchestratorFacade` + `FalseConsensusGuard`）

针对单个 LLM 自导自演协商容易“第一轮就和稀泥 `consensusReached: true`”的问题，实施四层隔离与校验：

1. **历史上下文透传 + 离散动作协议（`BoundedNegotiationMediator`）**
   - `NegotiationRoundRunner` 显式接收累计交锋历史 **`previousTurns`**，不再“每轮失忆”。
   - 响应方必须返回枚举动作 `action`（而非仅布尔自评）：
     - `ACCEPT_AND_PATCH`：采纳意见并给出具体可验证的 `concretePatch`；
     - `REBUT_WITH_EVIDENCE`：给出技术/规范依据进行反驳；
     - `ESCALATE_TRADEOFF`：承认触及范围/工期/体验/安全权衡——**状态机立即置 `escalated = true` 并终止剩余协商轮次**，直接生成 A/B 对比卡交人类拍板，禁止 AI 私自替业务降级或白耗后续轮次 Token。
2. **双独立上下文隔离（`Responder` ≠ `Challenger`）**
   - `WorkflowOrchestratorFacade` 的 `negotiationMediator` 将单轮拆为独立调用：
     - **Step A（响应方独立调用）**：赋予“保住核心需求与 AC、禁止软删减”职责 KPI；
     - **Step B（挑战方独立复核调用）**：独立的系统 Prompt（明确“若对方未提供具体修补方案或存在隐性阉割，拒绝妥协并触发总管熔断是正确结果”），输出 `{ accepted, critique, containsImplicitScopeCut }`；一旦拒绝或发现隐性缩水，本轮绝不宣布共识，并将 `critique` 传给下一轮。
   - **向后兼容保留**：若测试注入的旧版 mock 响应不含 `action` 且含合法 `{ responseResolution, consensusReached }`，保留兼容通道以稳定回归既往集成用例。
3. **无历史盲审裁判（Fresh-Context Blind Judge）**
   - 仅当挑战方复核通过时，额外发起一次**不携带多轮客套历史**的独立盲审调用，仅传入 `challengeContext` + `responseResolution` + `concretePatch`，专门检测 `{ hasImplicitDowngrade, reason }`。若盲审判定存在软降级/放宽验收标准，直接否决该轮伪共识。
4. **语义不变量守卫（`FalseConsensusGuard.evaluateSemanticInvariants`）**
   - 在保留原有 `evaluateScopeIntegrity()` 需求 ID 差集检测基础上，新增 **`evaluateSemanticInvariants()`**：拦截摘要/关键字段中出现的“TBD/待定/暂不实现/后续补充”等软阉割占位措辞、拦截涉 DDL/权限支付提案却声明 `declaredRiskLevel = LOW` 的低报行为、以及拦截 QA 存在安全漏洞却声称 `allAcceptanceCriteriaMet = true` 的自相矛盾产物。

---

## 二、 正式交付标准（Delivery Standards）

任何角色 Agent 或模型路由进入流水线可交付状态，必须同时满足以下 4 项硬性标准：

| 标准编号 | 名称                       | 强制交付要求                                                                                                                                                                                                                                                               | 责任模块                                                                          |
| :------- | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| **DS-1** | **结构与契约严格完整**     | 优先通过网关 `json_schema (strict: true)` 约束输出；所有产物必须通过 `ArtifactContractFactory.parse()` 与 `validateContractIntegrity()`；小模型启用 1-shot 结构化锚点且默认确定性采样（`temperature = 0`）。                                                               | `ModelRouterGateway`、`StagePromptSpecs`、`ArtifactContractFactory`               |
| **DS-2** | **阶段语义真值可核验**     | 非代码阶段禁止含占位词（`TBD`/`TODO`/`待定`/`暂不实现`），PM/PD 必须全量覆盖 `coreRequirementIds` 且带可测 AC / 组件状态，TechLead HTTP 方法与 SQL DDL 语法须合法且不低报风险；代码与 QA 阶段须与真实沙箱运行结果一致（防谎报）。                                          | 各子类 `validateStageSpecificConstraints()`、`FalseConsensusGuard`                |
| **DS-3** | **缓存安全与资源可收敛**   | 跨模型 L1/L2 缓存严禁低质量模型产出拦截高能力模型（`qualityUpgradeBypasses` 可观测），切换 Embedding 模型或 Prompt 版本自动分桶隔离（`crossSpaceSkips` 可观测）；单轮重试出现连续同错触发小模型升舱或 `STAGNATION_CIRCUIT_BREAKER`；工具调用受去重/次数上限/结果截断保护。 | `PromptCacheManager`、`AbstractWorkerAgent`、`ToolRegistry`                       |
| **DS-4** | **协商诚实与权衡显式上交** | 多轮协商传递上下文历史；发现业务权衡（`ESCALATE_TRADEOFF`）立即停止内耗并呈递 A/B 方案交人类决策；任何协商共识须经挑战方独立复核及无历史盲审裁判双关确认，禁止互相迎合与软阉割需求。                                                                                       | `BoundedNegotiationMediator`、`WorkflowOrchestratorFacade`、`FalseConsensusGuard` |

---

## 三、 量化验收标准（Acceptance Criteria）

以下 12 条验收标准与自动化测试套件 [`tests/agent-quality-efficiency.spec.ts`](../tests/agent-quality-efficiency.spec.ts)（AC-1 ~ AC-11）及全库回归门禁（AC-12）一一对应：

| 验收项    | 验证目标                             | 通过门槛（Pass Criteria）                                                                                                                                                                                             | 对应测试                                |
| :-------- | :----------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------- |
| **AC-1**  | 网关结构化解码与 KV 缓存计量         | `supportsJsonSchema=true` 时下发 `response_format.type='json_schema'`（`strict: true`）；`supportsJsonSchema=false` 回落 `json_object`；`receipt.cachedPromptTokens` 准确读取 `prompt_tokens_details.cached_tokens`。 | `agent-quality-efficiency.spec` Test 1  |
| **AC-2**  | 模型适配 Prompt 与非代码确定性校验   | 小模型画像（`preferFewShotExample=true`）首轮 Prompt 含 1-shot 示例；TechLead 拦截非法 HTTP 动词、非 DDL 语句与高危需求低报 `LOW`；PM 拦截 `TBD`/`待定` 占位符且保留 `forceScopeReduction` 进入 Step 5。              | `agent-quality-efficiency.spec` Test 2  |
| **AC-3**  | L1 跨模型单向质量治理（防倒挂）      | `qualityRank=90` 存入后可被 `qualityRank=65` 命中复用；反之 `qualityRank=65` 存入后请求方为 `90` 时触发绕过（`isHit=false`, `qualityUpgradeBypasses=1`），且高阶产物回写后不被低阶再次覆盖。                          | `agent-quality-efficiency.spec` Test 3  |
| **AC-4**  | L2 Embedding 空间与 Prompt 版本隔离  | 更换 Embedding 模型或变更 `promptSpecHash` 后，旧 L2 向量不参与余弦命中（`isHit=false`, `crossSpaceSkips > 0`），绝不跨向量空间误命中。                                                                               | `agent-quality-efficiency.spec` Test 4  |
| **AC-5**  | 停滞检测自动升舱 & 提前熔断          | 本地模型连续两次触发相同违规时自动升舱至 `HIGH_REASONING_HYBRID` 并最终成功；高阶模型连续两次同错在 `maxExecutionRetries=4` 耗尽前提前抛出含 `STAGNATION_CIRCUIT_BREAKER` 的 `StageContractError`。                   | `agent-quality-efficiency.spec` Test 5  |
| **AC-6**  | 靶向局部修复提示                     | 部分校验失败进入重试时，次轮 Prompt 载荷包含 `repairMode: 'TARGETED_PATCH'` 与 `previousValidKeys` 清单。                                                                                                             | `agent-quality-efficiency.spec` Test 6  |
| **AC-7**  | 工具调用防死循环守卫                 | 相同 `(toolName, args)` 被去重复用（`deduplicatedCalls > 0`）；超 `maxCallsPerStage` 触发拦截（`budgetBlockedCalls > 0`）；超长输出被截断并设 `truncated=true`（`truncatedResults > 0`）。                            | `agent-quality-efficiency.spec` Test 7  |
| **AC-8**  | 协商 `ESCALATE_TRADEOFF` 即时熔断    | `maxNegotiationTurns=3` 下第 1 轮返回 `ESCALATE_TRADEOFF` 时，仅执行 1 轮即设 `escalatedToSupervisor=true` 并向人类输出 A/B 方案（节省第 2/3 轮 Token）。                                                             | `agent-quality-efficiency.spec` Test 8  |
| **AC-9**  | 对抗式双独立复核与历史透传           | 第 1 轮响应方自称 `ACCEPT_AND_PATCH` 但挑战方独立复核否决时，不宣布共识；第 2 轮收到完整 `previousTurns` 并在修订补丁获双方通过及盲审放行后，方才达成真共识。                                                         | `agent-quality-efficiency.spec` Test 9  |
| **AC-10** | 盲审裁判拦截“迎合式软降级”           | 响应方与挑战方均“同意通过”，但无历史盲审裁判识别 `hasImplicitDowngrade=true` 时，伪共识被否决并在满轮后触发总管熔断。                                                                                                 | `agent-quality-efficiency.spec` Test 10 |
| **AC-11** | `FalseConsensusGuard` 语义不变量校验 | 在 `coreRequirementIds` 数量与 ID 完好无损下，仍能检出占位软阉割、高危低报 `LOW` 与“带漏洞宣称全部验收通过”的矛盾。                                                                                                   | `agent-quality-efficiency.spec` Test 11 |
| **AC-12** | 工程质量与全库零回归门禁             | `npm run typecheck:backend`、`npm run lint:backend`、`npx prettier --check` 零报错；新增套件与全库既有测试 0 失败。                                                                                                   | 全库 CLI + `npm test`                   |
