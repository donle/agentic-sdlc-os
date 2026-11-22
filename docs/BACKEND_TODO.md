# 后端实现差距分析与 TODO 清单（替代 Mockup 部分）

> [!NOTE]
> 本文档基于对当前代码库的逐模块审计（2026-11-22），对照《SYSTEM_DESIGN_REPORT.md》（设计报告）与《ENGINEERING_BLUEPRINT.md》（工程蓝图），
> 列出**所有"演示级模拟（Mockup）"与"完全缺失"的后端能力**，并给出可执行的分优先级 TODO 表。
> 每个条目标注：现状代码位置 → 目标行为 → 验收标准 → 依赖关系。（§一至§四作为历史基线不再回勾，新进项以 §五复选框与 `BACKEND_TODO_IMPL_LOG.md` 为准。）

> [!IMPORTANT]
> **执行状态（2026-11-23 更新）**：本文第一至四章为**初始审计基线存档**（2026-11-22），该批 A/B/C/D/E/F/G1/G2/G10/I1/I2/I3/J2/G11/J 条目及 M1-M7 Mockup 替代已全部实现（其中 D1/D2/D3/E3/I1 等在深度复核中暴露的未闭环缺陷已转入文末 §五 `#8–#14` 跟踪；详见 `BACKEND_TODO_IMPL_LOG.md`；原遗留项 H1-H3 为 P2 外部集成，暂挂待业务范围决策，见 `P2_REMAINING_PLAN.md`）。
> 2026-11-23 针对当前实现代码的深度复核新发现 **14 个具体工程问题（#1–#14）**：其中 **#1–#7 已完成修复与文档同步**（第八、九轮），**尚待修复的 #8–#14 已统一登记至文末第五章（§五）**（同步索引于 `BACKEND_TODO_IMPL_LOG.md` 的"待实现项"表）。新条目开工前请以本文第五章、`BACKEND_TODO_IMPL_LOG.md` 与 `P2_REMAINING_PLAN.md` 为准。

---

## 一、现状总览：真实实现 vs 模拟

### 1.1 已经真实实现（无需重做）

| 模块                   | 能力                                                                  | 代码位置                                     |
| :--------------------- | :-------------------------------------------------------------------- | :------------------------------------------- |
| DAG 状态机             | 不可变快照、SUPERSEDED 标记、Fork 分叉回退                            | `src/engine/DagWorkflowStateEngine.ts`       |
| 风险评估责任链         | 协商熔断/Scope Cut/DDL/权限支付/QA 缺陷 4 规则、阈值判定              | `src/patterns/RiskEvaluationChain.ts`        |
| 防虚假共识守卫         | 需求 ID 集合差集检测 → ScopeDiffReport                                | `src/patterns/FalseConsensusGuard.ts`        |
| YAML DSL 解析          | guardrails/modelRouting/stages/gatePolicy/enabled 校验与热切换        | `src/engine/WorkflowDslLoader.ts`            |
| 审计账本（内存+JSONL） | Append-Only 事件流、HumanDecision 账本、驳回经验沉淀                  | `src/engine/ImmutableAuditLedger.ts`         |
| 模型网关**适配器**     | OpenAI 兼容 HTTP 调用、脱敏中间件、基线体检（**已写好但从未被调用**） | `src/patterns/ModelRouterGateway.ts:269-405` |
| 上下文/缓存键          | L1 精确签名 + L2 意图指纹的键构建与命中逻辑                           | `src/telemetry/PromptCacheManager.ts`        |
| HTTP/SSE 服务          | 17 个 REST 端点、全量状态帧推送、静态托管                             | `src/server/WorkbenchServer.ts`              |

### 1.2 演示级模拟（Mockup）—— 本清单要替代的部分

| #   | 模块                | Mockup 行为                                                                                                                  | 影响                                  |
| :-- | :------------------ | :--------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ |
| M1  | 全部 6 个职能 Agent | `synthesizeArtifact()` 为**确定性字符串模板拼接**，无任何 LLM 调用                                                           | 系统不"AI 原生"，产物为固定句式       |
| M2  | 受限协商            | `mediateChallenge()` 由 `forceDeadlockToMaxTurns` 布尔量编排剧本，方案 A/B 文案硬编码                                        | 协商是回放不是博弈                    |
| M3  | Token/成本计量      | `estimateTokenUsage()` 公式估算、`MeterInvocation` 纯算术计费                                                                | 复盘指标（缓存命中率/成本）无真实意义 |
| M4  | 沙箱                | `.git` 目录为 mkdir+HEAD 文件伪造（非 `git worktree`）；测试通过数= `需求×6` 硬编码；"覆盖率 95.6%" 为写死字符串；无容器隔离 | "隔离编码+真实测试"不可信             |
| M5  | 意图识别            | `recognizeStageIntent()` 按需求条数拼串，置信度固定 0.96/0.97                                                                | L2 语义缓存与意图达成率指标失真       |
| M6  | 总管 NL 解析        | `parseNaturalLanguageRollback()` 为 if/else 关键词匹配，未命中一律回退到 3b                                                  | "自然语言调度"名不副实                |
| M7  | 负向经验 RAG        | 64 维向量 = 字符 bigram 哈希投影，非 embedding 模型                                                                          | 相似度检索是字符统计，非语义          |

