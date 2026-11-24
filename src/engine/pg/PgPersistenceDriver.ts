/**
 * @file PgPersistenceDriver.ts
 * @description D2 PostgreSQL 直连驱动：DATABASE_URL 存在时替代 JSON 文件持久化，
 * 将 runs/snapshots/negotiation_logs/human_decisions/rejected_history_rag/team_comments 写入真实 PG，
 * 并支持从 PostgreSQL 完整回读 (`loadFullState`)，彻底消除硬编码 120000 与协商日志漏同步。
 * 无 DATABASE_URL 时自动回落到 JSON 文件模式（D-2 全局决策：可降级）。
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { WorkflowStageId } from '../../domain/enums.ts';
import { HumanDecisionRecord, NegotiationTurnRecord } from '../../domain/models.ts';
import type { NegativeExperienceVectorRecord } from '../NegativeExperienceRagEngine.ts';
import type {
  PersistedCacheTelemetry,
  PersistedGovernanceConfig,
  PersistedLedgerSnapshot,
  PersistedRunRecord,
  PersistenceDriver,
} from '../PersistenceRepository.ts';

export type PgSqlExecutor = (sql: string, options?: { readOnly?: boolean }) => string;
export type PgAsyncSqlExecutor = (sql: string, options?: { readOnly?: boolean }) => Promise<string>;

export interface PgPersistenceDriverOptions {
  readonly asyncSqlExecutor?: PgAsyncSqlExecutor;
  readonly pinnedVectorDim?: number;
}

function escapeSql(val: unknown): string {
  return String(val ?? '')
    .replaceAll('\u0000', '')
    .replace(/'/g, "''");
}

function safeInt(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
}

function safeTimestampIso(value: unknown): string {
  const str = typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  return str || new Date().toISOString();
}

function mapAgentRoleToStageId(role: string): string {
  switch (role) {
    case 'PM_AGENT':
      return 'STAGE_1_PM';
    case 'PD_AGENT':
      return 'STAGE_2_PD';
    case 'TECH_LEAD_AGENT':
      return 'STAGE_3A_TECH_SPEC';
    case 'ENGINEER_AGENT':
      return 'STAGE_3B_ENGINEER';
    case 'QA_AGENT':
      return 'STAGE_4_QA';
    case 'DA_AGENT':
      return 'STAGE_5_DA';
    case 'SUPERVISOR_AGENT':
      return 'STAGE_0_INITIATION';
    default:
      return role || 'STAGE_0_INITIATION';
  }
}

function parsePgEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n));
  }
  return [];
}

/**
 * P1-2：PG 写入前可选向量维度对齐（未显式配置 PG_RAG_VECTOR_DIM / pinnedDim 时原样保留，兼容变长 vector 列同时存储 1024 与 1536 维）
 */
export function normalizeEmbeddingForPg(
  embedding: ReadonlyArray<number>,
  pinnedDim?: number,
): ReadonlyArray<number> {
  const envDim = Number(process.env.PG_RAG_VECTOR_DIM);
  const targetDim =
    pinnedDim !== undefined && Number.isFinite(pinnedDim) && pinnedDim > 0
      ? Math.floor(pinnedDim)
      : Number.isFinite(envDim) && envDim > 0
        ? Math.floor(envDim)
        : 0;
  if (targetDim <= 0 || embedding.length === targetDim) {
    return embedding;
  }
  const resized = new Array<number>(targetDim).fill(0);
  const copyLen = Math.min(embedding.length, targetDim);
  for (let i = 0; i < copyLen; i += 1) {
    resized[i] = embedding[i];
  }
  let normSq = 0;
  for (const val of resized) {
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) {
    resized[0] = 1;
    return resized;
  }
  return resized.map((v) => Number((v / norm).toFixed(6)));
}

/**
 * AUDIT-8 / P1-2：PostgreSQL 16 + pgvector 统一全量 UPSERT SQL 构建器（PersistenceRepository 与 PgPersistenceDriver 共用单一事实源）
 */
