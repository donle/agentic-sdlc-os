# UI 重设计稿 v2（待确认）

本目录是 **Agentic SDLC OS 前端重设计的设计稿**，系统设计梳理见
[`docs/UI_SYSTEM_DESIGN_MAP.md`](../docs/UI_SYSTEM_DESIGN_MAP.md)。

> ⚠️ **本目录仅是设计稿，不是生产代码。**
> 现有前端仍在 `src/ui/client/**` + `src/ui/styles/workbench.css`，
> 待设计确认后按本稿重构。

---

## 0.1 前置：Meridian UI 组件库（已落地，可直接评估）

在动前端之前先立了组件体系 —— 见 [`docs/UI_LIBRARY_DECISION.md`](../docs/UI_LIBRARY_DECISION.md)。

| 项 | 值 |
|---|---|
| 位置 | `src/ui/kit/`（9 个文件，34 个组件） |
| 依赖增量 | **0**（`package.json` 的 dependencies 不变） |
| 命名空间 | CSS `m-` 前缀 / 令牌 `--m-` 前缀，与旧版 `--bg-*` 完全隔离，可并存 |
| 实时评估页 | **`http://localhost:4300/#/gallery`**（工作台左侧导航最后一项） |
| 截图 | `design/kit-screens/K1–K4*.png` |

组件库总览页可以实时切换 **主题（浅/深）× 密度（紧凑/标准/宽松）**，
每个组件的默认 / 悬停 / 聚焦 / 禁用 / 载入 / 错误 / 空态 / 长文本 / 极窄容器状态都并排摆出。

**最该先看的一屏**：`K1-排版与度量-核心对比.png` —— 同一段文字在「无 Prose（会铺满容器）」
和「Prose（限宽 68ch）」两种容器下的并排对比。这就是「文字占满组件」问题的解法。

---

## 0. v2 相对 v1 改了什么

v1 评审反馈三条，全部已落进 v2：

| 反馈 | v2 处置 |
|---|---|
| **用浅色主题** | 浅色为默认主题，深色保留为等价完整实现（不是简单反色） |
| **员工视角不该看到那么多信息** | 新增**视角分级 L1/L2/L3**（§3）。员工只在自己阶段拿到 L2 完整审阅，其余阶段退化为一句话结论 |
| **"Agent 拿出来的内容到底在哪儿？结论和方案怎么看？Agent 具体怎么说的？"** | 查下去发现是**系统级问题**：真实数据一直存在，但前端在 `lib/stageContent.tsx` 里**编造了一套对话**。v2 新建**「Agent 交付审阅面板」**，全部改用后端真实字段（§4），并给出 6 项后端契约缺口（§5） |

---

## 1. 怎么看

### 方式 A：直接用浏览器打开（无需服务器）

```
design/ui-prototype.html
```

单文件、零依赖、零外部请求（内网私有化部署硬约束），双击即可打开。

### 方式 B：起一个本地静态服务（推荐）

```bash
node .runtime-data/design-static-server.mjs . 4399
# 打开 http://localhost:4399/design/ui-prototype.html
```

### 原型内可交互的部分

| 操作 | 效果 |
|---|---|
| 左侧导航轨 7 个图标 | 切换 7 个视图（M1–M7） |
| **顶栏「视角」7 个头像** | **切换登录身份，全站信息密度随之改变**（L1/L2/L3）——这是 v2 最该看的交互 |
| 左下角太阳/月亮图标 | 浅色 ⇄ 深色主题实时切换 |
| 审阅面板三个标签页 | 交付物本体 / 推演过程（事件链）/ 团队评论 |
| **点击任意事件** | 展开该步骤的结构化 `detailPayload` |
| 流水线节点 | 高亮当前聚焦阶段 |

> **建议对比看**：切到「林工 (PD/UX)」再切到「王总管」，看同一条流水线在两种视角下的信息量差异。

---

## 2. 屏幕清单

