# Agent 模块架构与工作流程说明书 (`src/agents/`)

本文档专门针对 `src/agents/` 模块的面向对象设计模式、各职能 Agent 的职责边界以及完整工作流程进行详细说明。

---

## 一、 面向对象设计模式矩阵

系统严格杜绝函数式面条代码或硬编码 Hack，所有 Agent 均由以下标准设计模式构建：

| 设计模式                                 | 核心承载类                                                                                                                   | 架构作用                                                                                                                                                                                                                                                                                                                                                                                                        |
| :--------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **模板方法模式 (Template Method)**       | `AbstractWorkerAgent<TArtifact>` (`src/agents/AbstractWorkerAgent.ts`)                                                       | 在基类 `executeStagePipeline()` 中固化不可逾越的 **7 步标准生命周期**；接入 `ModelCapabilityProfile`（`json_schema` 约束解码与小模型 1-shot 锚点）、`TARGETED_PATCH` 局部修复提示及连续同错停滞自动升舱/`STAGNATION_CIRCUIT_BREAKER`；子类必选实现 `recognizeStageIntent()` 与 `synthesizeTemplateArtifact()`，可选覆写 `prepareStageEnvironment()` 与 `validateStageSpecificConstraints()` 共 4 个受保护钩子。 |
| **中介者模式 (Mediator)**                | `BoundedNegotiationMediator` (`src/agents/BoundedNegotiationMediator.ts`)                                                    | 解耦下游质询 Agent（PD / QA）与上游响应 Agent（PM / Engineer）的 `DESIGN_REVIEW` / `QA_REPAIR` 对抗式多轮博弈：透传 `previousTurns`、要求 `ACCEPT_AND_PATCH`/`REBUT_WITH_EVIDENCE`/`ESCALATE_TRADEOFF` 离散动作（权衡即刻熔断），结合 Facade 内挑战方独立复核与无历史盲审裁判抑制互相迎合，并将 `totalTokensConsumed` 计入 `runState`。                                                                         |
| **命令模式 & 总管工具 (Command/Tools)**  | `SupervisorAgent`, `EscalateConflictToHumanCommand`, `supervisorTools.ts` (`src/agents/`)                                    | 用 `EscalateConflictToHumanCommand` 封装冲突上报命令；同时通过 `src/agents/supervisorTools.ts`（C2：`get_run_overview`、`summarize_conflict`、`override_gate`、`rollback_and_fork`）严格限制总管调度入口，严禁篡改业务产物。                                                                                                                                                                                    |
| **注册表模式 (Registry)**                | `AgentRegistry` (`src/agents/AgentRegistry.ts`), `ToolRegistry` / `ToolCallLoopGuard` (`src/agents/context/ToolRegistry.ts`) | `AgentRegistry` 管理 J2 自定义检查点阶段与角色映射；`ToolRegistry` 配合 `ToolCallLoopGuard` 管理外部上下文 Provider 解析、参数去重、单阶段调用次数预算上限、超长结果截断与 Token 预算裁剪。                                                                                                                                                                                                                     |
| **备忘录模式 (Memento)**                 | `StageSnapshotMemento` (`src/domain/models.ts`), `DagWorkflowStateEngine` (`src/engine/DagWorkflowStateEngine.ts`)           | 每阶段产出不可变快照；回退时将旧分支下游快照标记为 `SUPERSEDED` 并 Fork 新分支，彻底隔离脏数据。                                                                                                                                                                                                                                                                                                                |
| **责任链模式 (Chain of Responsibility)** | `AbstractRiskRuleHandler`, `RiskEvaluationPipeline` (`src/patterns/RiskEvaluationChain.ts`)                                  | 串联协商熔断、Scope 缩减、数据库 DDL 变更、核心安全域等风险评估节点，动态决定自动放行或人工阻塞。                                                                                                                                                                                                                                                                                                               |

> **目录协同结构（`src/agents/`）**：除核心 Agent 类与 `AgentRegistry.ts` / `supervisorTools.ts` 外，还包括 `prompt/`（`StagePromptSpecs.ts` 公共纪律前缀、Stage JSON Schema/1-shot 示例、版本哈希与 `JsonExtractor.ts` JSON 容错提取）、`deserialize/`（`ArtifactContractFactory.ts` 强类型契约反序列化与完整性校验）以及 `context/`（8 个文件：`types.ts`、`ToolRegistry.ts`、`ContextBudgetTrimmer.ts`、`GitContextProvider.ts`、`McpContextProvider.ts`、`StubProviders.ts`、`WarehouseQueryProvider.ts`、`UpstreamCompressor.ts`）。完整质量与交付/验收规范详见 [`AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md`](./AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md)。

