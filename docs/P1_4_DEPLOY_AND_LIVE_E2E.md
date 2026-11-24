# `P1-4` 容器部署配置硬化与真实 HTTP / 浏览器端到端验证说明

> 创建日期：2026-11-24 · 对应修复步骤：**Wave 2 · Step 10 (`P1-4`)** · 执行轮次：**第二十三轮**

---

## 一、背景与问题根因

在完成前端构建链路恢复、F1/F2 登录 UI、SSE 增量修复、PG/JSON 双模式持久化与 Agent/沙箱深层闭环后，复审发现部署编排与端到端实网校验层仍存在以下缺口：

1. **`Dockerfile` 单阶段与启动退化风险**：
   - 原镜像使用 `--ignore-scripts` 安装全部依赖并执行 `npm run build:ui`，在纯净 Alpine 环境下存在跳过 `esbuild` 原生二进制安装脚本的风险；
   - 默认以 `root` 运行，`CMD ["npm", "start"]` 每次容器启动都会重复执行 `npm run build:ui`，且缺少 `HEALTHCHECK`。
2. **`deploy/docker-compose.yml` 与模型网关配置缺失**：
   - `agentic-workbench` 仅声明普通 `depends_on` 而未等待 `service_healthy`，缺少 `LOCAL_PERSISTENCE_DIR` 与 `SANDBOX_WORKTREE_ROOT` 持久化卷；
   - `litellm-router` 未挂载配置文件，仓库中尚无 `deploy/litellm_config.yaml`。
3. **`deploy/.env.example` 配置漂移**：
   - `src/` 已新增 `AUTH_REQUIRED`、`COOKIE_SECURE`、`HTTP_*` 限流/包体安全参数、`RAG_VECTOR_DIM`、`PG_SESSION_*`、`EMBEDDING_MODEL`、`SANDBOX_RUNTIME` 等变量，但 `.env.example` 仅列出 12 项，运维部署极易漏配。
4. **缺少真实 TCP 协议与真实浏览器 UI E2E 验证**：
   - 既有测试全部基于进程内 dispatch 或单函数 mock，缺少真实 HTTP/SSE TCP socket、真实 OpenAI 兼容 HTTP `/v1/chat/completions` + `/v1/embeddings` 调用链、以及真实浏览器 Cookie 登录/改密/签核全链路检验。

---

## 二、修复编排与关键改动

### 1. 构建与脚手架脚本收敛（[`package.json`](../package.json) / [`tsconfig.json`](../tsconfig.json) / [`eslint.config.mjs`](../eslint.config.mjs)）

- 新增 `"start:server": "node src/server/WorkbenchServer.ts"`（仅供容器直启预构建产物，保留 `"start"` 为本地开发一键构建启动）；
- 新增 `"e2e:live": "node scripts/e2e-live-stack.ts"`；
- 将 `scripts/**/*.ts` 与 `deploy/**/*.{yaml,yml}` 纳入 `typecheck`、`lint` 与 `format` / `format:check` 检查范围。

### 2. 多阶段非 Root 硬化 [`Dockerfile`](../Dockerfile)

- **`builder` 阶段**（`node:22-alpine`）：不带 `--ignore-scripts` 执行 `npm ci || npm install`，确保 `esbuild` 二进制完整安装，完成 `npm run build:ui && npm run typecheck`。
- **`runtime` 阶段**（`node:22-alpine`）：保留 `apk add --no-cache git postgresql-client wget`，以 `--omit=dev` 安装生产依赖；拷贝预构建 `src/`（含 `src/ui/dist/`）、`configs/`、`deploy/` 与 `tsconfig.json`；预建并 `chown -R node:node` `/var/lib/agentic-sdlc/runtime-data` 与 `/var/lib/agentic-sdlc/worktrees`；切换 `USER node`，配置 `HEALTHCHECK` 探测 `/api/health`，以 `CMD ["npm", "run", "start:server"]` 启动。

### 3. LiteLLM 模型映射与健康检查编排（[`deploy/litellm_config.yaml`](../deploy/litellm_config.yaml) / [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) / [`deploy/.env.example`](../deploy/.env.example)）

- 新建 `deploy/litellm_config.yaml`：完整声明 `configs/workflows/enterprise_sdlc.yaml` 与 `ModelRouterGateway.ts` 使用的 4 个模型别名（`qwen2.5-coder-32b-instruct-int4`、`qwen2.5-coder-32b-instruct-local`、`claude-3-7-sonnet-enterprise`、`bge-m3-local`），对齐 `OLLAMA_API_BASE` 与 `LITELLM_API_KEY`。
- 更新 `deploy/docker-compose.yml`：
  - `postgres-pgvector` 增加 `pg_isready` 健康检查；
  - `litellm-router` 挂载 `./litellm_config.yaml:/app/config.yaml:ro` 并增加 `/health/liveliness` 健康检查；
  - `agentic-workbench` 使用 `condition: service_healthy` 等待 PG 与 LiteLLM 就绪，配置 `runtime_data` 与 `sandbox_worktrees` 命名持久卷，保留 `LITELLM_ENABLE_LIVE_HTTP=true` 并补齐 `AUTH_REQUIRED`、`LOCAL_PERSISTENCE_DIR`、`RAG_VECTOR_DIM` 等运行环境。
