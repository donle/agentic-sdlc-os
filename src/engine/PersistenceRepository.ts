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
import type { PersistedCacheTelemetrySnapshot } from '../telemetry/PromptCacheManager.ts';
import type { WorkflowRunState } from './DagWorkflowStateEngine.ts';
import type { AuditTrailEntry } from './ImmutableAuditLedger.ts';
import type { NegativeExperienceVectorRecord } from './NegativeExperienceRagEngine.ts';
import { buildPgUpsertSql, selectPersistenceDriver } from './pg/PgPersistenceDriver.ts';

export interface PersistedGovernanceConfig {
  readonly maxNegotiationTurns: number;
  readonly highRiskScoreThreshold: number;
  readonly allowSpecialistCrossStageRollback: boolean;
}

export type PersistedCacheTelemetry = PersistedCacheTelemetrySnapshot;

export interface PersistedRunRecord {
  readonly runId: string;
  readonly title: string;
  readonly workflowTemplateId: string;
  readonly activeBranchId: string;
  readonly status: string;
  readonly initiatorActor: string;
  readonly createdByUserId?: string;
  readonly createdAtIso: string;
  /** D1：完整重建运行状态机所需字段 */
  readonly proposal: Record<string, unknown>;
  readonly stagePipeline: ReadonlyArray<string>;
  readonly currentStageIndex: number;
  readonly branchCounter: number;
  readonly branchHistory: ReadonlyArray<string>;
  readonly tokensUsedTotal: number;
  /** AUDIT-8：运行实例对应的 Token 预算上限（取代 PG 硬编码 120000） */
  readonly tokenBudget?: number;
  readonly scenarioHints: Record<string, boolean>;
  /** AUDIT-9：各修复闭环的已尝试次数（防重启后清零绕过上限） */
  readonly autoRepairCounts?: Readonly<Record<string, number>>;
}

export interface PersistenceDriver {
  saveFullState(snapshot: PersistedLedgerSnapshot): void;
  loadFullState(): PersistedLedgerSnapshot | null;
  appendAudit(entry: Record<string, unknown>): void;
}

export interface PersistedLedgerSnapshot {
  readonly schemaVersion: string;
  readonly lastSyncedAtIso: string;
  readonly runs: ReadonlyArray<PersistedRunRecord>;
  readonly snapshots: ReadonlyArray<Record<string, unknown>>;
  readonly negotiationLogs: ReadonlyArray<NegotiationTurnRecord>;
  readonly humanDecisions: ReadonlyArray<HumanDecisionRecord>;
  readonly negativeExperienceRecords: ReadonlyArray<NegativeExperienceVectorRecord>;
  /** D1：EventBus 事件历史快照（供 liveInteractionStream 恢复） */
  readonly liveEvents?: ReadonlyArray<Record<string, unknown>>;
  /** AUDIT-9：EventBus 通知收件箱（保留待审批门禁卡片与已处理状态） */
  readonly notifications?: ReadonlyArray<Record<string, unknown>>;
  /** AUDIT-9：团队评论与签核备注（StageTeamCommentRecord） */
  readonly teamComments?: ReadonlyArray<Record<string, unknown>>;
  /** AUDIT-9：审计时间线条目兜底快照（WAL 缺失时亦可恢复） */
  readonly auditEntries?: ReadonlyArray<Record<string, unknown>>;
  /** P1-2：动态治理参数、缓存遥测与意图达成复盘追踪 */
  readonly governanceConfig?: PersistedGovernanceConfig;
  readonly cacheTelemetry?: PersistedCacheTelemetry;
  readonly intentTraces?: ReadonlyArray<Record<string, unknown>>;
}

export class PersistenceRepository {
  private readonly storageDir: string;
  private readonly snapshotFilePath: string;
  private readonly sqlDumpFilePath: string;
  private readonly pgDriver: PersistenceDriver | null;
  private lastSyncedAtIso: string;

