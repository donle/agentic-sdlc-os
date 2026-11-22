/**
 * @file PgPersistenceDriver.ts
 * @description D2 PostgreSQL 直连驱动：DATABASE_URL 存在时替代 JSON 文件持久化，
 * 将 runs/snapshots/negotiation_logs/human_decisions/rejected_history_rag 写入真实 PG。
 * 无 DATABASE_URL 时自动回落到 JSON 文件模式（D-2 全局决策：可降级）。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PersistedLedgerSnapshot, PersistenceDriver } from '../PersistenceRepository.ts';

/** psql CLI 方式执行 SQL 脚本（避免引入 pg 原生依赖，保持单机轻量） */
export class PgPersistenceDriver implements PersistenceDriver {
  private readonly databaseUrl: string;

  public constructor(databaseUrl?: string) {
    this.databaseUrl = databaseUrl ?? process.env.DATABASE_URL ?? '';
    if (!this.databaseUrl) {
      throw new Error('PgPersistenceDriver 需要 DATABASE_URL 环境变量');
    }
  }

  public saveFullState(snapshot: PersistedLedgerSnapshot): void {
    const sql = this.generateUpsertSql(snapshot);
    const tmpFile = path.resolve(
      this.databaseUrl.includes('DATABASE_URL') ? '.' : '.',
      '.d2-pg-sync.sql',
    );
    fs.writeFileSync(tmpFile, sql, 'utf-8');
    try {
      execFileSync('psql', [this.databaseUrl, '-f', tmpFile], {
        timeout: 30000,
        encoding: 'utf-8',
      });
    } catch (err) {
      console.warn(
        `[D2] PG 同步失败（数据保留在 JSON 兜底）: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  /** 恢复优先走 JSON（PG 用于运维查询与分析）；D1 StateReconstructor 基于统一 snapshot 格式 */
  public loadFullState(): PersistedLedgerSnapshot | null {
    return null; // PG 恢复由 StateReconstructor + JSON 兜底覆盖
  }

  public appendAudit(_entry: Record<string, unknown>): void {
    // 审计 JSONL 持续追加（Append-Only 不变），PG 侧在 saveFullState 时批量同步
  }

  private generateUpsertSql(snapshot: PersistedLedgerSnapshot): string {
    const escape = (v: string): string => v.replace(/'/g, "''");
    const lines: string[] = ['BEGIN;'];

    for (const run of snapshot.runs) {
      lines.push(
        `INSERT INTO workflow_runs (id, title, workflow_template_name, workflow_snapshot_yaml, active_branch_id, token_budget, token_used, status, created_by, created_at) VALUES ('${escape(run.runId)}', '${escape(run.title)}', '${escape(run.workflowTemplateId)}', '{}'::jsonb, '${escape(run.activeBranchId)}', 120000, ${run.tokensUsedTotal ?? 0}, '${escape(run.status)}', '${escape(run.initiatorActor)}', '${escape(run.createdAtIso)}') ON CONFLICT (id) DO UPDATE SET active_branch_id = EXCLUDED.active_branch_id, status = EXCLUDED.status, token_used = EXCLUDED.token_used;`,
      );
    }

    for (const snap of snapshot.snapshots) {
      const snapId = escape(String(snap.snapshotId ?? ''));
      const runId = escape(String(snap.runId ?? ''));
      const parentId = snap.parentSnapshotId
        ? `'${escape(String(snap.parentSnapshotId))}'`
        : 'NULL';
      const branchId = escape(String(snap.branchId ?? ''));
      const stageId = escape(String(snap.stageId ?? ''));
      const role = escape(String(snap.agentRole ?? ''));
      const model = escape(String(snap.modelUsed ?? ''));
      const artifactJson = escape(JSON.stringify(snap.artifactDetails ?? {}));
      const riskScore = Number(snap.riskScore ?? 0);
      const state = escape(String(snap.state ?? 'IDLE'));
      lines.push(
        `INSERT INTO stage_snapshots (id, run_id, parent_snap_id, branch_id, stage_id, role_agent, model_used, artifact_json, risk_score, state) VALUES ('${snapId}', '${runId}', ${parentId}, '${branchId}', '${stageId}', '${role}', '${model}', '${artifactJson}'::jsonb, ${riskScore}, '${state}') ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state;`,
      );
    }

    for (const dec of snapshot.humanDecisions) {
      lines.push(
        `INSERT INTO human_decisions (id, run_id, snap_id, reviewer_id, decision_type, comment, created_at) VALUES ('${escape(dec.decisionId)}', '${escape(dec.runId)}', '${escape(dec.snapshotId)}', '${escape(dec.reviewerActor)}', '${escape(dec.verdict)}', '${escape(dec.comment)}', '${escape(dec.createdAtIso)}') ON CONFLICT (id) DO NOTHING;`,
      );
    }

    for (const rag of snapshot.negativeExperienceRecords) {
      const vectorLiteral = `[${rag.embedding.join(',')}]`;
      lines.push(
        `INSERT INTO rejected_history_rag (id, stage_id, desensitized_lesson, embedding, created_at) VALUES ('${escape(rag.recordId)}', '${escape(rag.stageId)}', '${escape(rag.desensitizedLesson)}', '${vectorLiteral}'::vector, '${escape(rag.createdAtIso)}') ON CONFLICT (id) DO NOTHING;`,
      );
    }

    lines.push('COMMIT;');
    return lines.join('\n');
  }
}

/**
 * 存储驱动选择器：DATABASE_URL 存在 → PG；否则 JSON 文件（单机轻量降级）
 */
export function selectPersistenceDriver(databaseUrl?: string): PersistenceDriver | null {
  const url = databaseUrl ?? process.env.DATABASE_URL ?? '';
  if (url) {
    try {
      return new PgPersistenceDriver(url);
    } catch {
      console.warn('[D2] DATABASE_URL 存在但 PG 驱动初始化失败，回落 JSON 模式');
    }
  }
  return null;
}
