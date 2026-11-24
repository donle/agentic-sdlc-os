# 后端实现差距分析与 TODO 清单（替代 Mockup 部分）

> [!NOTE]
> 本文档基于对当前代码库的逐模块审计（2026-11-22），对照《SYSTEM_DESIGN_REPORT.md》（设计报告）与《ENGINEERING_BLUEPRINT.md》（工程蓝图），
> 列出**所有"演示级模拟（Mockup）"与"完全缺失"的后端能力**，并给出可执行的分优先级 TODO 表。
> 每个条目标注：现状代码位置 → 目标行为 → 验收标准 → 依赖关系。（§一至§四作为历史基线不再回勾，新进项以 §五复选框与 `BACKEND_TODO_IMPL_LOG.md` 为准。）

> [!IMPORTANT]
> **执行状态（2026-11-24 更新）**：本文第一至四章为**初始审计基线存档**（2026-11-22），该批 A/B/C/D/E/F/G1/G2/G10/I1/I2/I3/J2/G11/J 条目及 M1-M7 Mockup 替代已全部实现；2026-11-23 针对实现代码深度复核发现的 **14 个工程问题（`#1–#14`）** 已在第八、九轮（`#1–#7`）及第十一至十四轮（`#8–#14`）**全部完成修复并清零**（另第十轮完成 Agent 质量治理 `DS-1~DS-4`，详见 [`BACKEND_TODO_IMPL_LOG.md`](./BACKEND_TODO_IMPL_LOG.md)）。
> **当前最新待办**：原 P2 外部集成 `H1–H3` 暂挂于 [`P2_REMAINING_PLAN.md`](./P2_REMAINING_PLAN.md)；**2026-11-24 全项目（前端 + 后端 + 部署 + 验证）完整度复审新发现的剩余缺口已统一登记至文末第六章（§六）**，开工前请以本文第六章、`BACKEND_TODO_IMPL_LOG.md` 与 `P2_REMAINING_PLAN.md` 为准。

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

## 五、2026-11-23 后端深度审计修复清单（#8–#14，已全部清零）

> 本章记录 2026-11-23 后端深度审计中识别的 7 个关键工程问题（`AUDIT-8` 至 `AUDIT-14`），**已于第十一至十四轮（2026-11-23 ~ 2026-11-24）全部修复并验收通过**。执行明细同步记录于 [`BACKEND_TODO_IMPL_LOG.md`](./BACKEND_TODO_IMPL_LOG.md)。

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

- [x] **#10（AUDIT-10 / 关联 A2、B3）修复熔断通知 `RETRY_STAGE` 按钮点击报 400 的交互死路**（✅ 已于第十三轮修复）
  - **现状**：
    - `WorkflowRunState`（`src/engine/DagWorkflowStateEngine.ts`）新增 `increaseTokenBudget()`；`WorkflowEventBus`（`src/patterns/EventBus.ts`）新增 `resolveFailureNotificationsForStage()`。
    - `WorkflowOrchestratorFacade.continueExecutionUntilGateOrComplete()`（`src/engine/WorkflowOrchestratorFacade.ts`）在捕获 `StageContractError` / `TokenBudgetExceededError` 时改用可识别重试标识 `RETRY:<stageId>:<timestamp>`；新增 `retryAbortedStage()` 并在 `submitHumanGateDecision()` 识别 `RETRY:*` 与历史 `ROOT` 且处于 `ABORTED` / `ABORTED_TOKEN_BUDGET` 状态时自动走安全重启（预算熔断时支持按 `extraTokenBudget` 或默认额度扩容）。
    - `WorkbenchHttpServer`（`src/server/WorkbenchServer.ts`）新增专属 `POST /api/runs/retry` 端点并令 `POST /api/decisions` 透传 `extraTokenBudget`。
  - **验收**：已在 `tests/retry-and-concurrency-sse.spec.ts` Test 1–2 验证 `StageContractError` 与 `TokenBudgetExceededError` 经 `/api/decisions`（含 `RETRY:*` 与历史 `ROOT`）及 `/api/runs/retry` 均返回 200 且阶段恢复推进，通知标记已解决（详见 `BACKEND_TODO_IMPL_LOG.md` 第十三轮）。

