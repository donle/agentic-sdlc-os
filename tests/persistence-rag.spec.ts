/**
 * @file persistence-rag.spec.ts
 * @description Block 3 功能与结构测试：验证状态与审计账本落盘持久化 (`PersistenceRepository`)、
 * PostgreSQL 16 + `pgvector` SQL 同步脚本生成、以及负向经验飞轮 (`NegativeExperienceRagEngine`)
 * 的自动脱敏、64 维归一化向量嵌入与余弦相似度 Top-K 检索。
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

describe('Block 3 — 状态持久化仓储、PostgreSQL pgvector 同步与负向经验向量 RAG 测试套件', () => {
  it('1. NegativeExperienceRagEngine 应自动脱敏人类驳回批注、生成 64 维归一化向量并按余弦相似度检索最相关教训', () => {
    const rag = new NegativeExperienceRagEngine();

    const record1 = rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：数据库连接串 postgresql://admin:Pass123@10.10.1.9:5432/db 未开启分布式乐观锁与幂等键',
    );
    rag.ingestRejectionLesson(
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      '架构师驳回：前端静态图片 CDN 缓存过期时间设置过短',
    );

    assert.equal(record1.embedding.length, 64);
    assert.equal(
      record1.desensitizedLesson.includes('Pass123'),
      false,
      '沉淀到向量库的负向经验必须先完成敏感凭证脱敏',
    );

    // 检索与“数据库分布式锁与幂等”高度相关的查询，record1 的余弦相似度应排在第一位
    const results = rag.retrieveTopKSimilarLessons({
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

  it('2. PersistenceRepository 应将运行实例、快照、Append-Only JSONL 审计流与 pgvector SQL 持久化到磁盘', () => {
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
        simulateNegotiationConflict: false,
      });

      const runState = orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '架构师-林工',
      });

      // 触发一次总管对话式回退以沉淀一条负向经验
      orchestrator.invokeSupervisorConversationalRollback({
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