  public constructor(
    storageDir?: string,
    options?: { databaseUrl?: string; driver?: PersistenceDriver | null },
  ) {
    this.storageDir =
      storageDir ??
      path.resolve(process.cwd(), process.env.LOCAL_PERSISTENCE_DIR ?? '.runtime-data');
    this.snapshotFilePath = path.join(this.storageDir, 'ledger-store.json');
    this.sqlDumpFilePath = path.join(this.storageDir, 'pgvector-sync.sql');
    this.pgDriver =
      options?.driver !== undefined
        ? options.driver
        : selectPersistenceDriver(options?.databaseUrl);
    this.lastSyncedAtIso = new Date().toISOString();
    this.ensureStorageDirectory();
  }

  public getActiveDriver(): PersistenceDriver | null {
    return this.pgDriver;
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
   * I3：按月归档——条目写入 `audit-trail-YYYY-MM.jsonl`（归属依据 entry.timestampIso）；
   * 旧的单文件 `audit-trail.jsonl` 仍可被 readAuditWalEntries 合并读取（兼容历史数据）。
   */
  public appendAuditEntryToWal(entry: AuditTrailEntry): void {
    this.ensureStorageDirectory();
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(this.resolveMonthlyWalFilePath(entry.timestampIso), line, 'utf-8');
    this.pgDriver?.appendAudit(entry as unknown as Record<string, unknown>);
    this.lastSyncedAtIso = new Date().toISOString();
  }

  /** I3：按条目时间解析月度 WAL 文件路径 */
  private resolveMonthlyWalFilePath(timestampIso: string): string {
    const month = timestampIso.slice(0, 7); // YYYY-MM
    const safeMonth = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    return path.join(this.storageDir, `audit-trail-${safeMonth}.jsonl`);
  }

  /** I3：列出全部 WAL 文件（月度分片 + 旧单文件），按文件名字典序 = 时间序 */
  public getWalFileNames(): string[] {
    this.ensureStorageDirectory();
    return fs
      .readdirSync(this.storageDir)
      .filter((name) => /^audit-trail(-\d{4}-\d{2})?\.jsonl$/.test(name))
      .sort();
  }

  /**
   * 将当前所有运行实例、阶段快照、协商日志、人工裁决及负向经验向量持久化落盘，并同步生成 PostgreSQL + pgvector SQL
   */
  public persistFullState(params: {
    runs: ReadonlyArray<WorkflowRunState>;
    negotiationLogs: ReadonlyArray<NegotiationTurnRecord>;
    humanDecisions: ReadonlyArray<HumanDecisionRecord>;
    negativeExperienceRecords: ReadonlyArray<NegativeExperienceVectorRecord>;
    liveEvents?: ReadonlyArray<Record<string, unknown>>;
    notifications?: ReadonlyArray<Record<string, unknown>>;
    teamComments?: ReadonlyArray<Record<string, unknown>>;
    auditEntries?: ReadonlyArray<Record<string, unknown>>;
    governanceConfig?: PersistedGovernanceConfig;
    cacheTelemetry?: PersistedCacheTelemetry;
    intentTraces?: ReadonlyArray<Record<string, unknown>>;
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
        ...(r.createdByUserId ? { createdByUserId: r.createdByUserId } : {}),
        createdAtIso: r.createdAtIso,
        proposal: r.proposal.toSerializableRecord(),
        stagePipeline: [...r.getStagePipeline()],
        currentStageIndex: r.getCurrentStageIndex(),
        branchCounter: r.getBranchCounter(),
        branchHistory: [...r.getBranches()],
        tokensUsedTotal: r.getTokensUsedTotal(),
        tokenBudget: r.getTokenBudget(),
        scenarioHints: { ...r.scenarioHints },
        autoRepairCounts: r.getAutoRepairCountsRecord(),
      };
    });

    const payload: PersistedLedgerSnapshot = {
      schemaVersion: '1.1.0',
      lastSyncedAtIso: this.lastSyncedAtIso,
      runs: serializedRuns,
      snapshots: allSnapshots,
      negotiationLogs: [...params.negotiationLogs],
      humanDecisions: [...params.humanDecisions],
      negativeExperienceRecords: [...params.negativeExperienceRecords],
      liveEvents: [...(params.liveEvents ?? [])],
      notifications: [...(params.notifications ?? [])],
      teamComments: [...(params.teamComments ?? [])],
      ...(params.auditEntries ? { auditEntries: [...params.auditEntries] } : {}),
      ...(params.governanceConfig ? { governanceConfig: { ...params.governanceConfig } } : {}),
      ...(params.cacheTelemetry ? { cacheTelemetry: { ...params.cacheTelemetry } } : {}),
      ...(params.intentTraces ? { intentTraces: [...params.intentTraces] } : {}),
    };

