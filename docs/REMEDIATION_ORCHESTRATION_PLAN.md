# 全项目剩余 TODO 总修复编排与验收计划

> 创建日期：2026-11-24。
> 权威依据：[BACKEND_TODO.md](./BACKEND_TODO.md) §六（2026-11-24 全项目完整度复审）、[UI_SYSTEM_DESIGN_MAP.md](./UI_SYSTEM_DESIGN_MAP.md) §14（UI v2 改造清单）、[P2_REMAINING_PLAN.md](./P2_REMAINING_PLAN.md)（H1–H3 挂起项）。

---

## 一、全局执行纪律（每步闭环规范）

所有任务严格按 **优先级从高到低（P0 → P1 → P2）** 拆分为 **12 个可执行步骤 + 1 组挂起项**，分三波（Wave 1 / Wave 2 / Wave 3）依次推进。每一步必须完成以下闭环后方可进入下一步：

1. **设计核对**：确认前置依赖、接口契约与受影响文件边界。
2. **编码与测试**：实现代码修复并编写专项测试（单元 / 集成 / HTTP 契约）。
3. **验收与回归**：专项测试与全量回归（`npm run typecheck:backend && npm run lint:backend && npm test`，前端恢复后扩展为 `npm run check`）全部通过。
4. **文档同步更新**（验收通过后立即执行）：
   - 更新 [BACKEND_TODO.md](./BACKEND_TODO.md) §六对应复选框为 `[x]`（及涉及到的 [UI_SYSTEM_DESIGN_MAP.md](./UI_SYSTEM_DESIGN_MAP.md) §14 / [RETROSPECTIVE_PLAN.md](./RETROSPECTIVE_PLAN.md)）；
   - 更新 [BACKEND_TODO_IMPL_LOG.md](./BACKEND_TODO_IMPL_LOG.md) 追加本步执行记录与最新测试基线；
   - 更新本文档对应步骤状态为 `✅ 已验收`；
   - **创建新的独立变更解释文档** `docs/<STEP_DOC>.md`（涵盖问题根因、修复编排、关键实现、设计取舍、测试方案与实测验收结果），并在 [docs/README.md](./README.md) 中注册索引。

---

## 二、总编排进度总览表

