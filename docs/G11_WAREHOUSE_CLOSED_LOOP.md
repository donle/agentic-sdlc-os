# G11 实现文档：Stage 5 数仓闭环（mock 可验证范围）

> 对应 `BACKEND_TODO_DESIGN.md` §M3 "G11 Stage 5 闭环"，2026-11-23 完成。
> 范围说明：真实数仓凭证未接入（用户决策：H 系列同类外部接入一并挂起），本实现交付**可完整验证的闭环机制**——
> 只读查询通道 + 白名单模板 + 降级链；真实数仓只需配 env 即可接入，零代码改动。

## 问题背景

DA Agent 的 `analytics_metrics`（required）此前只有确定性 stub（G10）。G11 打通"真实数仓查询 → DA prompt 注入"的
通道；无数仓时保持投影报告并**显式标注**（不伪装）。

## 实现方案

### 1. WarehouseQueryProvider（新增 `src/agents/context/WarehouseQueryProvider.ts`）

实现 `ContextProvider`（`analytics_metrics`）：

- **只读 SQL 白名单模板**（唯一可执行的两个查询，业务输入零拼接）：
  - `metrics_by_requirement`：按 runId 查指标基线（`pipeline_metric_baselines`）
  - `tracking_events_coverage`：按 runId 查埋点核验状态（`tracking_event_verification`）
- **三层只读防线**：①每条查询前置 `SET default_transaction_read_only = on`；②模板白名单（模板名不在表内即抛错）；③runId 字符白名单净化（引号/分号等一律替换为下划线，字面量无法逃逸）+ 64 字符截断。
- **查询 runner 注入口**（测试零 psql 依赖）；默认 runner = `psql --csv` CLI（与 PgPersistenceDriver 零依赖先例一致；宿主机需安装 `psql`，容器镜像缺 `postgresql-client` 见 `BACKEND_TODO.md` §五 `#14`），行数上限 50。
- **降级链**：查询失败（连接拒绝/无结果）→ 回落确定性 stub（`isReal:false` + `source: warehouse-query:query-failed→stub`）——DA 永不空手，且降级显式可见。

### 2. Provider 工厂与注册（`createAnalyticsProvider`）

```
WAREHOUSE_MCP_URL 配置          → McpContextProvider（MCP 路线优先）
WAREHOUSE_CONNECTION_STRING 配置 → WarehouseQueryProvider（直连只读查询）
都未配置                         → WarehouseStubProvider（确定性 stub）
```

Facade 注册改用工厂（导出便于测试）；真实数仓接入 = 配 env，零代码改动。

### 3. 数据流

```
Facade 预取（STAGE_5_DA）→ analytics_metrics（required）
  ├─ MCP / 只读查询成功 → isReal:true → runCache → DA prompt externalContext（真实指标 JSON）
  └─ 失败/未配置 → stub → isReal:false → DA prompt externalContext（投影报告显式标注 stub 派生）
```

## 边界处理

1. CSV 解析按简单行处理（psql --csv；SET 输出行剔除）；复杂嵌套值场景应换 MCP 路线或 JSON 聚合查询。
2. 净化后残留的 `-`（连字符在白名单内）不构成注入向量（引号/分号必然归零）。
3. 查询行数上限 50 + BudgetTrimmer 兜底（token 预算既有约束）。

4. 同步执行边界：默认 `psql` runner 每阶段最多串行执行两次 `execFileSync('psql', ..., { timeout: 15000 })`，若数仓挂起最多会同步阻塞 Node.js 事件循环 30s。

## 验证（tests/warehouse-query.spec.ts，5 项）

1. SQL 模板白名单：只读会话前置、模板名白名单拦截、参数仅 :run_id
2. runId 净化：注入载荷引号/分号归零、长度截断
3. 查询成功 → `isReal:true` + 真实指标/埋点核验 JSON + source 标注
4. 查询失败 → stub 兜底 `isReal:false` + `query-failed` 显式降级标注
5. 工厂 env 选择：MCP > 直连 > stub 三级

**完成时测试基线**：127 项（123 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：143 项 / 45 套件，139 过 / 4 既有 skip）

## 遗留（等真实数仓环境）

- **容器 `psql` 缺失**：直连 `WAREHOUSE_CONNECTION_STRING` 依赖 `PATH` 中存在 `psql`，但当前 `Dockerfile` 仅安装了 `git` 未安装 `postgresql-client`，容器部署下直连将因 `ENOENT` 回落 `stub`（已登记 `BACKEND_TODO.md` §五 `#14`；容器环境可改走 `WAREHOUSE_MCP_URL` 或补齐 `postgresql-client`）。
- `pipeline_metric_baselines` / `tracking_event_verification` 表结构与真实数仓 schema 对齐（表名可在 SQL_TEMPLATES 处按客户环境调整）。
- 真实 psql 联调（含 `--csv` 对复杂类型的输出形态）。
