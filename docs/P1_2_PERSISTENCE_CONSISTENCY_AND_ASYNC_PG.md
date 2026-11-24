# `P1-2`：PG / JSON 双模式持久化一致性与 `psql` 阻塞优化变更说明

> 对应总编排步骤：Step 8（`P1-2`）  
> 状态：**已验收完成**（2026-11-24）  
> 前置关联：[`REMEDIATION_ORCHESTRATION_PLAN.md`](./REMEDIATION_ORCHESTRATION_PLAN.md)、[`BACKEND_TODO.md`](./BACKEND_TODO.md) §六 `P1-2`

---

## 一、问题背景与根因分析

在 `AUDIT-8 / D2` 与 `F1/F2` 初版落地后，系统虽然具备了 JSON 与 PostgreSQL 双驱动能力，但在重启一致性、纯 PG 无状态容器运行、向量维度兼容及高并发鉴权性能四个方面仍存在显著断点：

1. **认证客户端元数据缺失**：`deploy/init-pgvector-schema.sql` 中 `auth_sessions.ip` / `user_agent` 与 `auth_login_audit.ip` 已建列，但 `WorkbenchServer`、`SessionService` 与 `UserStore` 在登录、替身切换与会话续期时未采集或写入这些列。
2. **双轨外键未赋值**：`workflow_runs.created_by_user_id` 与 `human_decisions.reviewer_user_id` 虽已建列，但 `WorkflowRunState`、`HumanDecisionRecord`、`PersistenceRepository`、`PgPersistenceDriver` 及 `StateReconstructor` 未传值入库或回读重建。
3. **PG 缺表导致纯容器重启丢失运行态**：PG 端仅有前 10 张表，缺少 `notifications`、`live_events`、`audit_entries` 与运行时配置/复盘存储表；在无本地 `.runtime-data/` 挂载的纯 PG 容器环境中重启会丢失待审门禁通知卡、实时事件流、审计时间线、`updateAdminGovernanceConfig()` 动态参数、`PromptCacheManager` 统计计数及 `IntentFulfillmentTracker` 追踪记录。
4. **JSON 会话与登录审计仅驻留内存**：`JsonUserStore` 仅将 `users` 写入 `users.json`，会话（`sessions`）与登录审计（`loginAudit`）均在进程内存中，单机 JSON 模式重启后已登录令牌与安全审计日志全部丢失。
5. **RAG 向量维度冲突风险**：`rejected_history_rag.embedding` 固定定义为 `vector(1536)`，而默认本地 embedding 模型 `bge-m3-local` 输出 1024 维向量，升级入库时会在 PG 触发维度不匹配整事务回滚。
6. **同步 `execFileSync('psql')` 阻塞事件循环**：每次请求鉴权在 `WorkbenchServer` 中先后调用 `validate()` 与 `isImpersonating()`，触发两次同步 `psql` 进程孵化，写盘同步也同步阻塞主线程。

---

## 二、修复设计与实现清单

### 1. PostgreSQL 16 + `pgvector` Schema 扩展（`deploy/init-pgvector-schema.sql`）

- 将 `rejected_history_rag.embedding` 调整为变长 `vector NOT NULL`（兼容 PG 16 + `pgvector >= 0.5` 同列共存 1024 维 `bge-m3-local` 与 1536 维模型向量），新增 `embedding_dim INT NOT NULL DEFAULT 1536` 与 `embedding_source VARCHAR(32) NOT NULL DEFAULT 'HASH_FALLBACK'`，并提供幂等迁移 `ALTER TABLE` 语句。
- 新增 4 张表与索引（全库扩充为 14 张业务/用户/审计运行态表）：
  - `notifications`（+ `idx_notifications_run`）：持久化人机门禁与协商通知卡及已处理（`resolved`）状态；
  - `live_events`（+ `idx_live_events_run`）：持久化 Agent 实时交互事件流；
  - `audit_entries`（+ `idx_audit_entries_run`）：持久化不可变审计时间线；
  - `system_runtime_state`：以 `state_key`（`governance_config`、`cache_telemetry`、`intent_traces`）持久化动态治理参数、缓存遥测计数与意图达成追踪记录。

