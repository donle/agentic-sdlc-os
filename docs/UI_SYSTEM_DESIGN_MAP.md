# UI 重设计前置：系统设计全景图（API 契约 × 交互结果 × 业务语义）

> 本文档是前端重设计的**唯一事实源**。所有界面元素必须能追溯到本文档中的某个 API 字段或领域枚举；
> 凡是界面上出现的数字、状态、标签，都必须来自后端真实返回，不允许前端臆造。
>
> 覆盖代码基线：`src/server/WorkbenchServer.ts`、`src/engine/WorkflowOrchestratorFacade.ts`、
> `src/ui/client/**`（26 个 `.ts/.tsx` 文件）、`src/ui/kit/**`（10 个文件，Meridian UI）、`src/ui/styles/workbench.css`、`configs/workflows/*.yaml`。

---

## 0. 一句话产品定义

**Agentic SDLC OS** 是面向 B 端研发团队的「多智能体研发流水线控制台」。
6 个职能 Agent 沿固定 DAG 顺序产出交付物，每个阶段产出物都必须经过**风险分级门禁**（高风险阻塞人工、
低风险自动放行但强制留痕），人类在门禁处签核 / 驳回 / 拍板，全链路写入**不可变审计账本**，
总管 Agent（Supervisor）可用自然语言发起**分支回退**，历史版本永不覆盖。

**这个产品的界面第一职责不是"展示信息"，而是"让人在正确的时刻，作出正确的裁决"。**
因此新设计的核心 KPI 是：_待我裁决项的响应速度_ 与 _一屏内判断"卡在哪、谁该动"的时间_。

---

## 1. 运行时拓扑

```
┌──────────────┐  GET /api/events/stream (SSE)   ┌─────────────────────────────┐
│  浏览器 SPA  │◄─ run_event/user_notification ───┤  WorkbenchHttpServer        │
│  React 19    │◄─ event: state_updated ─────────┤  └ WorkflowOrchestratorFacade│
│  hash 路由   │                                  │    ├ DagWorkflowStateEngine  │
│  前端仍用     │── POST /api/* ───────────────────►│    ├ RbacGovernanceService    │
│  X-Actor-Id  │  X-Actor-Id / Session Cookie     │    ├ SessionService (F1/F2)   │
└──────────────┘  (后端支持 SessionService 鉴权)   │    ├ WorkflowDslLoader (YAML) │
                                                  │    ├ GitWorktreeSandboxMgr   │
                                                  │    └ NegativeExperienceRagEng│
                                                  └─────────────────────────────┘
```

**关键约束（直接影响 UI 形态）：**

| 约束                                                                       | 来源                               | 对 UI 的强制要求                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务端已按请求 `runId` 隔离（`#13`），不再以全局 `activeRunId` 串台        | `resolveRequestRunId` / `App.tsx`  | `GET /api/state` 与 `POST /api/runs/select` 仅返回对应 `runId` 状态；`WorkbenchApiClient` 维护当前页签 `activeRunId`（注：`App.tsx` SSE 重连暂缺 `runId` 依赖，见 `BACKEND_TODO.md` §六） |
| 每次状态变更服务端仅向对应 `runId` 订阅者 `broadcastSseStateUpdate(runId)` | 同上                               | 所有写操作返回**完整 DashboardStateDto**，前端无需乐观更新                                                                                                                                |
| SSE 连接按 `actorId` + `runId` 区分，每条推送按接收者身份重新计算 RBAC     | `broadcastSseStateUpdate`          | 切换身份或切换 `runId` 都必须**重连 SSE**，否则会收到越权视角或旧项目状态                                                                                                                 |
| 后端 SSE 推 3 类事件并已接线 `Last-Event-ID` 重放，前端暂只消费全量帧      | `SseBridge` + `WorkbenchApiClient` | 后端按 `id: <seq>` 与 `runId` 推送 `run_event`、`user_notification`、`state_updated` 并支持 `Last-Event-ID` 断线重放（`#13`）；前端仍靠整树替换 `state_updated`                           |
| 后端已落地 `SessionService`，前端尚未迁移登录流                            | `resolveAuthContext` / `App.tsx`   | 后端支持 Cookie/Bearer 与 `AUTH_REQUIRED=true`，默认模式下写接口与未知 `X-Actor-Id` 已被严格拦截；前端目前仍通过 `X-Actor-Id` 与身份切换条演示                                            |
| 静态资源由自研 Node 服务托管，无 CDN                                       | `routeRequest`                     | 不能引入外部字体/图标 CDN，离线内网可用是硬需求 → **必须内联 SVG 图标，系统字体栈**                                                                                                       |

---

## 2. API 契约全表（27 个 `/api/*` 端点）

### 2.1 统一约定

- **响应封装**：所有 JSON 接口返回 `{ ok: boolean, data?: T, error?: string }`。
  前端 `WorkbenchApiClient` 已统一拆包；失败时 `error` 为中文可直接展示的文案。
- **HTTP 状态码**：`200` 成功（`POST /api/admin/users` 返回 `201`）；`401` 会话无效/伪造/过期（或 `AUTH_REQUIRED=true` 未登录）；`403` 当权限不足 / `[RBAC` 拦截 / `mustChangePassword=true`；`409` 冲突（如停用/降级最后管理员）；`423` 登录锁定；`400` 其他业务错误；`404` 未知路由。
- **身份传递**：`SessionService` Cookie (`sdlc_session`) / `Authorization: Bearer` 优先；非 `AUTH_REQUIRED=true` 默认模式下允许 `X-Actor-Id` / query `actorId` / body `actorUserId`。**写接口与非 `/api/state` 路由不再对未知身份回落 `user-admin-01`**（直接返回 `403`/`401`；仅默认模式只读 `GET /api/state`、`POST /api/workflows/template` 与 `/api/events/stream` 在无身份时回退默认投影）。
- **鉴权执行位置**：服务端 `WorkbenchServer`（权限码校验）+ `RbacGovernanceService`（严格阶段权限）强制校验，**前端禁用态只是 UX 提示，不是安全边界**。
  前端必须依据返回的 `accessEvaluation` 渲染按钮禁用 + 原因文案。

### 2.2 端点明细

