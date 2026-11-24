# P0-5 变更说明：`WorkbenchServer` HTTP 安全加固与默认模式越权收敛

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 3 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-5`）。

---

## 一、问题背景与安全隐患

在对 [WorkbenchServer.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/server/WorkbenchServer.ts) 进行完整度复审时发现以下 HTTP 安全与边界问题：

1. **请求体缺少字节上限与读取超时**：`readJsonBody()` 无限制缓冲客户端数据且无超时，易受慢速连接或超大 JSON 载荷导致的内存膨胀风险。
2. **响应安全头与 `Secure` Cookie 缺失**：HTML、静态资源、SSE 与 JSON API 缺少 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Content-Security-Policy`；`Set-Cookie` 在 HTTPS/反向代理加密场景未附带 `Secure` 标志。
3. **缺少登录与高开销接口限流**：`/api/auth/login` 与创建提案/沙箱执行/模型体检等接口无速率限制。
4. **路径前缀校验边角漏洞**：`/styles/*.css`、`/dist/*.js` 与 `/api/sandbox/file` 的 `startsWith(root)` 缺少 `+ path.sep` 后缀且沙箱未校验 `isFile()`，存在同前缀兄弟目录越权访问风险。
5. **默认模式下权限收敛与强制改密缺口**：非 `AUTH_REQUIRED=true` 时 `GET /api/workflows/templates` 完全匿名放行、`GET /api/sandbox/file` 与 `POST /api/rag/query` 对 `authSource === 'none'` 跳过 RBAC 校验，且已登录会话的 `mustChangePassword=true` 仅在 `AUTH_REQUIRED=true` 下拦截。

---

## 二、核心修改内容（[WorkbenchServer.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/server/WorkbenchServer.ts)）

1. **`HttpRequestError` 与 `readJsonBody` 加固**（第 46-55 行、第 1347-1399 行）：
   - 构造函数支持 `maxBodyBytes`（默认 `HTTP_MAX_BODY_BYTES` 或 1 MB）、`bodyTimeoutMs`（默认 `HTTP_BODY_TIMEOUT_MS` 或 15s）及限流参数覆写。
   - 累计超限返回 `413`、读取超时返回 `408`，并在结算时统一移除事件监听器与定时器。
2. **统一安全响应头与条件 `Secure` Cookie**（第 1300-1329 行）：
   - `buildSecurityHeaders()` 统一输出 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`；HTML 响应附加 `Content-Security-Policy`。
   - `buildSessionCookie()` 根据 `COOKIE_SECURE === 'true'`、`x-forwarded-proto: https` 或 TLS socket 状态动态附带 `; Secure`，兼顾本地 HTTP 调试与生产 HTTPS 安全交付。
3. **滑动窗口速率限制**（第 1331-1350 行）：
   - `enforceRateLimit()` 按客户端 IP（`x-forwarded-for` / `remoteAddress`）对 `POST /api/auth/login`（默认 20/分钟）与高开销接口（`POST /api/proposals`、`POST /api/sandbox/verify`、`POST /api/admin/model-baseline`，默认 30/分钟）限流，超限返回 `429` 及 `Retry-After` 秒数。
4. **`+ path.sep` 路径前缀防御**（第 399-434 行、第 1150-1169 行）：
   - `/styles/*.css`、`/kit/*.css`、`/dist/*.js` 与 `/api/sandbox/file` 统一补全 `path.sep` 边界及 `statSync().isFile()` 核验，杜绝同前缀兄弟目录穿越。
5. **默认模式越权收敛与全模式强制改密拦截**（第 497-513 行、第 580-592 行、第 1143-1149 行、第 1218-1224 行）：
   - 将 `sessionUser && sessionUser.mustChangePassword && !impersonatedBy` 拦截提升至全局统一生效（豁免 `/api/auth/me`、`/api/auth/change-password`、`/api/auth/logout`、`/api/health`）。
   - `GET /api/workflows/templates`、`GET /api/sandbox/file`、`POST /api/rag/query` 在 `AUTH_DISABLED !== 'true'` 时统一执行 `assertHasPermission(..., VIEW_SHARED_WORKFLOW)`，不再对匿名请求跳过 RBAC；保留 `GET /api/state`、`/api/events/stream`、`POST /api/workflows/template` 默认回退以兼容既有单机演示测试。

---

## 三、测试与验收结果

- **新增专项套件（[tests/http-security-hardening.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/http-security-hardening.spec.ts)）**：
  - Test 1：请求体超限 `413` 与慢流超时 `408`。
  - Test 2：HTML/CSS/API 安全头与 `x-forwarded-proto: https` 条件 `Secure` Cookie。
  - Test 3：`login` 与 `/api/proposals` 滑动窗口限流 `429` + `Retry-After`（且不同 IP 隔离）。
  - Test 4：构造同前缀兄弟目录 `<wsPath>-evil/secret.txt` 验证 `+ path.sep` 拦截越权读取。
  - Test 5：默认模式下匿名访问 `templates`/`sandbox/file`/`rag/query` 均返回 `403`，`mustChangePassword=true` 会话访问 `/api/state` 与 `/api/workflows/templates` 亦返回 `403`。
- **回归结果**：
  - `tests/http-security-hardening.spec.ts` + `tests/server-sse-api.spec.ts` + `tests/session-service.spec.ts`：31/31 通过。
  - `npm run typecheck:backend && npm run lint:backend`：0 错误通过。
  - `npm test`：183 项测试 / 51 套件（179 通过 / 4 既有跳过 / 0 失败）。
