# P0-6 变更说明：修复 `runRetrospective.ts` 异步时序与真实历史复盘评估

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 4 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-6`）。

---

## 一、问题背景与根因

1. **6 处漏写 `await` 引起并发竞态**：[runRetrospective.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/retrospective/runRetrospective.ts) 在第一轮全系统异步化改造时遗漏了第 53/65/75/85/97/127 行的 `await`（调用 `submitHumanGateDecision()` 与 `invokeSupervisorConversationalRollback()` 时未等待完成即读取下一个门禁快照），依靠当时缺失重复裁决守卫而掩盖了时序错误。
2. **合成基准污染工作区持久化目录**：`RetrospectiveBenchmarkSuite` 构造 `WorkflowOrchestratorFacade` 时未传隔离目录，每次执行均向工作区默认 `.runtime-data/` 与 `.sandbox-worktrees/` 写入 `PROP-BENCH-001/002`。
3. **缺少真实历史评估能力与跨平台入口兼容性**：脚本仅能跑合成基准，无法对 `.runtime-data/` 中已有真实历史运行执行只读复盘；且第 141 行主模块判定使用 `` `file://${process.argv[1]}` ``，在 Windows 路径下无法直接启动。

---

## 二、核心修改内容

### 1. 抽出共用指标诊断方法（[RetrospectiveTaskRunner.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/telemetry/RetrospectiveTaskRunner.ts#L98-L110)）
- 新增 `public evaluateMetrics(cacheMetrics, fulfillmentMetrics): RetrospectiveEvaluationReport`，`executeRetrospectiveCheck()` 与历史持久化复盘共用同一套 SLA 阈值与诊断公式，零逻辑重复。

### 2. 修复 6 处 `await`、目录隔离与真实历史评估（[runRetrospective.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/retrospective/runRetrospective.ts)）
- **补全异步 `await` 与分叉门禁步进**：在 `runFullSuite()` 全部 6 处人工裁决与总管回退调用前补齐 `await`；同时在分叉回退至 `STAGE_2_PD` 后先拍板保留的 `forceNegotiationDeadlock` 门禁，再逐阶段有序推进 3a → 4 → 5。
- **合成基准隔离目录**：构造函数支持 `{ persistenceDir?, sandboxRootDir? }`，未显式传入时自动在 `os.tmpdir()` 创建临时隔离目录并在 `finally` 中清理，彻底杜绝污染默认 `.runtime-data/` 与 `.sandbox-worktrees/`。
- **新增 `evaluatePersistedHistory(persistenceDir?)`**：只读调用 `restoreFromPersistence()` 加载真实历史运行，汇总所有快照的缓存命中、Token 消耗、成本与重试次数分布（含 `ABORTED`/`ABORTED_TOKEN_BUDGET` 失败记录），经 `RetrospectiveTaskRunner.evaluateMetrics()` 生成 `RetrospectiveEvaluationReport`；空目录安全返回 `source: 'empty'` 且不写回任何合成数据。
- **跨平台 CLI 入口**：改用 `pathToFileURL(process.argv[1]).href` 判定直接执行，支持 `--benchmark`（隔离合成基准）与 `--history-only`（仅评估历史）；默认优先评估真实历史、无数据时回退隔离基准。

---

## 三、测试与验收结果

- **新增测试（[tests/retrospective-runner.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/retrospective-runner.spec.ts)）**：
  - Test 1：`runFullSuite()` 全 `await` 顺序执行通过 SLA，且不向工作区默认 `.runtime-data/ledger-store.json` 写入 `PROP-BENCH-001/002`。
  - Test 2：向临时持久化目录写入真实运行后，调用 `evaluatePersistedHistory()` 准确汇总快照/重试/成本并保持持久化文件字节级未修改。
  - Test 3：空持久化目录安全返回 `source: 'empty'` 与 `report: null`。
  - Test 4：直接运行 `node src/retrospective/runRetrospective.ts --benchmark` 正常退出 0 并输出健康报告。
- **回归结果**：
  - `tests/architecture.spec.ts`（含 Test 4 复盘任务验证）4/4 通过。
  - `npm run retrospective:eval -- --benchmark` 正常退出 0（实测缓存命中率 53.33%、意图达成率 100%、平均重试 0.07 次/调用、重试损耗 10.68%）。
  - `npm run typecheck:backend && npm run lint:backend`：0 错误通过。
  - `npm test`：178 项测试 / 50 套件（174 通过 / 4 既有跳过 / 0 失败）。