### 2. RAG 向量维数可配置与 PG 混合兼容（`src/engine/NegativeExperienceRagEngine.ts`）

- 新增 `NegativeExperienceRagEngine.resolveDefaultVectorDim()`：读取 `process.env.RAG_VECTOR_DIM`（合法整数 `>= 8`），未设置时保持默认 `1536`（完全向后兼容既有行为）。
- `computeNormalizedEmbedding(text, vectorDim?)` 与构造函数均支持自定义 `vectorDim`，并修复同毫秒多实例写入 `RAG-LESSON-*` 潜在 ID 碰撞问题（附加随机短后缀）。

### 3. 领域双轨外键与遥测/追踪序列化（`src/domain/models.ts`、`src/engine/DagWorkflowStateEngine.ts`、`src/telemetry/PromptCacheManager.ts`、`src/telemetry/IntentFulfillmentTracker.ts`）

- `HumanDecisionRecord` 新增可选只读属性 `reviewerUserId?: string`（同步完善 `fromJSON()`）；`WorkflowRunState` 与 `DagWorkflowStateEngine.createRun()` 新增可选 `createdByUserId?: string`。
- `PromptCacheManager` 新增导出 `PersistedCacheTelemetrySnapshot` 与 `restoreTelemetryCounters()` 方法，重启后无损恢复 9 项缓存命中/节省 Token/绕过统计计数。
- `IntentExecutionTraceRecord` 支持可选 `timestampIso`、新增 `toSerializableRecord()` 与 `fromJSON()`；`IntentFulfillmentTracker` 新增幂等 `restoreTrace()`（按 `traceId` 去重）。

### 4. 双模式快照契约与恢复编排（`src/engine/PersistenceRepository.ts`、`src/engine/pg/StateReconstructor.ts`）

- `PersistedRunRecord` 新增 `createdByUserId`；导出 `PersistedGovernanceConfig` 与 `PersistedCacheTelemetry`；`PersistedLedgerSnapshot` 与 `persistFullState()` 扩展支持 `governanceConfig`、`cacheTelemetry`、`intentTraces`，`loadPersistedSnapshot()` 对上述字段与 `notifications`/`liveEvents`/`teamComments`/`auditEntries` 统一执行 PG 优先与 JSON 兜底合入。
- `StateReconstructor` 扩展 `RestoreTargets`（`cacheManager`、`fulfillmentTracker`、`restoreGovernanceConfig`），在 `restore()` 与 `restoreRun()` 中完成全量还原。

### 5. `PgPersistenceDriver` 全表读写、维数可选对齐与非阻塞合并写入（`src/engine/pg/PgPersistenceDriver.ts`）

- 新增 `normalizeEmbeddingForPg(embedding, pinnedDim?)`：未设置 `PG_RAG_VECTOR_DIM` 或 `pinnedDim` 时保留原向量长度以利用 PG 变长 `vector`；显式指定固定维度时自动零填充或截断并重做 L2 归一化。
- `buildPgUpsertSql()` 在列尾追加双轨外键 `workflow_runs.created_by_user_id`、`human_decisions.reviewer_user_id`、`rejected_history_rag.embedding_dim`/`embedding_source`，并生成 `notifications`、`live_events`、`audit_entries` 与 `system_runtime_state` 的 UPSERT 语句。
- `loadFullState()` 优先查询 `FULL_LOAD_QUERY_EXTENDED`（遇到旧库缺列/缺表报错时自动降级 `FULL_LOAD_QUERY_WITH_COMMENTS` → `FULL_LOAD_QUERY_CORE`），完整反序列化全表与双轨字段。
- 默认 `psql` 模式及注入 `asyncSqlExecutor` 时启用 **非阻塞异步合并队列**（`execFile` 异步子进程 + `pendingSyncSql` 覆盖合并 + `flushPendingWrites()`），连续高并发 `saveFullState()` 不堵塞事件循环且自动合并跳过中间陈旧状态。

### 6. `JsonUserStore` 落盘与 `PgUserStore` 缓存/节流/瞬时驱逐（`src/server/auth/UserStore.ts`、`src/server/auth/SessionService.ts`）