| #     | 方法 | 路径                                                                                                                     | 请求                                                                                                    | 响应 `data`                                                 | 副作用 / 说明                                                                        |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1     | GET  | `/api/health`                                                                                                            | —                                                                                                       | 健康/配置/运行摘要                                          | 豁免鉴权（`AUTH_REQUIRED=true` 亦可访问）                                            |
| 2     | GET  | `/api/state`                                                                                                             | query: `actorId`, `runId?`                                                                              | `DashboardStateDto`                                         | 返回指定或默认 `runId` 状态，不再改写全局 `activeRunId`（`#13`）                     |
| 3     | POST | `/api/runs/select`                                                                                                       | `{runId, actorUserId}`                                                                                  | `DashboardStateDto`                                         | 仅返回所选 `runId` 状态，不篡改全局 `activeRunId` 且不触发全量 SSE 广播（`#13`）     |
| 4     | POST | `/api/proposals`                                                                                                         | preset 或自定义，见 §2.3                                                                                | `DashboardStateDto`                                         | **新建运行实例** + 按 `runId` 定向 SSE 广播                                          |
| 5     | GET  | `/api/workflows/templates`                                                                                               | —                                                                                                       | `{activeTemplateFile, templates[]}`                         | 无（**前端目前未使用**，可作动态模板列表源）                                         |
| 6     | POST | `/api/workflows/template`                                                                                                | `{templateFileName, actorUserId}`                                                                       | `DashboardStateDto`                                         | 重载 YAML DSL + **新建运行实例** + 按 `runId` 定向 SSE 广播                          |
| 7     | POST | `/api/decisions`                                                                                                         | `{runId?, snapshotId, verdict, comment, extraTokenBudget?, actorUserId}`                                | `DashboardStateDto`                                         | 写 `HumanDecision` → 推进/驳回/拍板；兼容 `RETRY:*`/旧 `ROOT` 熔断恢复（`#10`）      |
| 8     | POST | `/api/runs/retry`                                                                                                        | `{runId?, snapshotId?, extraTokenBudget?, comment?, reviewerActor?, actorUserId}`                       | `DashboardStateDto`                                         | **熔断专属恢复端点**（`#10`）：重启 `ABORTED`/`ABORTED_TOKEN_BUDGET` 阶段 + SSE 广播 |
| 9     | POST | `/api/comments`                                                                                                          | `{runId?, stageId, content, actorUserId}`                                                               | `DashboardStateDto`                                         | 写 `TeamComment`（全员可见）+ 按 `runId` 定向 SSE 广播                               |
| 10    | POST | `/api/supervisor/rollback`                                                                                               | `{runId?, targetStageId?, dialogueInstruction, actorUserId}`                                            | `DashboardStateDto`                                         | **Fork 新分支**，旧分支标 `SUPERSEDED` + 按 `runId` 定向 SSE 广播                    |
| 11    | GET  | `/api/sandbox/file`                                                                                                      | query: `path`, `runId?`, `actorId`                                                                      | `{relativePath, branchId, content}`                         | 按 `runId` 隔离读取沙箱文件（路径穿越有防护）                                        |
| 12    | POST | `/api/sandbox/verify`                                                                                                    | `{runId?, actorUserId}`                                                                                 | `{verification:{executionLog}, dashboardState}`             | 子进程跑真实单测 + 安全扫描 + 按 `runId` 定向 SSE 广播                               |
| 13    | POST | `/api/rag/query`                                                                                                         | `{stageId, queryText}`                                                                                  | `{matches: RagQueryMatchDto[]}`                             | 无（Top-K 余弦检索）                                                                 |
| 14    | POST | `/api/rag/ingest`                                                                                                        | `{runId?, stageId, lessonText, actorUserId}`                                                            | `DashboardStateDto`                                         | 写负向经验向量库 + 按 `runId` 定向 SSE 广播                                          |
| 15    | POST | `/api/admin/governance`                                                                                                  | `{runId?, maxNegotiationTurns, highRiskScoreThreshold, allowSpecialistCrossStageRollback, actorUserId}` | `DashboardStateDto`                                         | 改全局风控阈值（**仅 PROJECT_ADMIN**）+ 按 `runId` 定向 SSE 广播                     |
| 16    | POST | `/api/admin/model-baseline`                                                                                              | —                                                                                                       | `ModelBaselineReportDto`                                    | 两级端点 × 3 任务模型体检（**仅 PROJECT_ADMIN**；`AdminGovernanceView` 已接入）      |
| 17    | GET  | `/api/events/stream`                                                                                                     | query: `actorId`, `runId?`, `lastEventId?`; header: `Last-Event-ID?`                                    | SSE 流                                                      | 按 `runId` 过滤推送全量 `state_updated` + 增量重放与 `run_event`/`user_notification` |
| 18–22 | *    | `/api/auth/login` \| `logout` \| `me` \| `change-password` \| `act-as`                                                   | 会话认证与视角切换                                                                                      | `{ user, impersonating }` / 状态                            | F1 会话体系（前端登录 UI 待迁移，见 `USER_SYSTEM_DESIGN.md`）                        |
| 23–27 | *    | `GET/POST /api/admin/users` \| `PATCH /api/admin/users/:id` \| `POST .../reset-password` \| `GET /api/admin/login-audit` | 成员 CRUD、重设口令与登录审计                                                                           | `{ users[] }` / `{ user, tempPassword? }` / `{ entries[] }` | F2 用户管理与登录审计（**需 `MANAGE_RBAC_POLICY`**, 前端 UI 待迁移）                 |

> ⚠️ **设计发现 1**：`/api/workflows/templates` 存在但前端把两个模板名**硬编码**在 `Topbar.tsx` 的 `<select>` 里。
> 重设计时应改为调用该端点动态渲染，否则新增 YAML 模板前端不会同步。

### 2.3 `POST /api/proposals` 的 preset 语义（业务演示场景）

