# P0-3 变更说明：修复 `act-as` 不可逆切换陷阱与业务审计 `"via <admin>"` 归属

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 1 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-3`）。

---

## 一、问题背景与根因

在第九轮落地的 `SessionService` + `WorkbenchServer` 视角切换（`act-as`）实现中存在三处阻断级缺口：

1. **不可逆单向锁定陷阱**：管理员调用 `POST /api/auth/act-as` 切换为 `STAGE_SPECIALIST` 后，虽然会话表保存了 `impersonatedBy`，但 `POST /api/auth/act-as` 仅校验当前 `authCtx.user.tier === 'PROJECT_ADMIN'` 且缺少退出端点；一旦切到非管理员角色，再次调用 `act-as` 会被 `403` 拦截，管理员必须彻底退出重登才能恢复身份。
2. **靶标用户强制改密误拦截管理员**：在 `AUTH_REQUIRED=true` 模式下，`WorkbenchServer` 仅判断 `sessionUser.mustChangePassword`；若管理员已改密，但通过 `act-as` 切换到尚未首次改密的种子专长用户，会反被 target 用户的 `mustChangePassword=true` 阻塞业务访问。
3. **业务审计归属缺失**：`ResolvedAuthContext` 未携带 `impersonatedBy`，导致替身态下发起的门禁签核、熔断重试、总管回退、团队评论、立项提案与企业红线 RAG 录入均无法追踪背后的真实管理员（缺失 `"(via <admin>)"` 归属）。

---

## 二、核心修改内容

### 1. 用户审计类型扩展（[UserStore.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/server/auth/UserStore.ts#L34-L47)）
- `LoginAuditEntry['reason']` 增加 `'EXIT_ACT_AS'`，用于审计管理员主动退出替身视角或切回自身的行为。

### 2. 可逆 `actAs()` 与 `exitActAs()`（[SessionService.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/server/auth/SessionService.ts#L381-L450)）
- 改造 `SessionService.actAs(currentToken, targetUserId)`：
  - 基于 `realAdminId = session.impersonatedBy ?? session.userId` 核验真实管理员（需 `ACTIVE` 且 `PROJECT_ADMIN`），允许在替身态下连续切换其他专长用户或切回管理员自身。
  - 若当前会话本身为替身会话（`session.impersonatedBy !== null`），切换前吊销旧替身令牌，防止遗留多个替身令牌。
  - 切回管理员自身时将 `impersonatedBy` 置为 `null` 并写入 `'EXIT_ACT_AS'` 审计日志；返回 `{ token, user, impersonating }`。
- 新增 `SessionService.exitActAs(currentToken)`：
  - 仅在 `session.impersonatedBy !== null` 且原管理员仍处于 `ACTIVE` + `PROJECT_ADMIN` 时生效；吊销替身令牌、签发管理员正常会话并记录 `'EXIT_ACT_AS'`。

### 3. 业务编排层归属标注（[WorkflowOrchestratorFacade.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/engine/WorkflowOrchestratorFacade.ts#L82-L92)）
- 新增辅助函数 `appendImpersonationAttribution(actorLabel, impersonatedByLabel)`，统一追加 ` (via <adminDisplayName>)` 且避免重复拼接。
- 为 `addTeamComment`、`retryAbortedStage`、`submitHumanGateDecision`（含 `REJECT` 委托回退透传）与 `invokeSupervisorConversationalRollback` 增加可选参数 `impersonatedByLabel?: string`，将归属写入 `HumanDecisionRecord.reviewerActor` 与 `StageTeamCommentRecord.authorName`。

### 4. HTTP 鉴权上下文、端点与归属透传（[WorkbenchServer.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/server/WorkbenchServer.ts#L34-L40)）
- `ResolvedAuthContext` 新增 `impersonatedBy: AuthUserView | null`，在 `resolveAuthContext()` 中由 `this.sessionService.isImpersonating(rawToken)` 填充。
- 修正 `AUTH_REQUIRED=true` 强制改密拦截：加入 `!impersonatedBy` 条件，保证已完成改密的管理员在 `act-as` 至未改密成员时不触发 `mustChangePassword` 误拦截。
- `POST /api/auth/act-as` 放行 `authCtx.user.tier === 'PROJECT_ADMIN' || authCtx.impersonatedBy?.tier === 'PROJECT_ADMIN'` 并返回 `{ user, impersonating }`。
- 新增 `POST /api/auth/exit-act-as`：未处于替身态返回 `400`，成功退出则更新 `Set-Cookie` 并返回 `{ user, impersonating: null }`。
- 在 `POST /api/proposals`、`POST /api/decisions`、`POST /api/runs/retry`、`POST /api/supervisor/rollback`、`POST /api/comments`、`POST /api/rag/ingest` 中透传 `authCtx.impersonatedBy?.displayName` 至 `WorkflowOrchestratorFacade` 与 RAG/提案记录。

---

## 三、设计取舍说明

- **保留原管理员会话不吊销**：首次从管理员自身会话调用 `actAs` 时不销毁原管理员会话，仅当从一个替身会话再切换到下一个或调用 `exitActAs` 时销毁旧替身会话，既兼容多端/原令牌验证场景，又确保替身令牌随切出立即失效。
- **不直接篡改 `RbacGovernanceService` 用户对象**：归属标注在业务记录生成时注入（`reviewerActor`/`authorName`/`initiatorActor`），保持权限矩阵与花名册数据纯净。

---

## 四、测试与验收结果

- **新增测试（[tests/session-service.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/session-service.spec.ts)）**：
  - `SessionService` 单元测试 9b：覆盖替身态连续切换、旧替身令牌失效、`exitActAs` 恢复、`actAs` 切回自身以及 `EXIT_ACT_AS` 登录审计。
  - HTTP 集成测试 3：覆盖 `AUTH_REQUIRED=true` 下 `act-as` 连续切换、`POST /api/auth/exit-act-as` 恢复与重复退出 `400`、非管理员 `403`、以及替身态下评论/签核拍板/总管回退/立项均带 `(via 王总管)` 且不重复拼接。
- **全量回归结果**：
  - `node --test tests/session-service.spec.ts`：25/25 通过（0 失败）。
  - `npm run typecheck:backend && npm run lint:backend`：0 错误通过。
  - `npm test`：171 项测试 / 48 套件（167 通过 / 4 既有跳过 / 0 失败）。