| 文件 | 视图 | 核心视觉资产 |
|---|---|---|
| `screens/M1-项目总览.png` | 项目总览大厅 | 阶段进度轨道（分段状态色）、项目卡、KPI 微图表 |
| `screens/M2-项目工作台-管理员视角.png` | 项目分步协同工作区（王总管 · L3） | **流水线脊柱** + **Agent 交付审阅面板**（交付物本体 / 推演过程 / 裁决区）+ 右侧总管指挥舱 |
| `screens/M2-项目工作台-员工视角.png` | 同上（林工 PD/UX · L1+L2） | **非本人阶段退化为 L1 摘要节点**、右坞换成「我的工作台」、他人阶段审阅面板锁定 |
| `screens/M3-裁决中心-管理员视角.png` | 待办确认与方案拍板（管理员） | 队列 + 内嵌真实交付物的决策卡 + A/B 对比 + Scope Diff 红线 |
| `screens/M3-裁决中心-员工视角.png` | 同上（林工） | 队列只列「我可裁决」，他人项置灰只读 |
| `screens/M4-版本与分支-分叉泳道.png` | 总管对话与版本历史 | 分叉泳道图（fork 曲线）+ 决策时间轴轨 |
| `screens/M5-沙箱与测试.png` | 交付源码与测试沙箱 | 目录文件树、源码阅读器（行号 + 语法着色）、终端化测试日志 |
| `screens/M6-审计与经验库.png` | 协同动态与团队经验库 | 审计事件轨（类型化节点）+ 相似度计量条 |
| `screens/M7-成员与流程规则-权限矩阵.png` | 团队成员与流程设置 | 人员 × 阶段点阵权限矩阵 + 阈值滑杆 + KPI 环形图与分布柱图 |

---

## 3. 视角分级（L1 / L2 / L3）

| 级别 | 谁能看 | 看什么 | 界面表达 |
|---|---|---|---|
| **L1 摘要级** | 所有人（对他人阶段） | `artifactSummary` 一句话 + 状态 + 责任人 | 流水线节点淡出、隐藏 Agent 头像、状态行只留结论 |
| **L2 评审级** | 阶段负责人 + 管理员 | 完整交付物 + 推演过程 + 协商记录 + 评论 + 裁决区 | 节点高亮；审阅面板完整展开 |
| **L3 管理级** | 仅 `PROJECT_ADMIN` | 全局 KPI + 分支演化 + 跨步骤拍板 + 流程规则 | 顶部 KPI 条、全局分支态势 |

判定**全部来自后端**：`stageAccessMatrix[stageId].isDirectDomainOwner` / `.isAdminOverride` / `.canApproveOrArbitrate` / `.denialReason`，前端不做任何权限推断。

---

## 4. Agent 交付审阅面板（v2 核心组件）

人介入的每一个点都必须能按顺序回答三个问题：

1. **Agent 做了什么？** → 交付物本体（`snapshot.artifactDetails`，按 `artifactType` 分型渲染）
2. **它凭什么这么做？** → 推演过程（事件链可下钻 `detailPayload` + 真实协商记录）
3. **我怎么拍板？** → 裁决区（风险拆解 + Scope Diff 红线 + 独立理由输入 + 动作按钮）

原型里的所有内容都取自后端**真实字段**，例如：
`componentMappings` / `designChallengeNote`（Agent 自述）/ `accessibilityChecklist` /
`challengePoint` / `responseResolution` / `optionAProposal` / `optionBProposal` /
`intentCode` / `cacheLayer` / `savedTokens` / `model` / `tier`。

> ⚠️ 现有 `src/ui/client/lib/stageContent.tsx` 中的 `ACTIONS_BY_STAGE` 与 `STAGE_DISCUSSIONS`
> 是**前端编造的对话**，改造时必须删除，改为按 `artifactType` 渲染真实 `artifactDetails`。

---

## 5. 需要后端配合的 6 项契约缺口