| preset                                                     | 业务含义                                                                 | 关键开关                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CUSTOM`                                                   | 用户自定义立项                                                           | `involvesDatabaseMigration` / `involvesPermissionOrPayment` / `simulateNegotiationConflict` / `simulateScopeReductionAttempt` / `requirements{}` |
| `CONFLICT_AND_DDL`（**默认**，其余 preset 之外的兜底分支） | 完整高风险链路：PM-PD 3 轮协商熔断 + 3a DDL 高风险门禁 + Stage 4 QA 终审 | 三项风险全开 + **Stage 1 注入瞬态失败**（演示自愈重试）                                                                                          |
| `LOW_RISK_FAST_TRACK`                                      | 常规迭代，验证低风险阶段自动放行                                         | 无风险项，直达 Stage 4 QA 终审                                                                                                                   |
| `SCOPE_DIFF_ALERT`                                         | 防「虚假共识」：Agent 协商中擅自删减核心需求                             | `simulateScopeReductionAttempt=true` → 触发 `SCOPE_DIFF_WARNING`                                                                                 |
| `CACHE_HIT_REUSE`                                          | 复用同构历史方案，验证语义缓存命中                                       | 与默认项目同需求，命中 L1/L2 缓存、`cacheHit=true`、零 Token 消耗                                                                                |

> ⚠️ **设计发现 2**：`CUSTOM` 分支读取 `body.simulateScopeReductionAttempt`，但 `NewProposalModal.tsx`
> 的表单**没有这个字段**（只有 `simulateNegotiationConflict`）。即"范围变更红线"目前只能由 preset 触发。
> 重设计时应在表单中补齐该开关，并加上「高风险」可视化标识。

### 2.4 SSE 事件契约

| 事件                | 时机                                                     | 载荷                                                                  |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `state_updated`     | 建连立即 + **每一次**写操作后广播                        | 完整 `DashboardStateDto`（按接收者 actorId 重新计算 RBAC）            |
| `run_event`         | 阶段执行/意图/缓存/重试/门禁事件触发时（带 `id: <seq>`） | 实时事件载荷（由 `SseBridge` 推送，前端暂未单独订阅）                 |
| `user_notification` | 通知写入 `WorkflowEventBus` 时（带 `id: <seq>`）         | `AgentUserNotification` 载荷（由 `SseBridge` 推送，前端暂未单独订阅） |

连接状态通过 `EventSource` 的 `open` / `error` 事件反馈（`onConnectionChange`）。

---

## 3. 领域模型与状态机（界面上一切状态的来源）

### 3.1 阶段拓扑（`stagePipelineOrder` 来自 YAML DSL，非硬编码）

| #   | stageId              | Agent           | 交付物 artifactType                     | 门禁策略                         | 责任专家         |
| --- | -------------------- | --------------- | --------------------------------------- | -------------------------------- | ---------------- |
| 0   | `STAGE_0_INITIATION` | —               | 立项提案                                | —                                | 发起人           |
| 1   | `STAGE_1_PM`         | PM_AGENT        | `PRD_ARTIFACT_CONTRACT`                 | RISK_BASED                       | 陈工 (PM)        |
| 2   | `STAGE_2_PD`         | PD_AGENT        | `UI_DESIGN_ARTIFACT_CONTRACT`           | RISK_BASED，与 S1 协商           | 林工 (PD/UX)     |
| 3a  | `STAGE_3A_TECH_SPEC` | TECH_LEAD_AGENT | `TECH_SPEC_ARTIFACT_CONTRACT`           | RISK_BASED                       | 赵工 (Tech Lead) |
| 3b  | `STAGE_3B_ENGINEER`  | ENGINEER_AGENT  | `CODE_IMPLEMENTATION_ARTIFACT_CONTRACT` | RISK_BASED                       | 刘工 (Engineer)  |
| 4   | `STAGE_4_QA`         | QA_AGENT        | `QA_VERIFICATION_ARTIFACT_CONTRACT`     | **FORCE_HUMAN_GATE**（永远阻塞） | 孙工 (QA)        |
| 5   | `STAGE_5_DA`         | DA_AGENT        | `DATA_ANALYSIS_ARTIFACT_CONTRACT`       | RISK_BASED                       | 周工 (DA)        |

**协商关系**：`S2 ↔ S1`（PM-PD，Max Turns 熔断 → 总管接管）、`S4 ↔ S3B`（QA-Engineer 修复闭环）。
`backend_api_only.yaml` 模板会**动态移除 S2**（免 UI 流程），阶段顺序随之变化 —— UI 不能假设固定 6 格。

### 3.2 快照生命周期状态 `SnapshotLifecycleState`

| 值                       | 含义                     | 视觉语义（设计稿已采用）                        |
| ------------------------ | ------------------------ | ----------------------------------------------- |
| `IDLE`                   | 未启动                   | 空心灰                                          |
| `RECOGNIZING_INTENT`     | 意图识别中               | 蓝，呼吸                                        |
| `CACHE_HIT`              | 语义缓存命中             | 青，⚡ 角标                                     |
| `EXECUTING`              | 执行中                   | 主色，流动                                      |
| `NEGOTIATING`            | 协商中                   | 琥珀，脉冲                                      |
| `RETRYING`               | 自愈重试中               | 琥珀，旋转                                      |
| `PENDING_HUMAN_GATE`     | **等待人工裁决**         | 琥珀，**环形脉冲 + 呼吸光晕**（最高视觉优先级） |
| `APPROVED`               | 人工签核通过             | 玉绿，实心                                      |
| `AUTO_APPROVED_LOW_RISK` | 低风险自动放行（已留痕） | 青，实心 + 🤖 角标                              |
| `REJECTED`               | 被驳回                   | 珊瑚红                                          |
| `SUPERSEDED`             | 被回退替换的旧版         | 灰虚线 + 降透明                                 |

### 3.3 其它枚举 → 界面文案对照表

| 枚举                         | 取值                                             | 界面标签                                                     |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `WorkflowRunStatus`          | `RUNNING`                                        | 推进中                                                       |
|                              | `PAUSED_AT_HUMAN_GATE`                           | 等待人工裁决                                                 |
|                              | `COMPLETED`                                      | 已交付                                                       |
|                              | `ABORTED`                                        | 已中止                                                       |
|                              | `ABORTED_TOKEN_BUDGET`                           | Token 预算耗尽中止                                           |
| `BusinessRiskLevel`          | `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`           | 低 / 中 / 高 / 极高风险                                      |
| `GateActionType`             | `AUTO_PASS_WITH_AUDIT`                           | 自动放行（留痕）                                             |
|                              | `BLOCK_FOR_HUMAN_VERIFICATION`                   | 阻塞人工确认                                                 |
|                              | `BLOCK_FOR_CONFLICT_ARBITRATION`                 | 阻塞冲突裁决                                                 |
| `DecisionVerdict`            | `APPROVE` / `REJECT`                             | 确认通过 / 驳回重做                                          |
|                              | `ARBITRATE_OPTION_A` / `_B`                      | 拍板方案 A / 方案 B                                          |
|                              | `AUTO_PASS_LOW_RISK`                             | 低风险自动放行                                               |
|                              | `SUPERVISOR_ROLLBACK`                            | 总管对话回退                                                 |
| `NotificationCategory`       | `PENDING_VERIFICATION`                           | 待人工确认                                                   |
|                              | `CONFLICT_ARBITRATION_REQUIRED`                  | 冲突裁决                                                     |
|                              | `SCOPE_DIFF_WARNING`                             | 需求范围红线                                                 |
|                              | `AUTO_PASSED_TRACE`                              | 自动放行留痕                                                 |
|                              | `ROLLBACK_EXECUTED`                              | 回退已执行                                                   |
|                              | `STAGE_PROGRESS`                                 | 阶段推进                                                     |
|                              | `TOKEN_BUDGET_EXCEEDED`                          | Token 预算超限（`RETRY:*` 与 `/api/runs/retry` 恢复，`#10`） |
|                              | `STAGE_CONTRACT_FAILED`                          | 契约校验熔断（`RETRY:*` 与 `/api/runs/retry` 恢复，`#10`）   |
| `TeamComment.category`       | `COMMENT` / `APPROVAL_NOTE` / `REVISION_REQUEST` | 团队评论 / 步骤签核 / 修改建议                               |
| `AuditEntry.actionType` 前缀 | `AGENT_` / `NOTIFICATION_` / `VERDICT_`          | Agent 动作 / 系统通知 / 人工裁决                             |

---

## 4. RBAC：谁能做什么（决定按钮态与"只读"表达）

### 4.1 预置成员（7 人）

| userId          | 姓名             | 岗位                          | 层级             | 负责阶段   | 对应 Agent       | 徽标     |
| --------------- | ---------------- | ----------------------------- | ---------------- | ---------- | ---------------- | -------- |
| `user-admin-01` | 王总管           | 研发体系最高管理员 / PMO 总监 | PROJECT_ADMIN    | **全部**   | SUPERVISOR_AGENT | 👑 ADMIN |
| `user-pm-01`    | 陈工 (PM)        | 资深产品经理                  | STAGE_SPECIALIST | S0, S1, S2 | PM_AGENT         | 📋 PM    |
| `user-pd-01`    | 林工 (PD/UX)     | 主任体验与交互设计师          | STAGE_SPECIALIST | S2         | PD_AGENT         | 🎨 PD/UX |
| `user-tech-01`  | 赵工 (Tech Lead) | 首席系统架构师                | STAGE_SPECIALIST | S3a, S3b   | TECH_LEAD_AGENT  | 🏛️ ARCH  |
| `user-eng-01`   | 刘工 (Engineer)  | 高级核心研发工程师            | STAGE_SPECIALIST | S3b        | ENGINEER_AGENT   | 💻 ENG   |
| `user-qa-01`    | 孙工 (QA)        | 质量保证与自动化测试负责人    | STAGE_SPECIALIST | S4         | QA_AGENT         | 🛡️ QA    |
| `user-da-01`    | 周工 (DA)        | 资深数据分析师                | STAGE_SPECIALIST | S5         | DA_AGENT         | 📊 DA    |

> ⚠️ **设计发现 3**：`Topbar.tsx` 的「一键切换成员视角」条**漏了 `user-da-01`（周工 DA）**，
> 且标签写死为旧名字（"王总管(管理员)"、与 `displayName` "王总管" 不一致）。
> 7 人中只能切 6 人 —— 重设计时改为从 `rbacContext.roster` **动态渲染**，永不硬编码。

### 4.2 权限码与判定