- [x] **#11（AUDIT-11）修复 `RealGitWorktree.remove()` 匹配逻辑错误导致无法清理或误删其他 Worktree**（✅ 已于第十四轮修复）
  - **现状**：`src/sandbox/RealGitWorktree.ts` 新增 `parsePorcelainWorktrees()` 按空行分段（stanza）解析 `git worktree list --porcelain` 中的 `worktree <path>` 与 `branch refs/heads/<branch>`，`remove(branchName)` 按 `refs/heads/<branchName>` 精确匹配对应 worktree 并执行 `git worktree remove --force` 与 `git branch -D`，不再因匹配 `/worktree/` 路径片段而清理失败或误删无关 worktree。
  - **验收**：已在 `tests/sandbox-manager.spec.ts` Test 4 验证多 stanza porcelain 解析与真实临时 Git 仓库双 worktree 选择性清理（移除 `branchA` 后 `branchB` 目录、文件及分支完整保留）。

- [x] **#12（AUDIT-12 / 关联 E3）修复 `DockerTestRuntime` 管道吞没退出码与测试失败被误标为 `host-fallback`**（✅ 已于第十四轮修复）
  - **现状**：
    - `src/sandbox/DockerTestRuntime.ts` 将容器执行命令改为 `node --experimental-strip-types --test --test-reporter=spec --experimental-test-coverage "${containerTestPath}" > "/results/${resultsBasename}" 2>&1; ec=$?; cat "/results/${resultsBasename}"; exit $ec`，不依赖管道即可留档输出并严格保留 `node --test` 真实退出码（同时兼容 `node:22-alpine` TypeScript 执行）；新增 `infrastructureFailure` 与 `DockerTestRuntime.isInfrastructureFailure()`（仅超时、`exitCode === null`、Docker CLI 引擎错误码 `125/126/127` 或守护进程/镜像错误文本判定为基础设施故障）。
    - `src/sandbox/GitWorktreeSandboxManager.ts` 仅在 `dockerResult.infrastructureFailure === true`（或抛异常）时才降级 `host-fallback`；容器内测试断言失败（`exitCode=1`）准确保持 `runtime='docker'` 并如实解析失败用例数。
  - **验收**：已在 `tests/docker-runtime.spec.ts` Test 1 与 Test 6–7 验证命令退出码保留、`exitCode=1` 单测失败保持 `runtime='docker'`、以及 `exitCode=125` 镜像缺失降级 `host-fallback`。

- [x] **#13（AUDIT-13 / 关联 D3）消除 `WorkbenchServer` 全局单一 `activeRunId` 并发串台，并接线 SSE `Last-Event-ID` 重放**（✅ 已于第十三轮修复）
  - **现状**：
    - `WorkbenchHttpServer`（`src/server/WorkbenchServer.ts`）移除 `GET /api/state` 与 `POST /api/runs/select` 对全局 `this.activeRunId` 的篡改，新增 `resolveRequestRunId()`（优先显式 `runId`，`/api/decisions` 缺省 `runId` 时按 `snapshotId`/通知反向定位），覆盖 `/api/decisions`、`/api/runs/retry`、`/api/supervisor/rollback`、`/api/comments`、`/api/sandbox/file`、`/api/sandbox/verify`、`/api/rag/ingest` 与 `/api/admin/governance`。
    - `SseBridge`（`src/server/SseBridge.ts`）缓存与广播携带 `runId` 并新增 `getLatestEventId()`；`GET /api/events/stream?runId=...` 按客户端订阅 `runId` 隔离推送，并读取请求头 `last-event-id`（或 `?lastEventId`）调用 `sseBridge.replay(..., subscribedRunId)` 精确增量重放；`WorkbenchApiClient`（`src/ui/client/WorkbenchApiClient.ts`）同步追踪当前页签 `activeRunId` 并在各类读写请求及 SSE 订阅中透传。
  - **验收**：已在 `tests/retry-and-concurrency-sse.spec.ts` Test 3–4 验证多标签页并发查询/评论/签核严格隔离，以及 SSE 按 `runId` 隔离推送与 `Last-Event-ID` 断线重放，全数通过（详见 `BACKEND_TODO_IMPL_LOG.md` 第十三轮）。