- **`JsonUserStore`**：在 `users.json` 同目录同步持久化 `auth-sessions.json`（写入时自动清理过期会话）与 `auth-login-audit.jsonl`（Append-Only，重启自动恢复并延续自增 `id`）。
- **`PgUserStore`**：
  - 增加 `sessionCache` 内存短时 TTL 缓存（默认 `PG_SESSION_CACHE_TTL_MS=15000`）与 `touchSession` 写节流（默认 `PG_SESSION_TOUCH_THROTTLE_MS=60000`，仅首次或超窗口或 IP/UA 变化时落库），消除热路径冗余 `psql` 查询。
  - 引入异步串行写队列（默认真 `psql` 模式走 `execFile` + `flushPendingWrites()`），并引入 **`inFlightDeletedTokens` 与 `pendingUserRevocations` 阴性墓碑机制**：在 `logout()` / 改密踢人 / 停用用户触发后，异步 `DELETE` 尚未提交期间，即时拦截任何缓存在外回源读到的旧会话行，杜绝异步删除窗口期吊销失效竞态。
- **`SessionService`**：新增 `AuthClientMetadata`（`ip` / `userAgent` 安全截断至 64 / 255 字符）并透传至 `login`、`validateWithMeta`、`actAs`、`exitActAs` 与 `recordLoginAudit`；新增 `validateWithMeta()` 实现单次会话查询同时返回 `user` 与 `impersonatedBy`。

### 7. 总控编排与 HTTP 端到端接线（`src/engine/WorkflowOrchestratorFacade.ts`、`src/server/WorkbenchServer.ts`）

- `WorkbenchServer` 新增 `extractClientMetadata(req)`（解析 `X-Forwarded-For` 首跳与 `User-Agent` 并复用至 `enforceRateLimit`），全局鉴权入口改用单次 `sessionService.validateWithMeta()`，立项时透传 `initiatorUserId`。
- `WorkflowOrchestratorFacade` 在立项、门禁签核、熔断重试、总管回退中透传并记录 `createdByUserId` / `reviewerUserId`；在 `syncPersistenceState()` 与 `restoreFromPersistence()` 完整闭环 `governanceConfig`、`cacheTelemetry` 与 `intentTraces`。

---

## 三、验收标准与测试结果

| 验收维度                                         | 覆盖测试文件与用例                                    | 实测结果                                                                                              |
| :----------------------------------------------- | :---------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Schema 14 表 + 变长 `vector`                     | `tests/pg-persistence-driver.spec.ts` Test 4          | ✅ 通过（断言 14 张表、`embedding vector NOT NULL`、`embedding_dim`/`embedding_source` 与双轨外键列） |
| 纯 PG 删除 JSON + WAL 重启恢复                   | `tests/pg-persistence-driver.spec.ts` Test 6          | ✅ 通过（删光本地 JSON 与 WAL 后从 PG 完整还原通知、事件、审计、外键、治理参数、缓存与追踪）          |
| 1024/1536 维混存与对齐                           | `tests/pg-persistence-driver.spec.ts` Test 7          | ✅ 通过（`RAG_VECTOR_DIM=1024` 与 1536 同库共存；`pinnedVectorDim` 对齐无报错）                       |
| `JsonUserStore` 会话与审计落盘                   | `tests/pg-persistence-driver.spec.ts` Test 8          | ✅ 通过（会话 IP/UA、登录审计与登出吊销跨重启精确保持）                                               |
| `PgUserStore` TTL 缓存 + 瞬时驱逐 + 异步合并队列 | `tests/pg-persistence-driver.spec.ts` Test 9          | ✅ 通过（5 次连续校验 0 PG 读写、登出异步窗口内瞬时拦截、`PgPersistenceDriver` 连发 3 包合并为 2 次） |
| JSON 模式重启治理配置/遥测恢复                   | `tests/state-reconstructor.spec.ts` Test 6            | ✅ 通过                                                                                               |
| HTTP 登录与审计 IP / UA 采集                     | `tests/session-service.spec.ts` HTTP Test 4           | ✅ 通过                                                                                               |
| 全量前端构建、格式化、类型检查、Lint 与单测      | `npm run build:ui && npm run format && npm run check` | ✅ **192 tests / 53 suites（188 pass / 4 既有 skip / 0 fail）**                                       |