| 权限码                               | 含义                                             |
| ------------------------------------ | ------------------------------------------------ |
| `VIEW_SHARED_WORKFLOW`               | 查看全部步骤 + 交付物 + 评论（**所有成员都有**） |
| `CREATE_PROPOSAL`                    | 发起新提案                                       |
| `APPROVE_ASSIGNED_STAGE_GATE`        | 签核**自己负责**的阶段门禁                       |
| `ADMIN_OVERRIDE_ANY_GATE`            | 跨阶段拍板任意门禁（仅管理员）                   |
| `INVOKE_SUPERVISOR_ROLLBACK`         | 调度总管回退                                     |
| `EXECUTE_SANDBOX_VERIFICATION`       | 触发沙箱真实测试                                 |
| `MANAGE_WORKFLOW_DSL_AND_GUARDRAILS` | 管理 YAML 模板与风控阈值                         |
| `MANAGE_RBAC_POLICY`                 | 管理权限矩阵                                     |

判定结果由 `StageAccessEvaluationDto` 直接下发，前端只需消费 4 个布尔 + 2 个文案字段：

| 字段                        | 用途                                 |
| --------------------------- | ------------------------------------ |
| `canViewSharedArtifact`     | 决定该阶段内容是否只读               |
| `canApproveOrArbitrate`     | **裁决按钮是否可用**（唯一权威来源） |
| `isDirectDomainOwner`       | 显示「你是本阶段负责人」             |
| `isAdminOverride`           | 显示「管理员跨步骤权限」             |
| `requiredSpecialistRoles[]` | 显示「该由 XX 确认」                 |
| `denialReason`              | 禁用时的解释文案（直接展示）         |

---

## 5. 八个视图的「交互 → 请求 → 结果」全链路（7 业务视图 + `#/gallery` 组件画廊）

> 这张表就是 UI 重设计的行为契约。任何界面改动都必须能对上其中一行。

### V1 项目总览大厅 `ProjectsHubView` → hash `#/projects`

- **读**：`GET /api/state` → `allRunsList[]`（`RunListItemDto`：title / status / activeBranchId / currentStageId / completedStagesCount / totalStagesCount / commentsCount / createdAtIso）
- **交互**：点击项目卡 → `POST /api/runs/select {runId}` → 返回新 `DashboardStateDto`，路由跳 `#/workspace`
- **需要视觉化**：`completedStagesCount/totalStagesCount` 现在是一个百分比条 → 应改为**分阶段进度轨道**（每阶段一段，颜色即状态）

### V2 项目分步协同工作区 `WorkspaceView` → `#/workspace`（**主战场**）

- **读**：`run.snapshots[]`、`state.liveInteractionStream[]`、`notifications[]`、`negotiationLogs[]`、`teamComments[]`
- **交互 1**：点击流程图节点 → 就地展开 `StageNodePanel`（无网络请求，纯本地）
- **交互 2**：抽屉三入口 → 完整交付物（`ArtifactDetails`）/ 讨论过程（`AgentDiscussion`）/ 全部评论（`CommentCard`）
- **交互 3**：待办存在时 → 裁决：`POST /api/decisions {snapshotId, verdict, comment}`
- **交互 4**：无待办时 → 评论：`POST /api/comments {stageId, content}`
- **交互 5**：步骤查看器 ‹ › 步进 → 与流程图节点**双向联动高亮**（纯前端 state）
- **数据密度问题（核心痛点）**：一个 `stageContent.tsx` 里的动作分解是 3–4 条 `title + detail` 文字对，
  讨论过程是 2 个长气泡 + 1 个结论横幅，全部平铺在卡片里 → **这就是"文字过多且挤在一块儿"的根源**。

### V3 待办确认与方案拍板 `GateCenterView` → `#/gate-center`

- **读**：`notifications[]` + 每个通知的 `accessEvaluation` + `actionOptions[]`
- **交互**：`POST /api/decisions`，`verdict` 取自 `actionOptions[].verdict`
- **现状缺陷**：顶部有**一个全局共用**的"签核意见说明"输入框，勾选任意卡片都会把这段话写进去 —— 极易误签。
  **重设计必须改为每条决策独立的理由输入。**
- **现状缺陷 2**：`ARBITRATE_OPTION_A/B` 只渲染成两个按钮，**方案 A/B 的内容（`optionAProposal` / `optionBProposal`）
  只在 PD 阶段的讨论抽屉里可见** —— 拍板人看不到要拍的内容。**重设计必须把 A/B 方案做成对比卡。**

### V4 总管对话与版本历史 `DagSupervisorView` → `#/dag-supervisor`

- **交互**：`POST /api/supervisor/rollback {targetStageId?, dialogueInstruction}`
  → 服务端 `invokeSupervisorConversationalRollback` → **Fork 新分支**，旧分支快照 `SUPERSEDED`
- **读**：`run.branches[]` + `run.snapshots[]`（含 `SUPERSEDED`）+ `humanDecisions[]`
- **现状缺陷**：`BranchEvolution` 把分支渲染成**纵向分组列表**，完全看不出"分叉"的空间结构。
  **重设计应改为真正的分支泳道图（fork 曲线）。**

### V5 交付源码与测试沙箱 `SandboxExplorerView` → `#/sandbox-explorer`

- **读**：`sandboxWorkspaceSummary.generatedFiles[]`（relativePath / sizeBytes / previewSnippet）
- **交互 1**：点文件 → `GET /api/sandbox/file?path=` → `{relativePath, branchId, content}`
- **交互 2**：点「运行测试」→ `POST /api/sandbox/verify` → `{verification.executionLog, dashboardState}`（子进程真实执行）
- **现状缺陷**：用 `alert()` 弹结果；日志是纯文本 `<pre>`，无行类型着色；文件树无路径层级。
  **重设计：终端化日志 + 打字机逐行输出 + 文件树按目录分层。**

### V6 协同动态与团队经验库 `AuditRagView` → `#/audit-rag`

- **读**：`auditTimeline[]` + `negativeExperienceRecords[]`
- **交互 1**：`POST /api/rag/query {stageId, queryText}` → `matches[]`（含 `similarityScore`）
- **交互 2**：`POST /api/rag/ingest {stageId, lessonText}` → 写入向量库，`desensitizedLesson` 带 `[姓名 录入企业红线]` 前缀
- **现状缺陷**：`similarityScore` 只是印成一个文字 pill，**没有可视化相似度**。**重设计：相似度计量条。**

### V7 团队成员与流程设置 `AdminGovernanceView` → `#/admin-governance`

- **读**：`rbacContext.roster[]`、`workflowDslSummary`、`retrospectiveReport`
- **交互 1**：`POST /api/admin/governance {maxNegotiationTurns, highRiskScoreThreshold, allowSpecialistCrossStageRollback}`
  → 仅 `PROJECT_ADMIN` 生效，否则抛 `[RBAC...]` → 403
- **交互 2（已接入 A4）**：`POST /api/admin/model-baseline` → 两级模型端点 × 3 任务体检（非 admin 禁用，显示离线提示或两级报告结果）
- **现状缺陷 1**：权限矩阵是 **7 列大表格**（横向滚动、信息密集、无法一眼看出"谁能拍哪一步"）。
  **重设计：人员 × 阶段的二维点阵矩阵。**
- **现状缺陷 2**：KPI 是 4 个纯文字数字块（复用率 / 达成率 / 重试次数 / 节省比）。
  **重设计：微图表（环形 / 迷你柱 / 分布条）。**

### V8 Meridian UI 组件库画廊 `ComponentGalleryView` → `#/gallery`

