# 后端 TODO 实现日志（执行记录）

> [!IMPORTANT]
> 本文档记录 `BACKEND_TODO.md` 各条目的**实际执行过程**（改动文件 / 边界处理 / 复盘发现 / 测试验证）。
> 设计依据：`BACKEND_TODO_DESIGN.md`。每完成一项在此追加记录。

---

## 审计基线

- 日期：2026-11-22
- 代码版本：React 前端 + TypeScript 仿真内核
- 测试基线：21 项测试（8 套件）全绿

---

## M1-A 真 AI 内核

### ✅ J1 演示开关迁出领域契约

**改动**：

- `src/domain/contracts.ts`：`ProjectProposalContract` 删除 `simulateNegotiationConflict / simulateScopeReductionAttempt` 字段及构造参数；新增 `toSerializableRecord()` / `fromSerializableRecord()`（D1 恢复需要）。
- 新增 `src/domain/scenario.ts`：`ScenarioHints` 类型（forceNegotiationDeadlock / forceScopeReduction / forceTransientRetry / forceQaFailure）。
- `WorkflowRunState` 新增 `scenarioHints` 字段（构造参数 + getter）；`DagWorkflowStateEngine.createRun()` 透传。
- `WorkflowOrchestratorFacade.startProposalWorkflow()` 参数改为 `scenarioHints?: ScenarioHints`（替代 `simulateTransientRetryOnStage1`）。
- `WorkbenchServer` preset 端点把 preset 名映射为 `ScenarioHints`（CONFLICT_AND_DDL → {forceNegotiationDeadlock, forceTransientRetry}；SCOPE_DIFF_ALERT → {forceScopeReduction}）。
- 6 个 Agent 子类的 `simulate*` 引用改为 `context.scenarioHints?.forceXxx`。

**边界处理**：旧持久化快照中若残留 simulate 字段 → 恢复时忽略（schemaVersion 升级到 1.1.0）。

### ✅ A1 Agent 产物生成接入真实 LLM

**改动**：

- 新增 `src/agents/prompt/StagePromptSpecs.ts`：6 阶段 Prompt 规格表（角色纪律 + 任务指令 + JSON Schema 提示）。
- 新增 `src/agents/prompt/JsonExtractor.ts`：从 LLM 输出文本稳健提取 JSON（剥离围栏 / 截取大括号）。
- 新增 `src/agents/deserialize/ArtifactContractFactory.ts`：按阶段把 LLM JSON 映射为强类型 `*ArtifactContract`（字段映射 + 默认值填充，业务校验走原 `validateContractIntegrity`）。
- `AbstractWorkerAgent.executeStagePipeline()` **异步化**（LLM 调用为 IO）；步骤 4 从"估算 → MeterInvocation → 模板 synthesize"改为"buildStagePrompt → invokeChatCompletion → JsonExtractor → ArtifactContractFactory"。
- 原 `synthesizeArtifact()` 重命名为 `synthesizeTemplateArtifact()`，降级为 `fallbackContentGenerator`（网关不可达时平滑回落）。
- `ModelRouterGateway.invokeChatCompletion` 增加 `AbortSignal.timeout(LLM_TIMEOUT_MS ?? 60000)`。

**边界处理**：①LLM 返回散文 → JsonExtractor 报 OUTPUT_NOT_JSON → A2 重试；②JSON 合法但缺必填 → 契约校验违规 → A2 重试；③网关超时 → AbortSignal → catch → 模板降级（usedFallbackTemplate=true）。

**验证**：`model-gateway.spec` 3 项测试通过（脱敏 / 协议 / 基线体检）。

### ✅ A2 自愈重试真实化

**改动**：

- 重试循环改为 violations 驱动：LLM 解析失败/契约违规 → 收集违规 → `buildStagePrompt` 附加 `priorViolations` 重试。
- 重试耗尽抛 `StageContractError(stageId, violations, retryCount)`。
- `Facade.continueExecutionUntilGateOrComplete` 外层 try/catch 捕获 `StageContractError` / `TokenBudgetExceededError` → `runState.setStatus('ABORTED')` 或 `'ABORTED_TOKEN_BUDGET'` → 推送 `STAGE_CONTRACT_FAILED` / `TOKEN_BUDGET_EXCEEDED` 通知（可操作）→ break。
- `forceTransientRetryOnce` 从 `AgentExecutionInputContext` 删除；演示场景的瞬态注入改走 `ScenarioHints.forceTransientRetry`。

**复盘发现**：旧测试 `architecture.spec test 2` 期望协商熔断但仍走模板路径——需改用 `scenarioHints: {forceNegotiationDeadlock: true}` 而非提案字段。

### ✅ A3 Token 计量与成本真实化

**改动**：

- `ModelInvocationReceipt` 新增 `usageEstimated: boolean`（网关返回 usage → false；缺失/降级 → true）。
- `AgentExecutionOutcome` 新增 `usageEstimated / usedFallbackTemplate` 字段。
- 删除 `estimateTokenUsage` 抽象方法；Token/成本直接取 `invokeChatCompletion` 返回的真实 usage。
- `WorkflowRunState.recordTokenUsage(delta)` 累计 run 级消耗（B3 预算检查数据源）。

**验证**：复盘报告中的 token/cost 现在来自真实网关 usage（或显式标记估算）。

### ✅ B3 DSL 守卫字段全量接线

**改动**：

- `WorkflowRunStatus` 新增 `'ABORTED_TOKEN_BUDGET'`。
- `NotificationCategory` 新增 `TOKEN_BUDGET_EXCEEDED / STAGE_CONTRACT_FAILED`。
- `AgentExecutionInputContext` 新增 `tokenBudgetRemaining: number`（Facade 每阶段计算：DSL budget - tokensUsedTotal）。
- `AbstractWorkerAgent` 每次 attempt 前检查预算，超出抛 `TokenBudgetExceededError`（不重试）。
- `sharedAgentDeps` 增加 `maxExecutionRetries: dslConfig.guardrails.maxExecutionRetries`（替代硬编码 2）。
- `WorkflowDslLoader` 新校验：`tokenBudgetLimit >= 1000`（硬下限）。

**验证**：单测可配 `tokenBudgetLimit: 1000` 验证首 Agent 熔断。

---

## M1-B 可信工程

### ✅ B2 QA↔Engineer 修复闭环 + 协商路由 DSL 化

**改动**：

- `WorkflowDslLoader` 新增 `findNegotiationTarget(stageId)`：读取 DSL `negotiateWithStageId` 声明。
- `Facade` 替换 STAGE_2_PD 硬编码分支为 `evaluateStageNegotiation()`：
  - PD 阶段：UI 设计质询 PM（designChallengeNote 非空时）
  - QA 阶段：验证失败质询 Engineer（`!allAcceptanceCriteriaMet || securityIssuesFound > 0` 时）
- QA 协商一致 → 自动 `forkAndRollbackToStage(STAGE_3B, 修复指令)` 重跑 3b→4，`autoRepairDirective` 拦截在门禁阻塞之前。
- `MAX_AUTO_REPAIRS = 2`（`src/engine/repairLoop.ts`）；`WorkflowRunState.recordAutoRepair / getAutoRepairCount` 防死循环。
- 修复指令带轮次前缀（`QA 修复第 N 轮：`）——**防缓存命中同一失败产物**（关键边界）。
- 修复决策（REJECT）沉淀入负向经验飞轮。
- `NegotiationTurnRecord` / `mediator` 增加 `topic` 字段（DESIGN_REVIEW / QA_REPAIR）。
- `ScenarioHints` 新增 `forceQaFailure`（演示/测试用）。

**边界处理**：①修复轮次 ≥2 → forceDeadlock=true → 仲裁卡阻塞；②指令轮次前缀防缓存命中；③fork 后旧 QA 快照自动 SUPERSEDED；④修复指令同时入 RAG（REJECT 沉淀）。

**验证**：新增 `tests/qa-repair-loop.spec.ts`（2 项测试）：

- QA 失败 → 2 轮修复 → 超限仲裁（4 项断言：分支数/修复计数/通知类型/RAG 沉淀）
- QA 通过 → 不触发修复闭环（回归）

### ✅ E1 真实 Git Worktree

**改动**：

- 新增 `src/sandbox/RealGitWorktree.ts`：`add(runId, branchId)` 执行真实 `git worktree add`；分支重名自动 `-v{n}` 后缀；路径脏 prune 重试；`remove()` 清理。
- `GitWorktreeSandboxManager` 构造参数增加 `{repoPath?: string}`（env `GIT_REPO_PATH`）；真实模式下不再伪造 `.git` HEAD。
- 新增 `simulated: boolean` 到 `SandboxProvisionResult`（D-2 显式降级标记）。
- 新增 `cleanupWorktree(runId, branchId)`。

**边界处理**：①分支重名 → 后缀；②路径脏 → prune 重试；③git 不可用 → 降级模拟（WARN）；④Windows 路径 → `path.join`。

