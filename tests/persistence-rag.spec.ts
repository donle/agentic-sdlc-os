/**
 * @file persistence-rag.spec.ts
 * @description Block 3 功能与结构测试：验证状态与审计账本落盘持久化 (`PersistenceRepository`)、
 * PostgreSQL 16 + `pgvector` SQL 同步脚本生成、以及负向经验飞轮 (`NegativeExperienceRagEngine`)
 * 的自动脱敏、1536 维哈希降级向量 + G2 真实 embedding 后台升级与余弦相似度 Top-K 检索。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import { NegativeExperienceRagEngine } from '../src/engine/NegativeExperienceRagEngine.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import type { EmbeddingProvider } from '../src/telemetry/EmbeddingProvider.ts';

/** 可控向量 stub：按关键词给出确定性真实向量 */
class StubEmbeddingProvider implements EmbeddingProvider {
  public readonly providerName = 'stub';
  public failMode: boolean;

  public constructor(failMode = false) {
    this.failMode = failMode;
  }

  public async embed(text: string): Promise<number[] | null> {
    if (this.failMode) {
      return null;
    }
    // 极简语义向量：关键词命中维度置 1
    const vec = [0, 0, 0];
    if (text.includes('数据库') || text.includes('锁') || text.includes('幂等')) {
      vec[0] += 1;
    }
    if (text.includes('缓存') || text.includes('CDN') || text.includes('前端')) {
      vec[1] += 1;
    }
    return vec;
  }
}

