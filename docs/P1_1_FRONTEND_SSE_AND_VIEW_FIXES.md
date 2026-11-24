# P1-1 变更说明：修复前端多 Run SSE 重连串台与视图交互缺陷

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 7 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P1-1`）。

---

## 一、问题背景与修复清单

针对前端多运行实例切换、SSE 增量消费与 5 处视图交互瑕疵进行了全面修复：

1. **多 Run SSE 订阅串台与未释放连接**：`App.tsx` SSE `useEffect` 缺少 `state?.run?.runId` 依赖且清理函数未关闭旧 `EventSource`，切换项目或新建运行后旧流持续推送造成界面覆盖。
2. **增量帧与熔断重试未接通**：`WorkbenchApiClient` 未消费后端已广播的 `run_event`/`user_notification`，未封装 `POST /api/runs/retry`（含 `extraTokenBudget`），且 `submitDecision` 漏传 `notif.runId`。
3. **Topbar 角色与模板硬编码**：`Topbar.tsx` 硬编码 6 项角色（遗漏周工 DA 及动态新建成员）与 2 个静态模板 `<option>`，未消费 `rbacContext.roster` 与 `/api/workflows/templates`。
4. **SandboxExplorerView 虚假弹窗且状态不同步**：`runTests()` 硬编码 `alert('通过率 100%')` 且未回写 `dashboardState`。
5. **AuditRagView 收起按钮不可达**：展开全部审计记录后 `auditEntries.length > visible.length` 为 `false`，导致「收起审计记录 ▴」按钮无法渲染。
6. **ProjectsHubView 熔断状态误标**：将 `ABORTED` 与 `ABORTED_TOKEN_BUDGET` 统一显示为 `⏳ 推进中·待确认`。
7. **Sidebar 嵌套 `<svg>` DOM 违规**：`<svg className="nav-icon">` 内嵌套 `<svg>`。

---

## 二、核心修改内容

1. **SSE 多 Run 重连、增量合并与熔断恢复（[WorkbenchApiClient.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/WorkbenchApiClient.ts) & [App.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/App.tsx)）**：
   - `WorkbenchApiClient` 新增 `listWorkflowTemplates()`、`retryAbortedRun()`（透传 `extraTokenBudget`）、`closeRealtimeEventStream()`；`subscribeRealtimeEventStream()` 返回 cleanup 函数，按 `runId` 建连并解析派发 `run_event` / `user_notification`。
   - `App.tsx` SSE `useEffect` 绑定 `[authMode, mustChangePassword, actorId, activeRunId]`，并在 cleanup 时调用 `unsubscribe()`；增量合入同 `runId` 的 `liveInteractionStream` 与 `notifications`。
   - `submitDecision()` 透传 `notif.runId`，并对 `STAGE_CONTRACT_FAILED` / `TOKEN_BUDGET_EXCEEDED` / `RETRY:*` 自动转调 `retryAbortedRun()`（预算超限默认补充 `extraTokenBudget: 30000`）。
2. **动态花名册与动态模板下拉（[Topbar.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/components/Topbar.tsx)）**：
   - 角色切换条改为实时渲染 `state?.rbacContext?.roster`（完整包含周工 DA 及 F2 新增成员）；
   - `App.tsx` 拉取 `GET /api/workflows/templates` 传入 `templates`，并对 `activeTemplateFile` 兼容路径末段文件名匹配。
3. **视图缺陷全清**：
   - [SandboxExplorerView.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/views/SandboxExplorerView.tsx)：移除硬编码 `alert`，基于真实 `passedTestCases`/`totalTestCases`/`securityIssuesFound` 计算通过率，同步调用 `onApplyState(res.dashboardState)` 与 `onBanner()`，读文件透传 `state.run?.runId`。
   - [AuditRagView.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/views/AuditRagView.tsx#L58)：条件改为 `auditEntries.length > AUDIT_LIMIT`，恢复「收起审计记录 ▴」交互。
   - [ProjectsHubView.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/views/ProjectsHubView.tsx#L51-L63)：精细区分 `COMPLETED` / `ABORTED` / `ABORTED_TOKEN_BUDGET` / `PAUSED_AT_HUMAN_GATE` / `RUNNING` 五种状态徽标。
   - [Sidebar.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/components/Sidebar.tsx#L174-L176) & [workbench.css](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/styles/workbench.css#L211-L224)：改为 `<span className="nav-icon" aria-hidden="true">` 包裹子 `<svg>` 并配置 `inline-flex` + 子元素 `100%` 尺寸，消除嵌套 `<svg>`。

---

## 三、测试与验收结果

- **新增测试（[tests/frontend-api-client.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/frontend-api-client.spec.ts) P1-1 套件）**：
  - Test 1：真实 HTTP 验证 `listWorkflowTemplates()`、`triggerLiveSandboxVerification()`（核验真实测试计数与 `dashboardState`）以及向 `ABORTED_TOKEN_BUDGET` 运行提交 `retryAbortedRun({ extraTokenBudget: 50000 })` 恢复推进。
  - Test 2：验证 `subscribeRealtimeEventStream()` 按 `runId` 建连、分发 `run_event` 与 `user_notification` 增量帧，以及 `unsubscribe()` 调用 `EventSource.close()`。
- **全量回归（`npm run build:ui && npm run format && npm run check`）**：
  - 双端 `typecheck`、双端 `lint`、`format:check`、`esbuild` 打包全过；
  - `npm test`：**186 项测试 / 53 套件（182 通过 / 4 既有跳过 / 0 失败）**。