### ✅ E2 测试结果真实采集

**改动**：

- 新增 `src/sandbox/TestResultParser.ts`：解析 `node --test --test-reporter=spec --experimental-test-coverage` 的输出（ℹ tests/pass/fail 计数 + "all files" 覆盖率行）。
- 沙箱生成的单测模板改为 node:test 风格（2 个真实用例：主路径 + 空 actorId 防护）。
- `executeSandboxVerification`：逐文件真实执行 node:test → 解析计数/覆盖率 → 删除 `需求×6` 硬编码与 "95.6%" 写死字符串。
- `SandboxVerificationResult` 增加 `failedTestCases / coveragePercent / suites` 字段。
- Engineer Agent `selfTestPassed` 改为真实结果（`failedTestCases===0 && securityIssuesFound===0`）。
- QA Agent 使用 `verification.suites` 真实数据（不再硬编码套件）。

**关键边界（发现于复盘）**：从主测试运行器派生的子进程继承 `NODE_TEST_CONTEXT` env → 子进程 `node --test` 判定"递归运行"而跳过全部文件 → 计数为 0。**修复**：`TestResultParser.runSuite` 从 env 中删除 `NODE_TEST_CONTEXT` 键（`delete env.NODE_TEST_CONTEXT`，不能设为空字符串）。输出无法解析时如实记为 1 条失败（不编造通过数）。

**验证**：`sandbox-manager.spec` 断言 totalTestCases=4（2 文件×2 用例）、passedTestCases=4、coveragePercent 非 null。

---

## M1-C 可交付

### ✅ D1 启动恢复闭环

**改动**：

- `PersistedLedgerSnapshot.runs[]` 扩展：`proposal / stagePipeline / currentStageIndex / branchCounter / branchHistory / tokensUsedTotal / scenarioHints`；`schemaVersion` 升级 `'1.1.0'`；新增顶层 `liveEvents`（EventBus 事件历史）。
- 新增 `src/engine/pg/StateReconstructor.ts`：从持久化快照重建全部内存状态（runs/snapshots/decisions/negotiation/RAG/events）。
- 各领域实体新增 `fromJSON` 静态方法（`NegotiationTurnRecord` / `HumanDecisionRecord` / `ScopeDiffReport` / `WorkflowDomainEvent`）。
- `WorkflowEventBus.restoreEvent()` / `BoundedNegotiationMediator.restoreTurn()` / `ImmutableAuditLedger.restoreDecision()` / `NegativeExperienceRagEngine.restoreRecord()`：不触发观察者/不重放 WAL（防 RAG 双计）。
- `WorkflowRunState.restoreInternals()`：从持久化数据恢复私有字段。
- `Facade.restoreFromPersistence()`：读取 `ledger-store.json` → schemaVersion 校验 → StateReconstructor 重建 → 返回恢复的 runIds。
- `WorkbenchServer` 启动：D1 恢复优先 → 失败/无数据 → 播种演示场景（`SEED_DEMO_DATA` 可控）。

**边界处理**：①JSON 损坏 → try/catch → 播种；②schemaVersion 过旧 → 拒绝恢复；③JSONL 不重放；④`WorkflowRunState.restoreInternals` 需要精确恢复 branchCounter/branchHistory/tokensUsedTotal。

**验证**：创建运行 → 重启进程 → `GET /api/state` 数据完整。

### ✅ F1 登录会话与身份校验

**改动**：

- 新增 `src/server/auth/SessionService.ts`：
  - `scrypt` 口令哈希（每用户随机 salt）+ `timingSafeEqual` 比对
  - 会话 Token = `crypto.randomBytes(32).base64url`，服务端存 SHA-256，HttpOnly Cookie
  - 8h 滑动续期；连续失败 5 次锁定 60s；改密吊销其他会话
  - `actAs(adminToken, targetUserId)`：管理员视角切换（session 记录 `impersonatedBy`）
  - 用户 CRUD：`createUser` / `updateUser`（停用= 吊销会话）/ `resetPassword`（吊销 + 临时口令）
  - 首次初始化播种 7 个企业成员（口令=username，`mustChangePassword=true`）
- `WorkbenchServer` 新增 7 个认证端点（login/logout/me/change-password/act-as + admin/users × 2）+ `/api/admin/users` 管理 API。`[复核注：至第九轮已演进为 10 个认证与用户管理/审计端点，新增 PATCH /api/admin/users/:id、POST /api/admin/users/:id/reset-password、GET /api/admin/login-audit]`
- `resolveActorUserId()` 重写：`AUTH_DISABLED=true` → 旧行为（测试/演示）；否则从 Cookie/Bearer 校验会话 → 返回真实 userId → 未认证返回 `'UNAUTHENTICATED'`。`[复核注：已在第九轮进一步收紧并重命名为 resolveAuthContext()]`
- `RbacGovernanceService.getUserOrDefault` 保留（AUTH_DISABLED 时兼容）。

**边界处理**：①防用户枚举（统一文案）；②锁定 423 + Retry-After；③停用即时踢出（validate 查 status）；④改密吊销其他会话；⑤act-as 会话 `impersonatedBy` 审计；⑥最后一个 ACTIVE admin 不可停用（409）。

**验证**：登录 → me → 裁决（RBAC 403/200）→ act-as → 改密 → 全流程测试待补。`[复核注：已在第九轮由 session-service.spec.ts 共 23 项测试补齐]`

---

## M1-C 补充

### ✅ D2 PostgreSQL 直连驱动

**改动**：

- `PersistenceRepository` 新增 `PersistenceDriver` 接口；`persistFullState` 尾部在 `DATABASE_URL` 存在时通过 `psql -f` 执行 SQL 同步脚本（失败不阻塞主流程，JSON 兜底）。
- 新增 `src/engine/pg/PgPersistenceDriver.ts`：upsert 5 表（workflow_runs / stage_snapshots / negotiation_logs / human_decisions / rejected_history_rag），参数化查询防注入。`[复核纠正：现行 PgPersistenceDriver 仅覆盖 4 表、遗漏 negotiation_logs 且 token_budget 硬编码为 120000，使用字符串 escape 拼接 SQL 且尚未在 src/ 接线，loadFullState() 返回 null；已登记为 AUDIT-8（✅ 已于第十二轮 #8 完整修复）]`
- `selectPersistenceDriver(databaseUrl)` 选择器：PG / JSON 切换。

**边界**：PG 不可达 → WARN + JSON 兜底（D-2）；psql CLI 方式避免引入 pg 原生依赖。

---

## P1 已实现项

### ✅ C1 SSE 逐事件桥

**改动**：新增 `src/server/SseBridge.ts`（实现 `IWorkflowEventObserver`）；WorkbenchServer 构造时注册到 EventBus。Agent 生命周期事件/通知实时推送为 `run_event` / `user_notification` SSE 帧（不等全量帧）。

### ✅ I2 健康检查端点

**改动**：`GET /api/health` 返回 `{ status, activeRunId, sseClients, persistenceDir, authRequired, authDisabled, databaseUrl, llmLiveHttp, uptimeSec }`。

### ✅ D3 SSE Last-Event-ID 重放（部分）

**改动**：`SseBridge` 内置 200 条环形缓冲 + `replay(clientLastId, write)` 方法。服务端已写 `id: N` 到每个 SSE 帧。客户端重连时可通过 `Last-Event-ID` 请求重放。`[复核注：已于第十三轮 #13 完成 GET /api/events/stream 接线与按 runId 过滤重放]`

---

## 第二轮实现（P1 继续）

### ✅ C3 总管 NL 解析 LLM 化

**改动**：

- `SupervisorAgent` 构造器增加可选 `modelRouter` 参数；`parseNaturalLanguageRollback` 改为 `async`。
- 新增 `tryLlmParse(text)`：用 LLM 输出 `{targetStageId, cleanInstruction}`（枚举校验拦截注入）；失败/离线 → 回退到 `keywordParse`（原有关键词匹配不变）。
- Facade 构造 SupervisorAgent 时传入 `modelRouter`；`invokeSupervisorConversationalRollback` 对 parse 调用加 `await`。`[复核注：当时 Facade 实为漏传 modelRouter，已在第八轮 #2 补齐]`

**边界**：①枚举外 targetStageId → 拒绝；②离线 → 关键词回退；③指令仅作为 directive 传递，不执行为代码。

### ✅ B1 协商 LLM 化

**改动**：

- `BoundedNegotiationMediator` 新增 `NegotiationRoundRunner` 接口 + `setRoundRunner()` 方法。
- `mediateChallenge` 改为 `async`；有 runner 且在线时每轮调用 LLM 生成真实响应文本 + 共识判定 + 方案 A/B；离线/异常 → 剧本降级。
- Facade 构造 mediator 时注入 LLM-backed runner（调 `modelRouter.invokeChatCompletion`，system prompt 指定双角色视角 JSON 输出格式）。
- `consensusReached / escalated` 判定：LLM `consensusReached` 覆盖剧本预设值；`forceDeadlockToMaxTurns`（scenarioHints）仍可强制熔断。