### 1.3 完全缺失（文档承诺但代码中不存在）

| #   | 缺口                                                                                                                                                                             | 文档依据                         |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------- |
| G1  | **真实 LLM 调用链路**：`invokeChatCompletion` 全管道零调用                                                                                                                       | 设计报告 §4.2                    |
| G2  | **重启恢复**：`loadPersistedSnapshot` 零调用，重启清零并重播种演示数据                                                                                                           | PersistenceRepository 文件头承诺 |
| G3  | **PostgreSQL 直连**：只生成 `pgvector-sync.sql` 文件，代码无任何 pg 客户端；docker-compose 中 pgvector 容器空转                                                                  | 蓝图 §一/§三                     |
| G4  | **认证与会话**：无登录/token；`actorUserId` 由前端明文传入，未知用户静默回落 admin                                                                                               | 蓝图 §一（B 端交付底线）         |
| G5  | **DSL 守卫字段未接线**：`tokenBudgetLimit` 解析后无任何强制熔断；`maxExecutionRetries` 未传给 Agent（硬编码 2）；`negotiateWithStageId` 解析后编排器只硬编码 STAGE_2_PD 一处协商 | 设计报告 §7.1/7.2                |
| G6  | **QA↔Engineer 修复闭环**：YAML 已声明 `negotiateWithStageId: STAGE_3B_ENGINEER`，但 QA 失败只阻塞门禁，无打回-修复-重测循环                                                      | 设计报告 Stage 4                 |
| G7  | **异步执行与逐事件 SSE**：编排为同步 while 循环，一次动作只推一个最终全量帧；无 Redis/任务队列                                                                                   | 蓝图 §一/§三                     |
| G8  | **总管 4 工具契约**：蓝图 §4.2 的 `get_run_overview / summarize_conflict / rollback_and_fork / override_gate` 仅 `rollback_and_fork` 隐式存在                                    | 蓝图 §4.2                        |
| G9  | **外部工具双向同步**：无 Jira/飞书/GitLab webhook 适配器                                                                                                                         | 设计报告 遗漏补全 #5             |
| G10 | **上下文摄取**：无 Git 仓库/Figma/数据库 Schema 自动摄取（Agent 的"上游上下文"只是内存 Map）                                                                                     | 设计报告 §4.3                    |
| G11 | **Stage 5 真实数据闭环**：DA Agent 产物为模板，无数仓/BI 对接                                                                                                                    | 设计报告 Stage 5（二期）         |
| G12 | **演示开关混入领域契约**：`simulateNegotiationConflict / simulateScopeReductionAttempt / simulateTransientRetryOnStage1` 挂在 `ProjectProposalContract` 上                       | 代码卫生                         |

---

## 二、详细 TODO 表

优先级定义：**P0** = 替代核心 Mockup、MVP 可验收的阻塞项；**P1** = 工程完备性；**P2** = 商业化/二期。

### A. LLM 接入层（替代 M1/M3/M5，对应缺口 G1）

- [ ] **A1（P0）Agent 产物生成接入真实 LLM**
  - 现状：`src/agents/AbstractWorkerAgent.ts:319` 调 `synthesizeArtifact()`（各 Agent 内为字符串模板）。
  - 任务：在 `AbstractWorkerAgent` 模板方法中调用已实现的 `ModelRouterGateway.invokeChatCompletion()`；每个 Agent 提供 prompt 模板（system=角色职责+上游契约摘要，user=结构化输入 JSON）+ 输出 JSON Schema；LLM 返回 → `JSON.parse` → 构造对应 `*ArtifactContract` → `validateContractIntegrity()`。
  - 保留现有模板实现作为 `fallbackContentGenerator`（网关不可达时降级，适配器已支持该参数）。
  - 验收：提交提案后，产物字段由 LLM 生成且通过契约校验；断网/无 Key 时平滑降级到模板并标记 `usedLiveGateway=false`。
  - 依赖：无（适配器与降级逻辑已就绪）。

- [ ] **A2（P0）自愈重试真实化**
  - 现状：重试循环校验的是确定性模板（永远通过），`forceTransientRetryOnce` 是注入的假信号（`AbstractWorkerAgent.ts:312`）。
  - 任务：真实 LLM 输出校验失败（JSON 解析失败/契约违规）时携带违规原因构造修复提示词（原 prompt + violations）重试；移除 `forceTransientRetryOnce` 领域字段（移入测试工具，见 J1）。
  - 验收：人为让模型输出缺字段（低 temperature+错误 few-shot 或 mock transport）→ 观察到 ≥1 次带原因的重试 → 最终通过或抛 `FAILED_CONTRACT`。

