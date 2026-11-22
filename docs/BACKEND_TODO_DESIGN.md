# 后端改造逐项执行方案（代码设计定稿）

> [!IMPORTANT]
> 本文是 `docs/BACKEND_TODO.md` 的**配套设计文档**：对其中每一项给出可落地的代码设计（接口签名 / 数据流 / 边界与自验 / 验证方案 / 备选取舍）。
> 编号与 TODO 清单一一对应（A1…J2）。完成设计评审后按里程碑顺序执行；执行中若与本文冲突，先改本文再改代码。
>
> 审计基线日期：2026-11-22（React 前端 + TypeScript 仿真内核版本）。

> [!NOTE]
> **执行状态（2026-11-23 更新）**：§一~§三（M1-A/B/C + M2）全部条目已实现并测试通过——实际实现与本设计的偏差记录在各条目的实现文档中
> （如 G1/G2 的 `EmbeddingProvider`、E3 的 docker CLI 替代 dockerode、A4 的 `__intent` 随主调用返回）；逐条见 `BACKEND_TODO_IMPL_LOG.md`。
> §四（M3）剩余条目的实施决策见 `P2_REMAINING_PLAN.md`。

---

## 〇、全局设计决策（横切所有条目）

以下 5 个决策在多项设计中复用，先在此定稿，避免每项重复论证。

| #                                                               | 决策                                                                                                                                                      | 理由 / 备选取舍                                                                                                       |
| :-------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| **D-1 适配器优先，IO 分层**                                     | LLM 的"取数-调网关-解析"全部收敛在 `AbstractWorkerAgent`（模板方法）与两个新模块 `prompt/`、`deserialize/` 内；`*ArtifactContract` 保持纯数据类不动。     | 契约类是全系统信任锚点，混入 IO 会污染序列化/反序列化与缓存。备选"每个 Agent 自行调 LLM"被否：7 份重复重试/解析逻辑。 |
| **D-2 一切外部依赖可降级**                                      | PG / git / docker / LLM / embedding 全部通过环境开关启用，关闭时回落到现有仿真实现并在结果对象上带显式标记（`simulated/degraded/usedFallbackTemplate`）。 | 单机私有化是硬约束（设计报告 §7.3）；演示与测试环境必须可零依赖启动。                                                 |
| **D-3 同步编排保留，用"SSE 桥"实现逐事件推送**（C1 的核心取舍） | 不引入 Redis/队列：EventBus 增加第二个观察者（SSE 桥），阶段执行过程中实时写帧给所有已连接客户端。                                                        | 真异步队列是为并发与长任务隔离服务的；当前单机、单 run 串行执行，收益不抵运维成本。边界与迁移条件见 C1。              |
| **D-4 演示数据走场景注册表，不走领域契约**（J1）                | `simulate*` 三个字段从 `ProjectProposalContract` 移到运行时 `ScenarioHints`（由服务端 preset 注入，不持久化到契约）。                                     | 契约是审计与持久化对象，演示开关混入会污染真实提案的数据模型。                                                        |
| **D-5 所有新增错误必须有"人可读 + 可操作"的出口**               | 新增失败类型（预算超限/契约失败/网关不可达/裁决失败）统一走 `AgentUserNotification` + 状态机暂停，禁止静默吞掉或裸抛到 HTTP 500。                         | 现状 `executeStagePipeline` 抛错会直接打穿 POST handler 变 500，用户无感知修复路径。                                  |

**新增文件总览**（后续条目只引用不重复展开）：

```
src/agents/prompt/StagePromptSpecs.ts        # 每阶段的 system/user prompt 规格表 (A1)
src/agents/deserialize/ArtifactContractFactory.ts  # LLM JSON → 强类型契约 + 违规收集 (A1/A2/D1)
src/agents/prompt/JsonExtractor.ts           # 从 LLM 文本中稳健提取 JSON (A1)
src/server/auth/SessionService.ts            # 登录会话/口令哈希 (F1)
src/engine/pg/PgPersistenceDriver.ts         # PostgreSQL 驱动 (D2)
src/engine/pg/StateReconstructor.ts          # 持久化快照 → 内存状态机重建 (D1/D2)
src/agents/supervisorTools.ts                # 总管四工具契约 (C2)
src/sandbox/RealGitWorktree.ts               # 真实 git worktree 封装 (E1)
src/sandbox/TestResultParser.ts              # node --test TAP/覆盖率解析 (E2)
src/server/SseBridge.ts                      # EventBus → SSE 逐事件帧桥 (C1/D3)
```

---

## 一、M1-A 真 AI 内核

### A1 Agent 产物生成接入真实 LLM（P0）

**涉及文件**：改 `src/agents/AbstractWorkerAgent.ts`、6 个 Agent 子类；新增 `prompt/StagePromptSpecs.ts`、`prompt/JsonExtractor.ts`、`deserialize/ArtifactContractFactory.ts`；改 `src/patterns/ModelRouterGateway.ts`（超时）。

**代码设计**

1. Prompt 规格（每个阶段一份，静态表）：