**边界**：①离线 → runner 返回 null → 剧本路径；②LLM 恒不共识 → Max Turns 熔断；③Token 超预算 → 中止协商上报。

### ✅ F2 用户管理 API（已随 F1 实现）

**改动**：`WorkbenchServer` 已含 `GET/POST/PATCH /api/admin/users` + `POST /api/admin/users/:id/reset-password` + `POST /api/auth/act-as`，权限码 `MANAGE_RBAC_POLICY` 校验。

### ✅ I1 compose 联通验证

**改动**：`WorkbenchServer` 健康检查端点 (`/api/health`) 返回 `databaseUrl` 配置状态；`PgPersistenceDriver` 在 `DATABASE_URL` 存在时自动启用 psql 同步。`[复核注：实际由 PersistenceRepository.persistFullState 直接调 psql，PgPersistenceDriver 尚未接线（AUDIT-8），且容器缺 postgresql-client 与 LITELLM_ENABLE_LIVE_HTTP=true（AUDIT-14）（✅ 已于第十二/十四轮修复）]`

### 复盘发现（第二轮）

1. **C3 LLM 解析**的 `targetStageId` 枚举校验是注入防线——枚举外的值直接丢弃并回退到关键词。
2. **B1 协商 LLM 化**的关键取舍：每轮 2 次 LLM 调用（挑战+响应）成本约 400 tokens；与 C1 SSE 桥结合可实现实时协商过程展示。
3. **测试修复**：sandbox-manager.spec test 3 的 rollback 调用需要 `await`（async 化遗留）。`summarizeConflict` 需取最后一个协商轮次（首个的 `escalatedToSupervisor=false`）。

---

## 第三轮实现（高优补测 + C2 + 上下文介入）

### ✅ 高优测试缺口补齐（三项全完成）

**改动**（对应上一节"下一步优先补测项"表的高优先级行）：

- `tests/full-pipeline-llm.spec.ts`（3 项）：mock transport 按阶段返回各阶段 JSON → 断言 6 阶段全部经 LLM 驱动推进到 QA 终审门禁乃至 DA；含"LLM 缺字段 → 自愈重试后全管道不中断"。补上"A1 集成测试只覆盖 PM 阶段"的缺口。
- `tests/concurrency-and-cache.spec.ts`（6 项）：①两个提案并发推进 → runId 隔离、快照/决策/事件零交叉污染；②并发提案缓存键不冲突；③PromptCacheManager L1 精确命中 / L2 语义命中 / 未启用 MISS / savedTokens 真实计量。
- `tests/supervisor-tools.spec.ts`（4 项）：C2 四工具契约。

### ✅ C2 总管四工具

**改动**：

- 新增 `src/agents/supervisorTools.ts`：`getRunOverview`（运行全景）/ `summarizeConflict`（协商日志→裁决卡）/ `overrideGate`（复用 `submitHumanGateDecision`，RBAC 内建）/ `rollbackAndFork`（复用对话式回退）。
- 导出 `SUPERVISOR_TOOL_SCHEMAS`（4 个工具定义，供 M3 LLM function-calling 注册）。
- 四个函数为总管操作**唯一入口**，禁止直接修改业务产物（黄金架构铁律）。

### ✅ G10 Agent 外部知识介入（上下文摄取）

**改动**：

- 新增 `src/agents/context/`（5 个文件）：
  - `types.ts`：ContextNeed / ContextProvider / ContextResult 契约 + `STAGE_CONTEXT_NEEDS` 各阶段需求声明表（如 3a 需 code_structure/db_schema）+ `estimateTokens`（中文 1/字、英文 1/4 chars）。
  - `ToolRegistry.ts`：注册 Provider → 按 need 解析 → run 级缓存（`runId:type:stageId` 键）→ BudgetTrimmer 裁剪；`getCached` 同步读缓存供 prompt 注入。
  - `ContextBudgetTrimmer.ts`：required 优先 → 按 maxTokens 降序 → 超预算截断（剩余 <100 tokens 直接跳过）。
  - `GitContextProvider.ts`：真实读取仓库目录树（限深 3）+ package.json/tsconfig 摘要 + SQL Schema 文件（`GIT_REPO_PATH` 启用）。
  - `UpstreamCompressor.ts`：上游产物按阶段提取关键决策字段（非全文注入，省 Token）。
- 接线：`Facade` 构造时创建 ToolRegistry（budget 4000）并注入全部 Agent；每阶段执行前 `resolve()` 预取入缓存；`buildStagePrompt` 从 runCache 读取注入 `externalContext` 字段。
- required 上下文缺失/Provider 抛错 → 静默降级不阻塞流水线（D-2）。

**中断与收尾（2026-11-23 凌晨）**：本模块写入 `UpstreamCompressor.ts` 时会话中断，遗留两处问题，已收尾修复：

1. `KEY_FIELD_EXTRACTORS` 缺 `STAGE_0_INITIATION` 条目 → typecheck 失败（会话卡死的直接原因）。
2. **压缩器读取不存在的 `artifactDetails` 属性**——所有 `*ArtifactContract` 均为扁平强类型结构（userStories/apiContracts 等直接在类上），原实现即使编译通过也只会得到空 keyFields。修复为直接从产物对象提取（提案契约同样适用）。

**验证**：新增 `tests/agent-context.spec.ts`（11 项）——Compressor 提取（Stage 0/1/4 真实契约类 + token 上限）、ToolRegistry（Provider 匹配 + runCache 命中计数 / required 缺失显式 truncated / optional 缺失静默 / Provider 抛错降级）、BudgetTrimmer（required 优先 / maxTokens 上限 / 剩余 <100 跳过）、estimateTokens 计数口径。

**测试基线（第三轮末）**：92 项测试（30 套件）——88 通过 / 4 跳过（`test-result-parser.spec` 2 项含 Windows 超时及空输出兼容性 + `a1-llm-integration.spec` 2 项）/ 0 失败；typecheck + eslint + prettier 全绿。

---

## 第四轮实现（embedding 化 + 上下文介入补全，2026-11-23）

> 每项有独立实现文档：`docs/G1_SEMANTIC_CACHE_EMBEDDING.md` / `docs/G2_RAG_EMBEDDING.md` /
> `docs/CONTEXT_MCP_PROVIDERS.md` / `docs/DYNAMIC_CONTEXT_NEEDS.md`。

### ✅ G1 L2 语义缓存 embedding 化

- 网关新增 `ModelRoutingTier.EMBEDDING` + `invokeEmbedding`（OpenAI 兼容 `/v1/embeddings`，本地 bge-m3 默认，专用 `EmbeddingHttpTransport` 注入口）。
- 新增 `src/telemetry/EmbeddingProvider.ts`：`EmbeddingProvider` 抽象 + `GatewayEmbeddingProvider` + 共享 `cosineSimilarity`（min(len) 兼容）。
- `PromptCacheManager` L2：键相等 → **余弦 ≥ 0.86**（`SEMANTIC_CACHE_THRESHOLD` 可调）；意图文本含需求**描述**（修复"同条数不同语义误命中"）；lookup/store 异步化；embedding 失败仅 L1 + `embeddingUnavailableLookups` 诚实记账。
- L0 前缀缓存一并完成：`StagePromptSpecs` 公共纪律移至 systemPrompt 最前（6 阶段共享逐字节前缀，provider KV 缓存可命中）。

### ✅ G2 RAG embedding 化（替换 M7 哈希伪向量唯一路径）

- `NegativeExperienceRagEngine`：同步哈希落库（1536 维，对齐 PG `vector(1536)`，SQL 脚本同步改维度）+ provider 在位时后台串行队列升级真实 embedding；失败保持哈希 + `needsReembedding`；检索混检（哈希↔真实）显式 `matchDegraded` 标记。
- `restoreRecord` 对旧格式记录自动入升级队列（跨重启收敛）。
- async 化波及：`getRejectionLessonsForStage` / Facade lessons 调用 / `/api/rag/query` / qa-repair-loop 测试。

### ✅ 步骤 3 MCP 三服务器

- 新增 `src/agents/context/McpContextProvider.ts`（通用 JSON-RPC 2.0 `tools/call` 客户端，postJson 测试注入口，MCP_AUTH_TOKEN）。
- 新增 `src/agents/context/StubProviders.ts`（Figma/数仓确定性 stub，`isReal:false` 诚实降级）。
- Facade env 切换：`FIGMA_MCP_URL` / `WAREHOUSE_MCP_URL` 配置即接真实 MCP server，未配置用 stub 补位——PD/DA 的 required 外部知识从"永远缺失"变为"本地必达"。

