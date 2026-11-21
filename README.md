# Agentic SDLC OS — AI 原生多智能体研发协同管理系统

一套面向 B 端单机私有化交付的 **AI 原生多智能体研发协同管理框架**，完整覆盖从 **业务提案 (Stage 0) -> PM Agent (Stage 1) -> PD Agent (Stage 2) -> Tech Lead Agent (Stage 3a) -> Engineer Agent (Stage 3b) -> QA Agent (Stage 4) -> DA Agent (Stage 5)** 的端到端研发闭环。

---

## 一、 核心架构特性

1. **纯粹面向对象与成熟设计模式 (`src/patterns/`, `src/agents/`, `src/engine/`)**：
   - **模板方法模式 (`AbstractWorkerAgent`)**：固化 7 步标准 Agent 生命周期（上下文与负向经验挂载 -> 意图识别 -> L1/L2 缓存拦截 -> BYOM 模型路由与自愈重试 -> 防虚假共识校验 -> 缓存回填 -> 复盘遥测记账）。
   - **中介者模式 (`BoundedNegotiationMediator`)**：管控跨角色 Agent 协商，强制执行 `maxNegotiationTurns` 最大讨论轮次熔断，杜绝无限扯皮。
   - **命令模式 (`SupervisorAgent`)**：总管 Agent 仅做冲突提炼与自然语言回退路由，绝不越权直接修改业务文档或代码。
   - **状态与备忘录模式 (`DagWorkflowStateEngine`, `StageSnapshotMemento`)**：支持通过与总管 Agent 对话回退到任意历史阶段，自动将旧分支下游快照标记为 `SUPERSEDED` 并 Fork 新分支，彻底隔离脏数据。
   - **责任链模式 (`RiskEvaluationPipeline`)**：基于业务风险（DDL 变更、Scope 缩减、协商熔断、权限安全域）动态决定“低风险自动放行并留痕”或“高风险阻塞并推送人工核验提醒”。
   - **观察者模式 (`WorkflowEventBus`, `ImmutableAuditLedger`)**：实时向前端推送待核验/待拍板提醒，并自动写入只读追加审计账本与“负向经验飞轮”。
2. **完整的 Agent 模块注释与文档**：
   - 详见 `src/agents/` 下所有类的头部架构说明及 [docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md)。
3. **自动化复盘任务与成本控制指标检测**：
   - 实时追踪 **(a) L1/L2 双层缓存命中率** 与 **(b) 意图识别到最终执行结果达成率及重试次数分布**。详见 [docs/RETROSPECTIVE_PLAN.md](docs/RETROSPECTIVE_PLAN.md)。
4. **实时可视化管控工作台 UI (`src/ui/index.html`)**：
   - 实时抓取 6 阶段流水线进度、AI 交互状态、Agent 待核验/待拍板提醒收件箱、总管对话式 DAG 分叉回退指挥舱及复盘成本控制大盘。

---

## 二、 快速运行指南（零外部云依赖）

```bash
# 1. 运行面向对象架构、DAG分叉回退、风险门禁与复盘指标自动化测试套件
npm test

# 2. 运行复盘与成本控制基准评测任务 (输出缓存命中率、意图达成率与重试分布报告)
npm run retrospective:eval

# 3. 启动单机私有化 Web 管控工作台 (默认监听 http://localhost:4300)
npm start
```