- [ ] **A3（P0）Token 计量与成本真实化**
  - 现状：`estimateTokenUsage()` 为公式估算（`AbstractWorkerAgent.ts:299`）；`MeterInvocation` 纯算术。
  - 任务：使用 `invokeChatCompletion` 返回的 `usage.prompt_tokens/completion_tokens` 计量；成本按 DSL `costPer1kTokensUsd` 结算；遥测（IntentFulfillmentTracker/PromptCacheManager.savedTokens）改读真实值。
  - 验收：复盘报告中的 token/cost 与网关侧账单一致（±5%）。

- [ ] **A4（P1）意图识别 LLM 化 + 模型基线体检接线**
  - 现状：`recognizeStageIntent()` 拼串；`evaluateEndpointBaseline()`（网关已实现）无调用方。
  - 任务：意图识别改为轻量 LLM 调用（或先保留规则版但输出到遥测）；在 `WorkbenchServer` 增加管理端点 `POST /api/admin/model-baseline`，对配置的两级端点跑 JSON 遵循度体检并在 UI 治理视图展示。
  - 验收：可对任意端点执行体检并返回 JSON Schema 遵循报告。

### B. 协商与修复闭环（替代 M2，对应缺口 G5/G6）

- [ ] **B1（P1）受限协商 LLM 化**
  - 现状：`BoundedNegotiationMediator.mediateChallenge()`（`src/agents/BoundedNegotiationMediator.ts:75`）由 `forceDeadlockToMaxTurns` 布尔量决定剧本；方案 A/B 硬编码。
  - 任务：质询方/响应方各用一次 LLM 调用生成 challenge/response（输入：双方上游契约 + 轮次上限）；每轮产物仍写 `NegotiationTurnRecord`；熔断条件保持 Max Turns；方案 A/B 由响应方 LLM 生成并写回记录。
  - 验收：同一提案两次运行产生不同协商文本；熔断后冲突裁决卡的两方案来自 LLM。
  - 依赖：A1。

- [ ] **B2（P0）QA↔Engineer 修复闭环**
  - 现状：编排器仅硬编码 STAGE_2_PD 一处协商（`WorkflowOrchestratorFacade.ts` 内 `currentStageId === STAGE_2_PD` 分支）；QA 失败直接阻塞门禁。
  - 任务：编排器按 DSL `negotiateWithStageId` 动态路由协商（去掉硬编码阶段判断）；QA 契约 `allAcceptanceCriteriaMet=false` 时自动生成标准化 Bug Report → `rollback_and_fork` 到 STAGE_3B（携带修复指令）重跑 3b→4，循环受 `maxNegotiationTurns` 限制，超限熔断上报人工。
  - 验收：构造必然失败的 QA 场景 → 观察 3b 重跑 → 修复或熔断上仲裁。

- [ ] **B3（P0）DSL 守卫字段全量接线**（对应 G5）
  - 现状：`tokenBudgetLimit` 解析后无消费方；`maxExecutionRetries` 未传入 Agent 构造；`negotiateWithStageId` 见 B2。
  - 任务：
    1. `WorkflowRunState` 增加已消耗 token 累计；`AbstractWorkerAgent` 执行前检查 `tokenBudgetLimit`，超限抛 `TOKEN_BUDGET_EXCEEDED` → 编排器暂停并推送人工通知；
    2. Facade 构造 Agent 时传入 `dslConfig.guardrails.maxExecutionRetries`；
    3. 协商路由按 B2。
  - 验收：把 `tokenBudgetLimit` 配成 100 → 运行即在首个 Agent 处熔断并通知；DSL 改 retries=0 → 首次契约失败即 FAILED_CONTRACT。

### C. 编排与总管（对应缺口 G7/G8/M6）

- [ ] **C1（P1）阶段执行异步化 + SSE 逐事件推送**
  - 现状：`continueExecutionUntilGateOrComplete()` 同步 while；每个动作只广播一次最终全量帧（前端动画因此只能做回放）。
  - 任务：编排器改造为异步推进（阶段间 `await`，长任务沙箱可入队；单机先用进程内任务队列，不强制引入 Redis）；`POST /api/proposals` 立即返回 runId，前端通过 SSE 的 `run_event`（新增事件类型：单条 WorkflowDomainEvent + 阶段快照摘要）逐帧接收；保留 `/api/state` 全量帧。
  - 验收：前端可在阶段执行过程中收到 ≥N 条增量事件（替代"回放动画"的技术前提）。
  - 依赖：建议在 A1 之后（真实 LLM 调用耗时长，异步化收益才显现）。