- **作用**：独立全宽评估页面，用于并排校验 42 个 Meridian UI 组件 × 7 个分区 × 35 枚示例图标在双主题与三档密度下的表现（只读展示，不调业务 API）。

---

## 6. 现存 UI 的结构性问题清单（重设计的问题定义）

| #   | 问题                                                                                                                                            | 证据                                             | 设计对策                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| P1  | **信息平铺无层级**：所有区域都是同款 `panel`（白底 + 1px 边 + 同款阴影）                                                                        | `workbench.css` `.panel`                         | 改用 **发丝线（hairline）分区** + 单一抬升面，页面只保留 1–2 个浮起容器                                               |
| P2  | **文字拥挤**：12–13.5px 正文、长段落、无行高节奏、`<details>` 里套长文                                                                          | `.node-panel-summary`、`.artifact-subcard`       | 建立 **三级信息层**（扫描层 3s / 判断层 30s / 细节层钻取），细节全部进抽屉与折叠                                      |
| P3  | **视觉表达为零**：KPI 全是数字、进度是百分比条、风险是裸数字                                                                                    | `.kpi-box`、`.project-portfolio-card` 内联进度条 | 引入 **阶段进度轨道 / 风险环形仪表 / 相似度计量条 / 分叉泳道图 / 微图表**                                             |
| P4  | **动效近乎为零**：全站仅 4 个 keyframe（dash / glow / halo / slide-in）                                                                         | `workbench.css`                                  | 建立 **动效令牌表**（120/180/260/420ms + 3 种缓动），覆盖：流程推进、门禁脉冲、数字滚动、面板切换、抽屉弹性、列表入场 |
| P5  | **Emoji 充当图标**：🎯👑🔒💬⏳⚡🕘 与业务标签混排，字形随平台漂移                                                                               | 全文 `.pill` 内嵌 emoji                          | **全部换成内联 SVG 图标**（24×24 grid, stroke 1.5–2），emoji 仅保留为 Agent 头像这一处语义化用法                      |
| P6  | **无空/载入/错误态**：全是纯文字 div                                                                                                            | `.diagnosis-item`、`.feed-empty`                 | 补齐 **Empty / Loading(骨架) / Error / Permission-denied** 四态设计                                                   |
| P7  | **抽屉过窄**：500px 宽承载交付物 + 讨论 + 评论                                                                                                  | `.drawer-panel { width: min(500px, 92vw) }`      | 分级抽屉：窄（420 速览）/ 中（640 详情）/ 宽（960 审阅）                                                              |
| P8  | **工作区单列长滚动**：流程图 → 步骤查看器 → 阶段操作台垂直堆叠                                                                                  | `WorkspaceView`                                  | 三区布局：**导航轨 / 中央工作区 / 右侧常驻总管指挥舱**                                                                |
| P9  | **身份切换只是"按钮"，不改变界面表达**                                                                                                          | `Topbar` role chips                              | 身份切换后 **全局高亮该成员负责的阶段**（轨道上打标）、待办队列自动过滤                                               |
| P10 | **拍板看不到要拍的东西**                                                                                                                        | V3 缺陷 2                                        | 裁决台把 A/B 方案、风险拆解、Scope Diff 做成结构化决策卡                                                              |
| P11 | **共用签核意见框易误签**                                                                                                                        | V3 缺陷 1                                        | 每条决策独立理由输入                                                                                                  |
| P12 | **视觉资产无处安放**：所有业务"图形"都被压成文字                                                                                                | 全局                                             | 交付物类型、Agent 角色、风险等级、门禁状态各配一套专属图形语言                                                        |
| P13 | **窄屏下侧边栏盖住主内容**：`.app-sidebar` 是 `position:sticky; height:100vh`，而 `.app-shell` 在 ≤1024px 变单列 → 侧栏铺满整屏并遮挡下方工作区 | `workbench.css` `.app-shell` / `.app-sidebar`    | 重建为**图标导航轨 + 可折叠侧栏**；≤1280px 侧栏收为 72px 图标轨，不再参与文档流遮挡                                   |
| P14 | **无组件体系**：所有按钮/输入/表格/标签各写各的，视觉与交互全靠逐处手搓                                                                         | `src/ui/client/**` 全部组件                      | 引入 **Meridian UI 组件库**（`src/ui/kit/`），见 [`UI_LIBRARY_DECISION.md`](./UI_LIBRARY_DECISION.md)                 |

---

## 7. 新设计系统（Design System）规格

### 7.1 主题令牌

**深色为默认**（控制塔 / 长时间审阅场景），浅色为等价的完整实现（企业打印与投屏场景）。

> ⚠️ **v2 评审已改为「浅色为默认」**（第 7.1 节下方色板保持不变，仅默认值互换；深色仍作为等价完整实现保留）。

```
深色                                   浅色
--canvas   #0B0D12   页面底           #F4F5F7
--surface  #12151C   卡片面           #FFFFFF
--surface-2#171B24   次级填充         #F8F9FB
--surface-3#1E2430   三级/悬停        #EEF0F4
--line     #232A36   发丝线           #E3E6EB
--line-2   #333C4C   强线            #CBD1DA
--ink      #EEF1F6   主文字           #10131A
--ink-2    #A3ADBD   次文字           #4A5262
--ink-3    #6E7A8C   弱文字/轴标      #737C8C
```

语义色（深/浅各自校准，深色提亮 +2 档以保证对比度）：

| 语义   | 深色      | 浅色      | 用途                       |
| ------ | --------- | --------- | -------------------------- |
| brand  | `#5C7CFA` | `#2F54EB` | 主操作 / 进行中 / 当前步骤 |
| jade   | `#22C58B` | `#0E9F6E` | 已通过 / 成功 / 缓存命中   |
| amber  | `#F0A92B` | `#C77700` | 待裁决 / 协商中 / 高风险   |
| coral  | `#FF5C5C` | `#DC2B2B` | 驳回 / 违规 / 范围红线     |
| violet | `#A77BF5` | `#7B3FE4` | 总管 Agent / 管理员 / 分叉 |
| cyan   | `#22B8CF` | `#0E7490` | 自动放行 / 复用 / 辅助信息 |

### 7.2 字阶（严格三级，禁止同级混用）

| 角色    | 字号/行高 | 字重               | 用途                           |
| ------- | --------- | ------------------ | ------------------------------ |
| Display | 28/1.15   | 650                | 页面主标题、巨型数字           |
| Title   | 18/1.3    | 600                | 区块标题、卡片主标题           |
| Body    | 13.5/1.6  | 400                | 正文、说明                     |
| Label   | 11.5/1.4  | 600 + 0.04em 大写  | 字段名、轴标、分组标题         |
| Mono    | 12/1.5    | 400 `tabular-nums` | 所有 ID / 数值 / 代码 / 时间戳 |

**规则**：所有**数字**（分数、百分比、Token 数、时间）一律用等宽数字（`font-variant-numeric: tabular-nums`），
避免刷新时抖动。

### 7.3 间距 / 圆角 / 阴影

- 间距 4px 基准：`4 8 12 16 20 24 32 40 56`
- 圆角：`6` 微控件 / `10` 卡片 / `14` 大容器 / `999` 药丸
- 阴影（深色下用内描边代替投影）：`--elev-1` 1px 发丝边 + `inset 0 1px 0 rgba(255,255,255,.03)`

### 7.4 动效令牌