```ts
// prompt/StagePromptSpecs.ts
export interface StagePromptSpec {
  readonly systemPrompt: string; // 角色职责 + 公司规范 + 输出纪律（"仅输出 JSON"）
  readonly taskInstruction: string; // 该阶段做什么
  readonly jsonSchemaHint: string; // 输出 JSON 的字段清单与必填约束（与 *Contract 字段一一对应）
}
export const STAGE_PROMPT_SPECS: Record<WorkflowStageId, StagePromptSpec>;
```

2. `AbstractWorkerAgent` 模板方法改造（步骤 4 替换，其余 6 步不动）：

```ts
// AbstractWorkerAgent.ts（新增/修改成员）
protected abstract synthesizeTemplateArtifact(context, attemptIndex): TArtifact;   // 原 synthesizeArtifact 改名，仅作降级
private lastReceipt: ModelInvocationReceipt | null = null;
private usedFallbackTemplate = false;

protected buildStagePrompt(context, attemptIndex, violations: string[]): StagePromptInput {
  const spec = STAGE_PROMPT_SPECS[this.stageId];
  const upstream = [...context.upstreamArtifacts].map(([id, a]) => ({ stageId: id, summary: a.summary, keyFields: summarize(a) }));
  const userPrompt = JSON.stringify({
    proposal: { title, summary, requirementDescriptions, involvesDatabaseMigration, involvesPermissionOrPayment },
    upstreamArtifacts: upstream,
    rejectionLessons: context.historicalRejectionLessons,        // 负向经验注入
    humanDirective: context.humanFeedbackDirective,              // 回退/修复指令
    priorViolations: violations.slice(0, 5),                     // A2 自愈
    attemptIndex,
  });
  return { systemPrompt: spec.systemPrompt, userPrompt: `${spec.taskInstruction}\n${spec.jsonSchemaHint}\n${userPrompt}` };
}
```

3. 执行路径（替换原"估算 → MeterInvocation → synthesize"）：

````ts
// AbstractWorkerAgent.executeStagePipeline 步骤 4 内部
const prompt = this.buildStagePrompt(context, attemptIndex, retryReasons);
const llm = await this.modelRouter.invokeChatCompletion({
  tier: this.modelTier,
  systemPrompt: prompt.systemPrompt,
  userPrompt: prompt.userPrompt,
  fallbackContentGenerator: () =>
    JSON.stringify(this.synthesizeTemplateArtifact(context, attemptIndex)), // D-2 降级
});
this.lastReceipt = llm.receipt; // A3: 真实 usage
this.usedFallbackTemplate = !llm.usedLiveGateway;
const raw = JsonExtractor.extract(llm.content); // 剥 ```json 围栏 / 截取首尾大括号
const parsed = ArtifactContractFactory.parse(this.stageId, raw);
if (!parsed.ok) throw new ContractSynthesisError(parsed.violations); // 交由 A2 重试循环捕获
candidate = parsed.artifact;
````

4. `ArtifactContractFactory.parse(stageId, raw)`：每阶段一个 `fromJson`（如 `PrdArtifactContract.fromJson(raw)` 直接加在各契约类上，工厂只做分发）。**契约类的 `fromJson` 只做字段映射与默认值填充，不做业务校验**（校验仍走 `validateContractIntegrity`）。

5. `ModelRouterGateway` 补超时：`fetch` 加 `AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 60000))`；超时走现有 catch → 降级。

**边界与自验**

