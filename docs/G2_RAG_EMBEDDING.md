# G2 实现文档：负向经验 RAG embedding 化

> 对应 `BACKEND_TODO_DESIGN.md` §"G1/G2 语义缓存与 RAG embedding 化"，2026-11-23 完成。
> 替换审计基线中的 M7 Mockup（哈希伪向量）——哈希向量保留为离线降级路径，不再是唯一路径。

## 问题背景

旧 `NegativeExperienceRagEngine` 只有 64 维字符/bigram 局部敏感哈希向量——是伪向量而非语义向量：
字符级碰撞使"语义无关"的文本也可能相似，检索质量无语义保证。

## 实现方案

### 1. 引擎双路径（`src/engine/NegativeExperienceRagEngine.ts`）

| 路径                       | 触发条件                       | 行为                                                                                        |
| :------------------------- | :----------------------------- | :------------------------------------------------------------------------------------------ |
| **哈希降级（同步）**       | 始终先行                       | `ingestRejectionLesson` 同步计算 1536 维哈希向量立即落库（零延迟、零依赖，M7 兼容）         |
| **真实 embedding（后台）** | 构造注入了 `EmbeddingProvider` | 后台**串行队列**逐条调用真实 embedding 替换向量；失败保持哈希并标记 `needsReembedding=true` |

- 维度统一为 **1536**（与 PG `vector(1536)` 对齐；哈希投影桶数同步扩大）。
- 记录新增字段：`embeddingSource: 'HASH_FALLBACK' | 'REAL_EMBEDDING'`、`needsReembedding`。
- 检索查询向量：provider 可用 → 真实 embedding（`retrieveTopKSimilarLessons` **async 化**）；失败 → 回落哈希（与旧行为完全一致）。
- **混检诚实标记**：查询向量与记录向量来源不一致（哈希 ↔ 真实）时，命中结果带 `matchDegraded: true`——此时 `min(len)` 余弦语义无效，仅供过渡期参考。

### 2. 跨重启收敛（D1 联动）

`restoreRecord` 恢复旧格式记录（无 `embeddingSource` 字段视为哈希）时，若 provider 在位则自动排入升级队列——重启后旧记录逐步升级为真实向量，无需一次性迁移。

### 3. 接线

- `ImmutableAuditLedger` 构造函数新增可选 `embeddingProvider` 参数，透传给 RAG 引擎。
- `WorkflowOrchestratorFacade`：`modelRouter` 提前至 `auditLedger` 之前构造，注入 `GatewayEmbeddingProvider`。
- async 化波及（均已在 async 上下文内 await）：
  - `ImmutableAuditLedger.getRejectionLessonsForStage`
  - `Facade.continueExecutionUntilGateOrComplete` 的 lessons 调用
  - `WorkbenchServer` `/api/rag/query`
  - `tests/qa-repair-loop.spec.ts`

### 4. PG 同步（D2 联动）

`deploy/init-pgvector-schema.sql`：`rejected_history_rag.embedding vector(64)` → `vector(1536)`。
`PgPersistenceDriver` 的向量字面量生成是维度无关的（`[${embedding.join(',')}]`），但现行 PG 同步存在两项实操边界需注意：

1. **PG `ON CONFLICT` 向量覆盖已补齐（第十二轮 `#8`）**：`src/engine/pg/PgPersistenceDriver.ts` 中的 `buildPgUpsertSql()` 对 `rejected_history_rag` 已生成 `INSERT ... ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding;`，且 `PgPersistenceDriver` 已接入 `PersistenceRepository` 生产同步链路（并支持 `loadFullState()` 回读），因此后台队列将哈希记录升级为 `REAL_EMBEDDING` 后会在下次同步时覆盖 PG 中旧哈希向量。
2. **模型默认维度需与建表维度一致**：`ModelRouterGateway` 默认 `EMBEDDING_MODEL` 为 `'bge-m3-local'`（1024 维），若对接真实 PG `vector(1536)` 列，需保证部署模型输出维度与建表维度一致（否则写入报错）。

## 边界处理

1. **provider 缺席（离线单机）**：全部哈希路径，行为与 M7 时代完全一致，`needsReembedding` 恒 false（哈希即该环境的目标形态，不产生噪音标记）。
2. **升级失败**（端点不可达/返回 null）：保持哈希向量 + `needsReembedding=true`，队列链条不断（单条失败不影响后续）。
3. **升级只替换向量**，不动脱敏文本（`desensitizedLesson`）与审计字段。
4. **D1 恢复防双计**：`restoreRecord` 不触发观察者/WAL 重放的既有契约不变；升级仅先改内存对象，直到下次 `syncPersistenceState()` 调用时才会写入 `ledger-store.json`。
5. `flushPendingEmbeddingUpgrades()` 供测试与优雅关停等待队列排空。

## 验证（tests/persistence-rag.spec.ts，5 项）

1. 离线路径回归：1536 维哈希向量 + 脱敏 + 余弦 Top-K 排序（原 test 1 升维版）
2. 注入 provider：同步哈希落库 → 后台升级为真实向量（来源标记 + 维度替换）
3. 升级失败：保持哈希 + `needsReembedding=true`；查询恢复后混检 `matchDegraded=true`
4. 恢复的旧格式记录自动入升级队列（跨重启收敛）
5. 持久化 round-trip + pgvector SQL 脚本生成（原 test 2 不变，仍通过）

**完成时测试基线**：98 项（94 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：169 项 / 48 套件 / 28 文件，165 过 / 4 既有 skip）

## 遗留

- 已有 `needsReembedding` 记录的重试调度（当前仅在恢复/新沉淀时入队；可用定时任务兜底，暂无必要）。
- 模型输出维度（默认 `bge-m3-local` 1024 维）与 PG 建表 `vector(1536)` 的对齐策略及真实 PostgreSQL 16 + pgvector 联调（跟踪见 `BACKEND_TODO.md` §六）。