describe('Block 3 — 状态持久化仓储、PostgreSQL pgvector 同步与负向经验向量 RAG 测试套件', () => {
  it('1. NegativeExperienceRagEngine 应自动脱敏人类驳回批注、生成 1536 维哈希降级向量并按余弦相似度检索最相关教训（离线零依赖路径）', async () => {
    const rag = new NegativeExperienceRagEngine();

    const record1 = rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：数据库连接串 postgresql://admin:Pass123@10.10.1.9:5432/db 未开启分布式乐观锁与幂等键',
    );
    rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：前端静态图片 CDN 缓存过期时间设置过短',
    );

    assert.equal(record1.embedding.length, 1536);
    assert.equal(record1.embeddingSource, 'HASH_FALLBACK');
    assert.equal(
      record1.desensitizedLesson.includes('Pass123'),
      false,
      '沉淀到向量库的负向经验必须先完成敏感凭证脱敏',
    );

    // 检索与“数据库分布式锁与幂等”高度相关的查询，record1 的余弦相似度应排在第一位
    const results = await rag.retrieveTopKSimilarLessons({
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      queryText: '数据库分布式乐观锁与幂等键设计',
      topK: 2,
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].recordId, record1.recordId);
    assert.ok(
      results[0].similarityScore > results[1].similarityScore,
      `语义更接近的历史教训余弦相似度 (${results[0].similarityScore}) 应高于无关教训 (${results[1].similarityScore})`,
    );
  });

  it('1b. G2 — 注入 EmbeddingProvider 后：同步哈希落库 + 后台队列升级为真实向量', async () => {
    const provider = new StubEmbeddingProvider();
    const rag = new NegativeExperienceRagEngine([], provider);

    const record1 = rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：数据库连接串 postgresql://admin:Pass123@10.10.1.9/db 未开启分布式乐观锁与幂等键',
    );

    // 同步返回时仍是哈希向量（落库零延迟）
    assert.equal(record1.embeddingSource, 'HASH_FALLBACK');
    assert.equal(record1.embedding.length, 1536);
    assert.ok(rag.getPendingUpgradeCount() > 0, '升级任务已入后台队列');

    await rag.flushPendingEmbeddingUpgrades();

    const records = rag.getAllRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].embeddingSource, 'REAL_EMBEDDING', '后台升级后来源标记为真实向量');
    assert.equal(records[0].embedding.length, 3, '向量被替换为 stub 真实向量');
    assert.equal(records[0].needsReembedding, false);
    assert.ok(
      records[0].desensitizedLesson.includes('Pass123') === false,
      '升级只替换向量，不动脱敏文本',
    );
  });

  it('1c. G2 — embedding 升级失败 → 保持哈希向量并标记 needsReembedding；检索混检标记 matchDegraded', async () => {
    const provider = new StubEmbeddingProvider(true); // failMode：embed 返回 null
    const rag = new NegativeExperienceRagEngine([], provider);

    const record1 = rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：数据库未开启幂等键',
    );
    await rag.flushPendingEmbeddingUpgrades();

    const records = rag.getAllRecords();
    assert.equal(records[0].embeddingSource, 'HASH_FALLBACK', '升级失败保持哈希向量');
    assert.equal(records[0].embedding.length, 1536);
    assert.equal(records[0].needsReembedding, true, '失败记录标记待重嵌');

    // 查询时 provider 恢复可用（真实向量）+ 记录仍是哈希向量 → 混检标记 matchDegraded
    provider.failMode = false;
    const results = await rag.retrieveTopKSimilarLessons({
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      queryText: '数据库幂等键设计',
      topK: 3,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].matchDegraded, true, '哈希与真实向量混检必须显式降级标记');
    assert.equal(results[0].recordId, record1.recordId);
  });

  it('1d. G2 — 恢复的旧哈希记录在 provider 在位时自动排入升级队列（跨重启收敛）', async () => {
    const provider = new StubEmbeddingProvider();
    const rag = new NegativeExperienceRagEngine([], provider);
    const legacyRecord = {
      recordId: 'RAG-LEGACY-1',
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      desensitizedLesson: '旧记录：数据库连接串需开启幂等',
      embedding: NegativeExperienceRagEngine.computeNormalizedEmbedding('旧记录'),
      createdAtIso: '2026-11-01T00:00:00.000Z',
      // 旧持久化格式：无 embeddingSource 字段
    };

    rag.restoreRecord(legacyRecord as never);
    assert.ok(rag.getPendingUpgradeCount() > 0, '旧格式记录应排入升级队列');

    await rag.flushPendingEmbeddingUpgrades();
    const records = rag.getAllRecords();
    assert.equal(records[0].embeddingSource, 'REAL_EMBEDDING', '重启后旧记录完成升级');
  });

  it('2. PersistenceRepository 应将运行实例、快照、Append-Only JSONL 审计流与 pgvector SQL 持久化到磁盘', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-persist-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: tempDir,
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-PERSIST-001',
        title: '高并发库存扣减与分布式锁服务',
        summary: '验证状态机落盘与回退负向经验沉淀',
        requirements: {
          REQ_STOCK_LOCK: '支持库存扣减幂等与防超卖',
        },
        involvesDatabaseMigration: false,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '架构师-林工',
      });

      // 触发一次总管对话式回退以沉淀一条负向经验
      await orchestrator.invokeSupervisorConversationalRollback({
        runId: runState.runId,
        humanActor: '架构师-林工',
        dialogueInstruction: '回退到 Tech Lead Agent，补充 Redis 分布式锁防超卖 DDL',
      });

      const loaded = orchestrator.persistenceRepo.loadPersistedSnapshot();
      assert.ok(loaded, '应能从磁盘重新加载持久化的状态快照');
      assert.equal(loaded.runs.length, 1);
      assert.equal(loaded.runs[0].runId, runState.runId);
      assert.ok(loaded.snapshots.length >= 6);
      assert.equal(loaded.negativeExperienceRecords.length, 1);

      const walEntries = orchestrator.persistenceRepo.readAuditWalEntries();
      assert.ok(walEntries.length >= 10, 'Append-Only JSONL 审计日志文件应记录全链路事件');

      const sqlFile = path.join(tempDir, 'pgvector-sync.sql');
      assert.equal(fs.existsSync(sqlFile), true);
      const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
      assert.ok(sqlContent.includes('INSERT INTO workflow_runs'));
      assert.ok(sqlContent.includes('INSERT INTO stage_snapshots'));
      assert.ok(sqlContent.includes('INSERT INTO rejected_history_rag'));
      assert.ok(sqlContent.includes('::vector'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
