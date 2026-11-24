# `P2-2` + UI v2 全量改造（Backend G1–G4/G6 + Meridian UI Kit 接入全业务视图）说明

> 创建日期：2026-11-24 · 对应修复步骤：**Wave 3 · Step 11 (`P2-2 + UI_SYSTEM_DESIGN_MAP §14`)** · 执行轮次：**第二十四轮**

---

## 一、背景与改造目标

前期审计（[`BACKEND_TODO.md`](./BACKEND_TODO.md) §六与 [`UI_SYSTEM_DESIGN_MAP.md`](./UI_SYSTEM_DESIGN_MAP.md) §11–§14）发现 UI 与后端契约存在三类断层：

1. **后端可解释性与事件下钻缺口（G1 / G2 / G3 / G4 / G6）**：
   - 仅 PD 拥有 `designChallengeNote`，其余 5 个阶段缺少“为何做此设计/取舍”的一等公民字段；
   - `PENDING_HUMAN_GATE`、`APPROVED`、`REJECTED` 等关键状态转换缺少带 `snapshotId`、`riskScore`、`gateAction` 的机器可读 `detailPayload`；
   - `liveInteractionStream` 仅固定截取最新 40 条且无阶段/时间范围分页端点；
   - Stage 1 / 3a 默认无同侪协商通道；`artifactSummary` 为纯字符串，缺少 `rationale` 与 `caveats`。
2. **前端编造文案与审阅缺口**：
   - [`stageContent.tsx`](../src/ui/client/lib/stageContent.tsx) 硬编码 `ACTIONS_BY_STAGE` 与 `STAGE_DISCUSSIONS`（无论后端实际执行了什么都展示同一套固定台词）；
   - `GateCenterView` 全局顶部共享一个签核意见输入框，切换待办卡片会串味，且 `ARBITRATE_OPTION_A/B` 按钮看不到方案全文对照；
   - 6 类交付物缺少统一运行时容错解析器（G5）与 DA 阶段专用结构化表格。
3. **Meridian UI Kit 未接入业务视图 & 视角层级缺失**：
   - `src/ui/kit/` 组件体系此前仅在 `ComponentGalleryView` 中演示，7 个核心业务视图仍使用旧样式拼接；
   - 管理员与各领域专家看到完全一致的界面密度（缺少 L3 全局 / L2 评审 / L1 摘要视角分级）；
   - 同时 Step 10 实机浏览器测试暴露在 `759px` 窄视口下 `@media (max-width: 1024px)` `.app-sidebar` 因被后方 CSS 覆盖导致 `position: sticky; height: 100vh` 遮挡主操作区的布局缺陷。

---

## 二、后端契约与引擎改动（G1–G4 / G6）

| 编号   | 改动模块                                                                                                                                                                                                                                                  | 关键实现                                                                                                                                                                                                                                                  |
| :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | [`src/domain/contracts.ts`](../src/domain/contracts.ts)、[`ArtifactContractFactory.ts`](../src/agents/deserialize/ArtifactContractFactory.ts)、6 阶段 Agent 子类                                                                                          | 定义 `ArtifactKeyDecision` 与 `IDomainArtifactContract.agentRationale` / `keyDecisions`，在 6 个阶段 Agent 的 `synthesizeTemplateArtifact()` 填充真实推理依据与关键权衡，并在 Factory 反序列化中透传保留（兼容 PD `designChallengeNote`）。               |
| **G6** | [`src/domain/models.ts`](../src/domain/models.ts)                                                                                                                                                                                                         | `StageExecutionSnapshot.toSerializableRecord()` 新增结构化 `structuredSummary: { headline, rationale, caveats }`，保留原 `artifactSummary` 字符串向后兼容。                                                                                               |
| **G2** | [`src/engine/WorkflowOrchestratorFacade.ts`](../src/engine/WorkflowOrchestratorFacade.ts)                                                                                                                                                                 | 统一通过 `publishSnapshotGateEvent()` 在 `PENDING_HUMAN_GATE`、`AUTO_APPROVED_LOW_RISK`、`APPROVED`、`REJECTED` 时刻广播携带 `{ snapshotId, riskScore, riskLevel, gateAction, droppedRequirementIds, verdict, reviewerActor }` 的 `WorkflowDomainEvent`。 |
| **G3** | [`EventBus.ts`](../src/patterns/EventBus.ts)、[`WorkflowOrchestratorFacade.ts`](../src/engine/WorkflowOrchestratorFacade.ts)、[`WorkbenchServer.ts`](../src/server/WorkbenchServer.ts)、[`WorkbenchApiClient.ts`](../src/ui/client/WorkbenchApiClient.ts) | 新增 `WorkflowEventBus.getEventHistoryPage()`、`GET /api/events/history`（支持 `runId`/`stageId`/`since`/`until`/`offset`/`limit`）与前端 `fetchEventHistory()`；Dashboard 返回 `liveInteractionStreamTotal`。                                            |
| **G4** | [`src/domain/scenario.ts`](../src/domain/scenario.ts)、[`WorkflowOrchestratorFacade.ts`](../src/engine/WorkflowOrchestratorFacade.ts)                                                                                                                     | `evaluateStageNegotiation()` 扩展支持 Stage 1（PM ↔ DA `PRD_TRACKING_ALIGNMENT`）与 Stage 3a（Tech Lead ↔ Engineer `TECH_SPEC_REVIEW`），可通过 DSL `negotiateWithStageId` 或 `ScenarioHints.enableExtendedPeerNegotiation` 开启。                        |