- [ ] **C2（P1）总管 Agent 工具契约补全**（对应 G8）
  - 现状：`SupervisorAgent` 只有命令对象 + 关键词解析；蓝图 §4.2 四工具缺三个。
  - 任务：实现 `getRunOverview(runId)`（阶段状态/卡点/分支摘要）、`summarizeConflict(runId, negotiationId)`（从 NegotiationLog 提炼裁决卡）、`overrideGate(snapshotId, verdict, reason)`（= 现 submitHumanGateDecision 的服务端入口）；统一暴露为受控工具接口（未来 LLM function-calling 调用，严禁总管直改产物）。
  - 验收：四个工具均有单测且经 RBAC 校验。

- [ ] **C3（P1）总管自然语言解析 LLM 化**
  - 现状：`parseNaturalLanguageRollback()` 关键词 if/else（`SupervisorAgent.ts:147`）。
  - 任务：改用 LLM 结构化输出 `{targetStageId, cleanInstruction}`（few-shot 限定 6 个阶段枚举），解析失败回退关键词版；解析结果写审计。
  - 验收：10 条中文回退指令（含同义词）解析准确率 ≥90%，失败回退有日志。
  - 依赖：A1。

### D. 持久化与部署数据（对应缺口 G2/G3）

- [ ] **D1（P0）启动恢复闭环**
  - 现状：`PersistenceRepository.loadPersistedSnapshot()` 零调用；服务器每次启动 `seedInitialInteractiveScenario()` 造演示数据，内存即真相。
  - 任务：实现 `restoreFromSnapshot()`：启动时若存在 `ledger-store.json` → 重建 `WorkflowRunState`/快照/协商/决策/RAG 内存态；`seedInitialInteractiveScenario()` 改为仅在 `SEED_DEMO_DATA=true`（或 `--seed` 参数）时执行。
  - 验收：创建运行 → 重启进程 → `GET /api/state` 数据完整（含分支/决策/事件历史）。
  - 依赖：无。**注意**：`WorkflowRunState` 需补反序列化构造器（当前仅有内存构造）。

- [ ] **D2（P0）PostgreSQL 真实直连**（对应 G3）
  - 现状：仅生成 `pgvector-sync.sql`；`docker-compose.yml` 中 `postgres-pgvector` 与 `litellm-router` 无人连接。
  - 任务：引入 `pg` 客户端；`PersistenceRepository` 增加 `pgDriver` 实现（upsert workflow_runs/stage_snapshots/negotiation_logs/human_decisions/rejected_history_rag，对齐 `deploy/init-pgvector-schema.sql`）；配置 `DATABASE_URL` 时启用、否则回落 JSONL（保持单机轻量可选）；恢复路径优先读 PG。
  - 验收：compose 环境下创建运行后 `psql` 可查 5 张表；重启后从 PG 恢复；`pgvector-sync.sql` 文件导出保留为运维工具。

- [ ] **D3（P2）SSE 会话恢复**
  - 现状：`/api/events/stream` 无 `Last-Event-ID`/重放缓冲，断线只能靠全量帧兜底。
  - 任务：为每帧编号 `id:`，服务端保留每 run 最近 200 条环形缓冲，重连时按 `Last-Event-ID` 重放。
  - 验收：断网 10s 重连后事件不丢（有全量帧兜底亦可接受，但需验证幂等）。

### E. 沙箱真实化（替代 M4）

- [ ] **E1（P0）真实 Git Worktree**
  - 现状：`GitWorktreeSandboxManager.ts:90-92` 手工 mkdir+写 HEAD 文件伪造成 `.git`。
  - 任务：对目标仓库（`GIT_REPO_PATH` 配置）执行真实 `git worktree add <path> -b worktree/<runId>/<branchId>`；回退分支即新建 worktree；清理逻辑（prune）补齐；无 git 环境时保留现模拟模式并显式标记 `simulation=true`。
  - 验收：`git worktree list` 能看到每次运行创建的分支；主仓库工作区无污染。

- [ ] **E2（P0）测试结果真实采集**
  - 现状：`executeSandboxVerification()` 的 `totalTestCases = 需求×6`、"Coverage: 95.6%" 为硬编码字符串（`GitWorktreeSandboxManager.ts:273-283`）。
  - 任务：向沙箱写入 `package.json`/`node --test` 工程；解析子进程退出码与 TAP/stdout 统计真实用例数与通过数；覆盖率改由 `node --test --experimental-test-coverage`（或 c8）输出解析；`SandboxVerificationResult` 字段全部来自真实输出，解析失败如实报 0。
  - 验收：人为加入一条必失败断言的测试 → QA 报告通过数/率如实反映并触发 B2 闭环。

