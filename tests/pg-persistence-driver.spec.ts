/**
 * @file pg-persistence-driver.spec.ts
 * @description AUDIT-8 / D2 验收测试套件：
 * 1. `buildPgUpsertSql` 与 `PersistenceRepository.generatePostgreSqlStatements` 补齐 `negotiation_logs`、
 *    `team_comments` 与真实 `token_budget`/`token_used`（杜绝 120000 硬编码）；
 * 2. `selectPersistenceDriver` 驱动选择行为与 `PersistenceRepository.getActiveDriver()` 接线；
 * 3. `PgPersistenceDriver.saveFullState()` → 删 `ledger-store.json` → `WorkflowOrchestratorFacade.restoreFromPersistence()`
 *    经 `PgPersistenceDriver.loadFullState()` 完整恢复运行态（含协商日志/RAG/团队评论/预算）；
 * 4. `deploy/init-pgvector-schema.sql` 覆盖全部 10 张表与双轨关联 `ALTER TABLE`；
 * 5. `selectUserStore` + `PgUserStore` + `SessionService` 完整用户/阶段/会话/登录审计 PG 往返闭环。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict, WorkflowStageId } from '../src/domain/enums.ts';
import { PersistenceRepository } from '../src/engine/PersistenceRepository.ts';
import { WorkflowDslConfiguration, WorkflowDslLoader } from '../src/engine/WorkflowDslLoader.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import {
  buildPgUpsertSql,
  PgPersistenceDriver,
  type PgSqlExecutor,
  selectPersistenceDriver,
} from '../src/engine/pg/PgPersistenceDriver.ts';
import { SessionService } from '../src/server/auth/SessionService.ts';
import { JsonUserStore, PgUserStore, selectUserStore } from '../src/server/auth/UserStore.ts';

type SqlToken = string | number | boolean | null;

/** 轻量 SQL VALUES 词法解析器：从 INSERT 语句的 VALUES (...) 提取强类型值数组 */
function parseSqlValuesList(valuesClause: string): SqlToken[] {
  const result: SqlToken[] = [];
  let i = 0;
  const len = valuesClause.length;

  const skipWs = (): void => {
    while (i < len && /\s/.test(valuesClause[i])) {
      i++;
    }
  };

  while (i < len) {
    skipWs();
    if (i >= len) {
      break;
    }
    const ch = valuesClause[i];
    if (ch === "'") {
      i++;
      let str = '';
      while (i < len) {
        if (valuesClause[i] === "'") {
          if (valuesClause[i + 1] === "'") {
            str += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          str += valuesClause[i];
          i++;
        }
      }
      // 跳过 ::jsonb / ::vector / ::timestamptz 类型强转
      if (valuesClause.slice(i, i + 2) === '::') {
        i += 2;
        while (i < len && /[a-zA-Z0-9_]/.test(valuesClause[i])) {
          i++;
        }
      }
      result.push(str);
    } else if (ch === '(') {
      // 处理标量子查询如 (SELECT id FROM users WHERE id = 'user-pm-01')
      let depth = 1;
      const start = i + 1;
      i++;
      let inStr = false;
      while (i < len && depth > 0) {
        if (valuesClause[i] === "'") {
          if (inStr && valuesClause[i + 1] === "'") {
            i += 2;
            continue;
          }
          inStr = !inStr;
        } else if (!inStr) {
          if (valuesClause[i] === '(') {
            depth++;
          } else if (valuesClause[i] === ')') {
            depth--;
          }
        }
        i++;
      }
      const subSql = valuesClause.slice(start, i - 1);
      const idMatch = subSql.match(/WHERE\s+id\s*=\s*'((?:[^']|'')*)'/i);
      result.push(idMatch ? idMatch[1].replace(/''/g, "'") : null);
    } else {
      const start = i;
      while (i < len && valuesClause[i] !== ',') {
        i++;
      }
      const raw = valuesClause.slice(start, i).trim();
      if (raw.toUpperCase() === 'NULL') {
        result.push(null);
      } else if (raw.toUpperCase() === 'TRUE') {
        result.push(true);
      } else if (raw.toUpperCase() === 'FALSE') {
        result.push(false);
      } else if (raw === 'NOW()') {
        result.push(new Date().toISOString());
      } else {
        const n = Number(raw);
        result.push(Number.isFinite(n) ? n : raw);
      }
    }
    skipWs();
    if (valuesClause[i] === ',') {
      i++;
    }
  }
  return result;
}