---

## 二、 职能 Agent 的 7 步标准生命周期 (`AbstractWorkerAgent.ts`)

每一个职能 Agent 被状态机唤醒时，严格按以下 7 步执行：

1. **步骤 1：上下文组装与负向经验注入 (Context Assembly & Negative RAG)**
   - 读取当前活跃分支上游已批准阶段的契约产物（`upstreamArtifacts`，经 `UpstreamCompressor` 压缩为关键决策字段）。
   - `WorkflowOrchestratorFacade` 调用 `ImmutableAuditLedger.getRejectionLessonsForStage()`（G2：1536 维向量检索 / 离线哈希兜底，带 `matchDegraded` 标记），经 `AgentExecutionInputContext.historicalRejectionLessons` 注入本阶段，防止重犯历史架构或交互错误。
   - Facade 经 `ToolRegistry`（内嵌 `ToolCallLoopGuard` 防重复/超次/超长上下文）预取外部知识（Git 代码结构/Figma 组件/数仓指标 + LLM 动态需求），Agent 从 `runCache` 读取并注入 Prompt。
2. **步骤 2：意图识别与前端实时广播 (Intent Recognition)**
   - 经 `resolveStageIntent()` 解析意图（A4：按 `阶段 + 核心需求签名 + 回退指令` 作用域优先复用同构需求 LLM 顺带输出的 `__intent`，不同需求提案/首次/离线回落子类规则，防止跨提案串味）。
   - 通过 `WorkflowEventBus` 向前端实时广播 `RECOGNIZING_INTENT` 事件。
3. **步骤 3：双层缓存前置拦截 (Two-Tier Cache Lookup)**
   - 生成 L1 精确上下文签名与 L2 语义意图**向量**（embedding 余弦 ≥ 0.86，G1），按 `minQualityRank`（防弱模型污染强模型）、`promptSpecHash` 与 `embeddingSpaceId` 分桶检索 `PromptCacheManager`。
   - 若命中缓存，广播 `CACHE_HIT` 事件，零 Token 消耗直接返回已验证契约产物，并在复盘追踪器记为 `FULFILLED_VIA_CACHE`。
4. **步骤 4：物理沙箱准备、混合模型路由与自愈重试循环 (Sandbox Prep, BYOM Routing & Self-Healing Loop)**
   - 先调用 `prepareStageEnvironment()` 执行阶段物理环境准备（Stage 3b 真实创建 Git Worktree 沙箱、落盘代码并自测；Stage 4 真实执行 `node:test`/Docker 测试与安全扫描），将真实结果作为 `sandboxVerification` 注入阶段 Prompt（离线模板降级复用同一准备结果，避免重复执行子进程）。
   - **B3 预算前置守卫**：每次模型尝试前检查 `tokenBudgetRemaining`，不足时不再重试——直接记入 `FAILED_CONTRACT` 追踪并抛出 `TokenBudgetExceededError`（由 Facade 捕获并置为 `ABORTED_TOKEN_BUDGET`；当前熔断通知中的 `RETRY_STAGE` 见 `BACKEND_TODO.md` §五 `#10`）。
   - 按 `activeTier` 解析端点 `ModelCapabilityProfile`：支持 `json_schema` 时下发严格 JSON Schema 约束（不支持回落 `json_object`），按 `preferFewShotExample` 为小模型注入 1-shot 示例，并记录提供商侧 `cachedPromptTokens`；重试时携带 `priorViolations`、`repairMode: 'TARGETED_PATCH'` 与 `previousValidKeys` 局部修补。
   - LLM 输出经 `JsonExtractor` → `ArtifactContractFactory` 构造强类型契约；对产物同时执行 `validateContractIntegrity()` 与 `validateStageSpecificConstraints()`（PM/PD/TechLead 拦截占位符/非法 HTTP 与 DDL/高危低报；QA/Engineer 拦截谎报测试与漏洞）；连续两轮相同违规签名时，本地小模型自动升舱 `HIGH_REASONING_HYBRID`，高阶模型则提前触发 `STAGNATION_CIRCUIT_BREAKER` 避免空转。