| 波次   | 步骤    | 对应 TODO                                               | 优先级 | 前置依赖                 | 变更说明文档                                                                                   | 状态      |
| :----- | :------ | :------------------------------------------------------ | :----- | :----------------------- | :--------------------------------------------------------------------------------------------- | :-------- |
| Wave 1 | Step 1  | `P0-3` `act-as` 可逆切换与 `"via <admin>"` 归属         | P0     | 无                       | [P0_3_ACT_AS_AND_AUDIT_ATTRIBUTION.md](./P0_3_ACT_AS_AND_AUDIT_ATTRIBUTION.md)                 | ✅ 已验收 |
| Wave 1 | Step 2  | `P0-4` 同 `runId` 并发互斥锁与 Agent 态隔离             | P0     | 无                       | [P0_4_CONCURRENCY_LOCK_AND_AGENT_ISOLATION.md](./P0_4_CONCURRENCY_LOCK_AND_AGENT_ISOLATION.md) | ✅ 已验收 |
| Wave 1 | Step 3  | `P0-5` `WorkbenchServer` HTTP 安全加固与收敛            | P0     | 无                       | [P0_5_HTTP_SECURITY_HARDENING.md](./P0_5_HTTP_SECURITY_HARDENING.md)                           | ✅ 已验收 |
| Wave 1 | Step 4  | `P0-6` 修复 `runRetrospective.ts` 漏 `await` 与历史评估 | P0     | 无                       | [P0_6_RETROSPECTIVE_RUNNER_FIX.md](./P0_6_RETROSPECTIVE_RUNNER_FIX.md)                         | ✅ 已验收 |
| Wave 1 | Step 5  | `P0-1` 恢复前端 React 构建链路与替换 `src/ui/dist/`     | P0     | 外网/依赖还原            | [P0_1_FRONTEND_REACT_BUILD_RESTORE.md](./P0_1_FRONTEND_REACT_BUILD_RESTORE.md)                 | ✅ 已验收 |
| Wave 1 | Step 6  | `P0-2` 前端 F1/F2 登录鉴权与用户管理 UI                 | P0     | Step 1, Step 5           | [P0_2_FRONTEND_AUTH_AND_USER_ADMIN_UI.md](./P0_2_FRONTEND_AUTH_AND_USER_ADMIN_UI.md)           | ✅ 已验收 |
| Wave 2 | Step 7  | `P1-1` 前端多 Run SSE 重连与视图交互缺陷修复            | P1     | Step 5, Step 6           | [P1_1_FRONTEND_SSE_AND_VIEW_FIXES.md](./P1_1_FRONTEND_SSE_AND_VIEW_FIXES.md)                   | ✅ 已验收 |
| Wave 2 | Step 8  | `P1-2` PG/JSON 双模式一致性与 `psql` 阻塞优化           | P1     | 无                       | [P1_2_PERSISTENCE_CONSISTENCY_AND_ASYNC_PG.md](./P1_2_PERSISTENCE_CONSISTENCY_AND_ASYNC_PG.md) | ✅ 已验收 |
| Wave 2 | Step 9  | `P1-3` Agent 真实代码落盘、预算裁剪与沙箱深层闭环       | P1     | Step 2                   | [P1_3_AGENT_CONTEXT_AND_SANDBOX_LOOP.md](./P1_3_AGENT_CONTEXT_AND_SANDBOX_LOOP.md)             | ✅ 已验收 |
| Wave 2 | Step 10 | `P1-4` 实网 Compose + PG + 本地大模型 + 浏览器 E2E      | P1     | Step 5–9                 | [P1_4_DEPLOY_AND_LIVE_E2E.md](./P1_4_DEPLOY_AND_LIVE_E2E.md)                                   | ✅ 已验收 |
| Wave 3 | Step 11 | `P2-2 + UI v2` Meridian UI Kit 接入与全景图 §14 改造    | P2     | Step 5–7                 | [P2_2_MERIDIAN_UI_V2_MIGRATION.md](./P2_2_MERIDIAN_UI_V2_MIGRATION.md)                         | ✅ 已验收 |
| Wave 3 | Step 12 | `P2-3` 测试隔离卫生与仓库残留清理                       | P2     | Step 4                   | [P2_3_TEST_ISOLATION_HYGIENE.md](./P2_3_TEST_ISOLATION_HYGIENE.md)                             | ✅ 已验收 |
| 挂起   | 挂起项  | `P2-1` (`H1–H3`) 企业真实外部系统接入                   | P2     | 业务侧提供凭证与映射语义 | （解锁后按 `P2_REMAINING_PLAN.md` 落地）                                                       | ⏸️ 挂起   |

---

## 三、分步详细编排、验收标准与测试方案

### Wave 1：P0 阻断级（安全、并发、联调与构建基础）

#### Step 1 (`P0-3`)：修复 `act-as` 不可逆切换陷阱与业务审计 `"via <admin>"` 归属

- **修复编排**：
  1. `src/server/auth/UserStore.ts`：`LoginAuditEntry['reason']` 增加 `'EXIT_ACT_AS'`。
  2. `src/server/auth/SessionService.ts`：
     - `actAs(currentToken, targetUserId)` 支持通过 `session.impersonatedBy ?? session.userId` 识别真实管理员，允许在 `act-as` 状态下连续切换其他角色或切回管理员自身（清零 `impersonatedBy` 并吊销旧替身会话），返回 `{ token, user, impersonating }`；
     - 新增 `exitActAs(currentToken)`：验证替身会话后吊销旧替身令牌、签发管理员正常会话并记录 `'EXIT_ACT_AS'` 审计。
  3. `src/engine/WorkflowOrchestratorFacade.ts`：`submitHumanGateDecision`、`retryAbortedStage`、`invokeSupervisorConversationalRollback`、`addTeamComment` 接收可选 `impersonatedByLabel` 并通过统一 helper 安全追加 ` (via <admin>)`。
  4. `src/server/WorkbenchServer.ts`：`ResolvedAuthContext` 透传 `impersonatedBy`；`POST /api/auth/act-as` 放行处于管理员替身态的会话；新增 `POST /api/auth/exit-act-as`；在 `/api/proposals`、`/api/decisions`、`/api/runs/retry`、`/api/supervisor/rollback`、`/api/comments`、`/api/rag/ingest` 透传归属标签。