- [ ] **E3（P1）容器隔离（可选开关）**
  - 现状：子进程直接跑在宿主机。
  - 任务：`SANDBOX_RUNTIME=docker` 时用 dockerode 拉起一次性容器挂载 worktree 执行测试；默认 `host` 保持现状。
  - 验收：docker 模式下测试进程不可访问宿主工作目录外路径。

### F. 认证与 RBAC（对应缺口 G4）

- [ ] **F1（P0）登录会话与身份校验**
  - 现状：无登录；`resolveActor()` 从 `X-Actor-Id` 头/`?actorId` 读取并**默认 admin**（`WorkbenchServer.ts:127-144`）；RBAC 仅对"已在花名册的 userId"生效。
  - 任务：加最小登录（用户名/密码 → HttpOnly session cookie 或 JWT，用户表先落 PG/JSON）；服务端拒绝未知 userId（移除 `getUserOrDefault` 的 admin 兜底，改为 401/403）；`X-Actor-Id` 仅作为已登录会话的辅助头。
  - 验收：未登录访问 `/api/state` 返回 401；非本人负责阶段的签核被 403 且不落账。
  - 依赖：D2（用户表）可并行，先 JSON 存储亦可。

- [ ] **F2（P1）用户与花名册管理 API**
  - 现状：花名册硬编码在 `RbacGovernanceService.seedEnterpriseRoster()`。
  - 任务：CRUD API（admin-only）+ 持久化；RBAC 的 ownedStageIds 可配置。
  - 验收：新增成员并授权某阶段后，该成员登录可见并可用对应签核权。

### G. 成本守卫与语义层（替代 M7，对应缺口 G5 部分）

- [ ] **G1（P1）L2 语义缓存真实化**
  - 现状：`buildSemanticIntentKey` 用 intentCode 精确相等（intentCode 又是规则拼串）→ 命中即"字符串相等"。
  - 任务：意图向量用 A4 的轻量 LLM embedding（或本地小模型）替代规则码；相似度阈值可配（复用余弦工具 `NegativeExperienceRagEngine.cosineSimilarity`）。
  - 验收：同义不同表述的需求能命中 L2（报告命中率来源真实）。
  - 依赖：A3/A4。

- [ ] **G2（P1）负向经验 RAG embedding 化**（替代 M7）
  - 现状：`computeNormalizedEmbedding()` 为字符 bigram 哈希（`NegativeExperienceRagEngine.ts:43`）。
  - 任务：接入 embedding 端点（BYOM 网关加 `EMBEDDING` 层级）；落 PG 时用 `vector(1536)`（同步调整 `init-pgvector-schema.sql`）；保留哈希版作为离线降级。
  - 验收：语义相近（非字面相似）的两条驳回经验检索 Top1 命中。
  - 依赖：D2、A4。

### H. 外部集成（对应缺口 G9/G10，设计报告遗漏补全 #5 与 §4.3）

- [ ] **H1（P2）Git 仓库上下文摄取**
  - 任务：Stage 3a/3b 输入上下文注入真实仓库结构摘要（目录树/关键文件内容截断），复用 E1 的 worktree。
- [ ] **H2（P2）Jira/飞书项目双向同步**
  - 任务：状态机流转 → webhook 推送任务卡；外部状态变更 → 入站适配器映射为 `HumanDecisionRecord` 或评论。
- [ ] **H3（P2）Figma 设计系统摄取**
  - 任务：PD Agent 的组件映射输入接入企业组件库清单（OAuth/Token 拉取）。

### I. 部署与运维（P1）

- [ ] **I1（P1）docker-compose 真实联通**：litellm-router 挂载客户模型配置、workbench 与 pg/litellm 健康检查、`DATABASE_URL/LITELLM_ENABLE_LIVE_HTTP` 默认启用；验证一键 `docker compose up` 后全链路可用（对应 G3 的运行时部分）。
- [ ] **I2（P1）日志与可观测**：结构化日志（runId/branchId 贯穿）；`/api/health`。
- [ ] **I3（P2）数据清理策略**：worktree 与 `.runtime-data` 的保留/归档策略（配合 E1 prune）。

### J. 代码卫生（P0，随 A1/B2 一并完成）

- [ ] **J1（P0）演示开关迁出领域契约**：`simulateNegotiationConflict / simulateScopeReductionAttempt / simulateTransientRetryOnStage1` 从 `ProjectProposalContract` 移到测试工厂/`SEED_DEMO_DATA` 场景配置；`POST /api/proposals` 的 preset 场景改由服务端场景注册表实现。
- [ ] **J2（P1）枚举对齐 DSL**：新增节点需同步扩展 `WorkflowStageId/AgentRole` 枚举、`agentRegistry` 注册与 RBAC `getRequiredRolesForStage`（当前"可插拔 Agent"在 DSL 层允许启停但不允许新增，见设计报告 §7.1 的差距）。