### ✅ 步骤 4 LLM 意图分析（动态上下文需求）

- `Facade.inferDynamicContextNeeds`：轻量 LLM 规划器按提案推断额外知识需求；三道防线（离线零调用 / `ALL_CONTEXT_NEED_TYPES` 目录白名单注入拦截 / 上限 3 条一律 optional）。
- 动态需求与静态声明合并预取，经 `AgentExecutionInputContext.dynamicContextNeeds` → `buildStagePrompt` 注入 externalContext。

**测试基线（第四轮末）**：107 项测试（33 套件）——103 通过 / 4 跳过（既有）/ 0 失败；typecheck + eslint + prettier 全绿。

### ✅ A4 意图识别 LLM 化 + 体检端点（第五轮，2026-11-23，独立文档 `docs/A4_INTENT_LLM_AND_BASELINE.md`）

- `__intent` 随主 LLM 调用返回（buildStagePrompt 固定指令 + captureLlmIntent 校验捕获），Agent 实例级 `lastLlmIntent` 跨 run 复用；`resolveStageIntent` 优先 LLM 意图、回落子类规则（同步签名保持，零额外 LLM 往返）——**M5 Mockup 替代完毕，M1-M7 全部清零**。
- `runModelBaselineCheck()`：3 个固定 JSON 任务 × 两级端点 → 6 份 `evaluateEndpointBaseline` 报告；`POST /api/admin/model-baseline`（admin-only）替换硬编码样例占位实现；治理视图新增模型体检按钮（React，层级一行化结果）。
- 测试：`tests/a4-intent-and-baseline.spec.ts`（5 项——意图时序/非法回落/端点离线/在线 6 报告/403）。

**测试基线（第五轮末）**：112 项测试（35 套件）——108 通过 / 4 跳过（既有）/ 0 失败；typecheck（含前端）+ eslint + prettier 全绿；UI bundle 已构建。

## 第六轮实现（E3 docker 运行时，2026-11-23，独立文档 `docs/E3_DOCKER_RUNTIME.md`）

### ✅ E3 docker 沙箱测试运行时

- 新增 `src/sandbox/DockerTestRuntime.ts`：一次性 `node:22-alpine` 容器执行单测（`--network none` / worktree 只读挂载 / 结果目录读写 tee 留档 / 超时 kill + best-effort `docker rm -f`）。**对设计的偏离**：dockerode → docker CLI（零 npm 依赖，与 psql CLI 先例一致）。
- `GitWorktreeSandboxManager.executeSandboxVerification` 运行时切换：`SANDBOX_RUNTIME=docker` 且可用 → 容器执行；不可用/失败 → 显式 `host-fallback` 降级（D-2）；`SandboxVerificationResult` 新增 `runtime` 字段 + 日志行。同步执行口径与 E2 一致，调用方零改动。`[复核注：第十四轮 #12 已改为 POSIX 重定向 + exit $ec 保留退出码，仅 infrastructureFailure 时才降级 host-fallback，容器单测失败 exitCode=1 维持 runtime='docker']`
- `TestResultParser.parseSuiteOutput` 抽取（宿主机/docker 共用解析口径）。
- 测试：`tests/docker-runtime.spec.ts`（5 项——命令构造/超时清理/docker 集成/host-fallback 降级/默认回归）。

**测试基线（第六轮末）**：117 项测试（37 套件）——113 通过 / 4 跳过（既有）/ 0 失败；typecheck + eslint + prettier 全绿。

## 第七轮实现（P2 内部逻辑项，2026-11-23，用户决策：H 系列挂起待业务思考）

> 独立文档：`docs/I3_DATA_RETENTION.md` / `docs/G11_WAREHOUSE_CLOSED_LOOP.md` / `docs/J2_PLUGGABLE_NODES.md`。
> 挂起决策与分析见 `docs/P2_REMAINING_PLAN.md`。

### ✅ I3 数据保留

- 审计 WAL 按月归档（`audit-trail-YYYY-MM.jsonl`，按 entry.timestampIso 归属；旧单文件兼容合并读取；`AuditTrailEntry` 新增可选 timestampIso）。
- `GitWorktreeSandboxManager.enforceWorktreeRetention`：保留最近 N=10 个 run（`SANDBOX_WORKTREE_RETENTION` 可调），`protectRunIds` 保护活跃 run；真实模式先 `git worktree remove` 再删目录。
- Facade 终态钩子（COMPLETED/ABORTED/ABORTED_TOKEN_BUDGET 三处）触发保留策略，旁路 try/catch 不影响主流程。

### ✅ G11 Stage 5 数仓闭环（mock 可验证范围）

- 新增 `WarehouseQueryProvider`：只读 SQL 白名单模板（2 个）+ 三层只读防线（会话只读/模板白名单/runId 净化）+ `psql --csv` 零依赖 runner（可注入）+ 查询失败回落 stub 显式降级。
- `createAnalyticsProvider` 工厂：`WAREHOUSE_MCP_URL` > `WAREHOUSE_CONNECTION_STRING` > stub，Facade 注册改用工厂——真实数仓接入 = 配 env 零代码改动。

### ✅ J2 可插拔节点（最小注册表层）

- 新增 `AgentRegistry`：自定义节点注册（键格式校验 + 核心枚举保护 + 同键覆盖幂等）；`isValidStageId/isValidAgentRole` 注册表口径；`getRequiredHumanRoles` 配置化映射。
- `WorkflowDslLoader` 两遍解析（先注册全部自定义节点 → 再构建描述符），DSL 可声明新节点与协商目标；核心阶段角色语义保护不变。
- `RbacGovernanceService` 构造器注入注册表，自定义节点门禁角色配置化（缺省仅管理员）。
- Facade：自定义节点 = 编排检查点（广播 STAGE_PROGRESS 通知后跳过推进）；`dsl-loader.spec` 既有断言按新语义更新。

**测试基线（第七轮末）**：133 项测试（43 套件）——129 通过 / 4 跳过（既有）/ 0 失败；typecheck + lint + prettier 全绿。

---

## 第八轮实现（审计修复：核心 AI 编排与沙箱链路设计断层，2026-11-23）

### ✅ 1. 在线 LLM 模式下 Stage 3b/4 真实物理沙箱落盘与防谎报校验（A1 ↔ E1/E2/E3 闭环）

- **问题根因**：`provisionWorktreeAndWriteCode` 与 `executeSandboxVerification` 原先仅写在 `SoftwareEngineerAgent` / `QualityAssuranceAgent` 的 `synthesizeTemplateArtifact()`（离线 fallback）中；在线 LLM 模式下不走 fallback，导致既不创建物理沙箱/落盘代码，也不执行真实 `node:test`/Docker 单测，且 `buildStagePrompt` 未注入 `sandboxVerification`。
- **修复**：
  - `AbstractWorkerAgent` 新增 `prepareStageEnvironment(context)` 与 `validateStageSpecificConstraints(candidate, context)` 两个生命周期钩子；步骤 4 重试循环前先执行物理环境准备并将结果作为 `sandboxVerification` 注入 `buildStagePrompt`；同时修复重试违规未推入 `retryReasons` 的遗漏。
  - `SoftwareEngineerAgent` 在 `prepareStageEnvironment` 中执行真实 Git Worktree 沙箱代码落盘与 `node:test` 自测（离线模板复用同一结果，避免重复执行子进程），并在 `validateStageSpecificConstraints` 中拦截真实自测失败却谎报 `selfTestPassed=true`。
  - `QualityAssuranceAgent` 在 `prepareStageEnvironment` 中执行真实沙箱测试与静态安全扫描；`QaVerificationArtifactContract.validateContractIntegrity()` 与 `QualityAssuranceAgent.validateStageSpecificConstraints()` 双重拦截 `passedCases < totalCases` 或真实沙箱存在未通过用例/安全漏洞时谎报 `allAcceptanceCriteriaMet=true` 的行为，触发 A2 自愈重试。

### ✅ 2. C3 总管自然语言解析在 Facade 接线 + 动态阶段白名单

- **问题根因**：`WorkflowOrchestratorFacade` 构造 `SupervisorAgent` 时漏传 `this.modelRouter`，导致生产路径中 `tryLlmParse()` 恒返回 `null`；且 `tryLlmParse` 仅校验静态枚举，未校验当前流水线启用阶段与 J2 自定义节点。
- **修复**：`Facade` 构造 `new SupervisorAgent(this.eventBus, this.modelRouter)`；`invokeSupervisorConversationalRollback` 将 `runState.getStagePipeline()` 传入 `parseNaturalLanguageRollback`，`tryLlmParse` 与 `keywordParse` 均受当前活跃阶段拓扑与 `AgentRegistry` 白名单约束。

### ✅ 3. B1 受限协商多轮博弈、死锁方案生成与 Token 记账修复

