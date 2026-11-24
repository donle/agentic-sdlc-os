# `P1-3`：Agent 真实代码补丁落盘、上下文预算裁剪、总管四工具接线与全库零跳过收口变更说明

> 对应总编排步骤：Step 9（`P1-3`）  
> 状态：**已验收完成**（2026-11-24）  
> 前置关联：[`REMEDIATION_ORCHESTRATION_PLAN.md`](./REMEDIATION_ORCHESTRATION_PLAN.md)、[`BACKEND_TODO.md`](./BACKEND_TODO.md) §六 `P1-3`

---

## 一、问题背景与根因分析

此前各核心模块在主链路已通过基本测试，但在 **Agent 代码真实写入 Worktree、上下文 Token 预算裁剪生效、总管工具/冲突仲裁泛化、终态目录保留及既有跳过用例** 五方面仍存在断环：

1. **Stage 3b 尚未实现 LLM 代码写回沙箱重测闭环**：`SoftwareEngineerAgent` 在 LLM 调用前先写入模板代码与单测并完成自测，LLM 返回的新代码或 QA 返修补丁未真正写入 Worktree 重新运行 `node:test` 与安全扫描。
2. **上下文预算裁剪 `TrimmedContext` 被丢弃**：`WorkflowOrchestratorFacade` 调用 `contextRegistry.resolve()` 获得的 `TrimmedContext` 未传入 `AgentExecutionInputContext`，`AbstractWorkerAgent.buildStagePrompt()` 仍从未经预算裁剪的 `runCache` 读取原始超长上下文；`STAGE_3B_ENGINEER` 声明的必填 `dependency_versions` 缺少本地真实 Provider；且 `ToolRegistry.clearRunCache()` 从未在终态释放缓存。
3. **`SupervisorAgent` 选项硬编码、白名单校验不完整且工具未对外接线**：`EscalateConflictToHumanCommand` 硬编码了 PD/PM 专用文案；`explicitTargetStageId` 跳过了 `allowedStages` 白名单检查；`supervisorTools.ts` 的 4 个工具函数尚未接入 `SupervisorAgent` 与 `WorkbenchServer`。
4. **I3 `COMPLETED` 终态钩子不可达且误扫 `docker-results/`**：`WorkflowRunState.advanceToNextStage()` 在最后一阶段完成后即把状态置为 `COMPLETED`，导致循环条件退出后再也走不到循坏头部的 `currentStageId === null` 分支；同时 `GitWorktreeSandboxManager.enforceWorktreeRetention()` 未排除 `docker-results/` 目录。
5. **全库留有 4 项既有 `it.skip` 用例**：包含 `tests/a1-llm-integration.spec.ts` Test 2/5（含向 `reloadWorkflowDsl()` 误传内联 YAML 字符串）及 `tests/test-result-parser.spec.ts` Test 3/5。

---

## 二、修复设计与实现清单

### 1. Worktree 安全补丁落盘、全量文件扫描与 `docker-results/` 隔离（`src/sandbox/GitWorktreeSandboxManager.ts`、`src/sandbox/TestResultParser.ts`）

- 新增 `GitWorktreeSandboxManager.applyFilePatches({ runId, branchId, patches })`：执行工作区前缀（`+ path.sep`）路径防穿越检查、禁止绝对路径与写入 `.git` 目录，将合法补丁真实落盘到对应分叉 Worktree。
- 扩展 `executeSandboxVerification()`：除脚手架文件外，递归扫描工作区 `src/` 下全部 `.ts`/`.js`/`.mjs` 进行安全扫描（`eval`/`new Function`/密钥泄露），并发现执行 `tests/` 下全部 `*.spec.ts`/`*.spec.js`/`*.spec.mjs` 套件。
- 修正 `enforceWorktreeRetention()`：当沙箱根目录不存在时直接安全返回，扫描目录时自动排除 `docker-results` 与隐藏目录（`!e.name.startsWith('.')`）。
- 完善 `TestResultParser.runSuite()` 异常超时判定：`killed === true || code === 'ETIMEDOUT' || signal === 'SIGTERM' || /ETIMEDOUT/i`，确保跨平台超时准确置位 `timedOut=true`。

### 2. Stage 3b LLM `filePatches` 落盘与重跑验证闭环（`StagePromptSpecs.ts`、`AbstractWorkerAgent.ts`、`SoftwareEngineerAgent.ts`）

- `STAGE_prompt_specs` (`STAGE_3B_ENGINEER`) 扩展可选字段 `filePatches: [{ filePath, content }]` 提示与 Schema 声明（不加入 `required`，完全兼容离线降级与旧 Mock）。
- `AbstractWorkerAgent` 新增可选生命周期钩子 `applyLlmPostProcessing(candidate, rawCandidate, context)`，在契约反序列化后、物理约束交叉验证前触发。
- `SoftwareEngineerAgent` 覆写 `applyLlmPostProcessing()`：提取并写入 `filePatches` 至当前分支 Worktree，随后重跑真实 `executeSandboxVerification()` 并更新有界 `preparedSandboxes` 记录；若补丁引入失败测试或安全风险且 LLM 谎报 `selfTestPassed: true`，`validateStageSpecificConstraints()` 立即拦截并注入 A2 自愈重试循环。