---

## 三、建议实施顺序（里程碑）

| 里程碑                | 内容                                 | 出口标准                                                           |
| :-------------------- | :----------------------------------- | :----------------------------------------------------------------- |
| **M1-A "真 AI 内核"** | A1→A2→A3→J1→B3（token/retries 接线） | 一次真实提案全程由 LLM 生成产物并通过契约校验；token/成本真实计量  |
| **M1-B "可信工程"**   | E1→E2→B2→D1                          | 真实 worktree+真实测试结果；QA 失败自动打回 3b；重启不丢数据       |
| **M1-C "可交付"**     | F1→F2→D2→I1→I2                       | 登录+RBAC 硬校验；PG 持久化；compose 一键起全栈                    |
| **M2 "智能增强"**     | C1→C2→C3→A4→B1→G1→G2                 | 异步逐事件 SSE（前端实时动画的技术前提）；总管四工具；语义缓存/RAG |
| **M3 "生态"**         | H1→H2→H3→D3→E3→I3→J2→G11             | 外部双向同步；容器隔离；Stage 5 数仓闭环                           |

---

## 四、复核清单（audit 结论的代码证据索引）

| 结论                                                           | 证据位置                                                                |
| :------------------------------------------------------------- | :---------------------------------------------------------------------- |
| `invokeChatCompletion`/`evaluateEndpointBaseline` 全管道零调用 | 仅定义于 `ModelRouterGateway.ts:269/367`，无任何调用方                  |
| `loadPersistedSnapshot` 零调用                                 | 仅定义于 `PersistenceRepository.ts:128`                                 |
| `tokenBudgetLimit` 无消费方                                    | grep 全仓库仅 `WorkflowDslLoader.ts` 解析处                             |
| `maxExecutionRetries` 未接线                                   | `AbstractWorkerAgent.ts:183` 硬编码默认 2，Facade 未传                  |
| `negotiateWithStageId` 未动态路由                              | Facade 仅 `currentStageId === STAGE_2_PD` 硬编码分支                    |
| 沙箱伪 git / 硬编码测试数                                      | `GitWorktreeSandboxManager.ts:90-92 / 273-283`，全文件无 git 子进程调用 |
| 认证缺失 + admin 兜底                                          | `WorkbenchServer.ts:127-144`、`RbacGovernanceService.ts:181-186`        |
| 协商剧本化                                                     | `BoundedNegotiationMediator.ts:75-84`（`forceDeadlockToMaxTurns` 编排） |

---

## 五、2026-11-23 后端深度审计待修复 TODO（#8–#14）

> 本章记录 2026-11-23 后端深度审计中识别、且在第八/九轮修复（#1–#7）后**仍未解决的 7 个具体工程问题**。执行状态同步索引于 [`BACKEND_TODO_IMPL_LOG.md`](./BACKEND_TODO_IMPL_LOG.md) 的"待实现项"表（编号 `AUDIT-8` 至 `AUDIT-14`）。

### P0 阻断级（持久化与重启恢复可靠性）

- [x] **#8（AUDIT-8 / 关联 D2）修复 PostgreSQL 同步缺失 `negotiation_logs` 表，并打通 `PgPersistenceDriver` 与用户系统 Schema**（✅ 已于第十二轮修复）
  - **现状**：
    - `src/engine/pg/PgPersistenceDriver.ts` 新增统一构建器 `buildPgUpsertSql()` 作为唯一 SQL 事实源，`PersistenceRepository.generatePostgreSqlStatements()` 已消除重复拼装并补齐 `negotiation_logs`、`team_comments` 及来自 `WorkflowRunState.getTokenBudget()` 的真实 `token_budget` / `token_used`（杜绝 `120000` 硬编码）；`workflow_snapshot_yaml` / `artifact_json.__snapshotMeta` 完整承载重建元数据。
    - `PersistenceRepository` 构造函数与 `persistFullState()` / `loadPersistedSnapshot()` / `appendAuditEntryToWal()` 已接入 `selectPersistenceDriver()`；`PgPersistenceDriver.loadFullState()` 完整回读 6 张业务表并在空库/故障时回落 `ledger-store.json`。
    - `deploy/init-pgvector-schema.sql` 已补全用户体系与评论表（`users`、`user_owned_stages`、`auth_sessions`、`auth_login_audit`、`team_comments`）及 `workflow_runs.created_by_user_id` / `human_decisions.reviewer_user_id` 双轨关联外键；`src/server/auth/UserStore.ts` 实现 `JsonUserStore` + `PgUserStore` + `selectUserStore`，并由 `SessionService` 与 `WorkbenchServer` 正式消费。
  - **验收**：已在 `tests/pg-persistence-driver.spec.ts` 新增 5 项验收测试，覆盖 SQL 完整性（含定制 `tokenBudgetLimit: 88000`、`negotiation_logs`、`team_comments`）、`selectPersistenceDriver` 驱动切换、删除 `ledger-store.json` 后经 `PgPersistenceDriver.loadFullState()` 完整重启恢复、10 表 Schema 断言及 `PgUserStore` + `SessionService` PG 往返闭环，全数通过（详见 `BACKEND_TODO_IMPL_LOG.md` 第十二轮）。