- [x] **#14（AUDIT-14 / 关联 I1）补全 `Dockerfile` 的 `postgresql-client` 与 `docker-compose.yml` 的 `LITELLM_ENABLE_LIVE_HTTP=true`**（✅ 已于第十四轮修复）
  - **现状**：
    - `Dockerfile` 的 `apk add --no-cache` 已补全 `git postgresql-client`，容器内具备 `psql` CLI 供 `PersistenceRepository` 与 `WarehouseQueryProvider` 调用。
    - `deploy/docker-compose.yml` 中 `agentic-workbench.environment` 已默认加入 `LITELLM_ENABLE_LIVE_HTTP=true`。
  - **验收**：已在 `tests/docker-runtime.spec.ts` Test 8 校验 `Dockerfile` 安装 `postgresql-client` 且 `deploy/docker-compose.yml` 配置 `LITELLM_ENABLE_LIVE_HTTP=true`（真实镜像构建/Compose 拉起随容器环境执行）。

---

## 六、2026-11-24 全项目完整度复审与下一阶段待办

> 在 `#1–#14` 全部清零与 `169 项 / 48 套件` 测试全绿之后，2026-11-24 对**后端、前端、部署配置与验证覆盖面**进行了一次全仓完整度重审。以下为仍未补完的工程缺口（按 P0 / P1 / P2 排序，作为下一阶段施工清单）。

### P0（阻断级：前后端联调、鉴权闭环、并发与安全边界）

- [x] **P0-1：恢复前端 React 构建链路并替换过期静态产物 `src/ui/dist/`**（✅ 已于第十八轮 / Step 5 修复）
  - **现状**：已还原工作区 `react`、`react-dom`、`@types/react`、`@types/react-dom` 依赖；`npm run typecheck:frontend`、`npm run lint:frontend` 与 `npm run build:ui` 全过并生成 391,662 B React 19 `src/ui/dist/main.js`，已清除旧版 `StageDisplayFormatter.js`/`WorkbenchApiClient.js`/`WorkbenchViewController.js`/`types.js` 残留，并在 `tests/server-sse-api.spec.ts` 补齐 React bundle HTTP 校验与 `npm run check` 全绿（详见 [`P0_1_FRONTEND_REACT_BUILD_RESTORE.md`](./P0_1_FRONTEND_REACT_BUILD_RESTORE.md)）。
- [x] **P0-2：补齐前端 F1/F2 登录鉴权与用户管理 UI（解除 `AUTH_REQUIRED=true` 前端不可用）**（✅ 已于第十九轮 / Step 6 修复）
  - **现状**：`WorkbenchApiClient.ts` 已切换为 `credentials: 'same-origin'` Cookie 会话驱动（登录态下停止发送 `X-Actor-Id`）、封装完整 `/api/auth/*` 与 `/api/admin/users*`/`login-audit` 接口并注册 `401`/`403 (mustChangePassword)` 全局回调；新增 `LoginView.tsx` 与 `ChangePasswordModal.tsx`；`App.tsx` 与 `Topbar.tsx` 接入 `authMode` 启动探测、强改密流与替身警示条（含一键 `exitActAs`）；`AdminGovernanceView.tsx` 接入 F2 成员增改/启停/重置口令与登录审计表（详见 [`P0_2_FRONTEND_AUTH_AND_USER_ADMIN_UI.md`](./P0_2_FRONTEND_AUTH_AND_USER_ADMIN_UI.md)）。