5. **步骤 5：防“虚假共识”与范围篡改校验 (False Consensus Guard)**
   - 调用 `FalseConsensusGuard.evaluateScopeIntegrity()` 对比原始提案的核心需求 ID 集合（`FalseConsensusGuard` 另提供 `evaluateSemanticInvariants()` 用于检测未删 ID 的软阉割、高危低报及矛盾 QA 结论）。
6. **步骤 6：合格契约产物缓存回填 (Verified Cache Write-Back)**
   - 若契约校验通过且无非法范围缩减，携带当前 `modelQualityRank`、`modelIdentifier`、`promptSpecHash` 与 `stageId` 写入 L1 精确缓存与 L2 语义向量缓存池（G1：意图文本先 embedding，失败仅写 L1；低等级不覆写同版本高等级 L1）。
7. **步骤 7：复盘遥测与意图达成率记账 (Telemetry Recording)**
   - 对执行成功路径将最终状态（`FULFILLED_ON_FIRST_TRY` / `FULFILLED_AFTER_RETRY`）、重试次数与 Token 成本写入 `IntentFulfillmentTracker`（命中缓存路径已于步骤 3 记为 `FULFILLED_VIA_CACHE`，预算超限与重试耗尽路径已于步骤 4 记为 `FAILED_CONTRACT`）。

---

## 三、 六大专业职能 Agent 与总管 Agent 清单

1. **`ProductManagerAgent` (`STAGE_1_PM`)**：拆解业务提案为结构化 User Stories 与验收标准（AC），同步前置生成《数据埋点规划（Tracking Plan）》，并在 `validateStageSpecificConstraints` 拦截 `TBD`/占位词及缺失 Story 的核心需求。
2. **`ProductDesignerAgent` (`STAGE_2_PD`)**：映射企业 Design System 组件与交互状态机（拦截占位词/缺失组件映射与状态）；发现可行性冲突时生成 `designChallengeNote` 向 PM Agent 发起对抗式受限协商。
3. **`TechLeadAgent` (`STAGE_3A_TECH_SPEC`)**：在写代码前制定 API 接口契约与数据库 DDL 变更脚本（校验合法 HTTP 动词、`/` 路径前缀、SQL DDL 动词及高危需求不低报 `LOW`），触发架构高风险门禁审核。
4. **`SoftwareEngineerAgent` (`STAGE_3B_ENGINEER`)**：路由至本地私有代码大模型，在隔离的真实 Git Worktree 分支沙箱（E1；`SANDBOX_RUNTIME=docker` 时单测进一次性容器执行，E3）中编写面向对象业务类与单元测试。
5. **`QualityAssuranceAgent` (`STAGE_4_QA`)**：对照 Stage 1 验收标准，在真实沙箱（`node:test` E2 / 可选 `SANDBOX_RUNTIME=docker` E3）中执行验收测试、契约完整性校验与静态安全扫描，守卫上线前最后一道门禁；验证失败自动质询 Engineer 触发 B2 修复闭环（上限 `MAX_AUTO_REPAIRS = 2`，超限触发仲裁）。
6. **`DataAnalystAgent` (`STAGE_5_DA`)**：核验前置埋点事件覆盖率，构建发布后交付周期与业务转化归因模型；经 `createAnalyticsProvider()` 优先挂载真实数仓指标（G11：`WAREHOUSE_MCP_URL` > `WAREHOUSE_CONNECTION_STRING` > `WarehouseStubProvider`）。
7. **`SupervisorAgent` (总管 Agent)**：负责接管达到 `maxNegotiationTurns` 上限的协商死锁，生成《冲突裁决卡》推送给人类；经四工具契约（C2：`get_run_overview` / `summarize_conflict` / `override_gate` / `rollback_and_fork`）操作流水线，NL 回退指令经 LLM 解析（C3，按活跃运行阶段流水线 `allowedStages` 或 `WorkflowStageId ∪ AgentRegistry.default().listCustomStages()` 校验拦截注入，兼容 J2 自定义节点）驱动 DAG 状态机分叉回退。