- [x] **#9（AUDIT-9 / 关联 D1）修复启动恢复 `StateReconstructor` 丢失 5 项关键运行态数据**（✅ 已于第十一轮修复）
  - **现状**：
    - **1) `ScopeDiffReport` 字段丢失**：`StageSnapshotMemento.toSerializableRecord()`（`src/domain/models.ts`）已补齐 `baselineRequirementIds` / `currentRequirementIds`，且 `ScopeDiffReport.fromJSON()` 兼容历史仅含 `droppedRequirementIds` 的快照。
    - **2) `notificationInbox` 丢失**：`AgentUserNotification` 支持序列化/反序列化，经 `PersistedLedgerSnapshot.notifications` 与 `WorkflowEventBus.restoreNotification()` 保持原有倒序恢复待办审批通知卡。
    - **3) `teamComments` 丢失**：`StageTeamCommentRecord` 支持序列化，独立调用 `addTeamComment()` 时自动同步持久化并在 `restoreFromPersistence()` 完整恢复。
    - **4) `autoRepairCounts` 丢失**：`PersistedRunRecord.autoRepairCounts` 持久化与 `WorkflowRunState.restoreInternals()` 完整恢复 QA 自动返修计数。
    - **5) `auditEntries` 丢失**：`StateReconstructor.restore()` 从 `PersistenceRepository.readAuditWalEntries()`（及快照兜底）调用 `ImmutableAuditLedger.restoreAuditEntry()` 重建审计时间轴，且不重复写回 WAL 或触发二次 RAG。
  - **验收**：已在 `tests/state-reconstructor.spec.ts` 新增 Test 4–5 验证全量 5 项 round-trip、WAL 零重复及历史/损坏数据容错，全数通过（见 `BACKEND_TODO_IMPL_LOG.md` 第十一轮）。

### P1 核心工程缺陷（交互异常、沙箱真实性与并发安全）

- [ ] **#10（AUDIT-10 / 关联 A2、B3）修复熔断通知 `RETRY_STAGE` 按钮点击报 400 的交互死路**
  - **现状**：`src/engine/WorkflowOrchestratorFacade.ts` 的 `continueExecutionUntilGateOrComplete()` catch 块在捕获 `StageContractError` 或 `TokenBudgetExceededError` 时，发布 `STAGE_CONTRACT_FAILED` / `TOKEN_BUDGET_EXCEEDED` 通知，携带 `relatedSnapshotId: 'ROOT'` 与 `actionOptions`（其中 `RETRY_STAGE` 对应 `verdict: DecisionVerdict.APPROVE`）；但点击该按钮触发 `submitHumanGateDecision()` 时，代码调用 `runState.findSnapshotById('ROOT')` 并抛出 `未找到待审核快照 [ROOT]`，导致前端请求返回 400 错误。
  - **目标**：为契约熔断 / 预算超限通知绑定真实可恢复的阶段标识或专属重试入口（或当 `RETRY_STAGE` 命中熔断恢复路径时由 `WorkflowOrchestratorFacade` 安全重启失败节点），确保用户点击通知动作可真正触发阶段重试而非 400。
  - **验收**：新增测试模拟 `StageContractError`（及 `TokenBudgetExceededError`）触发通知后调用决策/重试接口，验证返回 200 且该阶段重新进入执行状态，不再抛出 `未找到待审核快照 [ROOT]`。

- [ ] **#11（AUDIT-11）修复 `RealGitWorktree.remove()` 匹配逻辑错误导致无法清理或误删其他 Worktree**
  - **现状**：`src/sandbox/RealGitWorktree.ts` 的 `remove(branchName)` 对 `git worktree list --porcelain` 输出按 `.find((line) => line.startsWith('worktree ') && line.includes('/worktree/'))` 匹配目录；实际磁盘路径（如 `.sandbox-worktrees/<runId>/<branchId>`）通常不包含 `/worktree/`（该前缀位于 `branch refs/heads/worktree/...` 行），且 `.find()` 未按 `branchName` 对应的 porcelain stanza 精确绑定，导致清理静默失败或误删同一仓库下的其他 worktree。
  - **目标**：按 `git worktree list --porcelain` 的空行分段（stanza）解析每组 `worktree <path>` 与 `branch refs/heads/<branch>`，严格匹配目标 `branchName` 后再执行 `git worktree remove` 与分支清理。
  - **验收**：在真实临时 Git 仓库创建至少 2 个不同 branch 的 worktree，调用 `remove(branchA)` 后仅 `branchA` 对应 worktree 与分支被移除，`branchB` 完整保留。