| 令牌            | 时长  | 缓动                           | 用途                             |
| --------------- | ----- | ------------------------------ | -------------------------------- |
| `--dur-1`       | 120ms | `ease-out`                     | 按钮/输入态、hover 变色          |
| `--dur-2`       | 180ms | `cubic-bezier(.22,1,.36,1)`    | 卡片展开、tab 切换、tooltip      |
| `--dur-3`       | 260ms | `cubic-bezier(.22,1,.36,1)`    | 抽屉滑入、模态、页面切换         |
| `--dur-4`       | 420ms | `cubic-bezier(.4,0,.2,1)`      | 流程推进、数字滚动、分叉曲线生长 |
| `--ease-spring` | —     | `cubic-bezier(.34,1.56,.64,1)` | 门禁拍板成功、审批通过           |

**强制降级**：`@media (prefers-reduced-motion: reduce)` 关闭所有动画与循环动效。

### 7.5 图标规范

- 24×24 viewBox，`stroke="currentColor"`，`stroke-width: 1.6`，`round` 端点，`fill:none`。
- 尺寸档：`14`（内联文本）/ `16`（列表、按钮）/ `20`（导航、卡片标题）/ `28`（状态大图标）/ `40`（Agent 头像）。
- 禁止 emoji 作为 UI 图标（仅 Agent 角色头像允许使用业务语义色 + SVG 几何标识）。

---

## 8. 新版信息架构（7 个视图 → 4 个一级入口 + 3 个二级）

```
一级导航轨（72px，hover 展开至 236px）
├─ 项目         总览大厅
├─ 协同  ────────────────
│  ├─ 工作台（默认）      ← 主页：流水线脊柱 + 当前阶段 + 实时流 + 右侧总管舱
│  ├─ 裁决中心           ← 二级：待我裁决 / 全部 / 冲突 / 范围告警
│  └─ 版本与分支         ← 二级
├─ 工程  ────────────────
│  ├─ 沙箱与测试
│  └─ 审计与经验库
└─ 治理  ────────────────
     └─ 成员与流程规则
```

**常驻右坞（340px，可折叠为 56px 图标条）**：总管 Agent 指挥舱 —— 自然语言回退输入、
最近总管动作、监听状态脉冲。跨视图常驻（符合原始设计文档"悬浮或侧边常驻的全局对话窗口"）。

---

## 9. 设计稿覆盖清单（本次交付）

设计稿文件：

- 原型：`design/ui-prototype.html`（单文件、零外部依赖，可直接浏览器打开）
- 逐屏截图：`design/screens/M1–M7*.png`
- 使用说明与落地映射：`design/README.md`

| 稿  | 视图           | 核心视觉资产                                                                                              |
| --- | -------------- | --------------------------------------------------------------------------------------------------------- |
| M1  | 项目总览大厅   | 阶段进度轨道（分段状态色）、项目卡、KPI 微图表                                                            |
| M2  | 项目工作台     | **流水线脊柱**（阶段节点 + 门禁菱形 + 协商弧 + 总管轨）、**Agent 交付审阅面板**、可下钻事件链、右侧视角坞 |
| M3  | 裁决中心       | 队列 + **A/B 方案对比决策卡** + 风险拆解 + Scope Diff 红线 + 独立理由输入 + 内嵌真实交付物                |
| M4  | 版本与分支     | **分叉泳道图**（fork 曲线）+ 决策时间轴轨                                                                 |
| M5  | 沙箱与测试     | 目录文件树、源码阅读器（行号）、终端化测试日志（打字机）                                                  |
| M6  | 审计与经验库   | 审计事件轨（类型化节点）+ **相似度计量条**                                                                |
| M7  | 成员与流程规则 | **人员 × 阶段点阵权限矩阵** + 阈值滑杆 + KPI 微图表                                                       |

### 9.1 v2 新增

| 稿                                     | 说明                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `screens/M2-项目工作台-员工视角.png`   | 林工 (PD/UX) 视角：L1 摘要节点 + 本人阶段 L2 完整审阅 + 右坞换成「我的工作台」 |
| `screens/M3-裁决中心-员工视角.png`     | 林工视角：可裁决项高亮，他人项只读置灰                                         |
| `screens/M2-项目工作台-管理员视角.png` | 王总管视角：L3 全局态势，审阅面板全量展开                                      |

---

## 10. 改造时必须保持的契约（不可破坏）

1. `WorkbenchApiClient` 的 15 个公开 API/SSE 方法（14 个 REST 方法含 A4 `runModelBaseline` + `subscribeRealtimeEventStream`；另有 `getActiveActorUserId`/`setActiveActorUserId` 与 `getActiveRunId`/`setActiveRunId`）与 `ApiResponseEnvelope` 拆包逻辑不变（后续需补 `POST /api/runs/retry`、`extraTokenBudget` 与 `/api/auth/*`）。
2. `types.ts` 的 DTO 定义不变（只允许新增可选字段，不允许改字段语义）。
3. `stagePipelineOrder` 动态长度 —— 所有阶段轨道必须按数组长度渲染，不能写死 6。
4. RBAC 判定**只读** `accessEvaluation.canApproveOrArbitrate`，禁止前端自行推断权限。
5. SSE 当前在前端仍以整树 `state_updated` 替换，`actorId` 变化时必须重建 `EventSource`（后端另已推送 `run_event`/`user_notification` 供后续增量订阅）。
6. 无外部 CDN 依赖（内网私有化部署硬约束）。
7. 主题通过 `document.documentElement.dataset.theme` 切换（服务端不感知，纯前端）；**默认 `light`**（v2 评审结论），深色为等价完整实现。
8. `prefers-reduced-motion` 降级必须保留。
9. 现有 `npm run check`（双端 typecheck + eslint + prettier + 全库测试：2026-11-22 基线为 19 项，当前后端测试已演进至 169 项 / 48 套件 / 28 文件，165 过 / 4 既有 skip；注：本地执行 `npm run typecheck:frontend` / `build:ui` 需先安装 `package.json` 已声明的 `react`/`react-dom`/`@types/react` 依赖，见 `BACKEND_TODO.md` §六）必须全绿。
10. 产物仍由 `esbuild` 打包为 `src/ui/dist/main.js`，不引入 Vite/webpack 等新构建链。

---

# 第二轮：交互模型与视角分级（v2 增补）

> 触发原因：v1 设计稿评审反馈三件事 ——
> ① 主题定浅色；② 员工视角不该看到与自身无关的大量细节；
> ③ **"每一个环节的决议，从 Agent 拿出来的内容到底在哪儿？我怎么样去看得到的结论和方案？"**
>
> 第 ③ 条查下去发现是一个**系统级问题，不是 UI 问题**，详见 §11。

---

## 11. 核心问题诊断：Agent 的产出到底在哪儿

### 11.1 结论先说

**真实数据一直都在后端下发，但现有前端没有用它们 —— 而是自己编了一套。**

`src/ui/client/lib/stageContent.tsx` 里的两张静态表是**前端硬编码的虚构内容**：

| 常量                | 内容                                                         | 性质                                                      |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| `ACTIONS_BY_STAGE`  | 每个阶段 3–4 条 "Agent 执行动作分解"                         | **编造**。后端从未产出过这个结构                          |
| `STAGE_DISCUSSIONS` | 每个阶段两段 "PM Agent：… / PD Agent：…" 对话气泡 + 结论横幅 | **编造**。无论真实协商是否发生，UI 都会显示同样格式的对话 |

所以用户看到"Agent 说了什么"时，看到的是**前端写死的台词**，与该次运行真实发生的事无关。
这直接解释了三个现象：

