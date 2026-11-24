# P0-2 变更说明：补齐前端 F1/F2 登录鉴权与用户管理 UI

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 6 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-2`）。

---

## 一、问题背景与根因

后端在第九轮已完成 `SessionService`（F1/F2）与 `AUTH_REQUIRED=true` 鉴权守卫，但前端 `src/ui/client/` 一直仅通过硬编码 `X-Actor-Id` 请求头交互，导致开启 `AUTH_REQUIRED=true` 后界面完全不可用：
- 缺少登录页、首登/重置后强制改密弹窗及 `401`/`403 (mustChangePassword)` 拦截跳转；
- `App.tsx` 未探测 `/api/auth/me` 且初始化失败会产生未处理拒绝；
- `AdminGovernanceView.tsx` 仅展示只读花名册，未对接 F2 成员增改/启停/重置口令与登录审计端点；
- 管理员替身视角缺少醒目横幅与一键退出 `/api/auth/exit-act-as` 入口。

---

## 二、核心修改内容

### 1. DTO 与会话驱动 API 客户端
- [types.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/types.ts#L309-L353)：新增 `AuthUserDto`、`AuthMeDto`、`LoginAuditEntryDto`、`WorkflowTemplateItemDto`、`SandboxVerificationSummaryDto`。
- [WorkbenchApiClient.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/WorkbenchApiClient.ts)：
  - 新增 `ApiHttpError`（携带 `statusCode`、`mustChangePassword`、`retryAfterSec`）与 `requestJson<T>()` 统一封装；
  - 始终传 `credentials: 'same-origin'`，已登录会话（`sessionAuthenticated=true`）不再发送 `X-Actor-Id` 与 `actorId` 参数；支持构造参数 `{ baseUrl, cookieJar }` 供 Node 真实 HTTP 联调测试；
  - 注册 `onUnauthorized`（401）与 `onMustChangePassword`（403）全局回调；
  - 新增 `fetchAuthMe`、`login`、`logout`、`changePassword`、`actAs`、`exitActAs`、`listAdminUsers`、`createAdminUser`、`updateAdminUser`、`resetAdminUserPassword`、`fetchLoginAudit`（同时预备后续阶段所需的模板列表与熔断重试调用封装）。

### 2. 登录页与改密弹窗组件
- 新建 [LoginView.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/components/LoginView.tsx)：账号/口令登录表单，处理 `401`/`403`/`423`（带 `retryAfterSec` 锁定倒计时提示）及演示模式按需返回。
- 新建 [ChangePasswordModal.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/components/ChangePasswordModal.tsx)：支持 `forced=true`（首登/重置强制改密，不可关闭但允许退出登录）与主动改密（前置校验 ≥8 位且含字母与数字）。

### 3. 根组件状态机、工具栏与替身警示条
- [App.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/App.tsx)：
  - 实现 `authMode: 'loading' | 'authenticated' | 'unauthenticated' | 'demo_mode'` 初始化探测（`/api/auth/me` → 401 时探 `/api/state` 决定演示兜底或渲染 `LoginView`），全路径加 `try/catch`；
  - 已登录模式下切换成员改调 `apiClient.actAs()`，主区域顶部展示管理员替身提示条与「退出代班视角」（`exitActAs()`）按钮。
- [Topbar.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/components/Topbar.tsx)：仅在演示模式或管理员/替身管理员身份下渲染成员切换条，并补齐「改密」「退出」「退出代班」「账号登录」按钮。
- [workbench.css](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/styles/workbench.css#L2195-L2289)：新增登录卡片、错误/提示框、替身警示条及管理子表单样式（复用明暗主题变量）。

### 4. F2 成员目录管理与登录审计面板
- [AdminGovernanceView.tsx](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/client/views/AdminGovernanceView.tsx)：
  - 管理员身份自动拉取 `/api/admin/users` 与 `/api/admin/login-audit`；
  - 支持「+ 新增团队成员」并展示生成的一次性 `tempPassword`；
  - 成员表支持行内「改权」（多选负责步骤保存）、「重置口令」（展示新临时口令）与「启/停用」（`ACTIVE`/`DISABLED`）；
  - 新增「安全登录与视角切换审计日志」表格与手动刷新按钮。

---

## 三、测试与验收结果

- **新增真实 HTTP 联调测试（[tests/frontend-api-client.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/frontend-api-client.spec.ts)）**：
  - 在 `AUTH_REQUIRED=true` 真实监听端口 `WorkbenchHttpServer` 下使用 `WorkbenchApiClient({ baseUrl, cookieJar: true })` 实测：未登录 401 回调 → 登录返回 `mustChangePassword=true` → 403 `onMustChangePassword` 回调 → 改密放行 `/api/state` → `actAs` → `fetchAuthMe` 核验 `impersonating` → `exitActAs` 恢复管理员 → F2 `createAdminUser`/`updateAdminUser`/`resetAdminUserPassword`/`fetchLoginAudit` → `logout` 后再请求触发 401。
- **全量回归（`npm run build:ui && npm run format && npm run check`）**：
  - 双端 `typecheck`、双端 `lint`、`format:check`、`esbuild` 打包均 0 错误通过；
  - `npm test`：**184 项测试 / 52 套件（180 通过 / 4 既有跳过 / 0 失败）**。