export function buildPgUpsertSql(
  snapshot: PersistedLedgerSnapshot,
  options?: { pinnedVectorDim?: number },
): string {
  const lines: string[] = [
    '-- Auto-generated PostgreSQL 16 + pgvector state synchronization script',
    'BEGIN;',
  ];

  for (const run of snapshot.runs) {
    const runMetaJson = escapeSql(
      JSON.stringify({
        proposal: run.proposal ?? {},
        stagePipeline: run.stagePipeline ?? [],
        currentStageIndex: safeInt(run.currentStageIndex, 0),
        branchCounter: safeInt(run.branchCounter, 1),
        branchHistory: run.branchHistory ?? [run.activeBranchId],
        scenarioHints: run.scenarioHints ?? {},
        autoRepairCounts: run.autoRepairCounts ?? {},
      }),
    );
    const tokenBudget = safeInt(run.tokenBudget, 120000);
    const tokenUsed = safeInt(run.tokensUsedTotal, 0);
    const createdByUserIdSql = run.createdByUserId
      ? `(SELECT id FROM users WHERE id = '${escapeSql(run.createdByUserId)}')`
      : 'NULL';
    lines.push(
      `INSERT INTO workflow_runs (id, title, workflow_template_name, workflow_snapshot_yaml, active_branch_id, token_budget, token_used, status, created_by, created_at, created_by_user_id) VALUES ('${escapeSql(run.runId)}', '${escapeSql(run.title)}', '${escapeSql(run.workflowTemplateId)}', '${runMetaJson}'::jsonb, '${escapeSql(run.activeBranchId)}', ${tokenBudget}, ${tokenUsed}, '${escapeSql(run.status)}', '${escapeSql(run.initiatorActor)}', '${escapeSql(safeTimestampIso(run.createdAtIso))}', ${createdByUserIdSql}) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, workflow_template_name = EXCLUDED.workflow_template_name, workflow_snapshot_yaml = EXCLUDED.workflow_snapshot_yaml, active_branch_id = EXCLUDED.active_branch_id, token_budget = EXCLUDED.token_budget, token_used = EXCLUDED.token_used, status = EXCLUDED.status, created_by_user_id = COALESCE(EXCLUDED.created_by_user_id, workflow_runs.created_by_user_id);`,
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
    const rawDetails =
      snap.artifactDetails && typeof snap.artifactDetails === 'object'
        ? (snap.artifactDetails as Record<string, unknown>)
        : {};
    const artifactPayload = {
      ...rawDetails,
      __snapshotMeta: {
        riskLevel: snap.riskLevel ?? 'LOW',
        riskReasons: Array.isArray(snap.riskReasons) ? snap.riskReasons : [],
        gateAction: snap.gateAction ?? 'AUTO_PASS_WITH_AUDIT',
        scopeDiff: snap.scopeDiff ?? {},
        cacheHit: Boolean(snap.cacheHit),
        retryCount: safeInt(snap.retryCount, 0),
        tokensConsumed: safeInt(snap.tokensConsumed, 0),
        artifactSummary: snap.artifactSummary ?? '',
        artifactType: snap.artifactType ?? '',
      },
    };
    const artifactJson = escapeSql(JSON.stringify(artifactPayload));
    const riskScore = safeInt(snap.riskScore, 0);
    const state = escapeSql(String(snap.state ?? 'IDLE'));
    const createdAtIso = escapeSql(safeTimestampIso(snap.createdAtIso));

    lines.push(
      `INSERT INTO stage_snapshots (id, run_id, parent_snap_id, branch_id, stage_id, role_agent, model_used, artifact_json, risk_score, state, created_at) VALUES ('${snapId}', '${runId}', ${parentId}, '${branchId}', '${stageId}', '${role}', '${model}', '${artifactJson}'::jsonb, ${riskScore}, '${state}', '${createdAtIso}') ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, artifact_json = EXCLUDED.artifact_json, risk_score = EXCLUDED.risk_score;`,
    );
  }

  for (const turn of snapshot.negotiationLogs ?? []) {
    const rawTurn = turn as unknown as Record<string, unknown>;
    const negId = escapeSql(String(turn.negotiationId ?? rawTurn.negotiationId ?? ''));
    const runId = escapeSql(String(turn.runId ?? rawTurn.runId ?? ''));
    const branchId = escapeSql(String(turn.branchId ?? rawTurn.branchId ?? ''));
    const challengerRole = String(turn.challengerRole ?? rawTurn.challengerRole ?? 'PD_AGENT');
    const responderRole = String(turn.responderRole ?? rawTurn.responderRole ?? 'PM_AGENT');
    const fromStage = escapeSql(mapAgentRoleToStageId(challengerRole));
    const toStage = escapeSql(mapAgentRoleToStageId(responderRole));
    const turnIndex = safeInt(turn.turnIndex ?? rawTurn.turnIndex, 1);
    const messageStructured = escapeSql(
      JSON.stringify({
        topic: turn.topic ?? 'DESIGN_REVIEW',
        maxTurnsAllowed: safeInt(turn.maxTurnsAllowed, 3),
        challengerRole,
        responderRole,
        challengePoint: turn.challengePoint ?? '',
        responseResolution: turn.responseResolution ?? '',
        consensusReached: Boolean(turn.consensusReached),
        optionAProposal: turn.optionAProposal ?? '',
        optionBProposal: turn.optionBProposal ?? '',
      }),
    );
    const scopeDiffJson = escapeSql(
      JSON.stringify(
        rawTurn.scopeDiff && typeof rawTurn.scopeDiff === 'object' ? rawTurn.scopeDiff : {},
      ),
    );
    const isEscalated = turn.escalatedToSupervisor ? 'TRUE' : 'FALSE';
    const createdAtIso = escapeSql(safeTimestampIso(turn.createdAtIso ?? rawTurn.createdAtIso));

    lines.push(
      `INSERT INTO negotiation_logs (id, run_id, branch_id, from_stage, to_stage, turn_index, message_structured, scope_diff, is_escalated, created_at) VALUES ('${negId}', '${runId}', '${branchId}', '${fromStage}', '${toStage}', ${turnIndex}, '${messageStructured}'::jsonb, '${scopeDiffJson}'::jsonb, ${isEscalated}, '${createdAtIso}') ON CONFLICT (id) DO UPDATE SET message_structured = EXCLUDED.message_structured, is_escalated = EXCLUDED.is_escalated;`,
    );
  }

  for (const dec of snapshot.humanDecisions) {
    const reviewerUserIdSql = dec.reviewerUserId
      ? `(SELECT id FROM users WHERE id = '${escapeSql(dec.reviewerUserId)}')`
      : 'NULL';
    lines.push(
      `INSERT INTO human_decisions (id, run_id, snap_id, reviewer_id, decision_type, comment, created_at, reviewer_user_id) VALUES ('${escapeSql(dec.decisionId)}', '${escapeSql(dec.runId)}', '${escapeSql(dec.snapshotId)}', '${escapeSql(dec.reviewerActor)}', '${escapeSql(dec.verdict)}', '${escapeSql(dec.comment)}', '${escapeSql(safeTimestampIso(dec.createdAtIso))}', ${reviewerUserIdSql}) ON CONFLICT (id) DO NOTHING;`,
    );
  }

  for (const rag of snapshot.negativeExperienceRecords) {
    const normalizedVec = normalizeEmbeddingForPg(rag.embedding, options?.pinnedVectorDim);
    const vectorLiteral = `[${normalizedVec.join(',')}]`;
    const embeddingDim = normalizedVec.length;
    const embeddingSource = escapeSql(rag.embeddingSource ?? 'HASH_FALLBACK');
    lines.push(
      `INSERT INTO rejected_history_rag (id, stage_id, desensitized_lesson, embedding, created_at, embedding_dim, embedding_source) VALUES ('${escapeSql(rag.recordId)}', '${escapeSql(rag.stageId)}', '${escapeSql(rag.desensitizedLesson)}', '${vectorLiteral}'::vector, '${escapeSql(safeTimestampIso(rag.createdAtIso))}', ${embeddingDim}, '${embeddingSource}') ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, embedding_dim = EXCLUDED.embedding_dim, embedding_source = EXCLUDED.embedding_source;`,
    );
  }

  for (const comment of snapshot.teamComments ?? []) {
    const commentId = escapeSql(String(comment.commentId ?? ''));
    const runId = escapeSql(String(comment.runId ?? ''));
    const stageId = escapeSql(String(comment.stageId ?? 'STAGE_0_INITIATION'));
    const authorUserId = comment.authorUserId
      ? `(SELECT id FROM users WHERE id = '${escapeSql(String(comment.authorUserId))}')`
      : 'NULL';
    const authorName = escapeSql(String(comment.authorName ?? ''));
    const authorJobTitle = escapeSql(String(comment.authorJobTitle ?? ''));
    const authorBadge = escapeSql(String(comment.authorBadge ?? ''));
    const content = escapeSql(String(comment.content ?? ''));
    const category = escapeSql(String(comment.category ?? 'COMMENT'));
    const createdAtIso = escapeSql(safeTimestampIso(comment.createdAtIso));

    lines.push(
      `INSERT INTO team_comments (id, run_id, stage_id, author_user_id, author_name, author_job_title, author_badge, content, category, created_at) VALUES ('${commentId}', '${runId}', '${stageId}', ${authorUserId}, '${authorName}', '${authorJobTitle}', '${authorBadge}', '${content}', '${category}', '${createdAtIso}') ON CONFLICT (id) DO NOTHING;`,
    );
  }

  for (const notif of snapshot.notifications ?? []) {
    const notifId = escapeSql(String(notif.notificationId ?? ''));
    if (!notifId) {
      continue;
    }
    const runId = escapeSql(String(notif.runId ?? ''));
    const branchId = escapeSql(String(notif.branchId ?? ''));
    const stageId = escapeSql(String(notif.stageId ?? 'STAGE_1_PM'));
    const senderRole = escapeSql(String(notif.senderRole ?? 'SUPERVISOR_AGENT'));
    const category = escapeSql(String(notif.category ?? 'STAGE_PROGRESS'));
    const title = escapeSql(String(notif.title ?? ''));
    const message = escapeSql(String(notif.message ?? ''));
    const relatedSnapshotId = escapeSql(String(notif.relatedSnapshotId ?? ''));
    const requiresHumanAction = notif.requiresHumanAction ? 'TRUE' : 'FALSE';
    const resolved = notif.resolved ? 'TRUE' : 'FALSE';
    const actionOptionsJson = escapeSql(
      JSON.stringify(Array.isArray(notif.actionOptions) ? notif.actionOptions : []),
    );
    const createdAtIso = escapeSql(safeTimestampIso(notif.createdAtIso));

    lines.push(
      `INSERT INTO notifications (id, run_id, branch_id, stage_id, sender_role, category, title, message, related_snapshot_id, requires_human_action, resolved, action_options, created_at) VALUES ('${notifId}', '${runId}', '${branchId}', '${stageId}', '${senderRole}', '${category}', '${title}', '${message}', '${relatedSnapshotId}', ${requiresHumanAction}, ${resolved}, '${actionOptionsJson}'::jsonb, '${createdAtIso}') ON CONFLICT (id) DO UPDATE SET resolved = EXCLUDED.resolved;`,
    );
  }

  for (const evt of snapshot.liveEvents ?? []) {
    const evtId = escapeSql(String(evt.eventId ?? ''));
    if (!evtId) {
      continue;
    }
    const runId = escapeSql(String(evt.runId ?? ''));
    const branchId = escapeSql(String(evt.branchId ?? ''));
    const stageId = escapeSql(String(evt.stageId ?? 'STAGE_0_INITIATION'));
    const agentRole = escapeSql(String(evt.agentRole ?? 'SUPERVISOR_AGENT'));
    const lifecycleState = escapeSql(String(evt.lifecycleState ?? 'IDLE'));
    const headline = escapeSql(String(evt.headline ?? ''));
    const detailPayloadJson = escapeSql(
      JSON.stringify(
        evt.detailPayload && typeof evt.detailPayload === 'object' ? evt.detailPayload : {},
      ),
    );
    const createdAtIso = escapeSql(safeTimestampIso(evt.timestampIso));

    lines.push(
      `INSERT INTO live_events (id, run_id, branch_id, stage_id, agent_role, lifecycle_state, headline, detail_payload, created_at) VALUES ('${evtId}', '${runId}', '${branchId}', '${stageId}', '${agentRole}', '${lifecycleState}', '${headline}', '${detailPayloadJson}'::jsonb, '${createdAtIso}') ON CONFLICT (id) DO NOTHING;`,
    );
  }

  for (const entry of snapshot.auditEntries ?? []) {
    const entryId = escapeSql(String(entry.entryId ?? ''));
    if (!entryId) {
      continue;
    }
    const runId = escapeSql(String(entry.runId ?? ''));
    const branchId = escapeSql(String(entry.branchId ?? ''));
    const stageId = escapeSql(String(entry.stageId ?? 'STAGE_0_INITIATION'));
    const actor = escapeSql(String(entry.actor ?? ''));
    const actionType = escapeSql(String(entry.actionType ?? ''));
    const summary = escapeSql(String(entry.summary ?? ''));
    const metadataJson = escapeSql(
      JSON.stringify(entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}),
    );
    const createdAtIso = escapeSql(safeTimestampIso(entry.timestampIso));

    lines.push(
      `INSERT INTO audit_entries (id, run_id, branch_id, stage_id, actor, action_type, summary, metadata, created_at) VALUES ('${entryId}', '${runId}', '${branchId}', '${stageId}', '${actor}', '${actionType}', '${summary}', '${metadataJson}'::jsonb, '${createdAtIso}') ON CONFLICT (id) DO NOTHING;`,
    );
  }

  if (snapshot.governanceConfig) {
    const govJson = escapeSql(JSON.stringify(snapshot.governanceConfig));
    lines.push(
      `INSERT INTO system_runtime_state (state_key, payload, updated_at) VALUES ('governance_config', '${govJson}'::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();`,
    );
  }
  if (snapshot.cacheTelemetry) {
    const cacheJson = escapeSql(JSON.stringify(snapshot.cacheTelemetry));
    lines.push(
      `INSERT INTO system_runtime_state (state_key, payload, updated_at) VALUES ('cache_telemetry', '${cacheJson}'::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();`,
    );
  }
  if (snapshot.intentTraces && snapshot.intentTraces.length > 0) {
    const tracesJson = escapeSql(JSON.stringify({ traces: snapshot.intentTraces }));
    lines.push(
      `INSERT INTO system_runtime_state (state_key, payload, updated_at) VALUES ('intent_traces', '${tracesJson}'::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();`,
    );
  }

  lines.push('COMMIT;');
  return lines.join('\n');
}

