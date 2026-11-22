# docs/ 文档导航

> 更新：2026-11-23。按"当前权威性"分层；带 ⚰️ 的为已实现设计/立项存档（保留供追溯，内容可能与代码不一致，以横幅说明为准）。

## 权威进度与计划（做任何后端工作前先读）

| 文档                                                   | 角色                                                                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| [BACKEND_TODO_IMPL_LOG.md](./BACKEND_TODO_IMPL_LOG.md) | **实现进度权威表**：逐条执行记录、边界处理、测试基线（161 项 / 47 套件）                                |
| [P2_REMAINING_PLAN.md](./P2_REMAINING_PLAN.md)         | **P2 剩余任务决策**：I3/G11/J2 已完成，H1-H3 外部集成已挂起；当前 P1 待修复见 `BACKEND_TODO.md` §五     |
| [BACKEND_TODO.md](./BACKEND_TODO.md)                   | §一–四为 2026-11-22 审计基线存档；**§五（#10–#14 P1 待办；P0 #8/#9 已完成）为 2026-11-23 深度审计清单** |
| [BACKEND_TODO_DESIGN.md](./BACKEND_TODO_DESIGN.md)     | 配套代码设计定稿（A1…J2 逐项签名/数据流/边界，含与实现偏差说明）                                        |

## 系统设计定稿（仍然有效）

| 文档                                                                               | 角色                                                                                                            |
| :--------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| [SYSTEM_DESIGN_REPORT.md](./SYSTEM_DESIGN_REPORT.md)                               | 系统设计方案基线（概念与工作流定稿；技术栈/DSL/Stage 5 实际落地偏差见文首现状说明与 `AGENT_ARCHITECTURE.md`）   |
| [AGENT_ARCHITECTURE.md](./AGENT_ARCHITECTURE.md)                                   | `src/agents/` 设计模式矩阵与 7 步生命周期（已按 A1-A4/B1-B3/C2-C3/E1-E3/G1/G10-G11/J2 及第八/十轮交付标准同步） |
| [AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md](./AGENT_QUALITY_AND_EFFICIENCY_DESIGN.md) | **Agent 质量、跨模型缓存、Token/防死循环与反迎合协商规范**（DS-1~DS-4 交付标准 + AC-1~AC-12 量化验收门槛）      |
| [USER_SYSTEM_DESIGN.md](./USER_SYSTEM_DESIGN.md)                                   | 用户系统设计定稿（F1/F2 JSON + 第九轮鉴权 + 第十二轮 `#8` PG 用户表/`PgUserStore` 已落地；前端登录 UI 待迁移）  |
| [RETROSPECTIVE_PLAN.md](./RETROSPECTIVE_PLAN.md)                                   | 复盘指标规范（缓存命中率 SLA / 意图达成率 / 成本控制效能；已同步 `resolveStageIntent` 与 G1/A4 现状）           |

## 逐项实现文档（2026-11-23）

| 文档                                                               | 对应条目                                            |
| :----------------------------------------------------------------- | :-------------------------------------------------- |
| [G1_SEMANTIC_CACHE_EMBEDDING.md](./G1_SEMANTIC_CACHE_EMBEDDING.md) | G1 L2 语义缓存 embedding 化（含 L0 前缀缓存）       |
| [G2_RAG_EMBEDDING.md](./G2_RAG_EMBEDDING.md)                       | G2 负向经验 RAG embedding 化                        |
| [CONTEXT_MCP_PROVIDERS.md](./CONTEXT_MCP_PROVIDERS.md)             | 上下文介入步骤 3：MCP 客户端 + Figma/数仓 stub      |
| [DYNAMIC_CONTEXT_NEEDS.md](./DYNAMIC_CONTEXT_NEEDS.md)             | 上下文介入步骤 4：LLM 动态上下文需求                |
| [A4_INTENT_LLM_AND_BASELINE.md](./A4_INTENT_LLM_AND_BASELINE.md)   | A4 意图识别 LLM 化 + 模型体检端点                   |
| [E3_DOCKER_RUNTIME.md](./E3_DOCKER_RUNTIME.md)                     | E3 docker 沙箱测试运行时                            |
| [I3_DATA_RETENTION.md](./I3_DATA_RETENTION.md)                     | I3 数据保留（WAL 月度归档 + worktree 保留策略）     |
| [G11_WAREHOUSE_CLOSED_LOOP.md](./G11_WAREHOUSE_CLOSED_LOOP.md)     | G11 Stage 5 数仓闭环（只读查询通道 + 降级链）       |
| [J2_PLUGGABLE_NODES.md](./J2_PLUGGABLE_NODES.md)                   | J2 可插拔节点注册表（DSL 新节点 + RBAC 映射配置化） |

## UI 设计文档（2026-11-22）

| 文档                                                 | 角色                                     |
| :--------------------------------------------------- | :--------------------------------------- |
| [UI_LIBRARY_DECISION.md](./UI_LIBRARY_DECISION.md)   | 前端组件体系选型决策（Meridian UI 规格） |
| [UI_SYSTEM_DESIGN_MAP.md](./UI_SYSTEM_DESIGN_MAP.md) | UI 系统设计全景图                        |

## 存档（立项时蓝图）

| 文档                                                   | 说明                                              |
| :----------------------------------------------------- | :------------------------------------------------ |
| [ENGINEERING_BLUEPRINT.md](./ENGINEERING_BLUEPRINT.md) | ⚰️ 立项蓝图（推荐栈已被有意偏离，见文首偏差说明） |
