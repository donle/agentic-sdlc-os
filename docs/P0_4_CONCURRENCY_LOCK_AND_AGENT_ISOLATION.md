# P0-4 变更说明：同 `runId` 异步并发互斥锁与共享 Agent 状态隔离

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 2 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-4`）。

---

## 一、问题背景与根因

1. **同 `runId` 写操作缺少串行互斥保护**：`WorkflowOrchestratorFacade` 是服务器级单例；当多个客户端或标签页同时对同一个 `runId` 发起 `submitHumanGateDecision()`、`retryAbortedStage()`、`invokeSupervisorConversationalRollback()` 或 `continueExecutionUntilGateOrComplete()` 时，异步 LLM/沙箱等待期间控制权让出，后到的请求会基于过期状态推进阶段或写入冲突决策；同时 `submitHumanGateDecision()` 未校验快照是否仍处于 `PENDING_HUMAN_GATE` 状态，并发重复签核同一快照会导致多次决策入账与阶段索引错乱。
2. **共享单例 Agent 实例保存单次准备结果**：`SoftwareEngineerAgent.lastPreparedSandbox` 与 `QualityAssuranceAgent.lastPreparedVerification` 均为单实例单一字段。当两个不同 `runId` 并发执行 Stage 3b/4 时，后进入 `prepareStageEnvironment()` 的运行会覆盖前者缓存；先进入的运行完成 LLM 推理并执行 `validateStageSpecificConstraints()` 时，会因缓存 key 不匹配而静默返回空违规数组，导致防谎报校验失效。

---

## 二、核心修改内容

### 1. 按 `runId` 隔离的异步互斥锁与门禁状态守卫（[WorkflowOrchestratorFacade.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/engine/WorkflowOrchestratorFacade.ts#L536-L565)）
- 新增 `runExecutionLocks = new Map<string, Promise<void>>()` 与 Promise 链式排队辅助 `withRunLock(runId, operation)`：
  - 同 `runId` 的写操作严格排队串行，不同 `runId` 保持并行互不阻塞；
  - 节点退出 `finally` 时释放门闸并在尾部仍为当前链节点时清理 Map 键，避免内存泄漏。
- 拆分公开入口与 `*Unlocked` 内部委托方法，杜绝重入死锁：
  - 公开加锁入口：`startProposalWorkflow`、`continueExecutionUntilGateOrComplete`、`retryAbortedStage`、`submitHumanGateDecision`、`invokeSupervisorConversationalRollback`；
  - 内部委托（如 `submitHumanGateDecisionUnlocked` 在 `APPROVE`/`REJECT`/`RETRY` 分支调用 `continueExecutionUntilGateOrCompleteUnlocked`、`retryAbortedStageUnlocked`、`invokeSupervisorConversationalRollbackUnlocked`）全部走无锁版本。
- 在 `submitHumanGateDecisionUnlocked` 中增加快照状态守卫：若 `snapshot.getState() !== SnapshotLifecycleState.PENDING_HUMAN_GATE`，直接抛出明确错误禁止重复裁决。

### 2. 共享基类键控与有界状态隔离（[AbstractWorkerAgent.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/agents/AbstractWorkerAgent.ts#L761-L785)）
- 在 `AbstractWorkerAgent` 新增受保护工具方法 `buildPreparedContextKey(context)`（`${runId}::${branchId}::${humanFeedbackDirective ?? ''}`）与 `saveBoundedPreparedState(store, key, value, maxEntries = 64)`，供子类复用并防止无界膨胀。

### 3. Engineer 与 QA 沙箱准备状态多 Run 隔离
- [SoftwareEngineerAgent.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/agents/SoftwareEngineerAgent.ts#L41-L157)：将 `lastPreparedSandbox` 替换为 `preparedSandboxes = new Map<string, PreparedSandboxEntry>()`，`ensureSandboxProvisioned` 与 `validateStageSpecificConstraints` 均按键精确读写。
- [QualityAssuranceAgent.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/agents/QualityAssuranceAgent.ts#L41-L155)：将 `lastPreparedVerification` 替换为 `preparedVerifications = new Map<string, PreparedVerificationEntry>()`，并发跑不同 `runId` 时互不覆盖防谎报校验依据。

---

## 三、测试与验收结果

- **新增测试（[tests/concurrency-and-cache.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/concurrency-and-cache.spec.ts#L176-L387)）**：
  - Test 3：同 `runId` 并发提交两次同一门禁签核（带异步延迟 mock transport）→ 仅 1 次成功、另 1 次被状态守卫拦截、快照人工裁决仅 1 条。
  - Test 4：`DecisionVerdict.REJECT` 内部委托 `invokeSupervisorConversationalRollbackUnlocked` 不发生重入死锁，正常创建 `branch-v2-rollback-*` 新分支并暂停门禁。
  - Test 5：并发推进 `PROP-P04-FAIL`（`forceQaFailure: true` + 延迟制造穿插 + LLM 谎报通过）与 `PROP-P04-PASS` → `PROP-P04-FAIL` 准确触发 QA 防谎报拦截并置为 `ABORTED`，`PROP-P04-PASS` 正常停在 Stage 4 终审门禁。
- **全量回归结果**：
  - `node --test tests/concurrency-and-cache.spec.ts`：12/12 通过。
  - `npm run typecheck:backend && npm run lint:backend`：0 错误通过。
  - `npm test`：178 项测试 / 50 套件（174 通过 / 4 既有跳过 / 0 失败）。