1. "我无法知道 Agent 到底做了什么东西" —— 因为展示的不是真实产出。
2. "裁决中心信息量太少" —— 裁决卡只有 `notification.message` 一句话 + 几个按钮，**没有承载交付物**。
3. "实时活动流没有具体细节" —— `detailPayload` 有结构化数据，但只以一行 `headline` 呈现，无法下钻。

### 11.2 后端真实存在的三类「Agent 内容」

| 载体           | 字段                                                                                                 | 回答的问题                       | 现状                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| **交付物本体** | `snapshot.artifactDetails`（= artifact 对象全量）                                                    | Agent **做了什么**               | 后端有、前端有渲染，但只覆盖 PRD/UI/技术/代码/QA 五类且信息被压缩 |
| **协商记录**   | `negotiationLogs[]`：`challengePoint` / `responseResolution` / `optionAProposal` / `optionBProposal` | Agent **怎么说的**、**分歧在哪** | 后端有，**只有 PD↔PM 与 QA↔Eng 真实产生**                         |
| **过程事件**   | `liveInteractionStream[].detailPayload`                                                              | Agent **当时经历了什么**         | 后端有，**前端只渲染 headline，detailPayload 被丢弃**             |

各阶段 `artifactDetails` 的真实字段（来自 `src/domain/contracts.ts`）：