| # | 缺口 | 优先级 |
|---|---|---|
| **G1** | 只有 PD Agent 有 `designChallengeNote`，其它 5 个 Agent 的交付物没有"为什么这么做"字段 | **高** |
| **G2** | `PENDING_HUMAN_GATE` / `APPROVED` 等终态事件没有 `detailPayload` | **高** |
| G3 | `liveInteractionStream` 只保留最近 40 条，不可回溯 | 中 |
| G4 | `negotiationLogs` 仅 PD↔PM、QA↔Eng 产生，其它阶段无讨论记录 | 中 |
| G5 | `artifactDetails` 是 `Record<string, unknown>`，无运行时 schema | 中（前端可独立解决） |
| G6 | `artifactSummary` 是一句话，不足以支撑"读一段 Agent 结论 + 理由" | 中 |

详见 `docs/UI_SYSTEM_DESIGN_MAP.md` §11.4 与 §14。

---

## 6. 设计系统速查

| 项 | 值 |
|---|---|
| 主题 | **浅色为默认**（v2 评审结论），深色为等价完整实现；`[data-theme]` 切换 |
| 主色 | brand `#2F54EB`（浅） / `#5C7CFA`（深） |
| 语义色 | jade 已通过 · amber 待裁决/高风险 · coral 驳回/红线 · violet 总管/管理员 · cyan 自动放行/复用 |
| 字阶 | Display 28 / Title 18 / Body 13.5 / Label 11.5 / Mono 12（全部数字 `tabular-nums`） |
| 间距 | 4px 基准：4 8 12 16 20 24 32 40 56 |
| 圆角 | 6 微控件 / 10 卡片 / 14 大容器 / 999 药丸 |
| 动效 | 120 / 180 / 260 / 420ms 四档 + 三种缓动；`prefers-reduced-motion` 全量降级 |
| 图标 | 全部内联 SVG（24×24 viewBox，stroke 1.6），**不引入任何 CDN 依赖**；emoji 仅保留 Agent 头像语义位 |

---

## 7. 落地映射建议

| 原文件 | 建议动作 |
|---|---|
| `src/ui/styles/workbench.css` | 整体替换为新令牌 + 组件层；浅色为默认主题 |
| `src/ui/client/lib/stageContent.tsx` | **删除编造内容**；改为按 `artifactType` 分型的渲染器 |
| `src/ui/client/lib/artifactDetails.tsx` | 重写：六类 artifact 的结构化卡片 + Agent 自述区 + 缺字段兜底 |
| `src/ui/client/components/AgentFlowCanvas.tsx` | → 流水线脊柱：DOM 节点 + SVG 连接线 + 门禁菱形 + L1 摘要形态；节点数按 `stagePipelineOrder` 动态 |
| `src/ui/client/components/StageNodePanel.tsx` | → 拆为「交付审阅面板」三标签页 + 常驻裁决区 |
| `src/ui/client/components/StepViewer.tsx` | → 事件链，每条可展开 `detailPayload`，末尾挂交付物入口 |
| `src/ui/client/views/GateCenterView.tsx` | → 队列 + 审阅面板双栏；**移除全局共用意见框**；补 A/B 对比卡 |
| `src/ui/client/views/DagSupervisorView.tsx` | → 分支泳道图（fork 曲线）替代分组列表 |
| `src/ui/client/views/AdminGovernanceView.tsx` | → 点阵权限矩阵替代 7 列表格；KPI 加环形图/柱图 |
| `src/ui/client/views/SandboxExplorerView.tsx` | → 去掉 `alert()`；终端逐行输出；文件树分层 |
| `src/ui/client/views/AuditRagView.tsx` | → 审计事件轨；相似度计量条 |
| `src/ui/client/components/DetailDrawer.tsx` | → 分级抽屉（420 速览 / 640 详情 / 960 审阅） |
| `src/ui/client/components/Topbar.tsx` | → 成员视角切换器改读 `rbacContext.roster`（修掉漏周工 DA 的 bug），接入视角状态机 |
| `src/ui/client/lib/display.ts` | → 扩展为「状态 → 视觉映射表」（颜色 / 图标 / 文案），供全站复用 |
| `src/ui/client/App.tsx` | → 单一 `perspective` 状态源驱动全站信息密度 |

**不可破坏的契约**见 `docs/UI_SYSTEM_DESIGN_MAP.md` §10。
