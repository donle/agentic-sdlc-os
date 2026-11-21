/**
 * @file PersistenceRepository.ts
 * @description 状态机、不可变审计账本与负向经验向量库的持久化仓储层 (`PersistenceRepository`)。
 *
 * 对应《工程落地架构草案》4.1 节：
 * 1. 支持单机私有化本地落盘持久化（Append-Only JSONL 审计流 + 结构化快照账本 JSON），进程重启后可完整恢复；
 * 2. 支持生成对齐 PostgreSQL 16 + `pgvector` 表结构（`workflow_runs`、`stage_snapshots`、`negotiation_logs`、
 *    `human_decisions`、`rejected_history_rag`）的标准 SQL 事务导出脚本，无缝对接 `deploy/init-pgvector-schema.sql`。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { HumanDecisionRecord, NegotiationTurnRecord } from '../domain/models.ts';
import type { WorkflowRunState } from './DagWorkflowStateEngine.ts';
import type { AuditTrailEntry } from './ImmutableAuditLedger.ts';
import type { NegativeExperienceVectorRecord } from './NegativeExperienceRagEngine.ts';

export interface PersistedLedgerSnapshot {
  readonly schemaVersion: string;
  readonly lastSyncedAtIso: string;
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly title: string;
    readonly workflowTemplateId: string;
    readonly activeBranchId: string;
    readonly status: string;
    readonly initiatorActor: string;
    readonly createdAtIso: string;
  }>;
  readonly snapshots: ReadonlyArray<Record<string, unknown>>;
  readonly negotiationLogs: ReadonlyArray<NegotiationTurnRecord>;
  readonly humanDecisions: ReadonlyArray<HumanDecisionRecord>;
  readonly negativeExperienceRecords: ReadonlyArray<NegativeExperienceVectorRecord>;
}

export class PersistenceRepository {
  private readonly storageDir: string;
  private readonly snapshotFilePath: string;
  private readonly auditJsonlFilePath: string;
  private readonly sqlDumpFilePath: string;
  private lastSyncedAtIso: string;

  public constructor(storageDir?: string) {
    this.storageDir =
      storageDir ??
      path.resolve(process.cwd(), process.env.LOCAL_PERSISTENCE_DIR ?? '.runtime-data');
    this.snapshotFilePath = path.join(this.storageDir, 'ledger-store.json');
    this.auditJsonlFilePath = path.join(this.storageDir, 'audit-trail.jsonl');
    this.sqlDumpFilePath = path.join(this.storageDir, 'pgvector-sync.sql');
    this.lastSyncedAtIso = new Date().toISOString();
    this.ensureStorageDirectory();
  }

  private ensureStorageDirectory(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  public getStorageDir(): string {
    return this.storageDir;
  }

  public getLastSyncedAtIso(): string {
    return this.lastSyncedAtIso;
  }

  /**
   * 追加一条不可变审计日志到 Append-Only JSONL 文件
   */
  public appendAuditEntryToWal(entry: AuditTrailEntry): void {
    this.ensureStorageDirectory();
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(this.auditJsonlFilePath, line, 'utf-8');
    this.lastSyncedAtIso = new Date().toISOString();
  }

  /**
   * 将当前所有运行实例、阶段快照、协商日志、人工裁决及负向经验向量持久化落盘，并同步生成 PostgreSQL + pgvector SQL
   */
  public persistFullState(params: {
    runs: ReadonlyArray<WorkflowRunState>;
    negotiationLogs: ReadonlyArray<NegotiationTurnRecord>;
    humanDecisions: ReadonlyArray<HumanDecisionRecord>;
    negativeExperienceRecords: ReadonlyArray<NegativeExperienceVectorRecord>;
  }): PersistedLedgerSnapshot {
    this.ensureStorageDirectory();
    this.lastSyncedAtIso = new Date().toISOString();

    const allSnapshots: Record<string, unknown>[] = [];
    const serializedRuns = params.runs.map((r) => {
      for (const snap of r.getAllSnapshots()) {
        allSnapshots.push(snap.toSerializableRecord());
      }
      return {
        runId: r.runId,
        title: r.proposal.title,
        workflowTemplateId: r.workflowTemplateId,
        activeBranchId: r.getActiveBranchId(),
        status: r.getStatus(),
        initiatorActor: r.initiatorActor,
        createdAtIso: r.createdAtIso,
      };
    });

    const payload: PersistedLedgerSnapshot = {
      schemaVersion: '1.0.0',
      lastSyncedAtIso: this.lastSyncedAtIso,
      runs: serializedRuns,
      snapshots: allSnapshots,
      negotiationLogs: [...params.negotiationLogs],
      humanDecisions: [...params.humanDecisions],
      negativeExperienceRecords: [...params.negativeExperienceRecords],
    };

    fs.writeFileSync(this.snapshotFilePath, JSON.stringify(payload, null, 2), 'utf-8');

    const sqlStatements = this.generatePostgreSqlStatements(payload);
    fs.writeFileSync(this.sqlDumpFilePath, sqlStatements, 'utf-8');

    return payload;
  }

  /**
   * 从磁盘读取已持久化的状态账本快照
   */
  public loadPersistedSnapshot(): PersistedLedgerSnapshot | null {
    if (!fs.existsSync(this.snapshotFilePath)) {
      return null;
    }
    const raw = fs.readFileSync(this.snapshotFilePath, 'utf-8');
    return JSON.parse(raw) as PersistedLedgerSnapshot;
  }

  /**
   * 读取 Append-Only JSONL 审计日志流中的所有记录
   */
  public readAuditWalEntries(): ReadonlyArray<Record<string, unknown>> {
    if (!fs.existsSync(this.auditJsonlFilePath)) {
      return [];
    }
    const lines = fs
      .readFileSync(this.auditJsonlFilePath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * 生成符合 `deploy/init-pgvector-schema.sql` 的 PostgreSQL + pgvector UPSERT 同步语句
   */
  public generatePostgreSqlStatements(snapshot: PersistedLedgerSnapshot): string {
    const escapeSql = (val: string): string => val.replace(/'/g, "''");
    const lines: string[] = [
      '-- Auto-generated PostgreSQL 16 + pgvector state synchronization script',
      'BEGIN;',
    ];

    for (const run of snapshot.runs) {
      lines.push(
        `INSERT INTO workflow_runs (id, title, workflow_template_name, workflow_snapshot_yaml, active_branch_id, status, created_by, created_at) VALUES ('${escapeSql(run.runId)}', '${escapeSql(run.title)}', '${escapeSql(run.workflowTemplateId)}', '{}'::jsonb, '${escapeSql(run.activeBranchId)}', '${escapeSql(run.status)}', '${escapeSql(run.initiatorActor)}', '${escapeSql(run.createdAtIso)}') ON CONFLICT (id) DO UPDATE SET active_branch_id = EXCLUDED.active_branch_id, status = EXCLUDED.status;`,
      );
    }

    for (const snap of snapshot.snapshots) {
      const snapId = escapeSql(String(snap.snapshotId ?? ''));
      const runId = escapeSql(String(snap.runId ?? ''));
      const parentId = snap.parentSnapshotId
        ? `'${escapeSql(String(snap.parentSnapshotId))}'`
        : 'NULL';
      const branchId = escapeSql(String(snap.branchId ?? ''));
      const stageId = escapeSql(String(snap.stageId ?? ''));
      const role = escapeSql(String(snap.agentRole ?? ''));
      const model = escapeSql(String(snap.modelUsed ?? ''));
      const artifactJson = escapeSql(JSON.stringify(snap.artifactDetails ?? {}));
      const riskScore = Number(snap.riskScore ?? 0);
      const state = escapeSql(String(snap.state ?? 'IDLE'));

      lines.push(
        `INSERT INTO stage_snapshots (id, run_id, parent_snap_id, branch_id, stage_id, role_agent, model_used, artifact_json, risk_score, state) VALUES ('${snapId}', '${runId}', ${parentId}, '${branchId}', '${stageId}', '${role}', '${model}', '${artifactJson}'::jsonb, ${riskScore}, '${state}') ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state;`,
      );
    }

    for (const dec of snapshot.humanDecisions) {
      lines.push(
        `INSERT INTO human_decisions (id, run_id, snap_id, reviewer_id, decision_type, comment, created_at) VALUES ('${escapeSql(dec.decisionId)}', '${escapeSql(dec.runId)}', '${escapeSql(dec.snapshotId)}', '${escapeSql(dec.reviewerActor)}', '${escapeSql(dec.verdict)}', '${escapeSql(dec.comment)}', '${escapeSql(dec.createdAtIso)}') ON CONFLICT (id) DO NOTHING;`,
      );
    }

    for (const rag of snapshot.negativeExperienceRecords) {
      const vectorLiteral = `[${rag.embedding.join(',')}]`;
      lines.push(
        `INSERT INTO rejected_history_rag (id, stage_id, desensitized_lesson, embedding, created_at) VALUES ('${escapeSql(rag.recordId)}', '${escapeSql(rag.stageId)}', '${escapeSql(rag.desensitizedLesson)}', '${vectorLiteral}'::vector, '${escapeSql(rag.createdAtIso)}') ON CONFLICT (id) DO NOTHING;`,
      );
    }

    lines.push('COMMIT;');
    return lines.join('\n');
  }
}