- **问题根因**：`BoundedNegotiationMediator.mediateChallenge` 在 `forceDeadlockToMaxTurns=false` 时循环上限写死为 1 且 `escalated` 写死为 `false`（首轮未共识即停止且不熔断）；而在 `forceDeadlockToMaxTurns=true` 时跳过了 `roundRunner`（熔断时反而不用 LLM 生成方案 A/B，且 QA 修复熔断复用了 PD/PM 三维画布硬编码文案）；此外协商 LLM 调用未校验必填字段且未计入 `runState` Token 消耗。
- **修复**：循环上限统一为 `maxNegotiationTurns`，达成共识即 `break`、持续分歧则推进至满轮触发 `escalatedToSupervisor=true`；死锁模式下仍调用 `roundRunner` 生成真实方案 A/B；新增 `QA_REPAIR` 主题专属兜底方案 A/B；`BoundedNegotiationOutcome` 增加 `totalTokensConsumed` 并由 `Facade` 计入 `runState.recordTokenUsage()`。

### ✅ 4. A4 意图缓存按需求集合签名隔离（防跨提案串味）

- **问题根因**：`AbstractWorkerAgent.lastLlmIntent` 为单例 Agent 上的无作用域属性，不同业务提案跨 run 执行时会复用上一提案的意图编码与描述，污染 L2 语义缓存查询文本。
- **修复**：改为 `llmIntentByScope: Map<string, RecognizedStageIntent>`，按 `stageId + 核心需求 ID/描述签名 + humanFeedbackDirective` 隔离——同构需求跨 run 仍零往返复用 `__intent`，不同需求提案自动回落规则意图。

**测试基线（第八轮末）**：136 项测试（43 套件）——新增在线沙箱落盘与 QA 防谎报自愈、C3 总管 Facade LLM 接线、B1 在线多轮协商演进、A4 跨提案防串味断言。

---

## 第九轮实现（审计修复：认证、会话与 RBAC 权限体系安全漏洞，2026-11-23）

### ✅ 5. 关闭未认证/未知用户的管理员静默提权漏洞 + 补齐服务端权限码守卫（F1）

- **问题根因**：`WorkbenchServer.resolveActorUserId` 在未开启 `AUTH_DISABLED` 且未登录时返回 `'UNAUTHENTICATED'`，但业务写路由未拦截 `'UNAUTHENTICATED'`；当传入 `orchestrator` 后，`RbacGovernanceService.getUserOrDefault` 将未知字符串一律回落为 `'user-admin-01'`（最高管理员），造成未认证请求与未知 `X-Actor-Id` 直接以管理员身份通过审批与全局治理；同时 `AUTH_REQUIRED` 守卫、`mustChangePassword` 强制改密拦截及 `ROUTE_PERMISSIONS` 权限码中间件尚未在服务端落地。
- **修复**：
  - `RbacGovernanceService` 新增 `getUserStrict()` 与 `assertHasPermission()`，并将 `assertCanApproveStageGate` / `assertIsProjectAdmin` / `assertCanInvokeRollback` 全部改为调用 `getUserStrict()`（未认证、未知或已停用账号一律抛 `[RBAC 权限拦截]`）；`evaluateStageAccess()` 对未知/未认证/已停用用户返回 `canApproveOrArbitrate: false`。`getUserOrDefault()` 仅保留给只读默认展示投影，不再用于任何权限校验。
  - `WorkbenchHttpServer` 重写为 `extractSessionToken()` + `resolveAuthContext()`：失效/伪造 Token 统一拦截返回 `401`；开启 `AUTH_REQUIRED=true` 时，除 `/api/health`、`POST /api/auth/login`、`POST /api/auth/logout` 与静态资源外全部要求有效会话（`401`），且 `mustChangePassword=true` 仅放行 `/api/auth/me` 与 `/api/auth/change-password`（其余 `403`）；对 `POST /api/proposals`、`POST /api/decisions`、`POST /api/supervisor/rollback`、`POST /api/sandbox/verify`、`POST /api/admin/governance`、`POST /api/workflows/template`、`POST /api/runs/select`、`POST /api/comments`、`POST /api/rag/ingest` 接入 `assertHasPermission` 系统权限码校验；新增 `GET /api/admin/login-audit` 审计查询端点；暴露 `handleHttpRequest()` / `waitUntilReady()` 支持进程内 HTTP 守卫测试。

### ✅ 6. 打通 `SessionService` 与 `RbacGovernanceService` 用户数据源（F2）

- **问题根因**：`SessionService` 读写 `users.json`，而 `RbacGovernanceService` 独立维护硬编码 7 人内存 Map，导致后台新建成员 `usr_xxx` 不被 RBAC 识别（甚至回落成管理员），且修改 `ownedStageIds` 或停用账号不实时生效。
- **修复**：
  - `RbacGovernanceService` 新增 `derivePermissionsForRole()`、`upsertUserAccount()`、`setUserStatus()`、`isUserActive()`。
  - `WorkbenchHttpServer` 将 `SessionService` 的 `users.json` 指向 `orchestrator.persistenceRepo.getStorageDir()` 并绑定 `orchestrator.rbacService`；`SessionService` 初始化、`createUser()`、`updateUser()` 实时同步账号与停用状态至 `RbacGovernanceService`。

### ✅ 7. `SessionService` 会话存储与安全细节修复

- **修复**：
  - 服务端会话表 `sessions` 键由明文 token 改为 `SHA-256(token)` 十六进制摘要（对齐 `USER_SYSTEM_DESIGN.md` §2.1）。
  - 修复 `changePassword()` 中 `token !== userId` 导致误删当前会话的缺陷，新增 `currentToken` 参数并按摘要精确保留当前会话、仅吊销其他设备会话。
  - 补齐 `loginAudit`（记录 `UNKNOWN_USER` / `BAD_PASSWORD` / `LOCKED` / `DISABLED` / `OK` / `ACT_AS`）；`updateUser()` 支持 `department` 与 `tier` 修改，并禁止降级最后一个 ACTIVE 管理员（`409`）；对齐 7 人默认花名册 `displayName` 与 `ownedStageIds`（含 `STAGE_0_INITIATION`），去除重复 `...def`。

**测试基线（第九轮末）**：143 项测试（45 套件，25 个测试文件：139 通过 / 4 既有跳过 / 0 失败）——新增会话 SHA-256 摘要校验、改密保留当前会话、最后管理员防降级、登录审计、用户源双向同步与禁止未知用户提权、`AUTH_REQUIRED=true` 进程内 HTTP 路由守卫等 7 项测试；`typecheck:backend` 与 `lint:backend` 全绿。

---

## 第十轮实现（Agent 准确率、跨模型缓存、Token/防死循环与反迎合协商治理，2026-11-23）

> 正式设计、交付标准（DS-1~DS-4）与量化验收标准（AC-1~AC-12）见独立规范文档：[`docs/AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md`](./AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md)。

### ✅ Pillar 1：多模型准确率与非代码阶段确定性语义校验（DS-1 / DS-2）

- **`ModelRouterGateway`**：新增 `ModelCapabilityProfile`（`qualityRank`、`supportsJsonSchema`、`recommendedTemperature`、`preferFewShotExample`、`supportsPromptPrefixCache`），支持下发 `response_format: { type: 'json_schema', json_schema: { strict: true } }` 并在不支持端点回落 `json_object`；`ModelInvocationReceipt` 记录提供商侧前缀缓存 `cachedPromptTokens`。
- **`StagePromptSpecs`**：新增 `STAGE_PROMPT_VERSION` 与 `computePromptSpecHash()`，并为 6 个核心阶段补充精确 `jsonSchema` 与中小模型 1-shot `compactExampleJson`。
- **`ProductManagerAgent` / `ProductDesignerAgent` / `TechLeadAgent`**：实现 `validateStageSpecificConstraints()`，共享 `containsPlaceholderText()`（`src/domain/contracts.ts`）拦截 `TBD`/`TODO`/`待定`/`暂不实现` 占位符、缺失 Story/组件映射、非法 HTTP 方法与 DDL 动词及高危需求低报 `LOW`（同时保留 `forceScopeReduction` 进入 Step 5）。

### ✅ Pillar 2：跨模型三层缓存防质量倒挂与向量空间隔离（DS-3）

- **`PromptCacheManager` + `EmbeddingProvider`**：L1/L2 条目记录 `modelQualityRank`、`modelIdentifier`、`promptSpecHash` 与 `embeddingSpaceId`。检索时高能力请求（`minQualityRank`）自动绕过低等级缓存（`qualityUpgradeBypasses`），禁止弱模型污染/覆写同版本强模型条目；切换 Embedding 模型或变更 `promptSpecHash`/阶段自动隔离分桶（`crossSpaceSkips`）。

### ✅ Pillar 3：Token 节省、停滞升舱熔断与工具防死循环（DS-3）

