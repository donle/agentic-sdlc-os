/**
 * @file UserStore.ts
 * @description F1 / AUDIT-8 用户账号、登录会话与登录审计持久化存储层 (`JsonUserStore` + `PgUserStore`)。
 * 对应 `docs/USER_SYSTEM_DESIGN.md` §2.2 & §3.3：
 * - 无 `DATABASE_URL` 时默认使用 `JsonUserStore`（users.json + 内存会话/审计）；
 * - `DATABASE_URL` 在位时 `selectUserStore()` 切换至 `PgUserStore`（读写 PG `users`、`user_owned_stages`、`auth_sessions`、`auth_login_audit` 四张表）。
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PgAsyncSqlExecutor, PgSqlExecutor } from '../../engine/pg/PgPersistenceDriver.ts';

export interface AuthUserRecord {
  userId: string;
  username: string;
  displayName: string;
  jobTitle: string;
  department: string;
  tier: 'PROJECT_ADMIN' | 'STAGE_SPECIALIST';
  specialistDomain: string;
  counterpartAgentRole: string;
  avatarBadge: string;
  ownedStageIds: string[];
  passwordHash: string;
  mustChangePassword: boolean;
  status: 'ACTIVE' | 'DISABLED';
  failedLoginCount: number;
  lockedUntil: string | null;
}

export interface LoginAuditEntry {
  readonly id: number;
  readonly username: string;
  readonly success: boolean;
  readonly reason:
    'OK' | 'BAD_PASSWORD' | 'UNKNOWN_USER' | 'LOCKED' | 'DISABLED' | 'ACT_AS' | 'EXIT_ACT_AS';
  readonly ip?: string | null;
  readonly createdAtIso: string;
}

export interface StoredSessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly impersonatedBy: string | null;
  readonly expiresAt: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface PgUserStoreOptions {
  readonly asyncSqlExecutor?: PgAsyncSqlExecutor;
  readonly sessionCacheTtlMs?: number;
  readonly touchThrottleMs?: number;
}

export interface UserStore {
  loadAllUsers(): AuthUserRecord[] | null;
  saveAllUsers(users: ReadonlyArray<AuthUserRecord>): void;
  upsertUser(user: AuthUserRecord): void;
  saveSession(session: StoredSessionRecord): void;
  getSessionByHash(tokenHash: string): StoredSessionRecord | null;
  touchSession(
    tokenHash: string,
    expiresAt: number,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): void;
  deleteSession(tokenHash: string): void;
  deleteSessionsByUser(userId: string, exceptTokenHash?: string | null): void;
  listStoredSessionTokenHashes(): ReadonlyArray<string>;
  appendLoginAudit(entry: Omit<LoginAuditEntry, 'id'>): LoginAuditEntry;
  listLoginAudit(params?: { username?: string; limit?: number }): ReadonlyArray<LoginAuditEntry>;
}

function escapeSql(val: string): string {
  return val.replaceAll('\u0000', '').replace(/'/g, "''");
}

function safeTimestampLiteral(iso: string | null | undefined): string {
  if (!iso) {
    return 'NULL';
  }
  return `'${escapeSql(iso)}'::timestamptz`;
}

/**
 * 构建单个或多个用户的 PostgreSQL UPSERT + user_owned_stages 同步脚本
 */
