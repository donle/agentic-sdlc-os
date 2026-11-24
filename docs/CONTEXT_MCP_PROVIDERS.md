# 实现文档：MCP 三服务器与外部知识连接器

> 对应上下文介入实施方案步骤 3，2026-11-23 完成。前置：G10 上下文介入骨架（ToolRegistry）已就绪。

## 问题背景

G10 骨架落地后，`STAGE_CONTEXT_NEEDS` 中三个 required 需求没有 Provider 解析（注：STAGE_3A 的 `code_structure` / `db_schema` 已由 `GitContextProvider` 直连覆盖，非 MCP 路线）：

- STAGE_2_PD `figma_components`（required）
- STAGE_5_DA `analytics_metrics`（required）
- STAGE_3B_ENGINEER `dependency_versions`（required，本步暂不覆盖，见文末遗留）

缺失时 PD/DA 阶段永远 blocked（静默降级），Agent 拿不到外部知识。

## 实现方案

### 1. 通用 MCP 客户端（新增 `src/agents/context/McpContextProvider.ts`）

- 实现 `ContextProvider`，经 HTTP JSON-RPC 2.0 调用外部 MCP server 的 `tools/call`：
  - 请求载荷：`{jsonrpc, id, method: 'tools/call', params: {name, arguments: {needType, runId, stageId, proposalTitle, requirements, upstreamSummaries, maxTokens}}}`
  - 响应解析：`result.content[]` 中 type=text 的片段拼接为上下文文本。
- 配置驱动：`serverUrl` + `resolvableTypes` + `toolName`——同一客户端适配任意真实 MCP server。
- 凭证：`token` 参数或 env `MCP_AUTH_TOKEN`（Bearer 头）。
- 超时：`AbortSignal.timeout(10s)`（可配）。
- **postJson 注入口**：测试无需真实网络。
- 失败 → 抛错，由 `ToolRegistry` 现有边界逻辑统一处理（required → blocked 显式可见 / optional → 静默降级 + WARN）。

### 2. D-2 显式降级 stub（新增 `src/agents/context/StubProviders.ts`）

私有化单机没有真实外部系统时的兜底，**确定性派生**（同输入同输出，演示可复现）：

| Provider                | need 类型           | 派生逻辑                                                                          |
| :---------------------- | :------------------ | :-------------------------------------------------------------------------------- |
| `FigmaStubProvider`     | `figma_components`  | 每条核心需求按 stableHash 确定性建议 DS 组件（DataTable/FormPanel/...）+ 交互状态 |
| `WarehouseStubProvider` | `analytics_metrics` | 按需求派生指标基线（0%）与目标投影（10-29% 区间确定性取值）                       |

**诚实口径**：`isReal: false`（与 `SandboxProvisionResult.simulated` 同哲学）——stub 数据进审计不会伪装成真实外部数据。

### 3. Facade 注册策略（env 开关）

```
FIGMA_MCP_URL 配置          → McpContextProvider(figma-mcp, tool=get_figma_components)
未配置                      → FigmaStubProvider
WAREHOUSE_MCP_URL / STRING  → createAnalyticsProvider() 三级工厂（G11）：
                              1) WAREHOUSE_MCP_URL → McpContextProvider(warehouse-mcp, tool=query_warehouse_metrics)
                              2) WAREHOUSE_CONNECTION_STRING → WarehouseQueryProvider（只读 SQL 白名单直连）
                              3) 均未配置 → WarehouseStubProvider
```

> 注：数仓三级选择逻辑详见 `G11_WAREHOUSE_CLOSED_LOOP.md`。

部署真实 MCP server 后设置环境变量即完成切换，业务代码零改动。

## 效果

- PD/DA 阶段的 required 外部知识从"永远缺失"变为"本地 stub 必达"——`buildStagePrompt` 的 `externalContext` 字段在 2/5 阶段稳定注入。
- 真实 Figma/数仓接入路径已就绪：起 MCP server + 配 env 即可。

## 边界处理

1. MCP error 响应 → 抛错（不静默）；空 content → 抛错（不让空字符串伪装有效上下文）。
2. stub 与真实 Provider 接口完全一致（`ContextProvider`），ToolRegistry 无感知切换。
3. stub 派生只用 runId/reqId 做种子，不依赖 LLM，零成本零延迟。

## 验证（tests/context-providers.spec.ts，7 项）

1. MCP `tools/call` 请求载荷形状 + 文本内容解析 + source 标记
2. MCP error 响应 → 抛错（`/MCP tools\/call 失败/`）
3. MCP 空 content → 抛错（`/内容为空/`）
4. `canResolve` 按声明类型匹配
5. Figma stub：确定性 + `isReal=false` + 每需求 ≥2 组件建议
6. 数仓 stub：指标基线/目标派生 + `isReal=false`
7. ToolRegistry 集成：stub 补位后 STAGE_2_PD required 需求不再 blocked

**完成时测试基线**：105 项（101 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：169 项 / 48 套件 / 28 文件，165 过 / 4 既有 skip）

## 遗留

- STAGE_3B `dependency_versions`（required）仍无 Provider——工程师阶段的依赖清单暂走静默降级，可在后续接入企业制品库 MCP。
- Git 读取器未走 MCP 协议（直连 fs 读取，单机内更简单；如需跨进程再包 MCP server）。