- 更新 `deploy/.env.example`：零遗漏补齐全部 30 个在 `src/` 中引用到的非 `NODE_ENV` 环境变量。

### 4. 可编程实网校验工具与真 TCP + HTTP/SSE + 浏览器 E2E 套件

- 新建 [`scripts/e2e-live-stack.ts`](../scripts/e2e-live-stack.ts)：提供 `checkHostPrerequisites()`、`verifyComposeConfig()`、`verifyPgSchema()`（核对全部 15 张表与 `pgvector` 扩展）与 `runHttpSmokeAgainstUrl()`；支持 `--check-env`、`--compose-config`、`--pg-verify`、`--http-smoke [url]` CLI 参数。
- 新建 [`tests/live-http-e2e.spec.ts`](../tests/live-http-e2e.spec.ts)（5 项自动化测试）：
  1. `Dockerfile` 多阶段构建、无构建阶段 `--ignore-scripts`、非 root、`HEALTHCHECK` 与 `start:server` 契约校验；
  2. `deploy/docker-compose.yml` 与 `deploy/litellm_config.yaml` YAML 解析校验（健康检查、`service_healthy`、持久卷与 4 模型别名）；
  3. `.env.example` 自动扫描全 `src/**/*.ts` 提取 `process.env.*` 执行零漂移对照；
  4. **真实 TCP HTTP + 本地 OpenAI 兼容推理端点 E2E**：启动真实监听端口的 `WorkbenchHttpServer`（`AUTH_REQUIRED=true`）与真实 TCP HTTP Mock OpenAI `/v1/chat/completions` + `/v1/embeddings` 服务端（`LITELLM_ENABLE_LIVE_HTTP=true`），通过真实 `fetch()` 串联未认证 `401` 拦截、静态 HTML/JS 加载、Cookie 登录（`sdlc_session`）与首次改密强制 `403` 拦截、改密、管理员新增成员与登录审计、发起高风险提案触发真实 HTTP Chat/Embedding 调用、`GET /api/events/stream` SSE 首帧验证、人工门禁审批、`POST /api/supervisor/tools`（`get_run_overview`）以及对话回退分叉；
  5. 调用 `runHttpSmokeAgainstUrl()` 在真实 `127.0.0.1:<port>` 跑通完整登录-改密-状态-立项-SSE-总管工具冒烟链路。

---

## 三、测试与验收报告（含宿主机能力边界诚实声明）

### 1. 本机实测已通过项

| 验证项目                                     | 执行方式                                                           | 实测结果                                                                                                                                                                                                                                                                 |
| :------------------------------------------- | :----------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端产物构建                                 | `npm run build:ui`                                                 | ✅ 退出码 `0`（生成 `src/ui/dist/main.js`）                                                                                                                                                                                                                              |
| 全库类型 / Lint / Prettier                   | `npm run typecheck && npm run lint && npm run format:check`        | ✅ 退出码 `0`（含 `scripts/**/*.ts` 与 `deploy/**/*.{yaml,yml}`）                                                                                                                                                                                                        |
| 全量自动化测试回归                           | `npm test`（含 `tests/live-http-e2e.spec.ts` 5 项）                | ✅ **205 / 205 通过（54 套件 / 32 测试文件，0 跳过 / 0 失败）**                                                                                                                                                                                                          |
| 真实浏览器 UI E2E（`http://localhost:4399`） | 独立启动隔离 `WorkbenchHttpServer`（`AUTH_REQUIRED=true`）+ Chrome | ✅ 通过：`BROWSER_HOST_FACTS` 确认访问 `http://localhost:4399`：登录页展示 → `admin/admin` 登录 → 强制改密为 `AdminPass2026!` → Topbar/Projects Hub/7 成员与登录审计表格渲染 → Gate 中心裁决推进 `STAGE_2_PD` 至 `STAGE_3A_TECH_SPEC`，全程零控制台未捕获异常与 5xx 响应 |
| 宿主机环境探测                               | `npm run e2e:live -- --check-env`                                  | `{"dockerAvailable":false,"dockerComposeAvailable":false,"psqlAvailable":false,"ollamaAvailable":false}`                                                                                                                                                                 |

### 2. 宿主机受限项（未伪造外部结果）与待目标环境执行命令

- 当前执行宿主机未安装 `docker`、`psql` 与 `ollama`，因此本轮 **未真实启动 Docker Compose 容器编排、真实 `pgvector` 实例及真实 Ollama/LiteLLM 模型权重推理**（所有测试报告与 TODO 状态均如实标注此边界）。
- 此外，浏览器 E2E 在 `759px` 窄视口下观察到侧边栏与主内容区存在布局重叠现象（可通过键盘 `Enter` 激活），该响应式布局缺陷已记录至 **Step 11 (`P2-2`) UI 改造阶段**一并治理。
- 在已安装 Docker + Ollama/PG 的目标部署机上，可直接执行以下标准一键验收命令：

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build
npm run e2e:live -- --compose-config --pg-verify --http-smoke http://127.0.0.1:4300 --strict
```