/** 拆解单个 SQL 脚本中的顶层 INSERT / DELETE / UPDATE 语句 */
function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      current += ch;
      if (inStr && sql[i + 1] === "'") {
        current += "'";
        i++;
      } else {
        inStr = !inStr;
      }
    } else if (ch === ';' && !inStr) {
      const trimmed = current.trim();
      if (trimmed && !trimmed.startsWith('--')) {
        stmts.push(trimmed);
      }
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    stmts.push(current.trim());
  }
  return stmts;
}

function extractInsertClause(stmt: string): { table: string; vals: SqlToken[] } | null {
  const match = stmt.match(
    /^INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\([^)]+\)\s*VALUES\s*\(([\s\S]*?)\)(?:\s+ON\s+CONFLICT[\s\S]*|\s+RETURNING[\s\S]*)?$/i,
  );
  if (!match) {
    return null;
  }
  return {
    table: match[1],
    vals: parseSqlValuesList(match[2]),
  };
}

/** 创建模拟 PG 事务库执行器：解析真实 UPSERT SQL 并按 PG `json_build_object` 协议回读 */
function createFakePgLedgerExecutor(): {
  executor: PgSqlExecutor;
  capturedSql: string[];
  tables: {
    runs: Map<string, Record<string, unknown>>;
    snapshots: Map<string, Record<string, unknown>>;
    negotiations: Map<string, Record<string, unknown>>;
    decisions: Map<string, Record<string, unknown>>;
    rag: Map<string, Record<string, unknown>>;
    comments: Map<string, Record<string, unknown>>;
  };
} {
  const capturedSql: string[] = [];
  const tables = {
    runs: new Map<string, Record<string, unknown>>(),
    snapshots: new Map<string, Record<string, unknown>>(),
    negotiations: new Map<string, Record<string, unknown>>(),
    decisions: new Map<string, Record<string, unknown>>(),
    rag: new Map<string, Record<string, unknown>>(),
    comments: new Map<string, Record<string, unknown>>(),
  };

  const executor: PgSqlExecutor = (sql, options) => {
    capturedSql.push(sql);
    if (options?.readOnly && sql.includes('json_build_object')) {
      return JSON.stringify({
        runs: [...tables.runs.values()],
        snapshots: [...tables.snapshots.values()],
        negotiation_logs: [...tables.negotiations.values()],
        human_decisions: [...tables.decisions.values()],
        rejected_history_rag: [...tables.rag.values()],
        team_comments: [...tables.comments.values()],
      });
    }

    for (const stmt of splitSqlStatements(sql)) {
      const parsed = extractInsertClause(stmt);
      if (!parsed) {
        continue;
      }
      const v = parsed.vals;
      switch (parsed.table) {
        case 'workflow_runs': {
          const id = String(v[0]);
          tables.runs.set(id, {
            id,
            title: String(v[1]),
            workflow_template_name: String(v[2]),
            workflow_snapshot_yaml: JSON.parse(String(v[3] ?? '{}')),
            active_branch_id: String(v[4]),
            token_budget: Number(v[5]),
            token_used: Number(v[6]),
            status: String(v[7]),
            created_by: String(v[8]),
            created_at: String(v[9]),
          });
          break;
        }
        case 'stage_snapshots': {
          const id = String(v[0]);
          tables.snapshots.set(id, {
            id,
            run_id: String(v[1]),
            parent_snap_id: v[2] === null ? null : String(v[2]),
            branch_id: String(v[3]),
            stage_id: String(v[4]),
            role_agent: String(v[5]),
            model_used: String(v[6]),
            artifact_json: JSON.parse(String(v[7] ?? '{}')),
            risk_score: Number(v[8]),
            state: String(v[9]),
            created_at: String(v[10]),
          });
          break;
        }
        case 'negotiation_logs': {
          const id = String(v[0]);
          tables.negotiations.set(id, {
            id,
            run_id: String(v[1]),
            branch_id: String(v[2]),
            from_stage: String(v[3]),
            to_stage: String(v[4]),
            turn_index: Number(v[5]),
            message_structured: JSON.parse(String(v[6] ?? '{}')),
            scope_diff: JSON.parse(String(v[7] ?? '{}')),
            is_escalated: Boolean(v[8]),
            created_at: String(v[9]),
          });
          break;
        }
        case 'human_decisions': {
          const id = String(v[0]);
          if (!tables.decisions.has(id)) {
            tables.decisions.set(id, {
              id,
              run_id: String(v[1]),
              snap_id: String(v[2]),
              reviewer_id: String(v[3]),
              decision_type: String(v[4]),
              comment: String(v[5]),
              created_at: String(v[6]),
            });
          }
          break;
        }
        case 'rejected_history_rag': {
          const id = String(v[0]);
          tables.rag.set(id, {
            id,
            stage_id: String(v[1]),
            desensitized_lesson: String(v[2]),
            embedding: String(v[3]),
            created_at: String(v[4]),
          });
          break;
        }
        case 'team_comments': {
          const id = String(v[0]);
          if (!tables.comments.has(id)) {
            tables.comments.set(id, {
              id,
              run_id: String(v[1]),
              stage_id: String(v[2]),
              author_user_id: v[3] ? String(v[3]) : null,
              author_name: String(v[4]),
              author_job_title: String(v[5]),
              author_badge: String(v[6]),
              content: String(v[7]),
              category: String(v[8]),
              created_at: String(v[9]),
            });
          }
          break;
        }
        default:
          break;
      }
    }
    return '';
  };

  return { executor, capturedSql, tables };
}