- [ ] **#12（AUDIT-12 / 关联 E3）修复 `DockerTestRuntime` 管道吞没退出码与测试失败被误标为 `host-fallback`**
  - **现状**：
    - `src/sandbox/DockerTestRuntime.ts` 执行 `sh -c "node --test --test-reporter=spec --experimental-test-coverage ${containerTestPath} 2>&1 | tee /results/${resultsBasename}"` 时未开启 `pipefail`（Alpine BusyBox `sh` 亦需注意兼容性），管道返回的是 `tee` 的退出码 `0` 而非 `node --test` 的真实退出码。
    - `src/sandbox/GitWorktreeSandboxManager.ts` 在 `dockerResult.exitCode !== 0` 时直接设置 `runtime = 'host-fallback'`，将单元测试用例失败混同为 Docker 容器启动/引擎故障；同时需核验 `node:22-alpine` 镜像内直接运行 TypeScript 测试文件的兼容性。
  - **目标**：
    - 使用不依赖管道掩码的方式保留容器内测试真实退出码（如文件重定向或显式保存 `$?`），并校验 `node:22-alpine` 下 TypeScript 测试执行链路。
    - 在 `GitWorktreeSandboxManager.ts` 区分"Docker 引擎/容器基础设施不可用"与"容器内测试断言失败"，仅前者才触发 `host-fallback`。
  - **验收**：单测验证容器内测试失败（退出码非 0）时 `runtime` 仍准确报告为 `docker` 且失败用例数正确解析；仅当 Docker daemon 不可用/超时/镜像缺失时才降级为 `host-fallback`。

- [ ] **#13（AUDIT-13 / 关联 D3）消除 `WorkbenchServer` 全局单一 `activeRunId` 并发串台，并接线 SSE `Last-Event-ID` 重放**
  - **现状**：
    - `src/server/WorkbenchServer.ts` 使用单一实例级 `this.activeRunId`：`GET /api/state?runId=` 会修改全局 `this.activeRunId`；`/api/decisions`、`/api/supervisor/rollback`、`/api/comments`、`/api/sandbox/file`、`/api/sandbox/verify` 均直接读取 `this.activeRunId` 而非请求自带 `runId`；`broadcastSseStateUpdate()` 向全部 SSE 客户端广播当前全局 `this.activeRunId` 状态，多用户或多标签页查看不同 Run 时会互相覆盖甚至误操作错误 Run。
    - `/api/events/stream` 未读取请求头 `last-event-id` 并调用 `this.sseBridge.replay()`（`src/server/SseBridge.ts` 已实现 `replay(clientLastId, write)` 但未接线）。
  - **目标**：
    - 所有读写接口优先以请求显式传入的 `runId`（query/body/path）定位目标 Run，不再用 `GET /api/state` 覆盖实例全局状态（仅无 `runId` 时回退默认最新 Run）；SSE 连接按订阅 `runId` 隔离推送或携带精确事件通道。
    - `/api/events/stream` 读取 `req.headers['last-event-id']` 并调用 `this.sseBridge.replay()` 补发断线期间缺失事件。
  - **验收**：并发打开两个不同 `runId` 的状态查询与审批请求互不串台；`GET /api/events/stream` 携带 `Last-Event-ID` 请求头时能够重放该 ID 之后的增量事件。

- [ ] **#14（AUDIT-14 / 关联 I1）补全 `Dockerfile` 的 `postgresql-client` 与 `docker-compose.yml` 的 `LITELLM_ENABLE_LIVE_HTTP=true`**
  - **现状**：
    - `Dockerfile` 仅执行 `apk add --no-cache git`，缺少 `postgresql-client`，导致容器化部署时 `PersistenceRepository` 与 `WarehouseQueryProvider` 调用 `execFileSync('psql', ...)` 抛出 `ENOENT`。
    - `deploy/docker-compose.yml` 中 `agentic-workbench` 服务的 `environment` 缺少 `LITELLM_ENABLE_LIVE_HTTP=true`，导致通过 Compose 一键拉起后 LLM 调用仍停留在离线回退模式。
  - **目标**：
    - 在 `Dockerfile` 中补齐 `postgresql-client` 安装；在 `deploy/docker-compose.yml` 的 `agentic-workbench` 环境变量中默认启用 `LITELLM_ENABLE_LIVE_HTTP=true`（及检查镜像运行所需环境一致）。
  - **验收**：容器内可执行 `psql --version` 且 `docker compose config` 校验 `agentic-workbench` 含 `LITELLM_ENABLE_LIVE_HTTP=true`。
