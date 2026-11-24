# J2 实现文档：可插拔节点注册表

> 对应 `BACKEND_TODO_DESIGN.md` §M3 "J2 可插拔节点"，2026-11-23 完成（最小注册表层，不动枚举体系）。

## 问题背景

审计缺口：新增节点需同步改 `WorkflowStageId`/`AgentRole` 枚举、Facade agentRegistry 与 RBAC
`getRequiredRolesForStage` 硬编码——DSL 层"可插拔"名存实亡，只允许启停不允许新增。

## 实现方案（最小注册表层）

### 1. AgentRegistry（新增 `src/agents/AgentRegistry.ts`）

- `registerCustomStage(descriptor)`：自定义节点（新阶段键 + 新角色键 + 门禁角色映射）。
  - 键格式校验：`^[A-Z][A-Z0-9_]{2,63}$`（大写下划线）；**核心枚举阶段禁止覆盖**。
  - 直接调用 `registerCustomStage()` 同键重复注册 = 覆盖更新。
- `isValidStageId` / `isValidAgentRole`：**注册表口径**（核心枚举 ∪ 自定义）——替代裸枚举白名单。
- `getRequiredHumanRoles(stageId)`：自定义节点返回声明映射（缺省仅 `最高管理员 (PROJECT_ADMIN)`）；
  核心阶段返回 null（RBAC 硬表负责）。
- `AgentRegistry.default()` 进程级共享实例（DSL 校验 / Facade / RBAC 共用同一口径）。

### 2. DSL 加载器（`WorkflowDslLoader.parseFromString`）

- 新增可选 `registry` 参数（缺省 default 实例）。
- **两遍解析**：第一遍对所有启用阶段中**尚未通过 `registry.isValidStageId()` 校验的未知阶段键**注册为自定义节点（带 `requiredHumanRoles` YAML 字段；同一模板重复解析幂等跳过——若修改已注册自定义键的 metadata 不会在重解析时自动覆盖，需直接调用 `registerCustomStage()`）；
  第二遍构建描述符——因此 `negotiateWithStageId` 可指向**后文声明**的自定义节点。
- 语义保护：核心枚举阶段声明未知角色仍抛错；键格式非法（小写等）仍抛错。

### 3. RBAC（`RbacGovernanceService`）

- 构造器新增可选 `agentRegistry` 参数（缺省 default 实例）。
- `getRequiredRolesForStage`：先查注册表（自定义节点 → 配置化展示映射），核心阶段原硬编码矩阵不变；注：实际审批权限校验 `evaluateStageAccess` 仍以 `user.ownedStageIds` / `isProjectAdmin()` 判定（`requiredHumanRoles` 仅用于展示与拒绝原因提示），且 `evaluateAllStagesForUser` 当前仅覆盖 6 个核心阶段。

### 4. Facade 编排检查点语义

流水线循环遇到无 Agent 的节点：若是注册表自定义节点（通过 `AgentRegistry.default()` 判定）→ **广播 `STAGE_PROGRESS` 检查点通知**（含 RBAC 门禁
角色提示，`requiresHumanAction: false`）→ `advanceToNextStage()` 跳过推进；未注册则维持原抛错。

### 5. 总管回退与 J2 联动（第八轮补齐）

`WorkflowOrchestratorFacade.invokeSupervisorConversationalRollback` 将当前运行的 `runState.getStagePipeline()` 作为 `allowedStages` 传入 `SupervisorAgent.parseNaturalLanguageRollback()`；未传时白名单自动并入 `AgentRegistry.default().listCustomStages()`，且 `mapStageToRole` 可解析自定义节点的 `agentRole`，支持总管识别与回退至自定义阶段节点。

## 设计边界（诚实口径）

- **编排占位/检查点语义**：自定义节点可被 DSL 声明、进入流水线顺序、通过解析期 `negotiateWithStageId` 校验、展示 `getRequiredRolesForStage` 门禁提示并在审计流可见——但**无自动执行体与独立快照**（强类型产物契约仅覆盖核心 7 阶段）：运行时不会创建 `StageSnapshotMemento`、**不会执行协商**（Facade 运行时协商目前仅固定处理 `STAGE_2_PD -> STAGE_1_PM` 与 `STAGE_4_QA -> STAGE_3B_ENGINEER`）、也**不会在自定义节点门禁暂停**（即便配置了 `gatePolicy.mode: FORCE_HUMAN_GATE`）。
- **注册表边界与运行时切换**：`src/agents/AgentRegistry.ts` 仅存储自定义节点元数据，核心职能 Agent 实例仍驻留于 Facade 私有 Map；`WorkflowOrchestratorFacade` 目前硬编码读取 `AgentRegistry.default()`（未支持注入独立 `AgentRegistry` 实例）；此外 `Facade.reloadWorkflowDsl()` 仅替换 `this.dslConfig`，全局门禁与协商查询也会作用于已在途的其他 Run。
- 类型层面：自定义键以字符串流动（描述符类型别名复用 `WorkflowStageId`），枚举体系未破坏。

## 验证（tests/pluggable-nodes.spec.ts，6 项）

1. 注册表：注册/口径扩展/同键覆盖幂等/核心枚举覆盖拦截/非法键格式拦截
2. RBAC 映射：声明配置生效、缺省仅管理员、核心阶段硬表不受影响
3. DSL 新节点：自动注册 + 进入 stageOrder + 协商目标可指向自定义节点
4. 同一模板重复解析幂等
5. 核心枚举阶段未知角色仍被拦截
6. Facade 端到端：PM → 自定义检查点 → PD 流水线 COMPLETED + 检查点通知可见

另更新 `dsl-loader.spec` 既有断言（J2 后未知阶段键行为变更为自动收录，非法格式仍拒绝）。

**完成时测试基线**：133 项（129 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：169 项 / 48 套件 / 28 文件，165 过 / 4 既有 skip）