const FULL_LOAD_QUERY_EXTENDED = `
SELECT json_build_object(
  'runs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', r.id,
      'title', r.title,
      'workflow_template_name', r.workflow_template_name,
      'workflow_snapshot_yaml', r.workflow_snapshot_yaml,
      'active_branch_id', r.active_branch_id,
      'token_budget', r.token_budget,
      'token_used', r.token_used,
      'status', r.status,
      'created_by', r.created_by,
      'created_by_user_id', r.created_by_user_id,
      'created_at', r.created_at
    ) ORDER BY r.created_at ASC)
    FROM workflow_runs r
  ), '[]'::json),
  'snapshots', COALESCE((
    SELECT json_agg(json_build_object(
      'id', s.id,
      'run_id', s.run_id,
      'parent_snap_id', s.parent_snap_id,
      'branch_id', s.branch_id,
      'stage_id', s.stage_id,
      'role_agent', s.role_agent,
      'model_used', s.model_used,
      'artifact_json', s.artifact_json,
      'risk_score', s.risk_score,
      'state', s.state,
      'created_at', s.created_at
    ) ORDER BY s.created_at ASC)
    FROM stage_snapshots s
  ), '[]'::json),
  'negotiation_logs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', n.id,
      'run_id', n.run_id,
      'branch_id', n.branch_id,
      'from_stage', n.from_stage,
      'to_stage', n.to_stage,
      'turn_index', n.turn_index,
      'message_structured', n.message_structured,
      'scope_diff', n.scope_diff,
      'is_escalated', n.is_escalated,
      'created_at', n.created_at
    ) ORDER BY n.created_at ASC, n.turn_index ASC)
    FROM negotiation_logs n
  ), '[]'::json),
  'human_decisions', COALESCE((
    SELECT json_agg(json_build_object(
      'id', h.id,
      'run_id', h.run_id,
      'snap_id', h.snap_id,
      'reviewer_id', h.reviewer_id,
      'reviewer_user_id', h.reviewer_user_id,
      'decision_type', h.decision_type,
      'comment', h.comment,
      'created_at', h.created_at
    ) ORDER BY h.created_at ASC)
    FROM human_decisions h
  ), '[]'::json),
  'rejected_history_rag', COALESCE((
    SELECT json_agg(json_build_object(
      'id', g.id,
      'stage_id', g.stage_id,
      'desensitized_lesson', g.desensitized_lesson,
      'embedding', g.embedding::text,
      'embedding_source', g.embedding_source,
      'created_at', g.created_at
    ) ORDER BY g.created_at ASC)
    FROM rejected_history_rag g
  ), '[]'::json),
  'team_comments', COALESCE((
    SELECT json_agg(json_build_object(
      'id', c.id,
      'run_id', c.run_id,
      'stage_id', c.stage_id,
      'author_user_id', c.author_user_id,
      'author_name', c.author_name,
      'author_job_title', c.author_job_title,
      'author_badge', c.author_badge,
      'content', c.content,
      'category', c.category,
      'created_at', c.created_at
    ) ORDER BY c.created_at ASC)
    FROM team_comments c
  ), '[]'::json),
  'notifications', COALESCE((
    SELECT json_agg(json_build_object(
      'id', n.id,
      'run_id', n.run_id,
      'branch_id', n.branch_id,
      'stage_id', n.stage_id,
      'sender_role', n.sender_role,
      'category', n.category,
      'title', n.title,
      'message', n.message,
      'related_snapshot_id', n.related_snapshot_id,
      'requires_human_action', n.requires_human_action,
      'resolved', n.resolved,
      'action_options', n.action_options,
      'created_at', n.created_at
    ) ORDER BY n.created_at ASC)
    FROM notifications n
  ), '[]'::json),
  'live_events', COALESCE((
    SELECT json_agg(json_build_object(
      'id', e.id,
      'run_id', e.run_id,
      'branch_id', e.branch_id,
      'stage_id', e.stage_id,
      'agent_role', e.agent_role,
      'lifecycle_state', e.lifecycle_state,
      'headline', e.headline,
      'detail_payload', e.detail_payload,
      'created_at', e.created_at
    ) ORDER BY e.created_at ASC)
    FROM live_events e
  ), '[]'::json),
  'audit_entries', COALESCE((
    SELECT json_agg(json_build_object(
      'id', a.id,
      'run_id', a.run_id,
      'branch_id', a.branch_id,
      'stage_id', a.stage_id,
      'actor', a.actor,
      'action_type', a.action_type,
      'summary', a.summary,
      'metadata', a.metadata,
      'created_at', a.created_at
    ) ORDER BY a.created_at ASC)
    FROM audit_entries a
  ), '[]'::json),
  'system_runtime_state', COALESCE((
    SELECT json_agg(json_build_object(
      'state_key', st.state_key,
      'payload', st.payload
    ))
    FROM system_runtime_state st
  ), '[]'::json)
)::text;
`.trim();