export function buildUpsertUserSql(users: ReadonlyArray<AuthUserRecord>): string {
  const lines: string[] = ['BEGIN;'];
  for (const user of users) {
    const failedCount =
      typeof user.failedLoginCount === 'number' && Number.isFinite(user.failedLoginCount)
        ? Math.floor(user.failedLoginCount)
        : 0;
    const lockedUntilSql = safeTimestampLiteral(user.lockedUntil);
    lines.push(
      `INSERT INTO users (id, username, display_name, job_title, department, tier, specialist_domain, counterpart_agent_role, avatar_badge, password_hash, must_change_password, status, failed_login_count, locked_until, updated_at) VALUES ('${escapeSql(user.userId)}', '${escapeSql(user.username)}', '${escapeSql(user.displayName)}', '${escapeSql(user.jobTitle)}', '${escapeSql(user.department)}', '${escapeSql(user.tier)}', '${escapeSql(user.specialistDomain)}', '${escapeSql(user.counterpartAgentRole)}', '${escapeSql(user.avatarBadge)}', '${escapeSql(user.passwordHash)}', ${user.mustChangePassword ? 'TRUE' : 'FALSE'}, '${escapeSql(user.status)}', ${failedCount}, ${lockedUntilSql}, NOW()) ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name, job_title = EXCLUDED.job_title, department = EXCLUDED.department, tier = EXCLUDED.tier, specialist_domain = EXCLUDED.specialist_domain, counterpart_agent_role = EXCLUDED.counterpart_agent_role, avatar_badge = EXCLUDED.avatar_badge, password_hash = EXCLUDED.password_hash, must_change_password = EXCLUDED.must_change_password, status = EXCLUDED.status, failed_login_count = EXCLUDED.failed_login_count, locked_until = EXCLUDED.locked_until, updated_at = NOW();`,
    );
    lines.push(`DELETE FROM user_owned_stages WHERE user_id = '${escapeSql(user.userId)}';`);
    for (const stageId of user.ownedStageIds) {
      lines.push(
        `INSERT INTO user_owned_stages (user_id, stage_id) VALUES ('${escapeSql(user.userId)}', '${escapeSql(stageId)}') ON CONFLICT (user_id, stage_id) DO NOTHING;`,
      );
    }
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

/**
 * 构建 auth_sessions 会话 UPSERT SQL（服务端仅存 SHA-256 摘要，并采集 IP / User-Agent）
 */
export function buildSaveSessionSql(session: StoredSessionRecord): string {
  const impersonatedSql = session.impersonatedBy
    ? `'${escapeSql(session.impersonatedBy)}'`
    : 'NULL';
  const ipSql = session.ip ? `'${escapeSql(session.ip)}'` : 'NULL';
  const uaSql = session.userAgent ? `'${escapeSql(session.userAgent)}'` : 'NULL';
  const expiresIso = new Date(session.expiresAt).toISOString();
  return `INSERT INTO auth_sessions (token_hash, user_id, impersonated_by, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ('${escapeSql(session.tokenHash)}', '${escapeSql(session.userId)}', ${impersonatedSql}, NOW(), NOW(), '${escapeSql(expiresIso)}'::timestamptz, ${ipSql}, ${uaSql}) ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = NOW(), expires_at = EXCLUDED.expires_at, ip = COALESCE(EXCLUDED.ip, auth_sessions.ip), user_agent = COALESCE(EXCLUDED.user_agent, auth_sessions.user_agent);`;
}

/**
 * 构建 auth_login_audit 登录审计追加 SQL（含来源 IP）
 */
export function buildAppendLoginAuditSql(entry: Omit<LoginAuditEntry, 'id'>): string {
  const ipSql = entry.ip ? `'${escapeSql(entry.ip)}'` : 'NULL';
  return `INSERT INTO auth_login_audit (username, success, reason, created_at, ip) VALUES ('${escapeSql(entry.username)}', ${entry.success ? 'TRUE' : 'FALSE'}, '${escapeSql(entry.reason)}', '${escapeSql(entry.createdAtIso)}'::timestamptz, ${ipSql}) RETURNING id;`;
}

/**
 * 单机轻量 JSON 文件用户存储实现（P1-2：会话与登录审计同步落盘 auth-sessions.json 与 auth-login-audit.jsonl）
 */
export class JsonUserStore implements UserStore {
  private readonly usersFilePath: string;
  private readonly sessionsFilePath: string;
  private readonly loginAuditFilePath: string;
  private usersCache: AuthUserRecord[] = [];
  private readonly sessions = new Map<string, StoredSessionRecord>();
  private readonly loginAudit: LoginAuditEntry[] = [];
  private nextAuditId = 1;

  public constructor(usersFilePath?: string) {
    this.usersFilePath =
      usersFilePath ?? path.resolve(process.cwd(), '.runtime-data', 'users.json');
    const storageDir = path.dirname(this.usersFilePath);
    this.sessionsFilePath = path.join(storageDir, 'auth-sessions.json');
    this.loginAuditFilePath = path.join(storageDir, 'auth-login-audit.jsonl');
    this.loadPersistedSessions();
    this.loadPersistedLoginAudit();
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private loadPersistedSessions(): void {
    if (!fs.existsSync(this.sessionsFilePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.sessionsFilePath, 'utf-8'),
      ) as StoredSessionRecord[];
      if (!Array.isArray(parsed)) {
        return;
      }
      const now = Date.now();
      for (const rec of parsed) {
        if (rec && rec.tokenHash && rec.userId && typeof rec.expiresAt === 'number') {
          if (rec.expiresAt > now) {
            this.sessions.set(rec.tokenHash, { ...rec });
          }
        }
      }
    } catch {
      // 容错：损坏的会话文件不阻塞启动
    }
  }

  private persistSessions(): void {
    const now = Date.now();
    for (const [tokenHash, rec] of [...this.sessions.entries()]) {
      if (rec.expiresAt <= now) {
        this.sessions.delete(tokenHash);
      }
    }
    this.ensureDir(this.sessionsFilePath);
    fs.writeFileSync(
      this.sessionsFilePath,
      JSON.stringify([...this.sessions.values()], null, 2),
      'utf-8',
    );
  }

  private loadPersistedLoginAudit(): void {
    if (!fs.existsSync(this.loginAuditFilePath)) {
      return;
    }
    try {
      const content = fs.readFileSync(this.loginAuditFilePath, 'utf-8');
      let maxId = 0;
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as LoginAuditEntry;
          if (parsed && typeof parsed.username === 'string') {
            const idNum = Number(parsed.id);
            const id = Number.isFinite(idNum) && idNum > 0 ? Math.floor(idNum) : maxId + 1;
            maxId = Math.max(maxId, id);
            this.loginAudit.push({
              id,
              username: String(parsed.username),
              success: Boolean(parsed.success),
              reason: parsed.reason,
              ...(parsed.ip !== undefined ? { ip: parsed.ip } : {}),
              createdAtIso: String(parsed.createdAtIso ?? new Date().toISOString()),
            });
          }
        } catch {
          // 跳过单行损坏日志
        }
      }
      this.nextAuditId = maxId + 1;
    } catch {
      // 容错：不可读审计文件不阻塞启动
    }
  }

  public loadAllUsers(): AuthUserRecord[] | null {
    if (!fs.existsSync(this.usersFilePath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(this.usersFilePath, 'utf-8')) as AuthUserRecord[];
    this.usersCache = parsed;
    return parsed;
  }

  public saveAllUsers(users: ReadonlyArray<AuthUserRecord>): void {
    this.usersCache = users.map((u) => ({ ...u, ownedStageIds: [...u.ownedStageIds] }));
    this.ensureDir(this.usersFilePath);
    fs.writeFileSync(this.usersFilePath, JSON.stringify(this.usersCache, null, 2), 'utf-8');
  }

  public upsertUser(user: AuthUserRecord): void {
    const idx = this.usersCache.findIndex((u) => u.userId === user.userId);
    const copy: AuthUserRecord = { ...user, ownedStageIds: [...user.ownedStageIds] };
    if (idx >= 0) {
      this.usersCache[idx] = copy;
    } else {
      this.usersCache.push(copy);
    }
    this.saveAllUsers(this.usersCache);
  }

  public saveSession(session: StoredSessionRecord): void {
    this.sessions.set(session.tokenHash, { ...session });
    this.persistSessions();
  }

  public getSessionByHash(tokenHash: string): StoredSessionRecord | null {
    return this.sessions.get(tokenHash) ?? null;
  }

  public touchSession(
    tokenHash: string,
    expiresAt: number,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): void {
    const existing = this.sessions.get(tokenHash);
    if (existing) {
      this.sessions.set(tokenHash, {
        ...existing,
        expiresAt,
        ...(meta?.ip !== undefined ? { ip: meta.ip ?? existing.ip ?? null } : {}),
        ...(meta?.userAgent !== undefined
          ? { userAgent: meta.userAgent ?? existing.userAgent ?? null }
          : {}),
      });
      this.persistSessions();
    }
  }

  public deleteSession(tokenHash: string): void {
    if (this.sessions.delete(tokenHash)) {
      this.persistSessions();
    }
  }

  public deleteSessionsByUser(userId: string, exceptTokenHash?: string | null): void {
    let changed = false;
    for (const [tokenHash, session] of [...this.sessions.entries()]) {
      if (session.userId === userId && tokenHash !== exceptTokenHash) {
        this.sessions.delete(tokenHash);
        changed = true;
      }
    }
    if (changed) {
      this.persistSessions();
    }
  }

  public listStoredSessionTokenHashes(): ReadonlyArray<string> {
    return [...this.sessions.keys()];
  }

  public appendLoginAudit(entry: Omit<LoginAuditEntry, 'id'>): LoginAuditEntry {
    const id = this.nextAuditId;
    this.nextAuditId += 1;
    const record: LoginAuditEntry = {
      id,
      ...entry,
    };
    this.loginAudit.push(record);
    this.ensureDir(this.loginAuditFilePath);
    fs.appendFileSync(this.loginAuditFilePath, `${JSON.stringify(record)}\n`, 'utf-8');
    return record;
  }

  public listLoginAudit(params?: {
    username?: string;
    limit?: number;
  }): ReadonlyArray<LoginAuditEntry> {
    const filterUser = params?.username?.trim().toLowerCase();
    const filtered = filterUser
      ? this.loginAudit.filter((a) => a.username.toLowerCase() === filterUser)
      : this.loginAudit;
    const limit = params?.limit && params.limit > 0 ? params.limit : 20;
    return filtered.slice(-limit).reverse();
  }
}

interface CachedSessionEntry {
  session: StoredSessionRecord;
  cachedAt: number;
  lastDbTouchAt: number;
}

/**
 * PostgreSQL 用户账号/权限阶段/会话/登录审计存储实现
 * （P1-2：增加会话短时内存 TTL 缓存、touchSession 写节流与非阻塞异步 SQL 队列，消除每次请求双次 execFileSync('psql') 阻塞）
 */
export class PgUserStore implements UserStore {
  private readonly databaseUrl: string;
  private readonly sqlExecutor: PgSqlExecutor;
  private readonly asyncWriteExecutor: PgAsyncSqlExecutor | null;
  private readonly sessionCacheTtlMs: number;
  private readonly touchThrottleMs: number;
  private readonly sessionCache = new Map<string, CachedSessionEntry>();
  private readonly inFlightDeletedTokens = new Map<string, number>();
  private readonly pendingUserRevocations = new Set<{
    readonly userId: string;
    readonly exceptTokenHash: string | null;
  }>();
  private readonly newlySavedAfterRevoke = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private nextFallbackAuditId = Date.now();

  public constructor(
    databaseUrl?: string,
    sqlExecutor?: PgSqlExecutor,
    options?: PgUserStoreOptions,
  ) {
    this.databaseUrl = databaseUrl ?? process.env.DATABASE_URL ?? '';
    if (!this.databaseUrl && !sqlExecutor && !options?.asyncSqlExecutor) {
      throw new Error('PgUserStore 需要 DATABASE_URL 环境变量');
    }
    const envCacheTtl = Number(process.env.PG_SESSION_CACHE_TTL_MS);
    const envTouchThrottle = Number(process.env.PG_SESSION_TOUCH_THROTTLE_MS);
    this.sessionCacheTtlMs =
      options?.sessionCacheTtlMs !== undefined
        ? Math.max(0, options.sessionCacheTtlMs)
        : Number.isFinite(envCacheTtl) && envCacheTtl >= 0
          ? envCacheTtl
          : 15000;
    this.touchThrottleMs =
      options?.touchThrottleMs !== undefined
        ? Math.max(0, options.touchThrottleMs)
        : Number.isFinite(envTouchThrottle) && envTouchThrottle >= 0
          ? envTouchThrottle
          : 60000;

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
          `d2-pg-user-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sql`,
        );
        fs.writeFileSync(tmpFile, sql, 'utf-8');
        try {
          return execFileSync(
            'psql',
            [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', tmpFile],
            {
              timeout: 30000,
              encoding: 'utf-8',
            },
          );
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
        `d2-pg-user-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sql`,
      );
      fs.writeFile(tmpFile, sql, 'utf-8', (writeErr) => {
        if (writeErr) {
          reject(writeErr);
          return;
        }
        execFile(
          'psql',
          [this.databaseUrl, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', tmpFile],
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

  private dispatchWriteSql(sql: string, errorLabel: string, onSettled?: () => void): void {
    if (this.asyncWriteExecutor) {
      const task = async (): Promise<void> => {
        try {
          await this.asyncWriteExecutor!(sql, { readOnly: false });
        } catch (err) {
          console.warn(
            `[D2 Auth] ${errorLabel}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
          );
        } finally {
          onSettled?.();
        }
      };
      this.writeChain = this.writeChain.then(task, task);
      return;
    }
    try {
      this.sqlExecutor(sql, { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] ${errorLabel}: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    } finally {
      onSettled?.();
    }
  }

  /** P1-2：等待异步 PG 用户/会话写入队列排空（测试与优雅关停用） */
  public async flushPendingWrites(): Promise<void> {
    await this.writeChain;
  }

  public loadAllUsers(): AuthUserRecord[] | null {
    const query = `
SELECT COALESCE(json_agg(json_build_object(
  'userId', u.id,
  'username', u.username,
  'displayName', u.display_name,
  'jobTitle', u.job_title,
  'department', u.department,
  'tier', u.tier,
  'specialistDomain', u.specialist_domain,
  'counterpartAgentRole', u.counterpart_agent_role,
  'avatarBadge', u.avatar_badge,
  'passwordHash', u.password_hash,
  'mustChangePassword', u.must_change_password,
  'status', u.status,
  'failedLoginCount', u.failed_login_count,
  'lockedUntil', u.locked_until,
  'ownedStageIds', COALESCE((
    SELECT json_agg(s.stage_id ORDER BY s.stage_id)
    FROM user_owned_stages s
    WHERE s.user_id = u.id
  ), '[]'::json)
) ORDER BY u.created_at ASC, u.id ASC), '[]'::json)::text
FROM users u;
`.trim();
    try {
      const raw = this.sqlExecutor(query, { readOnly: true }).trim();
      if (!raw) {
        return null;
      }
      const rows = JSON.parse(raw) as AuthUserRecord[];
      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }
      return rows.map((r) => ({
        userId: String(r.userId),
        username: String(r.username),
        displayName: String(r.displayName),
        jobTitle: String(r.jobTitle),
        department: String(r.department ?? ''),
        tier: r.tier === 'PROJECT_ADMIN' ? 'PROJECT_ADMIN' : 'STAGE_SPECIALIST',
        specialistDomain: String(r.specialistDomain),
        counterpartAgentRole: String(r.counterpartAgentRole),
        avatarBadge: String(r.avatarBadge ?? '👤'),
        ownedStageIds: Array.isArray(r.ownedStageIds) ? r.ownedStageIds.map(String) : [],
        passwordHash: String(r.passwordHash),
        mustChangePassword: Boolean(r.mustChangePassword),
        status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
        failedLoginCount: Number(r.failedLoginCount ?? 0),
        lockedUntil: r.lockedUntil ? String(r.lockedUntil) : null,
      }));
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 加载用户失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return null;
    }
  }

  public saveAllUsers(users: ReadonlyArray<AuthUserRecord>): void {
    if (users.length === 0) {
      return;
    }
    this.dispatchWriteSql(buildUpsertUserSql(users), 'PG 保存用户失败');
  }

  public upsertUser(user: AuthUserRecord): void {
    this.dispatchWriteSql(buildUpsertUserSql([user]), 'PG 更新用户失败');
  }

  public saveSession(session: StoredSessionRecord): void {
    const now = Date.now();
    this.inFlightDeletedTokens.delete(session.tokenHash);
    let hasUserRevoke = false;
    for (const rev of this.pendingUserRevocations) {
      if (rev.userId === session.userId) {
        hasUserRevoke = true;
        break;
      }
    }
    if (hasUserRevoke) {
      this.newlySavedAfterRevoke.add(session.tokenHash);
    }
    this.sessionCache.set(session.tokenHash, {
      session: { ...session },
      cachedAt: now,
      lastDbTouchAt: now,
    });
    this.dispatchWriteSql(buildSaveSessionSql(session), 'PG 保存会话失败', () => {
      this.newlySavedAfterRevoke.delete(session.tokenHash);
    });
  }

  public getSessionByHash(tokenHash: string): StoredSessionRecord | null {
    if ((this.inFlightDeletedTokens.get(tokenHash) ?? 0) > 0) {
      return null;
    }
    const now = Date.now();
    const cached = this.sessionCache.get(tokenHash);
    if (
      cached &&
      this.sessionCacheTtlMs > 0 &&
      now - cached.cachedAt <= this.sessionCacheTtlMs &&
      now <= cached.session.expiresAt
    ) {
      return { ...cached.session };
    }
    if (cached && now > cached.session.expiresAt) {
      this.sessionCache.delete(tokenHash);
    }

    const query = `
SELECT json_build_object(
  'tokenHash', token_hash,
  'userId', user_id,
  'impersonatedBy', impersonated_by,
  'expiresAt', (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint,
  'ip', ip,
  'userAgent', user_agent
)::text
FROM auth_sessions
WHERE token_hash = '${escapeSql(tokenHash)}'
LIMIT 1;
`.trim();
    try {
      const raw = this.sqlExecutor(query, { readOnly: true }).trim();
      if (!raw) {
        this.sessionCache.delete(tokenHash);
        return null;
      }
      const parsed = JSON.parse(raw) as StoredSessionRecord;
      const record: StoredSessionRecord = {
        tokenHash: String(parsed.tokenHash),
        userId: String(parsed.userId),
        impersonatedBy: parsed.impersonatedBy ? String(parsed.impersonatedBy) : null,
        expiresAt: Number(parsed.expiresAt),
        ...(parsed.ip !== undefined ? { ip: parsed.ip ? String(parsed.ip) : null } : {}),
        ...(parsed.userAgent !== undefined
          ? { userAgent: parsed.userAgent ? String(parsed.userAgent) : null }
          : {}),
      };
      if (!this.newlySavedAfterRevoke.has(tokenHash)) {
        for (const rev of this.pendingUserRevocations) {
          if (rev.userId === record.userId && tokenHash !== rev.exceptTokenHash) {
            this.sessionCache.delete(tokenHash);
            return null;
          }
        }
      }
      if (now <= record.expiresAt) {
        this.sessionCache.set(tokenHash, {
          session: { ...record },
          cachedAt: now,
          lastDbTouchAt: cached?.lastDbTouchAt ?? 0,
        });
      }
      return record;
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 查询会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return null;
    }
  }

  public touchSession(
    tokenHash: string,
    expiresAt: number,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): void {
    const now = Date.now();
    const cached = this.sessionCache.get(tokenHash);
    const nextIp = meta?.ip !== undefined ? meta.ip : (cached?.session.ip ?? null);
    const nextUa =
      meta?.userAgent !== undefined ? meta.userAgent : (cached?.session.userAgent ?? null);
    const metaChanged =
      Boolean(cached) &&
      ((meta?.ip !== undefined && meta.ip !== (cached?.session.ip ?? null)) ||
        (meta?.userAgent !== undefined && meta.userAgent !== (cached?.session.userAgent ?? null)));

    if (cached) {
      cached.session = {
        ...cached.session,
        expiresAt,
        ip: nextIp,
        userAgent: nextUa,
      };
      cached.cachedAt = now;
    }

    const shouldPersist =
      !cached || metaChanged || now - cached.lastDbTouchAt >= this.touchThrottleMs;
    if (!shouldPersist) {
      return;
    }
    if (cached) {
      cached.lastDbTouchAt = now;
    }

    const expiresIso = new Date(expiresAt).toISOString();
    const ipClause = nextIp ? `, ip = '${escapeSql(nextIp)}'` : '';
    const uaClause = nextUa ? `, user_agent = '${escapeSql(nextUa)}'` : '';
    const sql = `UPDATE auth_sessions SET last_seen_at = NOW(), expires_at = '${escapeSql(expiresIso)}'::timestamptz${ipClause}${uaClause} WHERE token_hash = '${escapeSql(tokenHash)}';`;
    this.dispatchWriteSql(sql, 'PG 续期会话失败');
  }

  public deleteSession(tokenHash: string): void {
    this.sessionCache.delete(tokenHash);
    this.newlySavedAfterRevoke.delete(tokenHash);
    this.inFlightDeletedTokens.set(tokenHash, (this.inFlightDeletedTokens.get(tokenHash) ?? 0) + 1);
    const sql = `DELETE FROM auth_sessions WHERE token_hash = '${escapeSql(tokenHash)}';`;
    this.dispatchWriteSql(sql, 'PG 删除会话失败', () => {
      const remaining = (this.inFlightDeletedTokens.get(tokenHash) ?? 0) - 1;
      if (remaining > 0) {
        this.inFlightDeletedTokens.set(tokenHash, remaining);
      } else {
        this.inFlightDeletedTokens.delete(tokenHash);
      }
    });
  }

  public deleteSessionsByUser(userId: string, exceptTokenHash?: string | null): void {
    const affectedHashes: string[] = [];
    for (const [hash, entry] of [...this.sessionCache.entries()]) {
      if (entry.session.userId === userId && hash !== exceptTokenHash) {
        this.sessionCache.delete(hash);
        this.newlySavedAfterRevoke.delete(hash);
        this.inFlightDeletedTokens.set(hash, (this.inFlightDeletedTokens.get(hash) ?? 0) + 1);
        affectedHashes.push(hash);
      }
    }
    const marker = { userId, exceptTokenHash: exceptTokenHash ?? null };
    this.pendingUserRevocations.add(marker);
    const exceptClause = exceptTokenHash
      ? ` AND token_hash <> '${escapeSql(exceptTokenHash)}'`
      : '';
    const sql = `DELETE FROM auth_sessions WHERE user_id = '${escapeSql(userId)}'${exceptClause};`;
    this.dispatchWriteSql(sql, 'PG 批量清理会话失败', () => {
      this.pendingUserRevocations.delete(marker);
      for (const hash of affectedHashes) {
        const remaining = (this.inFlightDeletedTokens.get(hash) ?? 0) - 1;
        if (remaining > 0) {
          this.inFlightDeletedTokens.set(hash, remaining);
        } else {
          this.inFlightDeletedTokens.delete(hash);
        }
      }
    });
  }

  public listStoredSessionTokenHashes(): ReadonlyArray<string> {
    const query = `SELECT COALESCE(json_agg(token_hash ORDER BY created_at ASC), '[]'::json)::text FROM auth_sessions;`;
    try {
      const raw = this.sqlExecutor(query, { readOnly: true }).trim();
      if (!raw) {
        return [];
      }
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 列出在线会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return [];
    }
  }

  public appendLoginAudit(entry: Omit<LoginAuditEntry, 'id'>): LoginAuditEntry {
    const sql = buildAppendLoginAuditSql(entry);
    if (this.asyncWriteExecutor) {
      this.dispatchWriteSql(sql, 'PG 写入登录审计失败');
      this.nextFallbackAuditId += 1;
      return {
        id: this.nextFallbackAuditId,
        ...entry,
      };
    }
    try {
      const raw = this.sqlExecutor(sql, { readOnly: false }).trim();
      const firstLine = raw.split('\n')[0]?.trim() ?? '';
      const numericId = Number(firstLine);
      return {
        id: Number.isFinite(numericId) && numericId > 0 ? numericId : Date.now(),
        ...entry,
      };
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 写入登录审计失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return {
        id: Date.now(),
        ...entry,
      };
    }
  }

  public listLoginAudit(params?: {
    username?: string;
    limit?: number;
  }): ReadonlyArray<LoginAuditEntry> {
    const filterUser = params?.username?.trim().toLowerCase();
    const whereClause = filterUser ? `WHERE LOWER(username) = '${escapeSql(filterUser)}'` : '';
    const limit = params?.limit && params.limit > 0 ? Math.floor(params.limit) : 20;
    const query = `
SELECT COALESCE(json_agg(json_build_object(
  'id', t.id,
  'username', t.username,
  'success', t.success,
  'reason', COALESCE(t.reason, 'OK'),
  'ip', t.ip,
  'createdAtIso', t.created_at
)), '[]'::json)::text
FROM (
  SELECT id, username, success, reason, ip, created_at
  FROM auth_login_audit
  ${whereClause}
  ORDER BY id DESC
  LIMIT ${limit}
) t;
`.trim();
    try {
      const raw = this.sqlExecutor(query, { readOnly: true }).trim();
      if (!raw) {
        return [];
      }
      const rows = JSON.parse(raw) as Array<{
        id: number;
        username: string;
        success: boolean;
        reason: LoginAuditEntry['reason'];
        ip?: string | null;
        createdAtIso: string;
      }>;
      return Array.isArray(rows)
        ? rows.map((r) => ({
            id: Number(r.id),
            username: String(r.username),
            success: Boolean(r.success),
            reason: r.reason,
            ...(r.ip !== undefined ? { ip: r.ip ? String(r.ip) : null } : {}),
            createdAtIso: String(r.createdAtIso),
          }))
        : [];
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 读取登录审计失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return [];
    }
  }
}

/**
 * 存储驱动选择器：DATABASE_URL 存在 → PG 用户库；否则 JSON 文件（单机轻量降级）
 */
export function selectUserStore(options?: {
  usersFilePath?: string;
  databaseUrl?: string;
  pgExecutor?: PgSqlExecutor;
  pgOptions?: PgUserStoreOptions;
}): UserStore {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL ?? '';
  if (url) {
    try {
      return new PgUserStore(url, options?.pgExecutor, options?.pgOptions);
    } catch {
      console.warn('[D2 Auth] DATABASE_URL 存在但 PgUserStore 初始化失败，回落 JSON 模式');
    }
  }
  return new JsonUserStore(options?.usersFilePath);
}