- **验收标准**：
  - Admin 切换为 `STAGE_SPECIALIST` 后可直接再切换其他成员，或调用 `/api/auth/exit-act-as` 恢复管理员（旧替身 token 失效，`/api/auth/me` 返回 `impersonating: null`）；非替身调用 `/api/auth/exit-act-as` 返回 400；普通用户不可调用 `act-as`（403）。
  - 替身态下的裁决/重试/回退/评论/立项/RAG 录入均带 `(via <adminDisplayName>)` 且不重复追加。
- **测试方案**：在 `tests/session-service.spec.ts` 新增单元 + HTTP 测试，验证连续切换、`exit-act-as`、审计事件与业务归属，全量后端回归绿灯。
- **变更文档**：`docs/P0_3_ACT_AS_AND_AUDIT_ATTRIBUTION.md`。

#### Step 2 (`P0-4`)：加装同 `runId` 异步并发互斥锁，消除共享单例 Agent 可变状态竞态

- **修复编排**：
  1. `src/engine/WorkflowOrchestratorFacade.ts`：引入按 `runId` 隔离的 Promise 链式异步互斥锁 `withRunLock(runId, fn)`（完成后清理 Map 防止泄漏）；公开写入口 `startProposalWorkflow`、`continueExecutionUntilGateOrComplete`、`retryAbortedStage`、`submitHumanGateDecision`、`invokeSupervisorConversationalRollback` 在最外层加锁，内部互相委托拆为 `*Unlocked` 私有方法避免重入死锁。
  2. `src/agents/SoftwareEngineerAgent.ts`：将单实例 `lastPreparedSandbox` 替换为以 `${runId}::${branchId}::${directive}` 为键的有界 `Map`（上限 64）。
  3. `src/agents/QualityAssuranceAgent.ts`：将单实例 `lastPreparedVerification` 替换为有界 `Map`（上限 64）。
- **验收标准**：
  - 同 `runId` 并发写请求严格串行执行，不损坏快照状态机且 `REJECT` 委托回退无重入死锁。
  - 不同 `runId` 并发执行 Stage 3b/4 时，防谎报校验精确命中各自沙箱结果，无覆盖竞态。
- **测试方案**：在 `tests/concurrency-and-cache.spec.ts` 新增同 `runId` 并发写互斥、`REJECT` 无死锁验证及跨 `runId` 并发 QA 防谎报隔离测试；全量后端回归绿灯。
- **变更文档**：`docs/P0_4_CONCURRENCY_LOCK_AND_AGENT_ISOLATION.md`。

#### Step 3 (`P0-5`)：`WorkbenchServer` HTTP 安全加固与默认模式越权收敛