const FULL_LOAD_QUERY_WITH_COMMENTS = `
SELECT json_build_object(
  'runs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', r.id,
      'title', r.title,
      'workflow_template_name', r.workflow_template_name,
      'workflow_snapshot_yaml', r.workflow_snapshot_yaml,
      'active_branch_id', r.active_branch_id,
      'token_budget', r.token_budget,
      'token_used', r.token_used,
      'status', r.status,
      'created_by', r.created_by,
      'created_at', r.created_at
    ) ORDER BY r.created_at ASC)
    FROM workflow_runs r
  ), '[]'::json),
  'snapshots', COALESCE((
    SELECT json_agg(json_build_object(
      'id', s.id,
      'run_id', s.run_id,
      'parent_snap_id', s.parent_snap_id,
      'branch_id', s.branch_id,
      'stage_id', s.stage_id,
      'role_agent', s.role_agent,
      'model_used', s.model_used,
      'artifact_json', s.artifact_json,
      'risk_score', s.risk_score,
      'state', s.state,
      'created_at', s.created_at
    ) ORDER BY s.created_at ASC)
    FROM stage_snapshots s
  ), '[]'::json),
  'negotiation_logs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', n.id,
      'run_id', n.run_id,
      'branch_id', n.branch_id,
      'from_stage', n.from_stage,
      'to_stage', n.to_stage,
      'turn_index', n.turn_index,
      'message_structured', n.message_structured,
      'scope_diff', n.scope_diff,
      'is_escalated', n.is_escalated,
      'created_at', n.created_at
    ) ORDER BY n.created_at ASC, n.turn_index ASC)
    FROM negotiation_logs n
  ), '[]'::json),
  'human_decisions', COALESCE((
    SELECT json_agg(json_build_object(
      'id', h.id,
      'run_id', h.run_id,
      'snap_id', h.snap_id,
      'reviewer_id', h.reviewer_id,
      'decision_type', h.decision_type,
      'comment', h.comment,
      'created_at', h.created_at
    ) ORDER BY h.created_at ASC)
    FROM human_decisions h
  ), '[]'::json),
  'rejected_history_rag', COALESCE((
    SELECT json_agg(json_build_object(
      'id', g.id,
      'stage_id', g.stage_id,
      'desensitized_lesson', g.desensitized_lesson,
      'embedding', g.embedding::text,
      'created_at', g.created_at
    ) ORDER BY g.created_at ASC)
    FROM rejected_history_rag g
  ), '[]'::json),
  'team_comments', COALESCE((
    SELECT json_agg(json_build_object(
      'id', c.id,
      'run_id', c.run_id,
      'stage_id', c.stage_id,
      'author_user_id', c.author_user_id,
      'author_name', c.author_name,
      'author_job_title', c.author_job_title,
      'author_badge', c.author_badge,
      'content', c.content,
      'category', c.category,
      'created_at', c.created_at
    ) ORDER BY c.created_at ASC)
    FROM team_comments c
  ), '[]'::json)
)::text;
`.trim();

