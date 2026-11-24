# `P2-3` 测试隔离卫生改造与工作区残留清理说明

> 创建日期：2026-11-24 · 对应修复步骤：**Wave 3 · Step 12 (`P2-3`)** · 执行轮次：**第二十五轮**

---

## 一、问题根因与清理前现场盘点

在全仓审计过程中发现，仓库根目录下持续堆积 `.runtime-data/` 与 `.sandbox-worktrees/` 两个未受清理的运行态产物目录：

| 目录                  | 清理前实测体积 | 内部残留内容                                                                                                                          | 污染根因                                                                                                                 |
| :-------------------- | :------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------- |
| `.runtime-data/`      | `9.9M`         | `audit-trail-2026-11.jsonl`（9.47 MB）、`audit-trail.jsonl`（793 KB）、`ledger-store.json`、`pgvector-sync.sql`、`users.json` 共 5 项 | 多组单元/集成测试实例化 `WorkflowOrchestratorFacade` 时未传 `persistenceDir`，回落至默认 `path.resolve('.runtime-data')` |
| `.sandbox-worktrees/` | `188K`         | 10 个 `RUN-*` 沙箱工作树残留目录                                                                                                      | 部分测试仅传 `persistenceDir`（如 `a4`、`persistence-rag`、`rbac-governance`）或二者皆未传，未配置 `sandboxRootDir`      |

这不仅造成本地磁盘与 WAL 文件在每次 `npm test` 后不断膨胀，还会导致 `node --test` 并发进程写入同一默认目录时产生状态互串风险。

---

## 二、修复编排与关键改动

### 1. 公共测试隔离助手 [`tests/helpers/testIsolation.ts`](../tests/helpers/testIsolation.ts)

新增标准化隔离设施，统一基于 `os.tmpdir()` 生成每次测试独立的根目录，并强制在结束时销毁：

- `createTestWorkspace(prefix)`：创建唯一临时 `rootDir`，派生 `persistenceDir = path.join(rootDir, 'persist')` 与 `sandboxRootDir = path.join(rootDir, 'sandbox')`，暴露 `cleanup()` 执行递归强删。
- `withTestWorkspace(prefix, fn)`：自动包裹 `try { ... } finally { ws.cleanup(); }`，保证无论是断言通过还是中途抛错都不遗留临时文件夹。

### 2. 全量 13 个未完全隔离测试文件改造

以下 13 个测试文件已全部补充显式 `persistenceDir` 与 `sandboxRootDir` 隔离，并在 `finally` / `afterEach` / `withTestWorkspace` 中自动回收：

| 测试文件                                                                              | 改造位置与方式                                                                                                      |
| :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------ |
| [`tests/a4-intent-and-baseline.spec.ts`](../tests/a4-intent-and-baseline.spec.ts)     | 2 处 `WorkflowOrchestratorFacade` 与 `startServer()` 中的 `WorkbenchHttpServer` 接入独立工作区并在 `afterEach` 清理 |
| [`tests/agent-quality-efficiency.spec.ts`](../tests/agent-quality-efficiency.spec.ts) | AC-8、AC-9、AC-10 3 处 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                      |
| [`tests/architecture.spec.ts`](../tests/architecture.spec.ts)                         | Test 1–3 共 3 处 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                            |
| [`tests/concurrency-and-cache.spec.ts`](../tests/concurrency-and-cache.spec.ts)       | 并发隔离 Test 1–2 两处 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                      |
| [`tests/dsl-loader.spec.ts`](../tests/dsl-loader.spec.ts)                             | Test 2 纯后端模板分支的 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                     |
| [`tests/dynamic-context-needs.spec.ts`](../tests/dynamic-context-needs.spec.ts)       | Test 1–2 两处 `WorkflowOrchestratorFacade` 使用按用例创建的临时工作区并在 `afterEach` 回收                          |
| [`tests/full-pipeline-llm.spec.ts`](../tests/full-pipeline-llm.spec.ts)               | Test 1–6 全 6 处 `WorkflowOrchestratorFacade` 使用按用例创建的临时工作区并在 `afterEach` 回收（Test 7 原已隔离）    |
| [`tests/persistence-rag.spec.ts`](../tests/persistence-rag.spec.ts)                   | Test 2 在已有临时 `persistenceDir` 基础上补齐 `sandboxRootDir`                                                      |
| [`tests/pluggable-nodes.spec.ts`](../tests/pluggable-nodes.spec.ts)                   | Test 6 为自定义节点 `WorkflowOrchestratorFacade` 补齐 `persistenceDir`/`sandboxRootDir` 与 `finally` 清理           |
| [`tests/qa-repair-loop.spec.ts`](../tests/qa-repair-loop.spec.ts)                     | Test 1–2 两处 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                               |
| [`tests/rbac-governance.spec.ts`](../tests/rbac-governance.spec.ts)                   | Test 1/3/4 补齐 `sandboxRootDir`，Test 2 无参构造改用 `withTestWorkspace()`                                         |
| [`tests/state-reconstructor.spec.ts`](../tests/state-reconstructor.spec.ts)           | Test 1/3 共享同一临时 `ws` 模拟进程重启恢复（`orchestrator1` → `orchestrator2`），Test 2 独立隔离                   |
| [`tests/supervisor-tools.spec.ts`](../tests/supervisor-tools.spec.ts)                 | Test 1–3 三处 `WorkflowOrchestratorFacade` 接入 `withTestWorkspace()`                                               |

### 3. 防回归静态 + 行为守卫 [`tests/test-isolation-hygiene.spec.ts`](../tests/test-isolation-hygiene.spec.ts)

新增 2 项自动化守卫用例，防止后续新增测试再次漏配隔离目录：

1. **全仓静态构造审计**：按括号深度与字符串状态机扫描全仓 `tests/*.spec.ts` 中全部 `new WorkflowOrchestratorFacade(...)` 与 `new WorkbenchHttpServer(...)` 调用参数，强制要求同时显式包含 `persistenceDir` 与 `sandboxRootDir`（任意遗漏立即报出 `file:line`）。
2. **`withTestWorkspace()` 正常/异常清理契约验证**：验证临时目录确切创建于 `os.tmpdir()` 下，在运行真实工作流后退出或回调抛出异常时均可彻底删除 `rootDir`。

---

## 三、仓库清理与实测验收结果

执行命令：

```bash
rm -rf .runtime-data .sandbox-worktrees && npm run format && npm run check && test ! -e .runtime-data && test ! -e .sandbox-worktrees && echo "CLEAN_WORKSPACE_OK"
```

| 验收指标                              | 实测结果                                                               |
| :------------------------------------ | :--------------------------------------------------------------------- |
| `.runtime-data/` 残留体积与生成检查   | `9.9M`（5 文件）→ **`0B`（目录不存在，全量测试期间零创建）**           |
| `.sandbox-worktrees/` 残留体积与检查  | `188K`（10 目录）→ **`0B`（目录不存在，全量测试期间零创建）**          |
| 前后端 TypeScript / ESLint / Prettier | `npm run typecheck && npm run lint && npm run format:check` 全部退出 0 |
| 全量自动化测试                        | **213 / 213 通过（56 套件 / 34 个测试文件，0 跳过 / 0 失败）**         |
| 零工作区污染门禁输出                  | `CLEAN_WORKSPACE_OK`                                                   |