/** 创建模拟 PG 用户库执行器：处理 users / user_owned_stages / auth_sessions / auth_login_audit */
function createFakePgAuthExecutor(): {
  executor: PgSqlExecutor;
  users: Map<string, Record<string, unknown>>;
  ownedStages: Map<string, Set<string>>;
  sessions: Map<string, Record<string, unknown>>;
  loginAudits: Array<{
    id: number;
    username: string;
    success: boolean;
    reason: string;
    createdAtIso: string;
  }>;
} {
  const users = new Map<string, Record<string, unknown>>();
  const ownedStages = new Map<string, Set<string>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const loginAudits: Array<{
    id: number;
    username: string;
    success: boolean;
    reason: string;
    createdAtIso: string;
  }> = [];

  const executor: PgSqlExecutor = (sql, options) => {
    if (options?.readOnly) {
      if (sql.includes('FROM users u')) {
        const list = [...users.values()].map((u) => ({
          ...u,
          ownedStageIds: [...(ownedStages.get(String(u.userId)) ?? new Set())].sort(),
        }));
        return JSON.stringify(list);
      }
      if (sql.includes('FROM auth_sessions') && sql.includes('LIMIT 1')) {
        const hashMatch = sql.match(/token_hash\s*=\s*'([^']+)'/);
        const rec = hashMatch ? sessions.get(hashMatch[1]) : undefined;
        return rec ? JSON.stringify(rec) : '';
      }
      if (sql.includes('json_agg(token_hash')) {
        return JSON.stringify([...sessions.keys()]);
      }
      if (sql.includes('FROM auth_login_audit')) {
        const userMatch = sql.match(/LOWER\(username\)\s*=\s*'([^']+)'/);
        const limitMatch = sql.match(/LIMIT\s+(\d+)/);
        const filterUser = userMatch ? userMatch[1].toLowerCase() : null;
        const limit = limitMatch ? Number(limitMatch[1]) : 20;
        const filtered = filterUser
          ? loginAudits.filter((a) => a.username.toLowerCase() === filterUser)
          : loginAudits;
        return JSON.stringify(filtered.slice(-limit).reverse());
      }
    }

    let lastReturn = '';
    for (const stmt of splitSqlStatements(sql)) {
      if (/^DELETE\s+FROM\s+user_owned_stages/i.test(stmt)) {
        const match = stmt.match(/user_id\s*=\s*'([^']+)'/);
        if (match) {
          ownedStages.set(match[1], new Set());
        }
        continue;
      }
      if (/^UPDATE\s+auth_sessions/i.test(stmt)) {
        const expMatch = stmt.match(/expires_at\s*=\s*'([^']+)'::timestamptz/);
        const hashMatch = stmt.match(/token_hash\s*=\s*'([^']+)'/);
        if (hashMatch && expMatch && sessions.has(hashMatch[1])) {
          const existing = sessions.get(hashMatch[1])!;
          sessions.set(hashMatch[1], {
            ...existing,
            expiresAt: Date.parse(expMatch[1]),
          });
        }
        continue;
      }
      if (/^DELETE\s+FROM\s+auth_sessions/i.test(stmt)) {
        const hashMatch = stmt.match(/token_hash\s*=\s*'([^']+)'/);
        const userMatch = stmt.match(/user_id\s*=\s*'([^']+)'/);
        const exceptMatch = stmt.match(/token_hash\s*<>\s*'([^']+)'/);
        if (hashMatch && !userMatch) {
          sessions.delete(hashMatch[1]);
        } else if (userMatch) {
          const targetUid = userMatch[1];
          const keep = exceptMatch ? exceptMatch[1] : null;
          for (const [k, s] of [...sessions.entries()]) {
            if (s.userId === targetUid && k !== keep) {
              sessions.delete(k);
            }
          }
        }
        continue;
      }

      const parsed = extractInsertClause(stmt);
      if (!parsed) {
        continue;
      }
      const v = parsed.vals;
      if (parsed.table === 'users') {
        const userId = String(v[0]);
        users.set(userId, {
          userId,
          username: String(v[1]),
          displayName: String(v[2]),
          jobTitle: String(v[3]),
          department: String(v[4]),
          tier: String(v[5]),
          specialistDomain: String(v[6]),
          counterpartAgentRole: String(v[7]),
          avatarBadge: String(v[8]),
          passwordHash: String(v[9]),
          mustChangePassword: Boolean(v[10]),
          status: String(v[11]),
          failedLoginCount: Number(v[12]),
          lockedUntil: v[13] ? String(v[13]) : null,
        });
      } else if (parsed.table === 'user_owned_stages') {
        const uid = String(v[0]);
        const sid = String(v[1]);
        if (!ownedStages.has(uid)) {
          ownedStages.set(uid, new Set());
        }
        ownedStages.get(uid)!.add(sid);
      } else if (parsed.table === 'auth_sessions') {
        const tokenHash = String(v[0]);
        sessions.set(tokenHash, {
          tokenHash,
          userId: String(v[1]),
          impersonatedBy: v[2] ? String(v[2]) : null,
          expiresAt: Date.parse(String(v[5])),
        });
      } else if (parsed.table === 'auth_login_audit') {
        const id = loginAudits.length + 1;
        loginAudits.push({
          id,
          username: String(v[0]),
          success: Boolean(v[1]),
          reason: String(v[2]),
          createdAtIso: String(v[3]),
        });
        lastReturn = String(id);
      }
    }
    return lastReturn;
  };

  return { executor, users, ownedStages, sessions, loginAudits };
}

