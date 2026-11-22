# P2 剩余任务计划与 H 系列分析（决策记录）

> 记录日期：2026-11-23。前置状态：M1-M7 Mockup 全部替代完毕，P1 清单清零（见 `BACKEND_TODO_IMPL_LOG.md`）。
> 本文是 H1-H3 / I3 / J2 / G11 的**目的与核心逻辑分析 + 实施决策**，开工前按此执行，勿重复分析。

---

## 一、H 系列的核心目的

把流水线里的 Agent 与企业三类真实外部系统连接起来（审计缺口 G9/G10 的后半程）。
G10 已建成摄取**框架**（ToolRegistry + ContextProvider 接口 + stub 补位 + 动态需求），H 系列是**真实系统接入**：

| 任务 | 连接的系统 | 打破的孤岛 |
| :--- | :--- | :--- |
| H1 | Git 代码库 | TechLead/Engineer 设计与实现时"看不见"真实仓库（G10 的 GitContextProvider 只读主仓库，不读沙箱 worktree） |
| H2 | Jira/飞书 | 流水线状态对人类项目工具不可见；外部审批/评论进不了流水线 |
| H3 | Figma 设计系统 | PD 的组件映射可能指向企业设计系统里不存在的组件 |

## 二、逐项分析与真实增量（对照已完成的 G10）

### H1 Git 上下文摄取（P2）—— 与 G10 重叠 ~80%

设计口径：worktree 内 `git ls-files + 目录树（限深 3）+ 关键文件截断（README/主入口/Schema）` 拼入 3a/3b prompt；预算上限 8K 字符。

**已覆盖**（G10，勿重做）：
- 主仓库目录树 + keyFiles + SQL Schema（`GitContextProvider`，`code_structure`/`db_schema` 两类 need）
- 已接入 3a（TechLead）prompt；`STAGE_CONTEXT_NEEDS` 已声明 3b 的 `code_structure`

**真实增量**（仅三点）：
1. 口径从主仓库换成**沙箱 worktree**（工程师分支上的产物，供修复/迭代回看）——新增 `WorktreeContextProvider`，从 `GitWorktreeSandboxManager` 取 worktree 路径执行 `git ls-files`
2. 3b（Engineer）注入（现有 `code_structure` need 已声明，注册 worktree Provider 即生效）
3. 8K 字符预算硬限（当前用 token 估算，加字符硬限）

**可完整验证**（本机有真实 git worktree）。

### H2 Jira/飞书双向同步（P2）—— 唯一零覆盖项

**核心逻辑**（双向）：
- 出站：状态机流转事件（阶段完成/门禁阻塞/回退/终态）→ webhook POST 任务卡 → 重试 3 次指数退避
- 入站：`/api/integrations/jira/webhook`（HMAC 签名校验）→ 映射为 `TeamComment` 或 `HumanDecisionRecord`
- 配置：`integrations.yaml`（适配器模式，配置驱动）

**技术难点不在代码而在业务映射语义**：什么外部事件算"批准"、什么算"驳回"、什么算"评论"——需要业务方输入。

**实施决策**（mock 可验证范围）：
- ✅ 做：出站 webhook 适配器（EventBus 观察者 → POST + 指数退避，可 mock 验证）、入站端点骨架（签名校验可测）
- ⏸ 缓：具体 Jira/飞书字段映射规则——留 `integrations.yaml` 配置位，等真实部署环境的业务输入
- 原因：单机私有化 MVP 的价值依赖客户真实使用外部工具；无凭证无法端到端验证

### H3 Figma 设计系统摄取（P2）—— 槽位就绪，剩真实 API + 缓存失效联动

**已覆盖**（G10）：`FigmaStubProvider`（确定性 stub 补位，`isReal:false`）+ `McpContextProvider`（真实接入路径，`FIGMA_MCP_URL` 环境切换）。

**真实增量**：
1. 直连 Figma REST API 的拉取 client（Token 拉取组件清单）
2. 本地缓存 24h
3. **清单变化 → 触发 PD 缓存失效**——最有技术含量的部分：外部数据变化 → L1/L2 语义缓存失效，否则会复用过期的组件映射

**实施决策**：做"mock 可验证"范围——API client 骨架（fetch 注入口）+ 24h 缓存 + 缓存失效联动逻辑（全可测）；真实 Figma 调用等凭证。若客户环境已起 MCP server，则 `McpContextProvider` 路线优先于直连（二选一，不重复建设）。

## 三、其余 P2 任务

| 编号 | 内容 | 关键点 |
| :--- | :--- | :--- |
| I3 数据保留 | worktree 保留最近 N=10 个 run；审计 WAL 按月切分；cleanup 挂 run 终态钩子 | 纯内部逻辑，可完整验证；注意 D1 恢复与保留策略的交互（保留期内才可恢复） |
| J2 可插拔节点 | `AgentRegistry.register(stageId, agent)` 动态注册 + RBAC 角色映射配置化 + `VALID_STAGE_IDS` 从注册表取 | 涉及枚举白名单改造（WorkflowStageId 是 `as const`），需设计好"新节点持久化/恢复"与 D1 的兼容 |
| G11 Stage 5 闭环 | DA Agent prompt 注入真实数仓查询结果（只读 SQL 模板 + 结果 JSON）；无数仓时保持投影报告并显式标注 | 数仓 stub 已补位（G10）；真实查询走 `WAREHOUSE_MCP_URL` 或直连只读连接；安全边界：只读 SQL 白名单模板 |

## 四、建议实施顺序（2026-11-23 用户决策更新）

> **用户决策：H 系列的实际接入信息打问号**——外部系统凭证、字段映射语义需业务侧再思考，
> **H1/H2/H3 整体挂起**，等业务输入后按本文件第二节的范围决策执行。
> 当前执行顺序：**I3 → G11 → J2**（全部为纯内部逻辑，可完整验证）。

| 顺序 | 任务 | 状态 |
| :--- | :--- | :--- |
| 1 | I3 数据保留 | ✅ 已完成（`I3_DATA_RETENTION.md`） |
| 2 | G11 Stage 5 闭环（mock 可验证范围：只读 SQL 模板 + 注入式查询 runner） | ✅ 已完成（`G11_WAREHOUSE_CLOSED_LOOP.md`） |
| 3 | J2 可插拔节点（最小注册表层，不动枚举体系） | ✅ 已完成（`J2_PLUGGABLE_NODES.md`） |
| ⏸ | H1 / H2 / H3 | **挂起，待业务思考**（范围决策见第二节，届时直接执行） |

## 五、挂起项（有意不做，勿当遗漏）

| 项 | 状态 | 原因 |
| :--- | :--- | :--- |
| L3 增量缓存 | 暂缓（已与用户确认） | 需产物粒度依赖追踪，等真实回退频率数据再决策 |
| B3 预算熔断精确阈值测试（a1 spec test 5 skip） | skip | 需 C1 异步化后才能精确控制估算；已有 B3 基本断言 |
| a1 spec test 2（缺字段自愈按阶段路由） | skip | `full-pipeline-llm.spec` test 3 已覆盖同一行为 |
| Agent 降级路径独立单测 | 低优 | 降级路径由离线集成测试间接覆盖 |
| H2 完整字段映射 / H3 真实 Figma 拉取 / G11 真实数仓 | 等部署环境 | 需外部系统凭证 |