| artifactType                            | 专属字段                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRD_ARTIFACT_CONTRACT`                 | `userStories[{reqId, story, acceptanceCriteria[]}]`、`trackingPlanEvents[{eventName, triggerCondition, properties[]}]`、`nonFunctionalConstraints[]` |
| `UI_DESIGN_ARTIFACT_CONTRACT`           | `componentMappings[{reqId, designSystemComponent, interactionStates[]}]`、`accessibilityChecklist[]`、**`designChallengeNote`（Agent 自述）**        |
| `TECH_SPEC_ARTIFACT_CONTRACT`           | `apiContracts[{method, endpoint, requestSchema, responseSchema}]`、`databaseDdlStatements[]`、`architecturePatternsUsed[]`、`declaredRiskLevel`      |
| `CODE_IMPLEMENTATION_ARTIFACT_CONTRACT` | `gitWorktreeBranch`、`modifiedFiles[{filePath, className, designPattern, linesChanged}]`、`selfTestPassed`                                           |
| `QA_VERIFICATION_ARTIFACT_CONTRACT`     | `testSuitesExecuted[{suiteName, totalCases, passedCases, coveragePercent}]`、`securityIssuesFound`、`allAcceptanceCriteriaMet`                       |
| `DATA_ANALYSIS_ARTIFACT_CONTRACT`       | `verifiedTrackingEvents[]`、`projectedMetrics[{metricName, baselineValue, targetValue}]`                                                             |

所有 artifact 共用：`contractType` / `stageId` / `producerRole` / `schemaVersion` / `summary` / `coreRequirementIds`。

### 11.3 过程事件的真实 detailPayload

来自 `AbstractWorkerAgent.broadcastProgress` 与 `BoundedNegotiationMediator`：

| 生命周期             | detailPayload                                                            | 展示价值                         |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| `RECOGNIZING_INTENT` | `{ intentCode, historicalLessonsLoaded }`                                | 用了哪套经验、注入了几条历史教训 |
| `CACHE_HIT`          | `{ cacheLayer, savedTokens }`                                            | 复用了什么、省了多少 Token       |
| `EXECUTING`          | `{ model, tier }`                                                        | 哪个模型、哪条路由（私有/高阶）  |
| `RETRYING`           | `{ attemptIndex, retryReasons }`                                         | 失败原因与自愈轨迹               |
| `NEGOTIATING`        | `{ turnIndex, maxTurns, challengePoint, responseResolution, escalated }` | **质询与响应的原文**             |
| `PENDING_HUMAN_GATE` | 后端未填                                                                 | 门禁快照与风险分（需补，见 G2）  |

### 11.4 后端契约缺口（需要后端配合，非前端可单独解决）

| #      | 缺口                                                                                                                                                         | 影响                                                                                          | 建议                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | **只有 PD Agent 有 `designChallengeNote`**（Agent 自述 / 主动提出的质疑）。PM / TechLead / Engineer / QA / DA 的 artifact **没有任何「为什么这么做」的字段** | 裁决人在步骤 1/3a/3b/4 拍板时，看不到 Agent 的理由与权衡，只能看到结构化结果 + 一句 `summary` | **在 `ArtifactContract` 基类增加可选 `agentRationale: string` 与 `keyDecisions: {decision, rationale, tradeoffs[]}[]`**，由各 Agent 子类填充 |
| **G2** | `PENDING_HUMAN_GATE` / `APPROVED` 等终态事件**没有 `detailPayload`**                                                                                         | 裁决区拿不到「该快照的风险分、门禁动作、被删需求」的机器可读副本，只能从 snapshot 反查        | 在挂起/通过时广播事件时带上 `{ snapshotId, riskScore, riskLevel, gateAction, droppedRequirementIds }`                                        |
| **G3** | `liveInteractionStream` 只保留**最近 40 条**（`slice(-40).reverse()`）                                                                                       | 长项目早期事件不可回溯                                                                        | 增加按 stageId / 时间范围的分页查询，或保留快照级的完整事件链                                                                                |
| **G4** | `negotiationLogs` 仅在 PD↔PM、QA↔Eng 产生；**其它阶段没有任何跨角色讨论记录**                                                                                | 步骤 1/3a 的「Agent 讨论过程」在数据上是空的                                                  | 扩展 `BoundedNegotiationMediator` 的调用点，或在 artifact 内增加 `peerReview[]`                                                              |
| **G5** | `artifactDetails` 是 `Record<string, unknown>`，**无运行时 schema**                                                                                          | 前端只能靠 `artifactType` 做字符串判断，字段缺失时静默降级                                    | 前端为六类 artifact 各写一个解析器 + 缺字段兜底 UI（不改变后端契约）                                                                         |
| **G6** | 没有「Agent 自述 / 结论陈述」的一等公民字段                                                                                                                  | 裁决时人需要读一段「Agent 的结论 + 理由」                                                     | 采纳 G1 的同时，把 `artifactSummary` 升级为 `{ headline, rationale, caveats[] }` 结构                                                        |

> **改造顺序建议**：G1 / G2 是「让人看懂 Agent」的关键，值得后端先补；
> G5 可由前端独立完成（解析器 + 兜底）；G3 / G4 属于二期范围。

---

## 12. 视角分级信息模型（L1 / L2 / L3）

### 12.1 问题

v1 原型里，所有角色看到的界面**完全一样**。管理员王总管看到的是全局态势，员工林工看到的也是同一份全局态势 —— 但林工只关心自己那一步。
这既浪费了林工的注意力，也让真正需要他做判断的内容被淹没。

### 12.2 三级信息密度

| 级别          | 谁能看               | 看什么                                                                          | 界面表达                                                                                              |
| ------------- | -------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **L1 摘要级** | 所有人（对他人阶段） | `artifactSummary` 一句话 + 阶段状态 + 责任人 + 是否有待你参与                   | 流水线节点淡出、隐藏 Agent 头像、状态行只留结论（如「人工签核通过 · 陈工 (PM)」）；右坞折叠成一行清单 |
| **L2 评审级** | 阶段负责人 + 管理员  | **完整交付物本体** + 推演过程（事件链可下钻）+ 真实协商记录 + 团队评论 + 裁决区 | 流水线节点高亮；审阅面板完整展开；裁决按钮可用                                                        |
| **L3 管理级** | 仅 `PROJECT_ADMIN`   | 全局 KPI + 分支与版本演化 + 跨阶段拍板 + 流程规则 + 全部阶段的 L2               | 顶部 KPI 条、全局分支态势、规则设置                                                                   |

**判定来源（全部来自后端，不在前端推断）：**

| 判定               | 字段                                                         |
| ------------------ | ------------------------------------------------------------ |
| 该阶段是否 L2      | `rbacContext.stageAccessMatrix[stageId].isDirectDomainOwner` |
| 是否可越级查看     | `...isAdminOverride`                                         |
| 裁决按钮是否可用   | `...canApproveOrArbitrate`                                   |
| 不可用时的解释文案 | `...denialReason`                                            |
| 我负责哪些阶段     | `rbacContext.currentUser.ownedStageIds`                      |

### 12.3 视角切换后的具体变化

| 区域         | 管理员（L3）                                              | 员工（L1 + L2）                                                               |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 顶栏视角条   | 「L3 全局态势」                                           | 「L2 我负责的阶段 · 完整交付物 + 证据链 + 裁决」+「L1 其他阶段 · 仅结论摘要」 |
| 流水线脊柱   | 6 个节点全 L2                                             | 本人阶段高亮 L2，其余节点退化为 L1 摘要节点                                   |
| 右侧常驻坞   | **总管 Agent 指挥舱**：全局卡点 / 总管最近动作 / 分支快照 | **我的工作台**：我的待办 / 我负责的阶段 / 其他阶段（仅结论）                  |
| 裁决中心队列 | 全部待办（管理员可跨步骤拍板）                            | 仅我可裁决的项可展开；他人项置灰只读并标注归属                                |
| 审阅面板     | 完整展开                                                  | 他人阶段 → 模糊 + 锁定说明（「仅阶段负责人与管理员开放」），本人阶段 → 完整   |

---

## 13. 「Agent 交付审阅面板」交互模型（核心组件）

### 13.1 设计原则

人介入的每一个点，都必须能回答三个问题，且顺序不可颠倒：

1. **Agent 做了什么？** → 交付物本体（结构化契约 + Agent 自述）
2. **它凭什么这么做？** → 推演过程（事件链 + 协商原文 + 风险拆解）
3. **我怎么拍板 / 不同意怎么办？** → 裁决区（红线 + 理由 + 动作）

> **信息必须来自后端真实字段。前端不得再出现任何「编造对话」。**

### 13.2 面板结构

```
┌──────────────────────────────────────────────────────────────────────┐
│ 头：Agent 身份 · artifactType · snapshotId · 模型 · 责任人 · 状态标签  │
├───────────────────────────────────────────┬──────────────────────────┤
│ 主区（三个标签页）                          │ 裁决区（常驻右栏）          │
│ ① Agent 交付了什么                        │  业务风险评估（环形 + 原因） │
│    · artifactSummary 一句话                │  Scope Diff 红线横幅        │
│    · 类型化结构化卡片（按 artifactType）   │  门禁动作说明              │
│    · **Agent 自述**（designChallengeNote） │  裁决理由输入框            │
│ ② 它怎么推演出来的                        │  通过 / 驳回 / 拍板 A/B     │
│    · 事件链（每条可展开 detailPayload）     │                          │
│    · 真实协商记录（质询 / 响应 / 方案 A/B）│                          │
│ ③ 团队意见（评论流 + 发布框）              │                          │
└───────────────────────────────────────────┴──────────────────────────┘
```

### 13.3 事件链下钻规范

- 每条事件显示：生命周期色点 + `headline` + `lifecycleState` + 时间戳 + 分支。
- **点击展开** `detailPayload`：键值表呈现，值按类型渲染（字符串 / 数字 / 布尔 / 对象 JSON）。
- 事件链末尾的 `PENDING_HUMAN_GATE` 事件额外挂载**该快照的交付物入口**（「查看该步骤交付物 →」），
  形成「事件 → 产出」的闭环，避免「看过程看不到结果」。
- 事件按阶段分组，支持按阶段过滤。

### 13.4 裁决区规范（修正 v1 的两个缺陷）

| v1 缺陷                                                | v2 方案                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶部一个**全局共用**的签核意见输入框，勾任意卡片都写入 | **每条决策独立**的理由输入框，紧贴该条裁决区                                                                                                          |
| `ARBITRATE_OPTION_A/B` 只有按钮，**看不到要拍的内容**  | A/B 方案以**对比卡**呈现：方案全文（后端原文）+ 工期/风险分/新增组件 + 优缺点清单，方案全文取自 `negotiationLogs[].optionAProposal / optionBProposal` |

---

## 14. v2 改造落地清单（后端 + 前端）

> ✅ 以下后端 G1–G4/G6 与前端 v2 改造项已于第二十四轮（[`P2_2_MERIDIAN_UI_V2_MIGRATION.md`](./P2_2_MERIDIAN_UI_V2_MIGRATION.md)）全部落地并通过 `tests/ui-v2-contracts.spec.ts` 与实时浏览器验收。

### 后端（已全部完成 G1 / G2 / G3 / G4 / G6）

- [x] G1：`ArtifactContract` 基类与 6 个阶段契约增加 `agentRationale?: string`、`keyDecisions?: {decision, rationale, tradeoffs}[]` 并为 6 大 Agent 填充（PD 保留 `designChallengeNote` 向后兼容）
- [x] G2：挂起 / 自动放行 / 通过 / 驳回时广播的事件补 `detailPayload`（snapshotId / riskScore / riskLevel / gateAction / droppedRequirementIds）
- [x] G3：`liveInteractionStream` 支持按阶段与时间范围分页（`GET /api/events/history` + `WorkflowEventBus.getEventHistoryPage`）
- [x] G4：扩展 `BoundedNegotiationMediator` 调用点，让步骤 1 / 3a 可产生真实协商记录（DSL 声明或 `enableExtendedPeerNegotiation`）
- [x] G6：`artifactSummary` 升级为结构化 `structuredSummary: { headline, rationale, caveats[] }`（保留旧 `summary` / `artifactSummary` 字符串兼容）

### 前端（`src/ui/client/**`，已全部完成）

- [x] **删除 `lib/stageContent.tsx` 中的 `ACTIONS_BY_STAGE` 与 `STAGE_DISCUSSIONS`**（编造内容），改为基于真实 `structuredSummary`、`artifactDetails`、事件链与协商记录渲染
- [x] 新增 `components/AgentDeliverableReview.tsx`：审阅面板（交付物 / 推演过程 / 团队评论 + 裁决区）
- [x] 新增 `lib/artifactParsers.ts`：六类 artifact 的运行时解析器 + 缺字段兜底（G5）
- [x] 新增 `lib/perspective.ts`：视角分级状态机（L1/L2/L3），单一数据源驱动全站
- [x] `views/GateCenterView.tsx`：改为队列 + 审阅面板双栏；移除全局共用意见框；补 A/B 对比卡
- [x] `views/WorkspaceView.tsx`：脊柱 + 审阅面板 + 事件链（每条可下钻）
- [x] `components/Topbar.tsx`：成员视角切换器读 `rbacContext.roster` 并接入视角状态机 `StatusChip`
- [x] `components/AgentFlowCanvas.tsx`：脊柱支持 L1 摘要节点形态，节点数按 `stagePipelineOrder` 动态
- [x] `components/DetailDrawer.tsx`：分级抽屉（420 速览 / 640 详情 / 960 审阅）
- [x] `styles/workbench.css`：对齐 Meridian v2 令牌与布局层（浅色默认 + 窄视口响应式修复）
- [x] `WorkbenchApiClient.ts`：提供 `GET /api/workflows/templates` 与 `GET /api/events/history` 封装