describe('AUDIT-8 / D2 — PostgreSQL 全量同步、PgPersistenceDriver 与 PgUserStore 验收测试', () => {
  it('1. buildPgUpsertSql & PersistenceRepository 输出真实 token_budget/token_used、negotiation_logs 与 team_comments（零 120000 硬编码）', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit8-sql-'));
    try {
      const baseDsl = WorkflowDslLoader.loadFromFile();
      const customDsl = new WorkflowDslConfiguration({
        id: baseDsl.id,
        name: baseDsl.name,
        deploymentMode: baseDsl.deploymentMode,
        sourceFilePath: baseDsl.sourceFilePath,
        rawYamlSnapshot: baseDsl.rawYamlSnapshot,
        guardrails: {
          ...baseDsl.guardrails,
          tokenBudgetLimit: 88000,
        },
        modelRouting: baseDsl.modelRouting,
        stages: baseDsl.stages,
      });

      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: path.join(tempDir, 'persist'),
        sandboxRootDir: path.join(tempDir, 'sandbox'),
        dslConfiguration: customDsl,
        persistenceDriver: null,
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-AUDIT8-SQL-001',
        title: 'PG 同步完整性与定制预算验证',
        summary: '触发协商轮次、人工裁决、负向经验沉淀与团队评论',
        requirements: {
          REQ_SYNC_1: '协商日志写入 negotiation_logs',
          REQ_SYNC_2: 'token_budget 与 token_used 真实反映运行配置',
        },
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '架构师-林工',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      const pendingSnap = runState.getLatestSnapshotOnActiveBranch();
      assert.ok(pendingSnap);
      await orchestrator.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: pendingSnap.snapshotId,
        reviewerActor: '设计总监-林工',
        verdict: DecisionVerdict.ARBITRATE_OPTION_A,
        comment: '选择标准降级方案 A',
      });

      await orchestrator.invokeSupervisorConversationalRollback({
        runId: runState.runId,
        humanActor: '架构师-林工',
        dialogueInstruction: '回退到 Tech Lead 补充防超卖锁',
      });

      orchestrator.addTeamComment({
        runId: runState.runId,
        stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
        actorUserId: 'user-tech-01',
        content: '需补充分布式锁 TTL 监控',
      });

      const persisted = orchestrator.persistenceRepo.loadPersistedSnapshot();
      assert.ok(persisted);
      const sql = orchestrator.persistenceRepo.generatePostgreSqlStatements(persisted);

      assert.equal(sql, buildPgUpsertSql(persisted));
      assert.ok(sql.includes('INSERT INTO workflow_runs'));
      assert.ok(sql.includes(', 88000, '), 'workflow_runs SQL 应写入真实 token_budget 88000');
      assert.equal(
        sql.includes(', 120000, '),
        false,
        '禁止将 token_budget 硬编码为 120000 覆盖真实配置',
      );
      assert.ok(runState.getTokensUsedTotal() > 0);
      assert.ok(
        sql.includes(`, ${runState.getTokensUsedTotal()}, `),
        'workflow_runs SQL 应写入真实累计 token_used',
      );
      assert.ok(sql.includes('INSERT INTO stage_snapshots'));
      assert.ok(sql.includes('INSERT INTO negotiation_logs'));
      assert.ok(sql.includes("'STAGE_2_PD'"));
      assert.ok(sql.includes('INSERT INTO human_decisions'));
      assert.ok(sql.includes('INSERT INTO rejected_history_rag'));
      assert.ok(sql.includes('::vector'));
      assert.ok(sql.includes('INSERT INTO team_comments'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. selectPersistenceDriver() 在无 DATABASE_URL 返回 null，存在时返回 PgPersistenceDriver 并接入 PersistenceRepository', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit8-driver-'));
    const prevDbUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      assert.equal(selectPersistenceDriver(), null);
      const repoNoDb = new PersistenceRepository(path.join(tempDir, 'no-db'));
      assert.equal(repoNoDb.getActiveDriver(), null);

      const { executor } = createFakePgLedgerExecutor();
      process.env.DATABASE_URL = 'postgres://sdlc:secret@localhost:5432/sdlc_os';
      const selected = selectPersistenceDriver(undefined, executor);
      assert.ok(selected instanceof PgPersistenceDriver);

      const repoWithDb = new PersistenceRepository(path.join(tempDir, 'with-db'), {
        driver: new PgPersistenceDriver(process.env.DATABASE_URL, executor),
      });
      assert.ok(repoWithDb.getActiveDriver() instanceof PgPersistenceDriver);
    } finally {
      if (prevDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDbUrl;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. PgPersistenceDriver saveFullState → 删除 ledger-store.json → Facade.restoreFromPersistence 从 PG 完整还原状态', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit8-pg-roundtrip-'));
    const persistDir = path.join(tempDir, 'persist');
    const sandboxDir = path.join(tempDir, 'sandbox');
    try {
      const fakePg = createFakePgLedgerExecutor();
      const pgDriver = new PgPersistenceDriver('postgres://fake/db', fakePg.executor);

      const baseDsl = WorkflowDslLoader.loadFromFile();
      const customDsl = new WorkflowDslConfiguration({
        id: baseDsl.id,
        name: baseDsl.name,
        deploymentMode: baseDsl.deploymentMode,
        sourceFilePath: baseDsl.sourceFilePath,
        rawYamlSnapshot: baseDsl.rawYamlSnapshot,
        guardrails: { ...baseDsl.guardrails, tokenBudgetLimit: 96000 },
        modelRouting: baseDsl.modelRouting,
        stages: baseDsl.stages,
      });

      const facade1 = new WorkflowOrchestratorFacade({
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
        dslConfiguration: customDsl,
        persistenceDriver: pgDriver,
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-AUDIT8-RT-001',
        title: 'PG 完整恢复端到端验证',
        summary: '删掉 JSON 文件后仅凭 PG loadFullState 还原运行态',
        requirements: { REQ_PG_RT: 'PG 读回后快照、协商、裁决、RAG 与评论完整一致' },
      });

      const run1 = await facade1.startProposalWorkflow({
        proposal,
        initiatorActor: '架构师-PG',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      const paused1 = run1.getLatestSnapshotOnActiveBranch();
      assert.ok(paused1);
      await facade1.submitHumanGateDecision({
        runId: run1.runId,
        snapshotId: paused1.snapshotId,
        reviewerActor: '设计总监-PG',
        verdict: DecisionVerdict.ARBITRATE_OPTION_B,
        comment: '选择定制设计方案 B',
      });

      await facade1.invokeSupervisorConversationalRollback({
        runId: run1.runId,
        humanActor: '架构师-PG',
        dialogueInstruction: '回退到 Tech Lead 校验 PG 索引',
      });

      facade1.addTeamComment({
        runId: run1.runId,
        stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
        actorUserId: 'user-pm-01',
        content: '确认索引策略已记录',
      });

      const expectedSnapshotsCount = run1.getAllSnapshots().length;
      const expectedTokensUsed = run1.getTokensUsedTotal();
      const expectedNegotiationCount = facade1.negotiationMediator
        .getNegotiationHistory()
        .filter((n) => n.runId === run1.runId).length;
      const expectedDecisionCount = facade1.auditLedger.getHumanDecisions(run1.runId).length;
      const expectedRagCount = facade1.auditLedger.ragEngine.getAllRecords().length;
      const expectedCommentsCount = facade1.getAllTeamComments().length;

      assert.ok(expectedNegotiationCount > 0, 'PG 表应已写入协商轮次');
      assert.ok(fakePg.tables.negotiations.size >= expectedNegotiationCount);

      // 删除本地 ledger-store.json，强制验证恢复来自 PG driver loadFullState()
      const ledgerJsonPath = path.join(persistDir, 'ledger-store.json');
      assert.equal(fs.existsSync(ledgerJsonPath), true);
      fs.rmSync(ledgerJsonPath, { force: true });
      assert.equal(fs.existsSync(ledgerJsonPath), false);

      const facade2 = new WorkflowOrchestratorFacade({
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
        dslConfiguration: customDsl,
        persistenceDriver: pgDriver,
      });
      const restored = facade2.restoreFromPersistence();
      assert.equal(restored.restored, true, '删除 JSON 后应仍能通过 PG driver 恢复');
      assert.ok(restored.runIds.includes(run1.runId));

      const run2 = facade2.stateEngine.getRunOrThrow(run1.runId);
      assert.equal(run2.getTokenBudget(), 96000);
      assert.equal(run2.getTokensUsedTotal(), expectedTokensUsed);
      assert.equal(run2.getAllSnapshots().length, expectedSnapshotsCount);
      assert.equal(
        facade2.negotiationMediator.getNegotiationHistory().filter((n) => n.runId === run1.runId)
          .length,
        expectedNegotiationCount,
      );
      assert.equal(facade2.auditLedger.getHumanDecisions(run1.runId).length, expectedDecisionCount);
      assert.equal(facade2.auditLedger.ragEngine.getAllRecords().length, expectedRagCount);
      assert.equal(facade2.getAllTeamComments().length, expectedCommentsCount);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. deploy/init-pgvector-schema.sql 应包含全部 10 张业务/用户表与双轨关联 ALTER TABLE 语句', () => {
    const schemaPath = path.resolve(process.cwd(), 'deploy', 'init-pgvector-schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    const requiredTables = [
      'workflow_runs',
      'stage_snapshots',
      'negotiation_logs',
      'human_decisions',
      'rejected_history_rag',
      'users',
      'user_owned_stages',
      'auth_sessions',
      'auth_login_audit',
      'team_comments',
    ];
    for (const table of requiredTables) {
      assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Schema 缺失表定义: ${table}`);
    }
    assert.ok(
      sql.includes('ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS created_by_user_id'),
      'Schema 缺失 workflow_runs.created_by_user_id 外键列',
    );
    assert.ok(
      sql.includes('ALTER TABLE human_decisions ADD COLUMN IF NOT EXISTS reviewer_user_id'),
      'Schema 缺失 human_decisions.reviewer_user_id 外键列',
    );
  });

  it('5. selectUserStore + PgUserStore + SessionService 完成用户/权限/会话/审计 PG 持久化与重启恢复', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit8-pg-user-'));
    const prevDbUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      const defaultStore = selectUserStore({ usersFilePath: path.join(tempDir, 'u.json') });
      assert.ok(defaultStore instanceof JsonUserStore);

      const fakeAuth = createFakePgAuthExecutor();
      const pgUrl = 'postgres://sdlc:secret@localhost:5432/sdlc_os';
      process.env.DATABASE_URL = pgUrl;

      const store1 = selectUserStore({
        usersFilePath: path.join(tempDir, 'u.json'),
        pgExecutor: fakeAuth.executor,
      });
      assert.ok(store1 instanceof PgUserStore);

      const svc1 = new SessionService(store1);
      assert.equal(fakeAuth.users.size, 7, '首次启动应在 PG 播种 7 个默认企业成员');
      assert.ok(
        (fakeAuth.ownedStages.get('user-qa-01')?.size ?? 0) > 0,
        'user_owned_stages 应写入阶段归属',
      );

      // 登录写会话（仅存 SHA-256 摘要）与登录审计
      const badLogin = svc1.login('admin', 'wrongpass');
      assert.equal(badLogin.ok, false);
      const login1 = svc1.login('admin', 'admin');
      assert.equal(login1.ok, true);
      const token1 = (login1 as { token: string }).token;
      const login2 = svc1.login('admin', 'admin');
      assert.equal(login2.ok, true);
      const token2 = (login2 as { token: string }).token;
      assert.equal(fakeAuth.sessions.size, 2);
      assert.equal(fakeAuth.sessions.has(token1), false, 'PG auth_sessions 绝不能存明文 token');

      // 创建新用户、改密保留当前会话 token2 并吊销 token1
      const created = svc1.createUser('user-admin-01', {
        username: 'sec_ops',
        displayName: '安全合规官',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'QUALITY_ASSURANCE',
        counterpartAgentRole: 'QA_AGENT',
        ownedStageIds: ['STAGE_4_QA'],
        tempPassword: 'InitPass99',
      });
      assert.equal(created.ok, true);
      svc1.updateUser('user-admin-01', created.user!.userId, { displayName: '首席安全合规官' });

      const chPwd = svc1.changePassword('user-admin-01', 'admin', 'AdminPass2026', token2);
      assert.equal(chPwd.ok, true);
      assert.equal(fakeAuth.sessions.size, 1, '改密应吊销 PG 中的其他会话，仅保留当前会话');

      // 模拟服务端进程重启：全新 PgUserStore + SessionService（内存全空，仅靠 PG 回读）
      const store2 = selectUserStore({
        usersFilePath: path.join(tempDir, 'u2.json'),
        databaseUrl: pgUrl,
        pgExecutor: fakeAuth.executor,
      });
      const svc2 = new SessionService(store2);

      assert.equal(svc2.validate(token1), null, '已吊销会话跨重启仍失效');
      assert.equal(svc2.validate(token2)?.userId, 'user-admin-01', '保留会话跨重启仍有效');
      const secLogin = svc2.login('sec_ops', 'InitPass99');
      assert.equal(secLogin.ok, true);
      assert.equal(
        (secLogin as { user: { displayName: string } }).user.displayName,
        '首席安全合规官',
      );

      const audits = svc2.getLoginAudit({ username: 'admin', limit: 10 });
      assert.ok(audits.some((a) => a.reason === 'BAD_PASSWORD'));
      assert.ok(audits.some((a) => a.reason === 'OK'));
    } finally {
      if (prevDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDbUrl;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