- [x] **P0-3：修复 `act-as` 不可逆切换陷阱与业务审计 `"via <admin>"` 归属**（✅ 已于第十五轮 / Step 1 修复）
  - **现状**：`SessionService.actAs()` 改按 `session.impersonatedBy ?? session.userId` 校验真实管理员并支持替身态连续切换与切回自身，新增 `SessionService.exitActAs()` 与 `POST /api/auth/exit-act-as` 吊销替身会话并记录 `EXIT_ACT_AS` 审计；`WorkbenchHttpServer` 修复了替身态下目标用户 `mustChangePassword` 误拦截管理员的问题，并将 `impersonatedBy` 透传至 `WorkflowOrchestratorFacade` 与业务接口，自动在立项/签核/重试/回退/评论/RAG 录入记录追加 `(via <admin>)`（详见 [`P0_3_ACT_AS_AND_AUDIT_ATTRIBUTION.md`](./P0_3_ACT_AS_AND_AUDIT_ATTRIBUTION.md)）。
- [x] **P0-4：加装同 `runId` 异步并发互斥锁，消除共享单例 Agent 可变状态竞态**（✅ 已于第十六轮 / Step 2 修复）
  - **现状**：`WorkflowOrchestratorFacade` 新增按 `runId` 隔离的 Promise 链异步互斥锁 `withRunLock()`（公开写入口加锁、内部委托拆分 `*Unlocked` 杜绝死锁）并在 `submitHumanGateDecisionUnlocked()` 增加 `PENDING_HUMAN_GATE` 状态守卫；`AbstractWorkerAgent` 提供 `buildPreparedContextKey()` / `saveBoundedPreparedState()`，将 `SoftwareEngineerAgent` 与 `QualityAssuranceAgent` 单实例准备字段改为上限 64 的有界 `Map`（详见 [`P0_4_CONCURRENCY_LOCK_AND_AGENT_ISOLATION.md`](./P0_4_CONCURRENCY_LOCK_AND_AGENT_ISOLATION.md)）。
- [x] **P0-5：`WorkbenchServer` HTTP 安全加固与默认模式越权收敛**（✅ 已于第十七轮 / Step 3 修复）
  - **现状**：`WorkbenchHttpServer` 新增 `HttpRequestError`、`readJsonBody()` 默认 1 MB 上限（`413`）与 15s 超时（`408`）；`buildSecurityHeaders()` 与 `buildSessionCookie()` 统一附带 `nosniff`/`DENY`/`same-origin`/HTML `CSP` 及 HTTPS 条件 `Secure`；`enforceRateLimit()` 为登录与高开销接口提供滑动窗口限流（`429` + `Retry-After`）；静态与沙箱路径前缀检查补齐 `+ path.sep` 及 `isFile()`；全模式统一拦截 `mustChangePassword=true` 会话并移除 `templates`/`sandbox/file`/`rag/query` 对 `authSource === 'none'` 的 RBAC 豁免（详见 [`P0_5_HTTP_SECURITY_HARDENING.md`](./P0_5_HTTP_SECURITY_HARDENING.md)）。
- [x] **P0-6：修复 `src/retrospective/runRetrospective.ts` 6 处漏写 `await` 并改为评估真实历史运行**（✅ 已于第十六轮 / Step 4 修复）
  - **现状**：`RetrospectiveBenchmarkSuite.runFullSuite()` 补齐全部 6 处 `await` 并按分叉阶段顺序稳态推进，默认使用 `os.tmpdir()` 隔离目录并在 `finally` 清理（不再污染 `.runtime-data/`）；抽出 `RetrospectiveTaskRunner.evaluateMetrics()` 共用诊断逻辑并新增只读 `evaluatePersistedHistory()` 评估真实历史运行；CLI 入口改用 `pathToFileURL` 并支持 `--benchmark` / `--history-only`（详见 [`P0_6_RETROSPECTIVE_RUNNER_FIX.md`](./P0_6_RETROSPECTIVE_RUNNER_FIX.md)）。

### P1（高优：前端交互修复、PG/持久化一致性、Agent 真实代码落盘与实网 E2E）