| #   | 边界场景                                                        | 处理                                                                                                                 |
| :-- | :-------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| 1   | LLM 返回散文/带 ```json 围栏                                    | `JsonExtractor`：剥围栏 → 找首个 `{` 与最后一个 `}` 截取 → `JSON.parse` 失败记违规 `OUTPUT_NOT_JSON` 交 A2 重试      |
| 2   | JSON 合法但缺必填字段                                           | `fromJson` 填默认值 → `validateContractIntegrity` 报违规 → A2 重试；重试耗尽 → FAILED_CONTRACT（见 A2 出口 D-5）     |
| 3   | 网关超时/不可达                                                 | AbortSignal 超时 → catch → `fallbackContentGenerator`（模板）→ `usedFallbackTemplate=true`，遥测与快照标注降级原因   |
| 4   | LLM 返回的字段值含注入文本（如 requirement 描述里塞"忽略上文"） | P0 接受风险并记录：prompt 中用户输入段用 JSON 序列化包裹（非拼接指令），并在 A4 体检中加注入检测样例；不做运行时拦截 |
| 5   | usage 缺失                                                      | 适配器现有长度估算兜底，新增 `usageEstimated` 标记（A3 区分）                                                        |
| 6   | 产物删需求（虚假共识）                                          | 流程不变：步骤 5 FalseConsensusGuard 在解析后照常执行，与 A1 正交                                                    |
| 7   | 极大输出截断                                                    | `jsonSchemaHint` 要求精简字段；`JsonExtractor` 截取失败按场景 1 重试                                                 |
| 8   | 并发两次提案                                                    | Agent 实例无状态（每次执行用 context），共享的 cache/mediator 均按 runId 隔离读——安全；LLM 调用串行（单进程 await）  |

**验证方案**：单测用 `setHttpTransport` 注入 mock transport（成功/坏 JSON/缺字段/超时四用例）；集成验证 `LITELLM_ENABLE_LIVE_HTTP=true` + 真实 Ollama 跑一次完整提案。

---

### A2 自愈重试真实化（P0）

**涉及文件**：`AbstractWorkerAgent.ts`（重试循环）、`Facade`（失败出口）。

**代码设计**

```ts
// 重试循环改造（伪码，替换 AbstractWorkerAgent.ts:281-330）
let violations: string[] = [];
while (attemptIndex <= this.maxExecutionRetries) {
  if (attemptIndex > 0) {
    prompt += repairSuffix(violations);   // "上次输出违反：…；仅输出修正后的 JSON"
  }
  try {
    candidate = await this.executeLlmAttempt(context, attemptIndex, violations);   // A1 路径
    const v = candidate.validateContractIntegrity();
    if (v.isValid()) break;
    violations = v.getViolations();
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) throw err;              // B3 不重试
    violations = [err instanceof ContractSynthesisError ? ...err.violations : String(err)];
  }
  retryCount += 1; attemptIndex += 1;
}
if (!candidate) { /* FAILED_CONTRACT trace（现状保留） */ throw new StageContractError(stageId, retryReasons); }
```

失败出口（D-5）：`Facade.continueExecutionUntilGateOrComplete` 外层 try/catch `StageContractError` → `runState.setStatus('ABORTED')` + `AgentUserNotification`（新增 `NotificationCategory.STAGE_CONTRACT_FAILED`，标题含阶段与违规摘要，actionOptions=[重试本阶段 / 中止项目]）→ `break`。重试耗尽不再打穿 HTTP。

**边界与自验**：①违规列表截断前 5 条防 prompt 膨胀；②重试间 token 累加进 `retryOverheadTokens`（现状保留）；③`forceTransientRetryOnce` 删除（J1），Facade 的 `simulateTransientRetryOnFirstStage` 参数一并移除；④重试期间缓存不写（现状：仅成功且无 ScopeCut 才回填，保持）。

---

### A3 Token/成本计量真实化（P0）

**代码设计**：删除 `estimateTokenUsage` 抽象方法；`AgentExecutionOutcome` 增加 `usageEstimated: boolean`、`usedFallbackTemplate: boolean`、`degradedReason?: string`；`tokensConsumed/costUsd` 直接取 `lastReceipt`（缓存命中路径保持 0）。`PromptCacheManager.storeVerifiedArtifact.estimatedTokens` 改传真实值。`IntentExecutionTraceRecord` 字段不变（语义已是"消耗"）。

**边界**：①`MeterInvocation` 保留但仅在降级路径为 receipt 提供估算；②成本计算仍按 DSL `costPer1kTokensUsd`（A4 体检时可校准单价）；③快照 `tokensConsumed` 为该阶段单值，run 级累计见 B3。

---

### B3 DSL 守卫字段全量接线（P0）

**代码设计**

```ts
// WorkflowRunState 新增
private tokensUsedTotal = 0;
public recordTokenUsage(delta: number): void { this.tokensUsedTotal += delta; }
public getTokensUsedTotal(): number { return this.tokensUsedTotal; }
// WorkflowRunStatus 扩展
export type WorkflowRunStatus = 'RUNNING' | 'PAUSED_AT_HUMAN_GATE' | 'COMPLETED' | 'ABORTED' | 'ABORTED_TOKEN_BUDGET';
// AgentExecutionInputContext 新增
readonly tokenBudgetRemaining: number;   // Facade 每阶段计算：budget - tokensUsedTotal
```

- Agent 内每次 attempt 前检查：`if (budgetRemaining !== -1 && estimatedTotal > budgetRemaining) throw new TokenBudgetExceededError(...)`（估算 = 已发 prompt 长度/3 + `jsonSchemaHint` 长度/3，宁可保守）。
- Facade 循环头：`runState.getTokensUsedTotal() >= budget` → 直接 `setStatus('ABORTED_TOKEN_BUDGET')` + 通知（新 `NotificationCategory.TOKEN_BUDGET_EXCEEDED`，actionOptions=[提高预算后继续 / 中止]）→ break。
- `maxExecutionRetries`：Facade 构造 `sharedAgentDeps` 时从 `dslConfig.guardrails.maxExecutionRetries` 传入（`AbstractWorkerAgent` 构造参数已存在，仅接线）。
- `WorkflowDslLoader` 新校验：`tokenBudgetLimit >= 1000`，否则 parse 抛错。
- 持久化：`persistFullState.runs[]` 增加 `tokensUsedTotal`（供 D1 恢复）。

**边界与自验**：①预算设 1000 → 首 Agent 首次 attempt 即抛，状态 `ABORTED_TOKEN_BUDGET`，通知可操作；②缓存命中阶段消耗 0，不误触发；③预算恰好卡在中间值时"估算保守 + 超出即停"，宁可提前熔断不超支；④提高预算后继续 = 人工"重试本阶段"（走现有门禁重试路径），不自动续跑。

**验证**：单测预算三态（未到/恰好/超限）；DSL 校验负例。

---

### J1 演示开关迁出领域契约（P0，随 A1/B2 执行）

**代码设计**：

```ts
// 新类型（不入持久化契约）
export interface ScenarioHints {
  readonly forceNegotiationDeadlock?: boolean; // 原 simulateNegotiationConflict
  readonly forceScopeReduction?: boolean; // 原 simulateScopeReductionAttempt
  readonly forceTransientRetry?: boolean; // 原 simulateTransientRetryOnStage1（A2 后由注入瞬态故障实现）
}
// startProposalWorkflow({ proposal, initiatorActor, scenarioHints?: ScenarioHints })
// WorkflowRunState 增加 private scenarioHints（不进 toSerializableRecord 的契约区，仅 run 元数据）
```

- `ProjectProposalContract` 删除三个 simulate 字段及其校验；服务端 preset 端点把 preset 名映射为 `ScenarioHints`；A2 的瞬态故障改为 transport 层注入（测试）或 ScenarioHints（演示）。
- 兼容：旧持久化快照里若带 simulate 字段，恢复时忽略。

---

## 二、M1-B 可信工程

### E1 真实 Git Worktree（P0）

**涉及文件**：改 `GitWorktreeSandboxManager.ts`；新增 `src/sandbox/RealGitWorktree.ts`。

```ts
export class RealGitWorktree {
  constructor(private repoPath: string) {}
  add(runId: string, branchId: string): { workspacePath: string; branchName: string } {
    const branch = `worktree/${runId}/${branchId}`;
    const target = path.join(this.worktreeRoot, safe(runId), safe(branchId));
    // 1) 分支已存在？git rev-parse --verify refs/heads/<branch> → 加 -v2 后缀
    // 2) git -C repo worktree add <target> -b <branch>
    // 3) 失败（路径脏/锁）：git worktree prune 后重试一次；仍失败 → throw WorktreeError
  }
  remove(branchName: string, target: string): void; // git worktree remove --force + git branch -D
  static isGitAvailable(): boolean; // git --version 探测
}
```

- `GitWorktreeSandboxManager` 构造参数加 `{ repoPath?: string }`（env `GIT_REPO_PATH`）；`provisionWorktreeAndWriteCode` 内：repoPath 存在且 `isGitAvailable()` → 真实 worktree（在目标目录内写代码文件，**不再伪造 .git**）；否则走现模拟路径并在结果上置 `simulated: true`。
- 新增 `cleanupWorktree(runId, branchId)`（Facade 在 run COMPLETED/ABORTED 后调用，I3 定归档策略）。

**边界与自验**：①分支重名 → 自动 `-v2` 后缀并复验；②目录已存在 → 先 prune 再重试一次，仍失败抛 `WorktreeError`（D-5 出口：阶段失败通知）；③repoPath 不存在/非 git 仓库 → 启动时探测并降级 simulated + 启动日志 WARN；④Windows 路径分隔符 → 全部 `path.join`；⑤fork 回退 = 新 branchId 新 worktree，旧 worktree 保留至 cleanup（不误删历史）。

**验证**：集成测试用临时 `git init` 仓库跑 provision → 断言 `git worktree list` 包含分支、主仓工作区无脏文件。

### E2 测试结果真实采集（P0）

**代码设计**：

```ts
// 新 src/sandbox/TestResultParser.ts
export interface ParsedTestResults {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  coveragePercent: number | null; // 覆盖率不可用则为 null
  suites: ReadonlyArray<{ name: string; total: number; passed: number; failed: number }>;
  rawOutput: string;
  timedOut: boolean;
}
export function parseNodeTestTap(tapOutput: string): ParsedTestResults; // # pass N / # fail M
```

- `provisionWorktreeAndWriteCode` 额外写入 `package.json`（`{"type":"module"}`）。
- `executeSandboxVerification`：命令改为
  `node --test --test-reporter=tap --test-timeout=8000 tests/`（一次子进程跑全部，替代逐文件 exec）；
  TAP 解析得真实 `totalCases/passedCases`；覆盖率用第二次可选命令 `node --test --experimental-test-coverage`（解析 `all files` 行），失败/不支持 → `coveragePercent: null`。
- 删除 `totalTestCases = 需求×6` 与 "95.6%" 硬编码；`SandboxVerificationResult` 增加 `coverageAvailable: boolean`。
- QA Agent（A1 后）prompt 注入真实 `ParsedTestResults` JSON；`QaVerificationArtifactContract.testSuitesExecuted` 由 LLM 按真实数据整理；`allAcceptanceCriteriaMet` 与真实 failedCases 联动校验（契约校验新增规则：`allAcceptanceCriteriaMet===true` 时 `passedCases===totalCases`，防止 LLM 谎报）。

**边界与自验**：①单测进程超时 → `timedOut=true`、该套件计 failed，触发 B2 修复闭环；②无测试文件 → 全 0 + 警示，QA 直接阻塞（不谎报）；③TAP 解析失败 → 保留 rawOutput，计数 0，`parseFailed=true`；④覆盖率命令不被支持 → null 不阻塞主流程；⑤安全扫描（eval/硬编码密钥正则）保持现状。

**验证**：单测三种 fixture（全过 / 一条失败 / 超时）；端到端在 3b 手动注入失败断言 → QA 报告真实反映 → B2 自动打回。

### B2 QA↔Engineer 修复闭环 + 协商路由（P0）

**代码设计**

```ts
// WorkflowDslConfiguration 增加（WorkflowDslLoader 已解析，无需改）
findNegotiationTarget(stageId): WorkflowStageId | null;   // = negotiateWithStageId
// Facade：替换 STAGE_2_PD 硬编码分支
const target = this.dslConfig.findNegotiationTarget(currentStageId);
if (target && this.shouldNegotiate(currentStageId, artifact, runState)) {
  const challenge = this.buildChallenge(currentStageId, artifact);   // PD: designChallengeNote；QA: 失败报告
  const neg = this.negotiationMediator.mediateChallenge({
    runId, branchId, stageId: currentStageId,
    challengerRole, responderRole: this.counterpartRole(target),
    initialChallengePoint: challenge,
    forceDeadlockToMaxTurns: runState.scenarioHints?.forceNegotiationDeadlock === true,   // J1
  });
  ...
}
private shouldNegotiate(stageId, artifact, runState): boolean {
  if (stageId === STAGE_2_PD) return artifact instanceof UiDesignArtifactContract && artifact.designChallengeNote !== null;
  if (stageId === STAGE_4_QA) {
    const qa = artifact as QaVerificationArtifactContract;
    return !qa.allAcceptanceCriteriaMet || qa.securityIssuesFound > 0
      && this.getAutoRepairCount(runState.runId, 'QA_TO_ENG') < MAX_AUTO_REPAIRS;   // 防死循环，MAX=2
  }
  return false;
}
```

- 协商一致（consensus）后：以协商结论作为 `humanDirective` 自动 `forkAndRollbackToStage(STAGE_3B, directive)` 重跑 3b→4；`runState.recordAutoRepair(runId, 'QA_TO_ENG')` 计数。
- 超限熔断（escalated）：走现有 `EscalateConflictToHumanCommand`，方案 A/B 由 B1 的 LLM 生成（A1 前： mediator 通用兜底文案）。
- `NegotiationTurnRecord` 增加 `topic: 'DESIGN_REVIEW' | 'QA_REPAIR'` 字段（区分两类协商，前端分栏显示）。

**边界与自验**：①死循环防护：`MAX_AUTO_REPAIRS=2`，超过即强制人工门禁（不再是协商）；②修复指令必须随轮次递增（缓存键含 `feedbackInstruction`——指令带 `第 N 轮修复：` 前缀，否则命中旧缓存返回同样失败产物，这是**关键边界**）；③repair 后旧分支 QA 快照 SUPERSEDED（现有 fork 算法覆盖，target=STAGE_3B 时仅 QA 快照废弃）；④QA 与 3b 之间的 DSL 声明（`negotiateWithStageId: STAGE_3B_ENGINEER`）即路由依据，纯后端模板（backend_api_only.yaml）无此字段则不协商；⑤修复后再次全绿 → 正常推进，autoRepair 计数保留入审计。

**验证**：E2 的"必失败"fixture → 断言 3b 重跑、第 2 轮修复计数、超限上仲裁三条路径。

### D1 启动恢复闭环（P0）

**涉及文件**：改 `PersistenceRepository.ts`、`DagWorkflowStateEngine.ts`、`WorkbenchServer.ts`；新增 `engine/pg/StateReconstructor.ts`（D2 复用）。

**代码设计**

1. 序列化补全（现状缺的字段）：

```ts
// PersistedLedgerSnapshot.runs[] 扩展
{
  ...现状字段,
  proposal: ProjectProposalContract.toSerializableRecord(),   // 新增契约序列化方法（J1 移除 simulate 后字段干净）
  stagePipeline: WorkflowStageId[],
  currentStageIndex: number,
  branchCounter: number,
  branchHistory: string[],
  tokensUsedTotal: number,
  scenarioHints?: ScenarioHints,
}
// 快照 artifactDetails → ArtifactContractFactory.parse(stageId, raw) 反解
// 新增顶层 liveEvents: WorkflowDomainEvent[]（最近 200 条环形，替代 EventBus 内存丢失）
```

2. `StateReconstructor.restore(snapshot, targets: {stateEngine, auditLedger, mediator, eventBus, cache?})`：

- 每个 run → `WorkflowRunState.fromPersisted(payload)`（新增静态方法：重建 proposal/private 字段，挂载反解后的 `StageSnapshotMemento`，lifecycleState 走 `initialState` 参数）；
- `humanDecisions`/`negotiationLogs` 用 `static fromJSON` 重建；**驳回经验不再重放 WAL**（避免 RAG 双计），RAG 记录直接从 `negativeExperienceRecords` 反解进引擎；
- `eventBus.restoreHistory(liveEvents)` + notifications 从 decisions 侧重建"未决待办"（resolved 状态由通知记录推导）。

3. `WorkbenchServer` 启动逻辑：

```ts
const canRestore = fs.existsSync(ledgerPath) && process.env.SEED_DEMO_DATA !== 'true';
if (canRestore) { try { reconstructor.restore(...) } catch { log.warn('恢复失败，转入演示播种'); seed(); } }
else if (process.env.SEED_DEMO_DATA === 'true') { seed(); }
```

**边界与自验**：①`ledger-store.json` 损坏 → try/catch 捕获 → 备份为 `.corrupt-<ts>` 后播种（D-2 降级）；②`schemaVersion` 不匹配 → 同上；③JSONL WAL 只追加不回放（幂等）；④恢复后 SSE 帧序号（D3）重置可接受（全量帧兜底）；⑤恢复后 `negotiationMediator.maxNegotiationTurns` 需按 DSL 重设（当前实例化即构造，无状态）；⑥contract `fromJson` 未知字段忽略（向前兼容）。

**验证**：集成测试——创建运行+裁决+回退 → 进程内新建 Facade restore → 断言 runs/snapshots/decisions/事件历史一致。

### D2 PostgreSQL 真实直连（P0）

**代码设计**

```ts
// src/engine/pg/PgPersistenceDriver.ts
export interface PersistenceDriver {
  saveFullState(snapshot: PersistedLedgerSnapshot): Promise<void>;
  loadFullState(): Promise<PersistedLedgerSnapshot | null>;
  appendAudit(entry: AuditTrailEntry): Promise<void>;
}
export class PgPersistenceDriver implements PersistenceDriver {
  /* pg Pool，upsert 5 表 */
}
export class JsonPersistenceDriver implements PersistenceDriver {
  /* 现有文件逻辑包装 */
}
// PersistenceRepository 构造：DATABASE_URL 存在 → Pg，否则 Json；写入失败重试 1 次 → 降级内存 + ERROR 日志
```

- 依赖：`npm i pg @types/pg`（可选依赖，bundle 侧 pg 仅服务端使用——服务端直接 node 运行，无打包问题）。
- SQL 与 `init-pgvector-schema.sql` 对齐（5 表 upsert，`rejected_history_rag.embedding` 先写哈希向量）。
- 边界：①PG 启动不可达 → WARN + 自动回落 Json（D-2）；②写 PG 失败但内存成功 → 继续运行，恢复时以 JSON 兜底；③`jsonb` 字段用参数化查询防注入（现有 `escapeSql` 字符串拼接仅保留在导出工具中）；④连接池 max=5；⑤事务：saveFullState 单事务包裹（避免半写）。

**验证**：compose 环境集成测试——写入 → psql 断言 → 清空内存 → loadFullState 恢复 → 数据一致。

### F1 登录会话与身份校验（P0）

**涉及文件**：新增 `src/server/auth/SessionService.ts`；改 `WorkbenchServer.ts`（resolveActor、路由守卫）、`RbacGovernanceService.ts`（移除 admin 兜底）。

```ts
export class SessionService {
  constructor(usersFile?: string); // .runtime-data/users.json，缺省从花名册播种（密码=用户名，首登强制改密标记）
  login(username, password): { token: string; user: EnterpriseUserAccount } | null; // scrypt 校验 + timingSafeEqual
  validate(token): EnterpriseUserAccount | null; // Map<token,{userId,expires}> 8h 滑动续期
  logout(token): void;
  changePassword(userId, old, next): boolean;
}
```

- Cookie：`Set-Cookie: sdlc_session=<token>; HttpOnly; SameSite=Lax; Path=/`（同源部署，无需 Secure 强制，但 compose 生产加 `COOKIE_SECURE=true` 开关）。
- `resolveActor` 重写：`AUTH_DISABLED=true`（本地开发/现有测试）→ 走旧逻辑；否则必须有效 session，401 JSON `{ok:false,error:'未登录'}`；`X-Actor-Id` 仅在 session 用户为 admin 时允许模拟其他成员（保留演示能力）。
- `RbacGovernanceService.getUserOrDefault` 改为 `getUserStrict`（未知 → throw RBACError → 403）。
- 前端：`App.tsx` 增加 401 拦截 → 渲染登录表单组件（新 `views/LoginView.tsx`，30 行）。

**边界与自验**：①登录失败 5 次锁定 60s（内存计数）；②token 过期滑动续期（每次校验刷新 expires）；③并发登录允许多会话；④退出清 Map；⑤SSE 连接同样走 cookie 校验（浏览器自动带）；⑥`AUTH_DISABLED=true` 时静默跳过（现有 19 项测试与本地开发零改动）；⑦口令存储：`scrypt(password, salt, 64)` + 每用户随机 salt。

### F2 用户管理 API（P1）

`/api/admin/users` GET/POST/PATCH（admin-only，SessionService 校验）：创建（校验 ownedStageIds ∈ 枚举）、改角色/授权、停用（停用即吊销其活跃 session）。持久化复用 users.json → D2 后迁 PG。

---

## 三、M2 智能增强

### C1 异步化替代方案：SSE 逐事件桥（P1，采纳全局决策 D-3）

**代码设计**

```ts
// src/server/SseBridge.ts —— 实现 IWorkflowEventObserver
export class SseBridge implements IWorkflowEventObserver {
  private seq = 0;
  constructor(private broadcast: (sseFrame: string, eventName: string, id: string) => void) {}
  onWorkflowEvent(event) {
    this.broadcast(JSON.stringify({ type: 'run_event', event }), 'run_event', String(++this.seq));
  }
  onUserNotification(n) {
    this.broadcast(
      JSON.stringify({ type: 'user_notification', notification: n }),
      'user_notification',
      String(++this.seq),
    );
  }
}
// Facade：阶段快照落库后追加 broadcast('stage_snapshot', {...摘要})
// WorkbenchServer.start(): eventBus.registerObserver(new SseBridge((frame, name, id) =>
//   this.sseClients.forEach((res) => res.write(`id: ${id}\nevent: ${name}\ndata: ${frame}\n\n`))));
```

- `POST /api/proposals` 仍是同步长请求（返回最终全量帧）；客户端在期间实时收到 `run_event` 帧（前端 `App.tsx` SSE 处理器新增分支：`run_event` → 仅更新"进行中"指示，最终以 `state_updated` 全量帧对账）。
- **迁移条件**（何时升级为真异步队列）：出现 ①多项目并行执行互相阻塞（LLM 串行等待 >10min），或 ②单阶段任务 >5min 需要跨进程恢复。届时把"阶段执行器"抽出为独立 Worker，POST 仅入队；接口不变。
- 边界：①客户端中途断开不影响执行（同步代码不依赖响应对象）；②SSE 写失败（客户端已断）→ 从 sseClients 移除（现有逻辑）；③帧序号全局自增，D3 重放据此实现；④事件帧不含制品全量（体积控制），全量靠 state_updated。

### C2 总管四工具契约（P1）

```ts
// src/agents/supervisorTools.ts
export interface SupervisorToolContext {
  stateEngine;
  auditLedger;
  negotiationMediator;
  eventBus;
  rbacService;
  facade: WorkflowOrchestratorFacade;
}
export function getRunOverview(ctx, runId): RunOverviewSummary;
export function summarizeConflict(ctx, runId, negotiationId): ConflictArbitrationCard; // 从 NegotiationLog 提炼分歧+方案A/B+风险
export function overrideGate(
  ctx,
  runId,
  snapshotId,
  verdict,
  reason,
  actorUserId,
): WorkflowRunState; // 内部走 facade.submitHumanGateDecision（RBAC 已内建）
export function rollbackAndFork(ctx, runId, directive, actorUserId): WorkflowRunState; // 包装 invokeSupervisorConversationalRollback
```

- 四个函数是**唯一入口**，为 M3 的 LLM function-calling 预留 schema；`SupervisorAgent` 保留命令对象，改为调用工具实现（消除双轨）。
- 边界：overrideGate 必须复用既有 RBAC 断言（不允许绕过）；rollbackAndFork 禁止携带制品修改（铁律不变）。

### C3 总管 NL 解析 LLM 化（P1）

- `parseNaturalLanguageRollback` 先走 LLM（system 限定目标 ∈ 6 枚举 + 指令改写），`response_format json_object`；解析结果 `{targetStageId, cleanInstruction, source:'llm'}`；任何异常/枚举外 → 关键词版兜底（`source:'keyword'`）→ 审计记录 source。
- 边界：指令注入（targetStageId 枚举校验拦截）；指令文本仅作为 directive 传给目标 Agent，不被执行为代码。

### A4 意图识别 LLM 化 + 体检端点（P1）

- `recognizeStageIntent` 保持同步签名（缓存键依赖），实现改为"上次同阶段 LLM 意图缓存 + 规则兜底"：首次由 A1 主调用顺带让模型输出 `intentCode`（并入主 JSON：`__intent` 字段），后续执行沿用；避免单独一次 LLM 往返。
- `POST /api/admin/model-baseline`（admin-only）：对两级端点各发 3 个固定 JSON 任务 → `evaluateEndpointBaseline` → 返回报告；治理视图加"模型体检"按钮。

### B1 协商 LLM 化（P1）

- `BoundedNegotiationMediator` 增加可选依赖 `roundRunner?: NegotiationRoundRunner`：

```ts
export interface NegotiationRoundRunner {
  runTurn(input: {
    turnIndex;
    maxTurns;
    challenger: AgentRole;
    responder: AgentRole;
    challengeContext: string;
    priorResponse?: string;
    topic: NegotiationTopic;
  }): Promise<{
    challengePoint: string;
    responseResolution: string;
    consensusReached: boolean;
    optionAProposal: string;
    optionBProposal: string;
  }>;
}
```

- 有 runner 且网关在线 → 每轮两次 LLM 调用（challenger 质询 / responder 裁决共识）；离线/异常 → 现有剧本路径（逐轮降级）。`forceDeadlockToMaxTurns` 仅当 scenarioHints 注入时用于演示熔断。
- 边界：①responder 恒不共识 → Max Turns 熔断（正确行为）；②单轮 Token 超预算 → 中止协商上报（B3 路径）；③每轮记录进 NegotiationLog（审计完整性不变）。

### G1/G2 语义缓存与 RAG embedding 化（P1）

- 网关增加 `ModelRoutingTier.EMBEDDING`；`PromptCacheManager` 与 `NegativeExperienceRagEngine` 注入 `EmbeddingProvider { embed(text): Promise<number[]> }`：
  - G1：L2 命中从"键相等"改为"意图 embedding 余弦 ≥ `SEMANTIC_CACHE_THRESHOLD`(0.86)"；embedding 失败 → 仅 L1。
  - G2：`ingestRejectionLesson` 保留同步哈希落库，后台队列异步升级为真 embedding（失败保持哈希）；PG 模式落 `vector(1536)`（D2 迁移脚本同步改维度）。
- 边界：embedding 维度不一致的旧记录 → 余弦按 `min(len)` 计算（现状函数已兼容）并标记待重嵌。

---

## 四、M3 生态（简要方案，执行前再细化）

| 编号                 | 设计要点                                                                                                                                                             |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 Git 上下文摄取    | E1 的 worktree 内 `git ls-files + 目录树（限深 3）+ 关键文件截断（README/主入口/Schema）` 拼入 3a/3b prompt 的 upstream 上下文；预算上限 8K 字符                     |
| H2 Jira/飞书双向同步 | 出站：状态机流转事件 → webhook POST（可重试 3 次指数退避）；入站：`/api/integrations/jira/webhook` 校验签名 → 映射为评论或 HumanDecision；配置存 `integrations.yaml` |
| H3 Figma 摄取        | PD prompt 注入企业组件库清单（Token 拉取 → 本地缓存 24h）；清单变化触发 PD 缓存失效                                                                                  |
| D3 SSE Last-Event-ID | SseBridge seq 落环形缓冲（每 run 200 条）；连接读 `Last-Event-ID` 重放 >seq 的帧；全量帧兜底幂等                                                                     |
| E3 docker 运行时     | `SANDBOX_RUNTIME=docker`：dockerode 起一次性 `node:22-alpine`，挂载 worktree ro+结果目录 rw，`--network none`，超时 kill                                             |
| I3 数据保留          | worktree 保留最近 N=10 个 run；`.runtime-data` 审计 WAL 按月切分；cleanup 挂 run 终态钩子                                                                            |
| J2 可插拔节点        | DSL `agentRole` 允许注册表新键：`AgentRegistry.register(stageId, agent)` + RBAC 角色映射表配置化；`VALID_STAGE_IDS` 从注册表取（替代枚举白名单）                     |
| G11 Stage 5 闭环     | DA Agent prompt 注入真实数仓查询结果（只读 SQL 模板 + 结果 JSON）；无数仓时保持投影报告并显式标注                                                                    |

---

## 五、全局风险清单与回滚策略

| 风险                                   | 触发条件                         | 缓解 / 回滚                                                                              |
| :------------------------------------- | :------------------------------- | :--------------------------------------------------------------------------------------- |
| LLM 输出质量不达标导致全链路失败率上升 | 契约校验 FAILED_CONTRACT 率 >20% | 降级开关 `LLM_ENABLED=false` 一键回落模板内核（A1 保留模板为 fallback）；A4 体检提前预警 |
| token 成本失控                         | run 级消耗 > 预算                | B3 硬熔断 + 通知；预算在 YAML 可调                                                       |
| PG 引入数据不一致                      | 内存与 PG 状态分叉               | saveFullState 单事务；恢复以 PG 优先、JSON 兜底；D1 集成测试守护                         |
| git worktree 泄漏（未清理）            | 异常中断绕过 cleanup             | I3 定期 prune 脚本 + 启动时 prune                                                        |
| 认证改造破坏现有测试                   | 测试直连端点                     | `AUTH_DISABLED` 测试开关（文档化）                                                       |
| 协商修复死循环                         | 修复轮次无限                     | B2 `MAX_AUTO_REPAIRS=2` + 指令轮次前缀防缓存命中                                         |
| 演示场景失真（移除 simulate 后）       | 销售/演示需要稳定场景            | ScenarioHints 保留演示能力；mock transport 用于确定性测试                                |

---

## 六、执行核对单（与 BACKEND_TODO.md 联动）

执行每个条目前：①确认依赖条目已勾选；②若实现与本文设计冲突，先更新本文"决策记录"再动代码；③完成后在本文件对应小节打勾并在 BACKEND_TODO.md 同步勾选。