const FULL_LOAD_QUERY_CORE = FULL_LOAD_QUERY_WITH_COMMENTS.replace(
  `,
  'team_comments', COALESCE((
    SELECT json_agg(json_build_object(
      'id', c.id,
      'run_id', c.run_id,
      'stage_id', c.stage_id,
      'author_user_id', c.author_user_id,
      'author_name', c.author_name,
      'author_job_title', c.author_job_title,
      'author_badge', c.author_badge,
      'content', c.content,
      'category', c.category,
      'created_at', c.created_at
    ) ORDER BY c.created_at ASC)
    FROM team_comments c
  ), '[]'::json)`,
  '',
);

/** psql CLI 方式执行 SQL 脚本（避免引入 pg 原生依赖，保持单机轻量；P1-2 写入路径改为非阻塞合并异步队列） */
export class PgPersistenceDriver implements PersistenceDriver {
  private readonly databaseUrl: string;
  private readonly sqlExecutor: PgSqlExecutor;
  private readonly asyncWriteExecutor: PgAsyncSqlExecutor | null;
  private readonly pinnedVectorDim?: number;
  private pendingSyncSql: string | null = null;
  private writeDrainPromise: Promise<void> | null = null;

  public constructor(
    databaseUrl?: string,
    sqlExecutor?: PgSqlExecutor,
    options?: PgPersistenceDriverOptions,
  ) {
    this.databaseUrl = databaseUrl ?? process.env.DATABASE_URL ?? '';
    if (!this.databaseUrl && !sqlExecutor && !options?.asyncSqlExecutor) {
      throw new Error('PgPersistenceDriver 需要 DATABASE_URL 环境变量');
    }
    this.pinnedVectorDim = options?.pinnedVectorDim;
    this.sqlExecutor =
      sqlExecutor ??
      ((sql: string, execOptions?: { readOnly?: boolean }): string => {
        if (!this.databaseUrl) {
          return '';
        }
        if (execOptions?.readOnly) {
          return execFileSync(
            'psql',
            [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
            { timeout: 30000, encoding: 'utf-8' },
          );
        }
        const tmpFile = path.join(
          os.tmpdir(),
          `d2-pg-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sql`,
        );
        fs.writeFileSync(tmpFile, sql, 'utf-8');
        try {
          return execFileSync('psql', [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', tmpFile], {
            timeout: 30000,
            encoding: 'utf-8',
          });
        } finally {
          fs.rmSync(tmpFile, { force: true });
        }
      });

    if (options?.asyncSqlExecutor) {
      this.asyncWriteExecutor = options.asyncSqlExecutor;
    } else if (!sqlExecutor) {
      this.asyncWriteExecutor = (
        sql: string,
        execOptions?: { readOnly?: boolean },
      ): Promise<string> => this.execPsqlAsync(sql, Boolean(execOptions?.readOnly));
    } else {
      this.asyncWriteExecutor = null;
    }
  }

  private execPsqlAsync(sql: string, readOnly: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      if (readOnly) {
        execFile(
          'psql',
          [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
          { timeout: 30000, encoding: 'utf-8' },
          (err, stdout) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(stdout);
          },
        );
        return;
      }
      const tmpFile = path.join(
        os.tmpdir(),
        `d2-pg-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sql`,
      );
      fs.writeFile(tmpFile, sql, 'utf-8', (writeErr) => {
        if (writeErr) {
          reject(writeErr);
          return;
        }
        execFile(
          'psql',
          [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', tmpFile],
          { timeout: 30000, encoding: 'utf-8' },
          (execErr, stdout) => {
            fs.rm(tmpFile, { force: true }, () => {
              if (execErr) {
                reject(execErr);
                return;
              }
              resolve(stdout);
            });
          },
        );
      });
    });
  }

