# I3 实现文档：数据保留策略

> 对应 `BACKEND_TODO_DESIGN.md` §M3 "I3 数据保留"，2026-11-23 完成。

## 问题背景

两个无限增长点：①审计 WAL 是单文件 `audit-trail.jsonl`，长期运行会膨胀；②沙箱 worktree 目录永不清理
（每个 run × 分支一个物理目录，真实模式下还占用 git worktree 注册表）。

## 实现方案

### 1. 审计 WAL 按月归档（`PersistenceRepository`）

- 写入：条目按 `entry.timestampIso` 归档到 `audit-trail-YYYY-MM.jsonl`（`AuditTrailEntry` 构造器新增可选
  `timestampIso` 参数，缺省当前时间——向后兼容，运行时条目仍为写入时间）。
- 读取：`readAuditWalEntries` 合并全部月度分片（文件名字典序 = 月度时间序）；**旧单文件
  `audit-trail.jsonl` 兼容读取**（历史数据不丢，排在其后）。
- `getWalFileNames()` 公开分片清单（观测/测试用）。
- 非法时间戳回落当前月份（不产生畸形文件名）。
- D1 无影响：恢复走 `ledger-store.json` 快照，JSONL 从不重放。

### 2. worktree 保留策略（`GitWorktreeSandboxManager.enforceWorktreeRetention`）

- 保留最近 N 个 run 的沙箱目录（默认 10，env `SANDBOX_WORKTREE_RETENTION` 可调，下限 1）；
  更旧的先按分支执行 `cleanupWorktree`（真实模式 → `git worktree remove`），再删除 run 目录。
- `protectRunIds`：无论多旧都保留——调用方传入活跃 run（RUNNING / PAUSED_AT_HUMAN_GATE）。
- 返回 `{removedRunIds, retainedRunIds}` 供日志。

### 3. Facade 终态钩子

- `onRunReachedTerminalState(runState)`：在 COMPLETED / ABORTED / ABORTED_TOKEN_BUDGET 三个终态转换点调用；
  保护集 = 全部 RUNNING/PAUSED run + 刚终态的 run 自身。
- **旁路设计**：钩子内 try/catch，保留策略失败只 WARN 不影响主流程终态语义。

## 边界处理

1. 跨月条目 → 各归各月；同月追加 → append 到同分片（Append-Only 语义不变）。
2. 旧单文件存在时与新分片共存，读取合并（历史条目排后）。
3. 目录名与 runId 的 sanitize 规则同源（`resolveWorkspacePath`），保护名单按 sanitize 后匹配。
4. 真实 git worktree 移除失败（分支已被删等）→ 不阻断目录清理。

## 验证（tests/data-retention.spec.ts，5 项）

1. 跨月条目分片落盘（2 个文件）+ 合并读取时间序
2. 非法时间戳回落当前月份
3. 旧单文件 `audit-trail.jsonl` 兼容合并（不丢失）
4. 保留策略：5 目录 N=2 → 清理 3 个最旧的；`protectRunIds` 无视新旧存活
5. Facade 终态钩子：散文输出 → ABORTED → 钩子自动清理最旧 run（N=1，端到端）

**测试基线**：122 项（118 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。

## 遗留

- WAL 分片无删除策略（设计只要求切分）；如需按月过期删除，挂到同一终态钩子即可。
- `enforceWorktreeRetention` 当前仅由终态钩子触发；服务长期运行但 run 不终态（暂停）时目录不清理——保护语义本就如此。