    fs.writeFileSync(this.snapshotFilePath, JSON.stringify(payload, null, 2), 'utf-8');

    const sqlStatements = this.generatePostgreSqlStatements(payload);
    fs.writeFileSync(this.sqlDumpFilePath, sqlStatements, 'utf-8');

    // D2 / AUDIT-8：PG 驱动在位时统一委托 PgPersistenceDriver 同步（失败不阻塞 JSON 兜底）
    if (this.pgDriver) {
      this.pgDriver.saveFullState(payload);
    }

    return payload;
  }

  /**
   * 从磁盘或 PostgreSQL 读取已持久化的状态账本快照（PG 优先，失败或空库回落 JSON 兜底）
   */
  public loadPersistedSnapshot(): PersistedLedgerSnapshot | null {
    const jsonFallback = fs.existsSync(this.snapshotFilePath)
      ? (JSON.parse(fs.readFileSync(this.snapshotFilePath, 'utf-8')) as PersistedLedgerSnapshot)
      : null;

    if (this.pgDriver) {
      const pgSnapshot = this.pgDriver.loadFullState();
      if (pgSnapshot && pgSnapshot.runs.length > 0) {
        return {
          ...pgSnapshot,
          ...((pgSnapshot.liveEvents ?? jsonFallback?.liveEvents)
            ? { liveEvents: pgSnapshot.liveEvents ?? jsonFallback?.liveEvents }
            : {}),
          ...((pgSnapshot.notifications ?? jsonFallback?.notifications)
            ? { notifications: pgSnapshot.notifications ?? jsonFallback?.notifications }
            : {}),
          ...((pgSnapshot.teamComments ?? jsonFallback?.teamComments)
            ? { teamComments: pgSnapshot.teamComments ?? jsonFallback?.teamComments }
            : {}),
          ...((pgSnapshot.auditEntries ?? jsonFallback?.auditEntries)
            ? { auditEntries: pgSnapshot.auditEntries ?? jsonFallback?.auditEntries }
            : {}),
          ...((pgSnapshot.governanceConfig ?? jsonFallback?.governanceConfig)
            ? { governanceConfig: pgSnapshot.governanceConfig ?? jsonFallback?.governanceConfig }
            : {}),
          ...((pgSnapshot.cacheTelemetry ?? jsonFallback?.cacheTelemetry)
            ? { cacheTelemetry: pgSnapshot.cacheTelemetry ?? jsonFallback?.cacheTelemetry }
            : {}),
          ...((pgSnapshot.intentTraces ?? jsonFallback?.intentTraces)
            ? { intentTraces: pgSnapshot.intentTraces ?? jsonFallback?.intentTraces }
            : {}),
        };
      }
    }

    return jsonFallback;
  }

  /**
   * 读取 Append-Only JSONL 审计日志流中的所有记录
   */
  public readAuditWalEntries(): ReadonlyArray<Record<string, unknown>> {
    // I3：合并读取全部月度分片 + 旧单文件（字典序 = 月度时间序）
    const entries: Record<string, unknown>[] = [];
    for (const fileName of this.getWalFileNames()) {
      const filePath = path.join(this.storageDir, fileName);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as Record<string, unknown>);
        } catch (err) {
          console.warn(
            `[D1 WAL] 跳过损坏或截断的审计日志行 (${fileName}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    return entries;
  }

  /**
   * 生成符合 `deploy/init-pgvector-schema.sql` 的 PostgreSQL + pgvector UPSERT 同步语句
   * AUDIT-8：委托 PgPersistenceDriver.buildPgUpsertSql 作为单一事实源（含 negotiation_logs / team_comments / 真实 token_budget）
   */
  public generatePostgreSqlStatements(snapshot: PersistedLedgerSnapshot): string {
    return buildPgUpsertSql(snapshot);
  }
}