- [x] **P1-1：修复前端多 Run SSE 重连串台与若干视图交互缺陷**（✅ 已于第二十轮 / Step 7 修复）
  - **现状**：`App.tsx` SSE `useEffect` 已加入 `activeRunId` 依赖与 `unsubscribe()` 关闭清理并合入 `run_event`/`user_notification` 增量帧；`WorkbenchApiClient` 封装 `listWorkflowTemplates()`、`retryAbortedRun()`（含 `extraTokenBudget`）与完整沙箱计数回传；`submitDecision` 透传 `notif.runId` 并路由熔断恢复；`Topbar` 改读动态 `roster`（含周工 DA）与 `/api/workflows/templates`；`SandboxExplorerView` 移除硬编码 100% `alert` 并同步刷新 `dashboardState`；`AuditRagView` 修复收起按钮条件；`ProjectsHubView` 区分 `ABORTED*` 徽标；`Sidebar` 消除嵌套 `<svg>`（详见 [`P1_1_FRONTEND_SSE_AND_VIEW_FIXES.md`](./P1_1_FRONTEND_SSE_AND_VIEW_FIXES.md)）。
- [x] **P1-2：补齐 PG / JSON 双模式持久化一致性与 `psql` 阻塞优化**（✅ 已于第二十一轮 / Step 8 修复）
  - **现状**：`WorkbenchServer`、`SessionService` 与 `UserStore` 已在登录、替身切换与会话校验时采集写入 `auth_sessions.ip` / `user_agent` 与 `auth_login_audit.ip`；`workflow_runs.created_by_user_id` 与 `human_decisions.reviewer_user_id` 双轨外键已接入模型、`PgPersistenceDriver` 与 `StateReconstructor`；`deploy/init-pgvector-schema.sql` 新增 `notifications`、`live_events`、`audit_entries` 与 `system_runtime_state` 四表并同步还原 `updateAdminGovernanceConfig()`、`PromptCacheManager` 与 `IntentFulfillmentTracker`；`JsonUserStore` 已将 `auth-sessions.json` 与 `auth-login-audit.jsonl` 落盘；`rejected_history_rag.embedding` 改为变长 `vector`（配合 `RAG_VECTOR_DIM` 与可选 `pinnedVectorDim` 兼容 1024/1536 维）；`PgUserStore` 与 `PgPersistenceDriver` 引入非阻塞 `execFile` 异步队列（后者支持合并覆盖写入）并配合 `validateWithMeta`、会话 TTL 缓存、续期节流与阴性墓碑瞬时驱逐（详见 [`P1_2_PERSISTENCE_CONSISTENCY_AND_ASYNC_PG.md`](./P1_2_PERSISTENCE_CONSISTENCY_AND_ASYNC_PG.md)）。
- [x] **P1-3：打通 Agent / 上下文预算裁剪 / 沙箱深层闭环**（✅ 已于第二十二轮 / Step 9 修复）
  - **现状**：Stage 3b `SoftwareEngineerAgent` 通过 `applyLlmPostProcessing` 将 LLM `filePatches` 经 `GitWorktreeSandboxManager.applyFilePatches()` 真实写入 Worktree（全量扫描 `src/` 与 `tests/*.spec.ts` 重跑 `node:test` 并联动 A2 自愈重试）；`WorkflowOrchestratorFacade` 将 `ContextBudgetTrimmer` 产出的 `TrimmedContext` 真实注入 `AgentExecutionInputContext` 并在 `COMPLETED`/`ABORTED*` 终态钩子按 `runId` 调用 `clearRunCache(runId)`；新增 `DependencyVersionsProvider` 满足 `dependency_versions`；`SupervisorAgent` 动态生成协商选项标签、对 `explicitTargetStageId` 校验 `allowedStages`，并接入 `supervisorTools.ts` 四工具至 `SupervisorAgent.executeTool()` 与 `GET/POST /api/supervisor/tools`；修正 `COMPLETED` 终态钩子不可达并从清理扫描排除 `docker-results/`；激活全部 4 项既有 `it.skip` 用例实现全库 **0 跳过**（详见 [`P1_3_AGENT_CONTEXT_AND_SANDBOX_LOOP.md`](./P1_3_AGENT_CONTEXT_AND_SANDBOX_LOOP.md)）。