- **`AbstractWorkerAgent`**：步骤 4 重试循环接入违规签名停滞检测——连续两轮相同违规时，本地私有小模型在线路径自动升舱至 `HIGH_REASONING_HYBRID` 破局，高阶或模板路径提前触发 `STAGNATION_CIRCUIT_BREAKER`；部分校验失败次轮自动注入 `repairMode: 'TARGETED_PATCH'` 与 `previousValidKeys`。
- **`ToolRegistry` + `ToolCallLoopGuard`**：独立导出 `ToolCallLoopGuard` 实现参数哈希去重（`deduplicatedCalls`）、单阶段调用次数预算上限（`budgetBlockedCalls`，默认 8 次）与超长结果截断（`truncatedResults`，默认 6000 字符并标 `truncated: true`）。

### ✅ Pillar 4：对抗式双上下文协商、盲审裁判与语义不变量（DS-4）

- **`BoundedNegotiationMediator` + `WorkflowOrchestratorFacade`**：`NegotiationRoundRunner` 透传累积历史 `previousTurns`，将单轮拆分为「响应方独立调用（强制 `ACCEPT_AND_PATCH` / `REBUT_WITH_EVIDENCE` / `ESCALATE_TRADEOFF` 离散动作，触及权衡即刻上交人类并终止剩余轮次）→ 挑战方独立复核（否定迎合）→ 无历史盲审裁判（Fresh-Context Blind Judge 专查隐性软降级）」（同时兼容既有单调用 mock）。
- **`FalseConsensusGuard`**：保留 `evaluateScopeIntegrity()` 需求 ID 差集守卫，新增 `evaluateSemanticInvariants()` 拦截未删 ID 的占位软阉割、高危低报 `LOW` 及带漏洞宣称全部验收通过的自相矛盾交付物。

**测试基线（第十轮末）**：154 项测试（46 套件，26 个测试文件：150 通过 / 4 既有跳过 / 0 失败）——新增 `tests/agent-quality-efficiency.spec.ts`（AC-1 ~ AC-11 共 11 项验收测试）；`typecheck:backend` 与 `lint:backend` 全绿。

---

## 第十一轮实现（AUDIT-9 / D1 启动恢复 5 项运行态完整还原，2026-11-23）

- **`#9（AUDIT-9）` 5 项运行态持久化与还原闭环**：
  - **1) `ScopeDiffReport`**：`StageSnapshotMemento.toSerializableRecord()`（`src/domain/models.ts`）补齐 `baselineRequirementIds` 与 `currentRequirementIds`，`ScopeDiffReport.fromJSON()` 兼容仅含 `droppedRequirementIds` 的历史快照。
  - **2) `notificationInbox`**：`AgentUserNotification` 增加 `toSerializableRecord()` / `fromJSON()`（保留 `resolved` 与 `createdAtIso`），经 `PersistedLedgerSnapshot.notifications` 与 `WorkflowEventBus.restoreNotification()` 保序还原待审批门禁卡片。
  - **3) `teamComments`**：`StageTeamCommentRecord` 增加序列化方法；`WorkflowOrchestratorFacade.addTeamComment()`（非初始化批量播种路径）即时触发 `syncPersistenceState()`，并经 `restoreTeamComment()` 去重还原。
  - **4) `autoRepairCounts`**：`PersistedRunRecord` 与 `WorkflowRunState.getAutoRepairCountsRecord()` / `restoreInternals()` 完整持久化与恢复 QA 自动返修次数。
  - **5) `auditEntries`**：`AuditTrailEntry.fromJSON()`、`ImmutableAuditLedger.restoreAuditEntry()` 与 `PersistenceRepository.readAuditWalEntries()`（新增损坏行容错）联动在 `StateReconstructor.restore()` 重建审计时间轴且不重放 WAL；另保留 `NegotiationTurnRecord` / `HumanDecisionRecord` 的 `createdAtIso`。

**测试基线（第十一轮末）**：156 项测试（46 套件，26 个测试文件：152 通过 / 4 既有跳过 / 0 失败）——`tests/state-reconstructor.spec.ts` 新增第 4–5 项测试（5 项全量 round-trip、WAL 零重复及历史/损坏容错）。

---

## 第十二轮实现（AUDIT-8 / D2：PostgreSQL 完整同步、PgPersistenceDriver 接线与用户体系 Schema/PgUserStore，2026-11-23）

- **`#8（AUDIT-8 / D2）` PG 持久化全量同步与恢复闭环**：
  - **真实 `token_budget` 传递链**：`WorkflowRunState`（`src/engine/DagWorkflowStateEngine.ts`）新增 `tokenBudget` / `getTokenBudget()`，经 `WorkflowOrchestratorFacade.startProposalWorkflow()` 从 DSL `guardrails.tokenBudgetLimit` 写入、`PersistedRunRecord.tokenBudget` 持久化并由 `StateReconstructor.restoreRun()` 原样还原。
  - **统一 SQL 单一事实源 + PG 读回**：`src/engine/pg/PgPersistenceDriver.ts` 导出 `buildPgUpsertSql()`，完整生成 `workflow_runs`（真实 `token_budget`/`token_used`/`workflow_snapshot_yaml`）、`stage_snapshots`（含 `__snapshotMeta`）、`negotiation_logs`（mapped `from_stage`/`to_stage`、`message_structured`、`is_escalated`）、`human_decisions`、`rejected_history_rag` 与 `team_comments` UPSERT 语句；实现 `PgPersistenceDriver.loadFullState()` 从 PG 聚合读回全量结构并兼容老库缺失 `team_comments` 降级查询。
  - **驱动接线**：`PersistenceRepository`（`src/engine/PersistenceRepository.ts`）消除重复 SQL 拼装代码，构造时通过 `selectPersistenceDriver()` 接入 PG 驱动，实现 `persistFullState()`、`loadPersistedSnapshot()`（PG 优先 + JSON 兜底）与 `appendAuditEntryToWal()` 统一经驱动协同。
  - **用户体系 Schema 与 `PgUserStore`**：`deploy/init-pgvector-schema.sql` 扩充 `users`、`user_owned_stages`、`auth_sessions`、`auth_login_audit`、`team_comments` 共 10 张表及 `workflow_runs.created_by_user_id` / `human_decisions.reviewer_user_id` 双轨关联外键；新增 `src/server/auth/UserStore.ts`（`JsonUserStore`、`PgUserStore`、`selectUserStore`），`SessionService.ts` 与 `WorkbenchServer.ts` 全面迁移至 `UserStore` 接口。

**测试基线（第十二轮末）**：161 项测试（47 套件，27 个测试文件：157 通过 / 4 既有跳过 / 0 失败）——新增 `tests/pg-persistence-driver.spec.ts`（5 项：SQL 完整生成与定制预算、`selectPersistenceDriver` 选择、删 JSON 后经 PG `loadFullState` 全量恢复、10 表 Schema、`PgUserStore` + `SessionService` 闭环）。

---

## 第十三轮实现（AUDIT-10 熔断 `RETRY_STAGE` 恢复 & AUDIT-13 多 Run 并发隔离/SSE `Last-Event-ID` 重放，2026-11-24）

- **`#10（AUDIT-10 / A2、B3）` 熔断重试恢复与预算追加闭环**：
  - `WorkflowRunState`（`src/engine/DagWorkflowStateEngine.ts`）将 `tokenBudget` 改为可追加并新增 `increaseTokenBudget()`；`WorkflowEventBus`（`src/patterns/EventBus.ts`）新增 `resolveFailureNotificationsForStage()` 统一消解同运行同阶段异常通知。
  - `WorkflowOrchestratorFacade`（`src/engine/WorkflowOrchestratorFacade.ts`）在 `continueExecutionUntilGateOrComplete()` 中实时读取 `runState.getTokenBudget()`，并在异常分支发布 `relatedSnapshotId = RETRY:<stageId>:<ts>`；新增 `retryAbortedStage()` 恢复 `ABORTED` / `ABORTED_TOKEN_BUDGET`（超限场景按 `extraTokenBudget` 或默认额度自动扩容并落盘决策与团队备注）；`submitHumanGateDecision()` 在检测到 `RETRY:*` 或历史 `ROOT` 且运行处于熔断态时直接转发至 `retryAbortedStage()`（不再报 400）。
  - `WorkbenchHttpServer` 新增 `POST /api/runs/retry` 并在 `POST /api/decisions` 透传 `extraTokenBudget`。