- **修复编排**：
  1. `src/server/WorkbenchServer.ts`：引入 `HttpRequestError`；`readJsonBody` 增加默认 1 MB 字节上限（超限 413）与 15s 超时（超时 408）。
  2. 统一附带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin` 与 HTML `Content-Security-Policy`；`Set-Cookie` 在 HTTPS/代理加密请求或 `COOKIE_SECURE=true` 时附带 `Secure`。
  3. 为 `/api/auth/login` 与高开销写端点增加轻量滑动窗口限流（超限 429 + `Retry-After`）。
  4. `/styles/*.css`、`/dist/*.js`、`/api/sandbox/file` 的 `startsWith` 路径检查补全 `+ path.sep` 与文件校验。
  5. 将 `mustChangePassword=true` 强制改密拦截统一至全模式生效；移除 `/api/workflows/templates`、`/api/sandbox/file`、`/api/rag/query` 对 `authSource === 'none'` 的 RBAC 跳过。
- **验收标准**：超大体 413、超时 408、安全头与条件 `Secure` Cookie 完备、限流 429、兄弟目录前缀路径穿越被拒、默认模式下 3 端点匿名请求与 `mustChangePassword=true` 均返回 403。
- **测试方案**：新增 `tests/http-security-hardening.spec.ts` 覆盖全部分支，并回归 `tests/server-sse-api.spec.ts` 与 `tests/session-service.spec.ts`。
- **变更文档**：`docs/P0_5_HTTP_SECURITY_HARDENING.md`。

#### Step 4 (`P0-6`)：修复 `src/retrospective/runRetrospective.ts` 6 处漏写 `await` 并改为评估真实历史运行

- **修复编排**：
  1. 补齐第 53/65/75/85/97/127 行 6 处 `await`，验证逐阶段驱动与 SLA 达标。
  2. `RetrospectiveBenchmarkSuite` 合成基准默认使用 `os.tmpdir()` 临时 `persistenceDir`/`sandboxRootDir` 并自动清理，不再污染工作区 `.runtime-data/`。
  3. 新增 `evaluatePersistedHistory(persistenceDir?)` 只读还原真实持久化运行并聚合快照/缓存/重试/成本指标生成 `RetrospectiveEvaluationReport`。
  4. CLI 主入口改用 `pathToFileURL(process.argv[1]).href` 并支持 `--benchmark` / `--history-only` 模式。
- **验收标准**：6 处全部 `await` 无竞态；`tests/architecture.spec.ts` Test 4 稳定通过且不写入工作区 `.runtime-data/`；`evaluatePersistedHistory()` 准确评估真实历史运行；`npm run retrospective:eval -- --benchmark` 正常退出 0。
- **测试方案**：新增 `tests/retrospective-runner.spec.ts` 验证全 `await` 顺序、零目录污染、真实持久化目录评估与 CLI 执行；回归全量测试。
- **变更文档**：`docs/P0_6_RETROSPECTIVE_RUNNER_FIX.md`。

#### Step 5 (`P0-1`)：恢复前端 React 构建链路并替换过期静态产物 `src/ui/dist/`

- **修复编排**：安装 `package.json` 声明的 `react`/`react-dom`/`@types/react`/`@types/react-dom` 依赖；执行 `npm run typecheck:frontend && npm run lint:frontend && npm run build:ui`；清理旧版非 React 遗留 `.js` 并确保 `/dist/main.js` 与 `src/ui/index.html` 匹配。
- **验收标准**：`npm run typecheck:frontend`、`npm run lint:frontend`、`npm run build:ui` 全过；HTTP 访问 `/` 与 `/dist/main.js` 返回最新 React bundle。
- **测试方案**：`npm run check` 全绿 + HTTP 加载验证（如安装依赖受网络/沙箱阻断，立即记录原因并暂停交回决策）。
- **变更文档**：`docs/P0_1_FRONTEND_REACT_BUILD_RESTORE.md`。

#### Step 6 (`P0-2`)：补齐前端 F1/F2 登录鉴权与用户管理 UI（解除 `AUTH_REQUIRED=true` 前端不可用）

- **修复编排**：`WorkbenchApiClient` 封装 `/api/auth/login|logout|me|change-password|act-as|exit-act-as` 与 `/api/admin/users*`、`login-audit` 并移除裸 `X-Actor-Id` 主路径；新增 `LoginView.tsx`、首次登录强制改密弹窗与 401/403 全局拦截；`App.tsx` 初始化接入 `/api/auth/me` 与 `impersonating` 状态条（含一键退出 `act-as`）；`AdminGovernanceView.tsx` 接入成员增改/重置密码/登录审计表格。
- **验收标准**：`AUTH_REQUIRED=true` 下浏览器可正常登录、首登强制改密、管理员 `act-as` 与退出 `act-as`、成员 CRUD 与登录审计展示；`401/403` 无未捕获异常。
- **测试方案**：前端类型检查 + 构建 + API Client 单测 +（随 Step 10 或 headless 浏览器）登录与 RBAC 交互 E2E。
- **变更文档**：`docs/P0_2_FRONTEND_AUTH_AND_USER_ADMIN_UI.md`。

---

### Wave 2：P1 高优（前端交互、持久化一致性、Agent 深层闭环与实网 E2E）

#### Step 7 (`P1-1`)：修复前端多 Run SSE 重连串台与若干视图交互缺陷

- **修复编排**：`App.tsx` SSE `useEffect` 加入 `state?.run?.runId` 依赖并在 cleanup 中关闭旧 `EventSource`；`WorkbenchApiClient` 消费 `run_event`/`user_notification` 增量帧、封装 `POST /api/runs/retry` 与 `extraTokenBudget`；`submitDecision` 传入 `notif.runId`；修复 `Topbar`（读动态 `roster` 与 `/api/workflows/templates`）、`SandboxExplorerView`（真实测试率与回写状态）、`AuditRagView`（展开/收起状态分离）、`ProjectsHubView`（`ABORTED*` 状态徽标）、`Sidebar`（消除嵌套 `<svg>`）。
- **验收标准**：切换项目或新立项后 SSE 实时重连至新 `runId` 无串台；熔断恢复按钮直接调 `/api/runs/retry` 成功；上述 5 个视图交互缺陷全部修复。
- **测试方案**：`npm run check` + 前端状态与 SSE 客户端单测 + 视图交互回归。
- **变更文档**：`docs/P1_1_FRONTEND_SSE_AND_VIEW_FIXES.md`。

#### Step 8 (`P1-2`)：补齐 PG / JSON 双模式持久化一致性与 `psql` 阻塞优化

- **修复编排**：登录/校验采集写入 `ip` 与 `user_agent`；`PgPersistenceDriver` 写入并恢复 `created_by_user_id`/`reviewer_user_id`；PG Schema 补齐 `notifications`、`live_events`、`audit_entries`（及持久化配置/复盘快照）；`JsonUserStore` 将会话与登录审计落盘 JSON；`rejected_history_rag` 向量维度可配置（支持 1024/1536 对齐 `bge-m3-local`）；将热路径 `PgUserStore`/`PgPersistenceDriver` 的同步 `execFileSync('psql')` 改造为异步 `execFile` 或连接池队列并加短缓存。
- **验收标准**：纯 PG 或纯 JSON 模式下重启不丢会话、审计、通知与配置；`bge-m3-local` 1024 维入库无维数冲突；高并发鉴权不阻塞事件循环。
- **测试方案**：扩展 `tests/pg-persistence-driver.spec.ts` 与 `tests/state-reconstructor.spec.ts` 覆盖双轨 FK、3 张新表、JSON 会话持久化与维度配置测试。
- **变更文档**：`docs/P1_2_PERSISTENCE_CONSISTENCY_AND_ASYNC_PG.md`。

#### Step 9 (`P1-3`)：打通 Agent / 上下文预算裁剪 / 沙箱深层闭环

- **修复编排**：Stage 3b `SoftwareEngineerAgent` 将 LLM 生成的文件补丁真实写入 Worktree 后再执行沙箱验证（QA 返修指令驱动真实补丁重跑）；`WorkflowOrchestratorFacade` 将 `contextRegistry.resolve()` 产出的 `TrimmedContext` 真实注入 Agent 上下文并在终态调用 `clearRunCache()`；新增 `dependency_versions` ContextProvider；`SupervisorAgent` 冲突升级动态读取协商记录并将 `explicitTargetStageId` 纳入 `allowedStages` 校验；将 `supervisorTools.ts` 4 工具接入 `SupervisorAgent`/`WorkbenchServer`；修复 I3 `COMPLETED` 终态钩子不可达并排除 `docker-results/`；收口/清理 4 项 `it.skip`。
- **验收标准**：3b LLM 产出文件真落盘并影响 `node:test` 结果；`TrimmedContext` 生效且缓存可控清理；`COMPLETED` 终态触发 worktree 保留清理且保护 `docker-results/`；`a1-llm-integration.spec.ts` test 5 激活通过。
- **测试方案**：扩展 `tests/full-pipeline-llm.spec.ts`、`tests/agent-context.spec.ts`、`tests/data-retention.spec.ts`、`tests/supervisor-tools.spec.ts` 验证全闭环。
- **变更文档**：`docs/P1_3_AGENT_CONTEXT_AND_SANDBOX_LOOP.md`。

#### Step 10 (`P1-4`)：实网 Docker Compose + PG + 本地大模型 + Playwright UI E2E 与部署配置修正

- **修复编排**：修正 `Dockerfile`（评估 `--ignore-scripts`、消除启动重复 `build:ui`、非 root 运行用户、补充 `HEALTHCHECK`）、`deploy/docker-compose.yml`（`service_healthy` 依赖、工作区持久卷、`litellm_config.yaml` 挂载）、`deploy/.env.example`（补齐 12 个新增环境变量）；新增实网 Compose + `pgvector` + 本地推理端点验证脚本及 Playwright UI E2E 测试套件（登录、立项、签核、熔断重试、总管回退、成员管理）。
- **验收标准**：`docker compose up` 一键健康启动；Playwright 全流程 E2E 绿灯。
- **测试方案**：静态部署校验 + 实网容器编排与 Playwright E2E 流水线执行报告。
- **变更文档**：`docs/P1_4_DEPLOY_AND_LIVE_E2E.md`。

---

### Wave 3：P2 架构演进与工程卫生

#### Step 11 (`P2-2 + UI_SYSTEM_DESIGN_MAP §14`)：Meridian UI Kit 接入 7 个业务视图 & UI v2 改造

- **修复编排**：先补后端 G1–G4/G6（`ArtifactContract.agentRationale/keyDecisions`、`detailPayload`、`liveInteractionStream` 分页、1/3a 协商拓展、结构化 `artifactSummary`），再完成前端 11 项改造（删除 `ACTIONS_BY_STAGE`/`STAGE_DISCUSSIONS`、新增 `AgentDeliverableReview.tsx`/`artifactParsers.ts`/`perspective.ts`、将 `src/ui/kit/` 接入 7 个业务视图、浅色 v2 令牌体系与动态模板接口）。
- **验收标准**：全界面零前端编造假文案，7 个视图统一使用 Meridian UI Kit，视角状态机与 A/B 对比裁决卡可用。
- **测试方案**：后端契约测试 + 前端构建 + UI v2 组件与 E2E 测试。
- **变更文档**：`docs/P2_2_MERIDIAN_UI_V2_MIGRATION.md`。

#### Step 12 (`P2-3`)：测试隔离卫生清理

- **修复编排**：审计全部 `tests/*.spec.ts`，为未传隔离目录的用例统一使用 `os.tmpdir()` 临时 `persistenceDir`/`sandboxRootDir` 并 `after` 清理；清理仓库根目录历史残留 `.sandbox-worktrees/` 与测试膨胀的 `.runtime-data/` WAL。
- **验收标准**：`npm test` 跑完后工作区不产生未跟踪测试产物，全量测试通过。
- **测试方案**：运行 `npm test` 前后比对 `git status` 与工作区目录体积/文件数。
- **变更文档**：`docs/P2_3_TEST_ISOLATION_HYGIENE.md`。

#### 挂起项 (`P2-1 / H1–H3`)：企业真实外部系统接入

- **触发条件**：业务侧提供 Git 仓库工作流要求、Jira/飞书字段映射与 Webhook 密钥、Figma Token 或 MCP Server 地址后解锁，按 [P2_REMAINING_PLAN.md](./P2_REMAINING_PLAN.md) 第二节执行并补充实网/Mock 测试与独立说明文档。