- [x] **P1-4：实网 Docker Compose + PG + 本地大模型 + 浏览器 UI 端到端验证与部署配置修正**（✅ 已于第二十三轮 / Step 10 完成配置硬化、真实 TCP/SSE/OpenAI HTTP E2E 与实机浏览器 UI E2E；宿主无 docker/psql/ollama，容器编排实测待目标机运行 `npm run e2e:live`）
  - **现状**：`Dockerfile` 已改为非 root 多阶段构建（`builder` 正常安装 `esbuild` 构建 UI，`runtime` 保留 `git`/`postgresql-client`/`wget`、`HEALTHCHECK` 与 `start:server` 直启）；新增 `deploy/litellm_config.yaml` 映射 4 个模型别名；`deploy/docker-compose.yml` 补齐 PG/LiteLLM 健康检查、`service_healthy` 依赖与 `runtime_data`/`sandbox_worktrees` 持久卷；`deploy/.env.example` 全量补齐全部 30 个环境变量；新增 `scripts/e2e-live-stack.ts` 与 `tests/live-http-e2e.spec.ts`（5 项含真实 TCP `WorkbenchHttpServer` + 本地 TCP OpenAI 兼容 `/v1/chat/completions` & `/v1/embeddings` + `AUTH_REQUIRED=true` Cookie/改密/门禁/回退 + SSE 流测试），且已通过真实浏览器 UI 完成登录、强制改密、成员审计查看与 Gate 审批端到端走查（详见 [`P1_4_DEPLOY_AND_LIVE_E2E.md`](./P1_4_DEPLOY_AND_LIVE_E2E.md)）。**边界注**：当前宿主机未安装 `docker`/`psql`/`ollama`，真实 Compose 拉起、PG 与 Ollama 实网联合推理需在 Docker+PG+Ollama 宿主机执行 `npm run e2e:live -- --compose-config --pg-verify --http-smoke`。

### P2（架构演进、外部集成与工程卫生）

- [ ] **P2-1：H1–H3 企业真实外部系统接入**（待业务侧明确凭证与字段映射语义后实施，见 [`P2_REMAINING_PLAN.md`](./P2_REMAINING_PLAN.md)）。
- [x] **P2-2：Meridian UI Kit (`src/ui/kit/`) 实际接入 7 个业务视图 & `UI_SYSTEM_DESIGN_MAP.md` §14 全量改造**（✅ 已于第二十四轮 / Step 11 完成）
  - **现状**：后端补全 G1（`agentRationale`/`keyDecisions`）、G2（门禁暂停/自动放行/签核/驳回事件 `detailPayload`）、G3（`GET /api/events/history` 阶段与时间范围分页）、G4（Stage 1/3a 扩展同侪协商）与 G6（`structuredSummary`）；前端彻底删除 `ACTIONS_BY_STAGE`/`STAGE_DISCUSSIONS` 硬编码假文案，新增 `artifactParsers.ts`、`perspective.ts` 与 `AgentDeliverableReview.tsx`，7 个核心业务视图及 `Topbar`/`AgentFlowCanvas`/`DetailDrawer` 全部接入 `src/ui/kit/` 浅色默认令牌体系，并修复窄视口下 `.app-sidebar`/`.app-topbar` 遮挡问题（详见 [`P2_2_MERIDIAN_UI_V2_MIGRATION.md`](./P2_2_MERIDIAN_UI_V2_MIGRATION.md)）。
- [x] **P2-3：测试隔离卫生清理**（✅ 已于第二十五轮 / Step 12 完成）
  - **现状**：新增 [`tests/helpers/testIsolation.ts`](../tests/helpers/testIsolation.ts) 并将全部 13 个未完全隔离测试套件接入 `os.tmpdir()` 独立 `persistenceDir` + `sandboxRootDir` 与退出清理；新增 [`tests/test-isolation-hygiene.spec.ts`](../tests/test-isolation-hygiene.spec.ts) 对全仓 `tests/*.spec.ts` 进行构造点静态审计与清理行为守卫；已彻底清除工作区历史残留的 `9.9M` `.runtime-data/` 与 `188K` `.sandbox-worktrees/`，全量 `npm run check`（213 项 / 56 套件 / 34 文件全过）后验证仓库根目录零测试产物生成（`CLEAN_WORKSPACE_OK`，详见 [`P2_3_TEST_ISOLATION_HYGIENE.md`](./P2_3_TEST_ISOLATION_HYGIENE.md)）。