### 3. `DependencyVersionsProvider`、`TrimmedContext` 真实注入与按 `runId` 隔离清理（`DependencyVersionsProvider.ts`、`ToolRegistry.ts`、`AbstractWorkerAgent.ts`、`WorkflowOrchestratorFacade.ts`）

- 新增 `src/agents/context/DependencyVersionsProvider.ts`：解析工作区/工程根目录 `package.json` 的运行环境与依赖版本号（`isReal: true`，缺失时安全降级），并注册到 `WorkflowOrchestratorFacade` 的 `ToolRegistry`。
- `AgentExecutionInputContext` 新增 `trimmedExternalContext: TrimmedContext | null`；`AbstractWorkerAgent.buildStagePrompt()` 在非空时优先消费裁剪后的 `included` 列表并附带 `contextBudgetSummary`（仅无 Facade 注入时回落 `runCache`）。
- `ToolRegistry.clearRunCache(runId?)` 与 `ToolCallLoopGuard.clearScopePrefix()` 支持按 `runId` 精确清理缓存而不误伤并发运行中的其他 `runId`，同时提供 `getCacheEntryCount()` 供观测。

### 4. `SupervisorAgent` 动态冲突选项、`explicitTargetStageId` 白名单与四工具端到端接线（`SupervisorAgent.ts`、`supervisorTools.ts`、`WorkbenchServer.ts`）

- `EscalateConflictToHumanCommand.execute()` 动态截断拼装 `deadlockedTurn.optionAProposal` 与 `optionBProposal`，移除硬编码的 PD 标准/定制组件选项文案。
- `SupervisorAgent.parseNaturalLanguageRollback()` 当传入 `explicitTargetStageId` 且提供 `allowedStages` 时严格校验白名单，越界即显式拒绝。
- `supervisorTools.ts`（`overrideGate` / `rollbackAndFork`）补充透传 `impersonatedByLabel`；`SupervisorAgent` 新增 `getToolSchemas()` 与 `executeTool()`；`WorkbenchServer` 新增 `GET /api/supervisor/tools` 与 `POST /api/supervisor/tools`（含分工具 RBAC 权限码校验、`resolveRequestRunId` 与变更类操作 SSE 广播）。

### 5. `WorkflowOrchestratorFacade` `COMPLETED` 终态钩子与 `clearRunCache()` 闭环

- `continueExecutionUntilGateOrCompleteUnlocked()` 在退出 `RUNNING` 循环后检测 `runState.getStatus() === 'COMPLETED'`，补齐此前不可达的终态钩子调用。
- `onRunReachedTerminalState(runState)` 同步调用 `this.contextRegistry?.clearRunCache(runState.runId)` 与 `this.sandboxManager.enforceWorktreeRetention(...)`。

---

## 三、验收标准与测试结果

| 验收维度                                                                      | 覆盖测试文件与用例                                                                           | 实测结果                                                                                                     |
| :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| 3b LLM `filePatches` 落盘重跑与 A2 自愈                                       | `tests/full-pipeline-llm.spec.ts` Test 7                                                     | ✅ 通过（首轮错误补丁被 `node:test` 实测拦截触发重试，次轮补丁修复通过并真实落盘）                           |
| `DependencyVersionsProvider` + `TrimmedContext` 注入 + `clearRunCache(runId)` | `tests/agent-context.spec.ts` Test 12–13                                                     | ✅ 通过（真实读取 `package.json`，超预算 `api_inventory` 被裁剪带 `contextBudgetSummary`，隔离清理互不干扰） |
| `COMPLETED` 终态清理与排除 `docker-results/`                                  | `tests/data-retention.spec.ts` Test 6–7                                                      | ✅ 通过（`docker-results/` 原样保留，`COMPLETED` 自动清理旧目录并清空本 run 缓存）                           |
| 动态冲突标签、`allowedStages` 校验与 HTTP 工具端点                            | `tests/supervisor-tools.spec.ts` Test 5–7                                                    | ✅ 通过（动态读入 `optionA/BProposal`、白名单拦截、`GET/POST /api/supervisor/tools` + 403 RBAC）             |
| 激活全库既有 4 项 `it.skip` 用例                                              | `tests/a1-llm-integration.spec.ts` Test 2 & 5、`tests/test-result-parser.spec.ts` Test 3 & 5 | ✅ 4 项全部激活通过（全库实现 **0 跳过**）                                                                   |
| 全量构建、格式化、双端类型检查、ESLint 与单测                                 | `npm run build:ui && npm run format && npm run check`                                        | ✅ **200 tests / 53 suites / 31 spec files（200 pass / 0 skipped / 0 fail）**                                |