- **`#13（AUDIT-13 / D3）` 多标签页并发隔离与 SSE 增量重放**：
  - `SseBridge`（`src/server/SseBridge.ts`）缓存与广播增加 `runId` 标识并新增 `getLatestEventId()`，支持 `replay(clientLastId, write, filterRunId)` 按订阅 `runId` 过滤增量重放。
  - `WorkbenchHttpServer`（`src/server/WorkbenchServer.ts`）移除 `GET /api/state` 与 `POST /api/runs/select` 对全局 `this.activeRunId` 的篡改，新增 `resolveRequestRunId()` 将 `/api/decisions`、`/api/runs/retry`、`/api/supervisor/rollback`、`/api/comments`、`/api/sandbox/file`、`/api/sandbox/verify`、`/api/rag/ingest` 与 `/api/admin/governance` 全部改为按请求 `runId`（或快照/通知归属）精确路由并只定向广播相关 SSE 订阅者；`GET /api/events/stream?runId=...` 接线读取请求头 `last-event-id`（或 `?lastEventId`）调用 `sseBridge.replay()`。
  - `WorkbenchApiClient`（`src/ui/client/WorkbenchApiClient.ts`）维护页签级 `activeRunId` 并在各类读写请求及 SSE 连接参数中自动透传。

**测试基线（第十三轮末）**：165 项测试（48 套件，28 个测试文件：161 通过 / 4 既有跳过 / 0 失败）——新增 `tests/retry-and-concurrency-sse.spec.ts`（4 项：`StageContractError` 与 `TokenBudgetExceededError` 经 `/api/decisions` & `/api/runs/retry` 恢复、多 `runId` 并发请求隔离、SSE 按 `runId` 隔离与 `Last-Event-ID` 增量重放）。

---

## 第十四轮实现（AUDIT-11 Worktree 精确清理 / AUDIT-12 Docker 真实退出码与降级判定 / AUDIT-14 容器 psql 与 Live LLM 补齐，2026-11-24）

- **`#11（AUDIT-11）` Worktree porcelain 分段精确清理**：`src/sandbox/RealGitWorktree.ts` 新增 `parsePorcelainWorktrees()` 按空行 stanza 提取 `worktree <path>` 与 `branch <ref>`，重写 `remove(branchName)` 严格按 `refs/heads/<branchName>` 匹配后删除对应 worktree 与分支；`tests/sandbox-manager.spec.ts` 新增 Test 4 验证多 stanza 解析及真实临时 Git 仓库保留无关 worktree。
- **`#12（AUDIT-12 / E3）` 容器测试真实退出码与引擎/用例失败隔离**：`src/sandbox/DockerTestRuntime.ts` 将容器命令改为 `node --experimental-strip-types ... > "/results/${resultsBasename}" 2>&1; ec=$?; cat ...; exit $ec`，消除无 `pipefail` 管道掩码并支持 `node:22-alpine` 直接跑 TS 单测；新增 `infrastructureFailure` 与 `DockerTestRuntime.isInfrastructureFailure()`（仅超时/`null`/Docker 引擎错误码 `125/126/127`/守护进程或镜像异常触发）；`src/sandbox/GitWorktreeSandboxManager.ts` 仅在基础设施故障时降级 `host-fallback`，容器内单测失败保持 `runtime='docker'`；`tests/docker-runtime.spec.ts` 更新 Test 1 并新增 Test 6–7。
- **`#14（AUDIT-14 / I1）` 容器运行环境补齐**：`Dockerfile` 补装 `postgresql-client`；`deploy/docker-compose.yml` 为 `agentic-workbench` 默认开启 `LITELLM_ENABLE_LIVE_HTTP=true`；`tests/docker-runtime.spec.ts` 新增 Test 8 自动化校验配置文件。

**测试基线（第十四轮末）**：169 项测试（48 套件，28 个测试文件：165 通过 / 4 既有跳过 / 0 失败）——`tests/sandbox-manager.spec.ts`（+1 项至 4 项）与 `tests/docker-runtime.spec.ts`（+3 项至 8 项）。

---

## 待实现项（详见 `BACKEND_TODO.md` 第五章与 `BACKEND_TODO_DESIGN.md`）

| 编号           | 优先级 | 设计/审计状态                                          | 预估工作量 |
| :------------- | :----- | :----------------------------------------------------- | :--------- |
| H1-H3 外部集成 | P2     | ✅ 设计定稿，用户决策挂起（见 `P2_REMAINING_PLAN.md`） | 各 2h      |

> 已完成并从表中移除：C2 总管四工具 / C3 NL 解析 LLM 化 / B1 协商 LLM 化 / F2 用户管理 API / I1 compose 联通 / G10 上下文介入 / G1 L2 语义缓存 embedding / G2 RAG embedding / A4 意图识别 LLM + 体检端点 / E3 docker 运行时 / I3 数据保留 / J2 可插拔节点 / G11 Stage 5 闭环（mock 可验证范围）/ 第八轮核心编排与沙箱闭环修复（`#1–#4`）/ 第九轮认证与 RBAC 安全加固（`#5–#7`）/ 第十轮 Agent 质量与协商治理（`DS-1~DS-4` / `AC-1~AC-12`）/ 第十一轮 D1 启动恢复 5 项运行态补全（`#9 / AUDIT-9`）/ 第十二轮 D2 PostgreSQL 同步、PG 驱动恢复与用户 Schema（`#8 / AUDIT-8`）/ 第十三轮熔断重试恢复与并发 `runId`/SSE 重放（`#10`、`#13`）/ **第十四轮 Worktree 精确清理、Docker 退出码区分与容器 psql/Live LLM 补全（`#11`、`#12`、`#14`）**（见上方各节记录）。
> **当前待处理**：2026-11-23 深度审计 **#8–#14（全部 P0 + P1）已清零**；**2026-11-24 全项目完整度复审新发现的前后端联调、并发/安全加固与实网 E2E 待办已登记至 `BACKEND_TODO.md` §六**，原 P2 外部集成 **`H1-H3`** 继续挂起于 `P2_REMAINING_PLAN.md`。

---

## 测试覆盖率诚实分析

### 新增测试文件（全库 28 个文件 / 48 套件 / 169 项测试：165 通过 + 4 跳过）

| 文件                                | 测试数           | 覆盖目标                                                                                                    | 通过 |
| :---------------------------------- | :--------------- | :---------------------------------------------------------------------------------------------------------- | :--- |
| `retry-and-concurrency-sse.spec.ts` | 4                | 第十三轮 AUDIT-10 & AUDIT-13（契约/预算熔断 `RETRY_STAGE` 恢复、多 `runId` 并发隔离、SSE `Last-Event-ID`）  | ✅   |
| `pg-persistence-driver.spec.ts`     | 5                | 第十二轮 AUDIT-8 / D2（SQL `negotiation_logs`/真实预算、PG 驱动全量恢复、10 表 Schema、`PgUserStore`）      | ✅   |
| `agent-quality-efficiency.spec.ts`  | 11               | 第十轮 DS-1~DS-4（json_schema/确定性语义/L1-L2 跨模型缓存/停滞升舱/LoopGuard/对抗协商与盲审 AC-1~11）       | ✅   |
| `json-extractor.spec.ts`            | 9                | A1 JsonExtractor 全边界（围栏/散文/空/数组/截断/嵌套/多对象）                                               | ✅   |
| `artifact-contract-factory.spec.ts` | 8                | A1 工厂（正常/缺字段→违规触发A2/未知阶段/riskLevel/round-trip）                                             | ✅   |
| `session-service.spec.ts`           | 23               | F1/F2 SessionService 全套 + SHA-256/改密保留/防降级/登录审计 + AUTH_REQUIRED HTTP 路由守卫                  | ✅   |
| `state-reconstructor.spec.ts`       | 5                | D1 / AUDIT-9 状态恢复（全量 5 项状态 round-trip / 历史与损坏 WAL 容错 / 恢复后可裁决）                      | ✅   |
| `test-result-parser.spec.ts`        | 5（3 过/2 skip） | E2 TestResultParser（全通过/部分失败/Node 解析兼容性等；2 项既有 skip）                                     | ✅   |
| `qa-repair-loop.spec.ts`            | 2                | B2 修复闭环（2轮修复+超限仲裁/正常路径回归）                                                                | ✅   |
| `a1-llm-integration.spec.ts`        | 5（3 过/2 skip） | A1/A2/A3 集成（LLM成功/降级/散文耗尽/B3预算熔断；2项既有 skip）                                             | ✅   |
| `full-pipeline-llm.spec.ts`         | 6                | 高优缺口1：6 阶段全 LLM 管道 + 缺字段自愈 + 3b/4 在线真实沙箱与防谎报 + C3 总管接线 + B1 多轮协商           | ✅   |
| `concurrency-and-cache.spec.ts`     | 9                | 并发隔离（2 项）+ PromptCacheManager（7 项：含 L1/L2 语义命中/误命中修复/降级记账）                         | ✅   |
| `supervisor-tools.spec.ts`          | 4                | C2 总管四工具契约（overview/裁决卡/覆写推进/schema）                                                        | ✅   |
| `agent-context.spec.ts`             | 11               | G10 上下文介入（Compressor 提取/ToolRegistry 缓存与降级/Trimmer 预算）                                      | ✅   |
| `context-providers.spec.ts`         | 7                | 步骤 3（MCP JSON-RPC/错误边界 + Figma/数仓 stub 确定性 + Registry 集成）                                    | ✅   |
| `dynamic-context-needs.spec.ts`     | 2                | 步骤 4（端到端动态注入 + 注入拦截 + 离线零调用回归）                                                        | ✅   |
| `a4-intent-and-baseline.spec.ts`    | 5                | A4（__intent 捕获时序/跨提案不串味 + 体检端点离线/在线 6 报告/403）                                         | ✅   |
| `docker-runtime.spec.ts`            | 8                | E3 / AUDIT-12 / AUDIT-14（真实退出码重定向/容器测试失败与引擎故障区分/host-fallback/Dockerfile 与 Compose） | ✅   |
| `data-retention.spec.ts`            | 5                | I3（WAL 月度分片/旧文件兼容 + 保留策略/保护名单/Facade 终态钩子）                                           | ✅   |
| `warehouse-query.spec.ts`           | 5                | G11（SQL 白名单/runId 净化/真实注入/stub 兜底/工厂 env 三级选择）                                           | ✅   |
| `pluggable-nodes.spec.ts`           | 6                | J2（注册表口径/RBAC 映射/DSL 新节点/幂等/核心保护/检查点端到端）                                            | ✅   |