  private enqueueCoalescedWrite(sql: string): void {
    this.pendingSyncSql = sql;
    if (this.writeDrainPromise) {
      return;
    }
    this.writeDrainPromise = this.drainWriteQueue();
  }

  private async drainWriteQueue(): Promise<void> {
    try {
      while (this.pendingSyncSql !== null) {
        const nextSql = this.pendingSyncSql;
        this.pendingSyncSql = null;
        try {
          await this.asyncWriteExecutor!(nextSql, { readOnly: false });
        } catch (err) {
          console.warn(
            `[D2] PG 异步同步失败（数据保留在 JSON 兜底）: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
          );
        }
      }
    } finally {
      this.writeDrainPromise = null;
    }
  }

  /** P1-2：等待挂起的异步 PG 状态同步排空（优雅关停/测试断言用） */
  public async flushPendingWrites(): Promise<void> {
    while (this.writeDrainPromise !== null || this.pendingSyncSql !== null) {
      if (this.writeDrainPromise) {
        await this.writeDrainPromise;
      } else if (this.pendingSyncSql !== null) {
        this.writeDrainPromise = this.drainWriteQueue();
        await this.writeDrainPromise;
      }
    }
  }

  public generateUpsertSql(snapshot: PersistedLedgerSnapshot): string {
    return buildPgUpsertSql(snapshot, { pinnedVectorDim: this.pinnedVectorDim });
  }

  public saveFullState(snapshot: PersistedLedgerSnapshot): void {
    const sql = this.generateUpsertSql(snapshot);
    if (this.asyncWriteExecutor) {
      this.enqueueCoalescedWrite(sql);
      return;
    }
    try {
      this.sqlExecutor(sql, { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2] PG 同步失败（数据保留在 JSON 兜底）: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  /** AUDIT-8 / P1-2：从 PostgreSQL 完整回读运行实例、快照、协商日志、人工裁决、RAG、团队评论、通知、事件流、审计与运行时配置 */
  public loadFullState(): PersistedLedgerSnapshot | null {
    let rawOutput: string;
    try {
      rawOutput = this.sqlExecutor(FULL_LOAD_QUERY_EXTENDED, { readOnly: true });
    } catch (extErr) {
      const extMsg = extErr instanceof Error ? extErr.message : String(extErr);
      const canFallbackToComments =
        extMsg.includes('notifications') ||
        extMsg.includes('live_events') ||
        extMsg.includes('audit_entries') ||
        extMsg.includes('system_runtime_state') ||
        extMsg.includes('created_by_user_id') ||
        extMsg.includes('reviewer_user_id') ||
        extMsg.includes('embedding_source');
      if (canFallbackToComments) {
        try {
          rawOutput = this.sqlExecutor(FULL_LOAD_QUERY_WITH_COMMENTS, { readOnly: true });
        } catch (commentsErr) {
          const msg = commentsErr instanceof Error ? commentsErr.message : String(commentsErr);
          if (msg.includes('team_comments')) {
            try {
              rawOutput = this.sqlExecutor(FULL_LOAD_QUERY_CORE, { readOnly: true });
            } catch (fallbackErr) {
              console.warn(
                `[D2] PG 读取失败（回落 JSON 兜底）: ${fallbackErr instanceof Error ? fallbackErr.message.slice(0, 200) : fallbackErr}`,
              );
              return null;
            }
          } else {
            console.warn(`[D2] PG 读取失败（回落 JSON 兜底）: ${msg.slice(0, 200)}`);
            return null;
          }
        }
      } else {
        console.warn(`[D2] PG 读取失败（回落 JSON 兜底）: ${extMsg.slice(0, 200)}`);
        return null;
      }
    }

    const trimmed = rawOutput.trim();
    if (!trimmed) {
      return null;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[D2] PG 返回 JSON 解析失败（回落 JSON 兜底）: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return null;
    }

    const rawRuns = Array.isArray(parsed.runs) ? (parsed.runs as Record<string, unknown>[]) : [];
    if (rawRuns.length === 0) {
      return null;
    }

    const runs: PersistedRunRecord[] = rawRuns.map((row) => {
      const yamlMeta =
        row.workflow_snapshot_yaml && typeof row.workflow_snapshot_yaml === 'object'
          ? (row.workflow_snapshot_yaml as Record<string, unknown>)
          : {};
      const activeBranchId = String(row.active_branch_id ?? 'branch-v1-main');
      return {
        runId: String(row.id ?? ''),
        title: String(row.title ?? ''),
        workflowTemplateId: String(row.workflow_template_name ?? 'enterprise_standard_sdlc_v1'),
        activeBranchId,
        status: String(row.status ?? 'RUNNING'),
        initiatorActor: String(row.created_by ?? ''),
        ...(row.created_by_user_id ? { createdByUserId: String(row.created_by_user_id) } : {}),
        createdAtIso: safeTimestampIso(row.created_at),
        proposal:
          yamlMeta.proposal && typeof yamlMeta.proposal === 'object'
            ? (yamlMeta.proposal as Record<string, unknown>)
            : {},
        stagePipeline: Array.isArray(yamlMeta.stagePipeline)
          ? (yamlMeta.stagePipeline as string[])
          : [],
        currentStageIndex: safeInt(yamlMeta.currentStageIndex, 0),
        branchCounter: safeInt(yamlMeta.branchCounter, 1),
        branchHistory: Array.isArray(yamlMeta.branchHistory)
          ? (yamlMeta.branchHistory as string[])
          : [activeBranchId],
        tokensUsedTotal: safeInt(row.token_used, 0),
        tokenBudget: safeInt(row.token_budget, 120000),
        scenarioHints:
          yamlMeta.scenarioHints && typeof yamlMeta.scenarioHints === 'object'
            ? (yamlMeta.scenarioHints as Record<string, boolean>)
            : {},
        autoRepairCounts:
          yamlMeta.autoRepairCounts && typeof yamlMeta.autoRepairCounts === 'object'
            ? (yamlMeta.autoRepairCounts as Record<string, number>)
            : {},
      };
    });

    const rawSnapshots = Array.isArray(parsed.snapshots)
      ? (parsed.snapshots as Record<string, unknown>[])
      : [];
    const snapshotMetaById = new Map<string, { branchId: string; stageId: string }>();
    const snapshots: Record<string, unknown>[] = rawSnapshots.map((row) => {
      const snapId = String(row.id ?? '');
      const branchId = String(row.branch_id ?? '');
      const stageId = String(row.stage_id ?? '');
      snapshotMetaById.set(snapId, { branchId, stageId });

      const rawArtifact =
        row.artifact_json && typeof row.artifact_json === 'object'
          ? { ...(row.artifact_json as Record<string, unknown>) }
          : {};
      const snapMeta =
        rawArtifact.__snapshotMeta && typeof rawArtifact.__snapshotMeta === 'object'
          ? (rawArtifact.__snapshotMeta as Record<string, unknown>)
          : {};
      delete rawArtifact.__snapshotMeta;

      return {
        snapshotId: snapId,
        runId: String(row.run_id ?? ''),
        parentSnapshotId: row.parent_snap_id ? String(row.parent_snap_id) : null,
        branchId,
        stageId,
        agentRole: String(row.role_agent ?? ''),
        modelUsed: String(row.model_used ?? ''),
        state: String(row.state ?? 'IDLE'),
        riskScore: safeInt(row.risk_score, 0),
        riskLevel: String(snapMeta.riskLevel ?? 'LOW'),
        riskReasons: Array.isArray(snapMeta.riskReasons) ? snapMeta.riskReasons : [],
        gateAction: String(snapMeta.gateAction ?? 'AUTO_PASS_WITH_AUDIT'),
        scopeDiff: snapMeta.scopeDiff ?? {},
        cacheHit: Boolean(snapMeta.cacheHit),
        retryCount: safeInt(snapMeta.retryCount, 0),
        tokensConsumed: safeInt(snapMeta.tokensConsumed, 0),
        artifactSummary: String(snapMeta.artifactSummary ?? rawArtifact.summary ?? ''),
        artifactType: String(snapMeta.artifactType ?? rawArtifact.contractType ?? ''),
        artifactDetails: rawArtifact,
        createdAtIso: safeTimestampIso(row.created_at),
      };
    });

    const rawNegotiations = Array.isArray(parsed.negotiation_logs)
      ? (parsed.negotiation_logs as Record<string, unknown>[])
      : [];
    const negotiationLogs: NegotiationTurnRecord[] = rawNegotiations.map((row) => {
      const msg =
        row.message_structured && typeof row.message_structured === 'object'
          ? (row.message_structured as Record<string, unknown>)
          : {};
      return NegotiationTurnRecord.fromJSON({
        negotiationId: String(row.id ?? ''),
        runId: String(row.run_id ?? ''),
        branchId: String(row.branch_id ?? ''),
        topic: msg.topic ?? 'DESIGN_REVIEW',
        turnIndex: safeInt(row.turn_index, 1),
        maxTurnsAllowed: safeInt(msg.maxTurnsAllowed, 3),
        challengerRole: String(msg.challengerRole ?? row.from_stage ?? 'PD_AGENT'),
        responderRole: String(msg.responderRole ?? row.to_stage ?? 'PM_AGENT'),
        challengePoint: String(msg.challengePoint ?? ''),
        responseResolution: String(msg.responseResolution ?? ''),
        consensusReached: Boolean(msg.consensusReached),
        escalatedToSupervisor: Boolean(row.is_escalated),
        optionAProposal: msg.optionAProposal ? String(msg.optionAProposal) : undefined,
        optionBProposal: msg.optionBProposal ? String(msg.optionBProposal) : undefined,
        createdAtIso: safeTimestampIso(row.created_at),
      });
    });

    const rawDecisions = Array.isArray(parsed.human_decisions)
      ? (parsed.human_decisions as Record<string, unknown>[])
      : [];
    const humanDecisions: HumanDecisionRecord[] = rawDecisions.map((row) => {
      const snapId = String(row.snap_id ?? '');
      const linkedSnap = snapshotMetaById.get(snapId);
      return HumanDecisionRecord.fromJSON({
        decisionId: String(row.id ?? ''),
        runId: String(row.run_id ?? ''),
        snapshotId: snapId,
        branchId: linkedSnap?.branchId ?? 'branch-v1-main',
        stageId: linkedSnap?.stageId ?? 'STAGE_1_PM',
        reviewerActor: String(row.reviewer_id ?? ''),
        reviewerUserId: row.reviewer_user_id ? String(row.reviewer_user_id) : undefined,
        verdict: String(row.decision_type ?? 'APPROVE'),
        comment: String(row.comment ?? ''),
        createdAtIso: safeTimestampIso(row.created_at),
      });
    });

    const rawRag = Array.isArray(parsed.rejected_history_rag)
      ? (parsed.rejected_history_rag as Record<string, unknown>[])
      : [];
    const negativeExperienceRecords: NegativeExperienceVectorRecord[] = rawRag.map((row) => ({
      recordId: String(row.id ?? ''),
      stageId: String(row.stage_id ?? 'STAGE_3A_TECH_SPEC') as WorkflowStageId,
      desensitizedLesson: String(row.desensitized_lesson ?? ''),
      embedding: parsePgEmbedding(row.embedding),
      createdAtIso: safeTimestampIso(row.created_at),
      ...(row.embedding_source
        ? {
            embeddingSource: String(row.embedding_source) as 'HASH_FALLBACK' | 'REAL_EMBEDDING',
          }
        : {}),
    }));

    const rawComments = Array.isArray(parsed.team_comments)
      ? (parsed.team_comments as Record<string, unknown>[])
      : [];
    const teamComments: Record<string, unknown>[] = rawComments.map((row) => ({
      commentId: String(row.id ?? ''),
      runId: String(row.run_id ?? ''),
      stageId: String(row.stage_id ?? 'STAGE_0_INITIATION'),
      authorUserId: row.author_user_id ? String(row.author_user_id) : '',
      authorName: String(row.author_name ?? ''),
      authorJobTitle: String(row.author_job_title ?? ''),
      authorBadge: String(row.author_badge ?? ''),
      content: String(row.content ?? ''),
      category: String(row.category ?? 'COMMENT'),
      createdAtIso: safeTimestampIso(row.created_at),
    }));

    const rawNotifications = Array.isArray(parsed.notifications)
      ? (parsed.notifications as Record<string, unknown>[])
      : [];
    const notifications: Record<string, unknown>[] = rawNotifications.map((row) => ({
      notificationId: String(row.id ?? ''),
      runId: String(row.run_id ?? ''),
      branchId: String(row.branch_id ?? ''),
      stageId: String(row.stage_id ?? 'STAGE_1_PM'),
      senderRole: String(row.sender_role ?? 'SUPERVISOR_AGENT'),
      category: String(row.category ?? 'STAGE_PROGRESS'),
      title: String(row.title ?? ''),
      message: String(row.message ?? ''),
      relatedSnapshotId: String(row.related_snapshot_id ?? ''),
      requiresHumanAction: Boolean(row.requires_human_action),
      resolved: Boolean(row.resolved),
      actionOptions: Array.isArray(row.action_options) ? row.action_options : [],
      createdAtIso: safeTimestampIso(row.created_at),
    }));

    const rawLiveEvents = Array.isArray(parsed.live_events)
      ? (parsed.live_events as Record<string, unknown>[])
      : [];
    const liveEvents: Record<string, unknown>[] = rawLiveEvents.map((row) => ({
      eventId: String(row.id ?? ''),
      runId: String(row.run_id ?? ''),
      branchId: String(row.branch_id ?? ''),
      stageId: String(row.stage_id ?? 'STAGE_0_INITIATION'),
      agentRole: String(row.agent_role ?? 'SUPERVISOR_AGENT'),
      lifecycleState: String(row.lifecycle_state ?? 'IDLE'),
      headline: String(row.headline ?? ''),
      detailPayload:
        row.detail_payload && typeof row.detail_payload === 'object' ? row.detail_payload : {},
      timestampIso: safeTimestampIso(row.created_at),
    }));

    const rawAuditEntries = Array.isArray(parsed.audit_entries)
      ? (parsed.audit_entries as Record<string, unknown>[])
      : [];
    const auditEntries: Record<string, unknown>[] = rawAuditEntries.map((row) => ({
      entryId: String(row.id ?? ''),
      runId: String(row.run_id ?? ''),
      branchId: String(row.branch_id ?? ''),
      stageId: String(row.stage_id ?? 'STAGE_0_INITIATION'),
      actor: String(row.actor ?? ''),
      actionType: String(row.action_type ?? ''),
      summary: String(row.summary ?? ''),
      metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
      timestampIso: safeTimestampIso(row.created_at),
    }));

    const rawRuntimeState = Array.isArray(parsed.system_runtime_state)
      ? (parsed.system_runtime_state as Record<string, unknown>[])
      : [];
    let governanceConfig: PersistedGovernanceConfig | undefined;
    let cacheTelemetry: PersistedCacheTelemetry | undefined;
    let intentTraces: Record<string, unknown>[] | undefined;
    for (const row of rawRuntimeState) {
      const stateKey = String(row.state_key ?? '');
      const statePayload =
        row.payload && typeof row.payload === 'object'
          ? (row.payload as Record<string, unknown>)
          : null;
      if (!statePayload) {
        continue;
      }
      if (stateKey === 'governance_config') {
        governanceConfig = statePayload as unknown as PersistedGovernanceConfig;
      } else if (stateKey === 'cache_telemetry') {
        cacheTelemetry = statePayload as unknown as PersistedCacheTelemetry;
      } else if (stateKey === 'intent_traces' && Array.isArray(statePayload.traces)) {
        intentTraces = statePayload.traces as Record<string, unknown>[];
      }
    }

    return {
      schemaVersion: '1.1.0',
      lastSyncedAtIso: new Date().toISOString(),
      runs,
      snapshots,
      negotiationLogs,
      humanDecisions,
      negativeExperienceRecords,
      ...(teamComments.length > 0 ? { teamComments } : {}),
      ...(notifications.length > 0 ? { notifications } : {}),
      ...(liveEvents.length > 0 ? { liveEvents } : {}),
      ...(auditEntries.length > 0 ? { auditEntries } : {}),
      ...(governanceConfig ? { governanceConfig } : {}),
      ...(cacheTelemetry ? { cacheTelemetry } : {}),
      ...(intentTraces && intentTraces.length > 0 ? { intentTraces } : {}),
    };
  }

  public appendAudit(_entry: Record<string, unknown>): void {
    // 审计 JSONL 持续追加（Append-Only 不变），PG 侧在 saveFullState 时批量同步
  }
}

/**
 * 存储驱动选择器：DATABASE_URL 存在 → PG；否则 JSON 文件（单机轻量降级）
 */
export function selectPersistenceDriver(
  databaseUrl?: string,
  sqlExecutor?: PgSqlExecutor,
  options?: PgPersistenceDriverOptions,
): PersistenceDriver | null {
  const url = databaseUrl ?? process.env.DATABASE_URL ?? '';
  if (url) {
    try {
      return new PgPersistenceDriver(url, sqlExecutor, options);
    } catch {
      console.warn('[D2] DATABASE_URL 存在但 PG 驱动初始化失败，回落 JSON 模式');
    }
  }
  return null;
}
