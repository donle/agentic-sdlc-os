# Agent 模块架构与工作流程说明书 (`src/agents/`)

本文档专门针对 `src/agents/` 模块的面向对象设计模式、各职能 Agent 的职责边界以及完整工作流程进行详细说明。

---

## 一、 面向对象设计模式矩阵

系统严格杜绝函数式面条代码或硬编码 Hack，所有 Agent 均由以下标准设计模式构建：

| 设计模式 | 核心承载类 | 架构作用 |
| :--- | :--- | :--- |
| **模板方法模式 (Template Method)** | `AbstractWorkerAgent<TArtifact>` | 在基类 `executeStagePipeline()` 中固化不可逾越的 **7 步标准生命周期**，子类仅实现 `recognizeStageIntent()`、`synthesizeArtifact()` 与 `estimateTokenUsage()` 三个受保护钩子。 |
| **中介者模式 (Mediator)** | `BoundedNegotiationMediator` | 解耦下游质询 Agent（如 PD / QA）与上游响应 Agent（如 PM / Engineer）的多轮博弈，强制执行 `maxNegotiationTurns` 讨论上限熔断。 |
| **命令模式 (Command)** | `SupervisorAgent`, `ISupervisorCommand`, `EscalateConflictToHumanCommand` | 将总管 Agent 的冲突上报、门禁裁决与 DAG 分叉回退封装为标准命令对象，确保总管只做调度而不越权篡改业务产物。 |
| **备忘录模式 (Memento)** | `StageSnapshotMemento`, `DagWorkflowStateEngine` | 每阶段产出不可变快照；回退时将旧分支下游快照标记为 `SUPERSEDED` 并 Fork 新分支，彻底隔离脏数据。 |
| **责任链模式 (Chain of Responsibility)** | `AbstractRiskRuleHandler`, `RiskEvaluationPipeline` | 串联协商熔断、Scope 缩减、数据库 DDL 变更、核心安全域等风险评估节点，动态决定自动放行或人工阻塞。 |

---

## 二、 职能 Agent 的 7 步标准生命周期 (`AbstractWorkerAgent.ts`)

每一个职能 Agent 被状态机唤醒时，严格按以下 7 步执行：

1. **步骤 1：上下文组装与负向经验注入 (Context Assembly & Negative RAG)**
   * 读取当前活跃分支上游已批准阶段的契约产物（`upstreamArtifacts`）。
   * 从 `ImmutableAuditLedger` 检索该阶段历史上被人类驳回的批注（`historicalRejectionLessons`），防止重犯同类架构或交互错误。
2. **步骤 2：意图识别与前端实时广播 (Intent Recognition)**
   * 调用 `recognizeStageIntent()` 解析本次任务的具体意图编码（`intentCode`）与置信度。
   * 通过 `WorkflowEventBus` 向前端实时广播 `RECOGNIZING_INTENT` 事件。
3. **步骤 3：双层缓存前置拦截 (Two-Tier Cache Lookup)**
   * 生成 L1 精确上下文签名与 L2 归一化语义意图指纹，查询 `PromptCacheManager`。
   * 若命中缓存，广播 `CACHE_HIT` 事件，零 Token 消耗直接返回已验证契约产物，并在复盘追踪器记为 `FULFILLED_VIA_CACHE`。
4. **步骤 4：混合模型路由与自愈重试循环 (BYOM Routing & Self-Healing Loop)**
   * 根据角色绑定的 `ModelRoutingTier`（本地私有模型 `PRIVACY_SENSITIVE_LOCAL` vs 高阶推理模型 `HIGH_REASONING_HYBRID`）调用 `ModelRouterGateway` 计量推理。
   * 对生成的产物执行 `validateContractIntegrity()` 契约校验；若失败且未超过 `maxExecutionRetries`，向前端广播 `RETRYING` 状态并自愈重试。
5. **步骤 5：防“虚假共识”与范围篡改校验 (False Consensus Guard)**
   * 调用 `FalseConsensusGuard.evaluateScopeIntegrity()` 对比原始提案的核心需求 ID 集合，防止 Agent 为达成妥协擅自删减业务范围。
6. **步骤 6：合格契约产物缓存回填 (Verified Cache Write-Back)**
   * 若契约校验通过且无非法范围缩减，将产物写入 L1 与 L2 缓存池。
7. **步骤 7：复盘遥测与意图达成率记账 (Telemetry Recording)**
   * 将意图达成状态（`FULFILLED_ON_FIRST_TRY` / `FULFILLED_AFTER_RETRY` / `FAILED_CONTRACT`）、重试次数与 Token 成本写入 `IntentFulfillmentTracker`。

---

## 三、 六大专业职能 Agent 与总管 Agent 清单

1. **`ProductManagerAgent` (`STAGE_1_PM`)**：拆解业务提案为结构化 User Stories 与验收标准（AC），并同步前置生成《数据埋点规划（Tracking Plan）》。
2. **`ProductDesignerAgent` (`STAGE_2_PD`)**：映射企业 Design System 组件与交互状态机；发现可行性冲突时生成 `designChallengeNote` 向 PM Agent 发起受限协商。
3. **`TechLeadAgent` (`STAGE_3A_TECH_SPEC`)**：在写代码前先行制定 API 接口契约与数据库 DDL 变更脚本，触发架构高风险门禁审核。
4. **`SoftwareEngineerAgent` (`STAGE_3B_ENGINEER`)**：路由至本地私有代码大模型，在隔离的 Git Worktree 分支沙箱中编写面向对象业务类与单元测试。
5. **`QualityAssuranceAgent` (`STAGE_4_QA`)**：对照 Stage 1 验收标准执行自动化单测、契约集成测试与安全扫描，守卫上线前最后一道门禁。
6. **`DataAnalystAgent` (`STAGE_5_DA`)**：核验前置埋点事件覆盖率，构建发布后交付周期与业务转化归因模型。
7. **`SupervisorAgent` (总管 Agent)**：负责接管达到 `maxNegotiationTurns` 上限的协商死锁，生成《冲突裁决卡》推送给人类；并支持解析人类的自然语言指令，驱动 DAG 状态机分叉回退至任意历史阶段。