> 注：`persistence-rag.spec.ts` 在 G2 后扩为 5 项（1536 维回归 + 后台升级/失败标记/跨重启收敛）；其余既有套件（`architecture` 4、`dsl-loader` 5、`model-gateway` 5、`rbac-governance` 4、`sandbox-manager` 4（含 AUDIT-11）、`server-sse-api` 1）共 28 项，加近四轮新增 `agent-quality-efficiency.spec.ts` 11 项、`state-reconstructor.spec.ts` 新增 2 项、`pg-persistence-driver.spec.ts` 5 项、`retry-and-concurrency-sse.spec.ts` 4 项及 `docker-runtime.spec.ts` 新增 3 项，全库总计 169 项（165 通过 / 4 跳过 / 0 失败）。

### 按层级的覆盖率评估

| 层级         | 实际覆盖                                                                                                                                                                                                                                                                                               | 缺口                                                                                                   |
| :----------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **单元测试** | JsonExtractor（9 场景全覆盖）、ArtifactContractFactory（8 场景含 round-trip）、SessionService（23 场景含 SHA-256/审计/同步/HTTP 路由守卫）、TestResultParser（3 过 + 2 skip）、PromptCacheManager（7 场景含 L2 语义命中/误命中修复）                                                                   | TestResultParser 超时/空文件 2 项因跨平台不一致 skip；Agent 6 子类部分离线模板细节主要由集成测试覆盖   |
| **集成测试** | 6 阶段 mock-transport 全 LLM 管道 + 自愈 + 3b/4 在线沙箱 + C3 + B1（`full-pipeline-llm.spec` 6 项）；LLM 集成 × 3 过 + 2 skip；B2 修复闭环 × 2；并发隔离 × 2；D1 状态恢复 × 5；D2 PG 驱动 × 5；#10/#13 熔断重试与 SSE 重放 × 4；#11/#12/#14 Worktree/Docker/容器配置 × 12；RBAC × 4；E3/I3/G11 各 5 项 | 真实外部网关（Ollama/vLLM）+ 真实 Postgres pgvector + Docker daemon 联合端到端需真实部署环境           |
| **系统测试** | `AUTH_REQUIRED=true` 进程内 HTTP 路由守卫（`session-service.spec`）+ 多标签页并发/SSE 重放测试（`retry-and-concurrency-sse.spec`）+ 浏览器走查（人工）                                                                                                                                                 | **无自动化 Playwright UI E2E 系统测试**；**未在容器编排环境完整跑通带真实 LLM 网关 + PG 的端到端验证** |
| **边界检测** | JsonExtractor 9 项、SessionService 23 项、并发提案与多 runId HTTP/SSE × 6、Cache L2 7 项、D1 恢复 × 5、D2 PG 驱动 × 5、B3/A2 熔断重试恢复 × 2、Worktree stanza 隔离清理、Docker 单测失败 vs 引擎故障区分、NODE_TEST_CONTEXT 环境泄漏已修复                                                             | **2026-11-23 深度审计 #8–#14 全部边界回归断言已补齐**                                                  |

### 对用户四个问题的诚实回答

1. **"有针对每个功能写单元测试吗？"** —— 核心模块（JsonExtractor 9 / SessionService 23 / PromptCacheManager 7 / ArtifactContractFactory 8 / Context 11 / Warehouse 5 / PluggableNodes 6 / PG 驱动 5 / 重试与 SSE 并发隔离 4 / Docker 与沙箱 12）均有独立单测；仅 Agent 各子类的部分离线模板分支依赖集成测试间接覆盖。

2. **"最后功能合并有做功能测试吗？"** —— 不仅原有降级全链路通过，第三轮与第八轮补充的 `full-pipeline-llm.spec.ts`（6 项）已通过 mock LLM transport 跑通 **Stage 0→5 六阶段全 LLM 驱动管道、缺字段自愈重试、3b/4 物理沙箱落盘防谎报、C3 总管与 B1 多轮协商**；仅接真实外部 Ollama/vLLM 网关的实网集成依赖本地推理服务，CI 默认离线。

3. **"整个系统联合起来跑过系统测试吗？"** —— 已补齐进程内 `AUTH_REQUIRED=true` HTTP 路由守卫测试（`session-service.spec`）与多标签页并发/SSE 重放测试（`retry-and-concurrency-sse.spec`），并补齐 `Dockerfile` (`postgresql-client`) 与 Compose (`LITELLM_ENABLE_LIVE_HTTP=true`)；目前缺少自动化浏览器 UI E2E（Playwright）及在线容器编排环境的端到端实测。

4. **"边界检测如何做的？"** —— 核心、安全与工程可靠性边界（JSON 截断、并发隔离、Session SHA-256/锁定/防降级/路由守卫、RBAC 严格拦截、3b/4 防谎报、D1 五项恢复、D2 PG 全量同步、A2/B3 熔断重试、多 runId SSE 重放、Worktree porcelain 精确清理、Docker 测试失败 vs 引擎故障区分等）均已转为自动化断言，**`#8–#14` 深度审计项全部清零**。

### 下一步优先补测项

| 优先级 | 缺口                        | 建议测试                                                                                                               | 状态                     |
| :----- | :-------------------------- | :--------------------------------------------------------------------------------------------------------------------- | :----------------------- |
| **高** | 全阶段 LLM 管道测试         | mock transport 按阶段返回不同 JSON → 断言 6 阶段全部通过契约校验                                                       | ✅ 已补齐（第三/八轮）   |
| **高** | PromptCacheManager 独立测试 | L1 精确命中 / L2 语义命中 / 缓存未启用 / 误命中修复                                                                    | ✅ 已补齐（第三/四轮）   |
| **高** | 并发提案                    | 两个 run 同时推进 → 断言 runId 隔离、无状态交叉污染（`concurrency-and-cache.spec` + `retry-and-concurrency-sse.spec`） | ✅ 已补齐（第三/十三轮） |
| **高** | `#8–#14` 审计缺陷回归测试   | ✅ 已全部补齐 `#9`（5 项）、`#8`（5 项）、`#10/#13`（4 项）、`#11/#12/#14`（4 项）                                     | ✅ 全部完成              |
| **中** | F1 + AUTH_REQUIRED 联合测试 | 进程内 HTTP 路由守卫已覆盖（`session-service.spec`）；带真实 TCP 监听的端到端测试保留作系统级补强                      | ✅（部分已补齐）         |
| **中** | B3 预算熔断活跃测试         | `ABORTED_TOKEN_BUDGET` 与追加预算重启恢复已在 `retry-and-concurrency-sse.spec.ts` Test 2 完整覆盖                      | ✅ 已覆盖                |

---

## 复盘总结

1. **异步化改造**波及面大（Facade / 6 Agent / 8 测试文件 / Server），但通过统一 `async/await` + `Promise<WorkflowRunState>` 一次性完成。
2. **NODE_TEST_CONTEXT env 泄漏**是 E2 最大的隐性边界：从主测试运行器派生的子进程继承该 env 导致 `node --test` 跳过全部文件。修复方式：从 env 中 `delete` 该键（不能设空字符串）。
3. **演示开关迁出契约**（J1）牵动了 6 个 Agent + Server preset 端点 + 测试文件，但使 `ProjectProposalContract` 成为纯业务数据对象，可安全序列化/审计。
4. **缓存命中与修复指令冲突**是 B2 的关键边界：不带轮次前缀的修复指令会命中旧缓存返回同一失败产物——指令中的轮次序号有效打破了缓存键碰撞。
5. **TypeScript 参数属性**（`constructor(private x: T)`）在 Node strip-types 模式下不支持——新文件需手写字段赋值。