---

## 三、前端 Meridian UI Kit 迁移与 UI v2 改动（P2-2 + §14）

1. **零编造内容彻底清理（[`stageContent.tsx`](../src/ui/client/lib/stageContent.tsx)）**：
   - 删除全部硬编码 `ACTIONS_BY_STAGE` 与 `STAGE_DISCUSSIONS`；
   - `AgentWorkActivity` 与 `AgentDiscussion` 全部改由真实快照 `structuredSummary`、`keyDecisions`、`stageEvents`、`negotiationLogs` 及 `SUPERSEDED` 版本记录渲染。
2. **G5 运行时契约解析与 §12 视角状态机**：
   - 新增 [`src/ui/client/lib/artifactParsers.ts`](../src/ui/client/lib/artifactParsers.ts)（覆盖 PRD / UI Design / Tech Spec / Code Impl / QA / Data Analysis 六类契约 + 缺字段警告 + 通用 `GENERIC` 兜底）；
   - 新增 [`src/ui/client/lib/perspective.ts`](../src/ui/client/lib/perspective.ts)（`derivePerspective(rbacContext)`），完全基于后端 `stageAccessMatrix` 推导 `L3` 全局管理视角与 `L2`（我负责步骤完整审阅）/ `L1`（他人步骤结论摘要）密度层级。
3. **核心审阅组件（[`AgentDeliverableReview.tsx`](../src/ui/client/components/AgentDeliverableReview.tsx)）**：
   - 基于 Meridian Kit 构建 3 标签页主区（`① Agent 交付了什么` / `② 它怎么推演出来的` 含 `detailPayload` 点击展开与 G3 加载更多 / `③ 团队意见`）与右侧常驻裁决栏（`Gauge` 风险仪表、`Banner` Scope Diff 红线、`Callout` L1 权限收敛、A/B 方案全文对比卡以及每条待办独立绑定状态的多卡零串联 `Textarea`）。
4. **7 个业务视图与公共容器全面接入 Meridian UI Kit**：
   - `ProjectsHubView.tsx`、`WorkspaceView.tsx`、`GateCenterView.tsx`、`DagSupervisorView.tsx`、`SandboxExplorerView.tsx`、`AuditRagView.tsx` 与 `AdminGovernanceView.tsx` 均已直接接入 `src/ui/kit/index.ts`（`Panel`, `Card`, `Button`, `StatusChip`, `Meter`, `Gauge`, `KeyValueList`, `ListRow`, `SegmentedControl`, `Tabs`, `MetricGrid`, `DataTable`, `Callout`, `EmptyState`, `Select`, `Input`, `Textarea`）；
   - `AgentFlowCanvas.tsx` 改用 `stageOrder.length` 动态计算水平宽度与节点尺寸，并对 L1 节点应用 `.node-l1-summary` 摘要视觉态；
   - `DetailDrawer.tsx` 支持 `sm`（420px）/ `md`（640px）/ `lg`（960px）三级宽度；
   - `Topbar.tsx` 集成 `StatusChip` 展示 `perspective.badgeText`。
5. **CSS 令牌对齐与窄视口响应式修复（[`workbench.css`](../src/ui/styles/workbench.css)）**：
   - `:root` 与 `[data-theme='dark']` 映射 Meridian `--m-*` 浅色默认令牌体系；
   - 将 `@media (max-width: 1024px)` 下 `.app-sidebar` 与 `.app-topbar` 的 `position: static; height: auto;` 规则置于基础定义之后，彻底解决窄视口侧边栏与顶栏悬浮遮挡主操作区的问题。

---

## 四、测试与实机浏览器验收结果

| 验证项目                              | 执行方式                                                                                    | 实测结果                                                                                                                                                                            |
| :------------------------------------ | :------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前后端类型 / ESLint / Prettier        | `npm run typecheck && npm run lint && npm run format:check`                                 | ✅ 全部通过（0 错误、0 警告）                                                                                                                                                       |
| 全量自动化测试                        | `npm test`（新增 [`tests/ui-v2-contracts.spec.ts`](../tests/ui-v2-contracts.spec.ts) 6 项） | ✅ **211 / 211 通过（55 套件 / 33 测试文件，0 跳过 / 0 失败）**                                                                                                                     |
| 实机浏览器 Desktop (`1280×900`)       | 独立服务 `http://localhost:4398` + Chrome 验证                                              | ✅ `WorkspaceView` 3 标签/Gauge/事件下钻、`Topbar` `L3`↔`L2/L1` 视角切换、`GateCenterView` 双栏队列 + A/B 对比卡 + 独立理由框、以及其余 5 个业务视图全部正常渲染，零未捕获 JS 异常  |
| 实机浏览器窄视口 (`759×996`) 布局回归 | `workbench.css` 重排后重载 `http://localhost:4398/#/workspace`                              | ✅ `.app-sidebar`（`height=716.18`）与 `.app-topbar`（`y=716.18`）随文档流自然滚走，正常指针点击 `② 它怎么推演出来的` 标签直接选中（`aria-selected="true"`），零 `ELEMENT_OCCLUDED` |
