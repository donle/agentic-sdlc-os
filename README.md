# Agentic SDLC OS — AI 原生多智能体研发协同管理系统

一套面向 B 端团队单机私有化交付的 **可观测、可回滚、可审计的 AI 原生研发流水线操作系统（Agentic SDLC OS）**。系统不是“让多个 AI 自由聊天的对话工具”，而是通过**多智能体受限协商 + 全流程可控 DAG 状态机 + 团队多角色交叉审核与评论 + 总管 Agent 异常接管与分叉回退 + 全链路不可变审计账本**，完整覆盖从 **业务提案 (Stage 0) -> PM Agent (Stage 1) -> PD Agent (Stage 2) -> Tech Lead Agent (Stage 3a) -> Engineer Agent (Stage 3b) -> QA Agent (Stage 4) -> DA Agent (Stage 5)** 的端到端研发闭环。

---

## 一、 核心创意理念与系统设计文档 (`docs/`)

项目的最初构想、产品创意理念、六大关键遗漏补全以及工程化落地蓝图均完整收录在 `docs/` 目录中：

1. **[《AI 原生多智能体研发协同管理系统——完整方案设计报告》](docs/SYSTEM_DESIGN_REPORT.md)** (`docs/SYSTEM_DESIGN_REPORT.md`)
   - **四层解耦架构**：人机协同与治理层、编排与状态机引擎层、专业职能智能体层、企业底座与连接层。
   - **端到端 6 阶段工作流**：Stage 0 立项挂载 → Stage 1 PM 结构化 PRD 与前置埋点 → Stage 2 PD 交互设计与 PM-PD 受限轮次协商 → Stage 3a 架构契约与表结构前置门禁 → Stage 3b 隔离沙箱编码 → Stage 4 QA 自动化验证 → Stage 5 DA 埋点核验与复盘。
   - **六大关键遗漏补全**：技术方案前置门禁（3a/3b 拆分）、埋点设计前置、防“虚假共识” Scope Diff 守卫、沙箱与分支物理隔离、外部工具同步、基于业务风险的分级门禁（消除审批疲劳）。
2. **[《工程落地架构草案（Engineering Blueprint）》](docs/ENGINEERING_BLUEPRINT.md)** (`docs/ENGINEERING_BLUEPRINT.md`)
   - 单机私有化部署拓扑（Docker Compose + PostgreSQL `pgvector` + LiteLLM / Ollama 本地模型网关 + Git Worktree 沙箱）。
   - 核心数据库 Schema（`workflow_runs`、`stage_snapshots`、`negotiation_logs`、`human_decisions`、`rejected_history_rag`）与总管 Agent 受控调度契约。
3. **[《Agent 模块面向对象架构与 7 步标准生命周期说明书》](docs/AGENT_ARCHITECTURE.md)** (`docs/AGENT_ARCHITECTURE.md`)
   - 模板方法模式 (`AbstractWorkerAgent`)、中介者模式 (`BoundedNegotiationMediator`)、命令模式 (`SupervisorAgent`)、备忘录模式 (`StageSnapshotMemento`)、责任链模式 (`RiskEvaluationPipeline`) 详细解析。
4. **[《复盘任务与成本控制指标检测规范》](docs/RETROSPECTIVE_PLAN.md)** (`docs/RETROSPECTIVE_PLAN.md`)
   - L1/L2 双层语义缓存命中率、意图识别到最终契约达成率、自愈重试次数分布及 SLA 诊断标准。

---

## 二、 核心系统架构特性

1. **面向全员的多角色协同网站与两级 RBAC 权限体系 (`src/domain/rbac.ts`, `src/engine/RbacGovernanceService.ts`, `src/ui/`)**：
   - **全员透明共享视野**：产品经理 (`PM`)、体验设计师 (`PD/UX`)、系统架构师 (`Tech Lead`)、研发工程师 (`Engineer`)、测试负责人 (`QA`)、数据分析师 (`DA`) 与项目最高管理员 (`PROJECT_ADMIN`) 登录后共享完整的项目大厅与每个步骤的进展。
   - **分步协同详情页**：点击任意项目的任意步骤，直观展示 **(1) 当前步骤 Agent 正在做什么与动作分解**、**(2) Agent 跨岗位讨论对话过程与历史结论**、**(3) 本步骤结构化交付物文档**、以及 **(4) 其他团队成员留下的评论与评审意见**。
   - **专长角色确认与管理员最高权限**：所有成员均可在任意步骤发表团队评论；各步骤的签核放行与冲突拍板由对应专长负责人或顶层管理员执行。
2. **声明式 YAML 工作流 DSL 引擎 (`src/engine/WorkflowDslLoader.ts`, `configs/workflows/`)**：
   - 动态解析 `enterprise_sdlc.yaml`（全栈 6 步骤）与 `backend_api_only.yaml`（纯后端 4 步骤，动态跳过 UI 设计阶段），无需改代码即可按客户微调流程。
3. **BYOM 混合模型路由网关与脱敏中间件 (`src/patterns/ModelRouterGateway.ts`)**：
   - 支持本地私有模型与混合高阶推理模型分级路由，内置 `PayloadDesensitizer` 自动脱敏数据库连接串、API Key、JWT 与内网 IPv4，并提供模型 JSON 契约遵循度基线体检。
4. **双模持久化仓储与负向经验向量 RAG (`src/engine/PersistenceRepository.ts`, `src/engine/NegativeExperienceRagEngine.ts`)**：
   - 支持本地 JSON + Append-Only JSONL 审计流落盘与 PostgreSQL 16 + `pgvector` SQL 同步脚本生成；自动将历史驳回/回退意见脱敏并转化为 64 维归一化向量，按余弦相似度检索 Top-K 历史避坑经验注入给 Agent。
5. **Git Worktree 隔离代码与测试沙箱 (`src/sandbox/GitWorktreeSandboxManager.ts`)**：
   - 为每个任务与回退分叉分支创建独立的 Git Worktree 沙箱目录，真实落盘 TypeScript 业务类、SQL 迁移脚本与单测文件，并支持子进程运行真实单测与静态安全漏洞扫描。

---

## 三、 快速运行与工程化质量门禁

```bash
# 1. 运行全量工程化质量门禁（前后端 TypeScript 类型检查 + ESLint + Prettier 格式检查 + 7大测试套件共19项测试）
npm run check

# 2. 单独运行自动化测试套件
npm test

# 3. 运行复盘与成本控制基准评测任务 (输出缓存命中率、意图达成率与重试分布报告)
npm run retrospective:eval

# 4. 编译前端 TypeScript 模块并启动多角色研发协同网站 (默认监听 http://localhost:4300)
npm start
```
