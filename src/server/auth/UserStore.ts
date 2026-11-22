/**
 * @file UserStore.ts
 * @description F1 / AUDIT-8 用户账号、登录会话与登录审计持久化存储层 (`JsonUserStore` + `PgUserStore`)。
 * 对应 `docs/USER_SYSTEM_DESIGN.md` §2.2 & §3.3：
 * - 无 `DATABASE_URL` 时默认使用 `JsonUserStore`（users.json + 内存会话/审计）；
 * - `DATABASE_URL` 在位时 `selectUserStore()` 切换至 `PgUserStore`（读写 PG `users`、`user_owned_stages`、`auth_sessions`、`auth_login_audit` 四张表）。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PgSqlExecutor } from '../../engine/pg/PgPersistenceDriver.ts';

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
  readonly reason: 'OK' | 'BAD_PASSWORD' | 'UNKNOWN_USER' | 'LOCKED' | 'DISABLED' | 'ACT_AS';
  readonly createdAtIso: string;
}

export interface StoredSessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly impersonatedBy: string | null;
  readonly expiresAt: number;
}

export interface UserStore {
  loadAllUsers(): AuthUserRecord[] | null;
  saveAllUsers(users: ReadonlyArray<AuthUserRecord>): void;
  upsertUser(user: AuthUserRecord): void;
  saveSession(session: StoredSessionRecord): void;
  getSessionByHash(tokenHash: string): StoredSessionRecord | null;
  touchSession(tokenHash: string, expiresAt: number): void;
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
 * 构建 auth_sessions 会话 UPSERT SQL（服务端仅存 SHA-256 摘要）
 */
export function buildSaveSessionSql(session: StoredSessionRecord): string {
  const impersonatedSql = session.impersonatedBy
    ? `'${escapeSql(session.impersonatedBy)}'`
    : 'NULL';
  const expiresIso = new Date(session.expiresAt).toISOString();
  return `INSERT INTO auth_sessions (token_hash, user_id, impersonated_by, created_at, last_seen_at, expires_at) VALUES ('${escapeSql(session.tokenHash)}', '${escapeSql(session.userId)}', ${impersonatedSql}, NOW(), NOW(), '${escapeSql(expiresIso)}'::timestamptz) ON CONFLICT (token_hash) DO UPDATE SET last_seen_at = NOW(), expires_at = EXCLUDED.expires_at;`;
}

/**
 * 构建 auth_login_audit 登录审计追加 SQL
 */
export function buildAppendLoginAuditSql(entry: Omit<LoginAuditEntry, 'id'>): string {
  return `INSERT INTO auth_login_audit (username, success, reason, created_at) VALUES ('${escapeSql(entry.username)}', ${entry.success ? 'TRUE' : 'FALSE'}, '${escapeSql(entry.reason)}', '${escapeSql(entry.createdAtIso)}'::timestamptz) RETURNING id;`;
}

/**
 * 单机轻量 JSON 文件用户存储实现
 */
export class JsonUserStore implements UserStore {
  private readonly usersFilePath: string;
  private usersCache: AuthUserRecord[] = [];
  private readonly sessions = new Map<string, StoredSessionRecord>();
  private readonly loginAudit: LoginAuditEntry[] = [];

  public constructor(usersFilePath?: string) {
    this.usersFilePath =
      usersFilePath ?? path.resolve(process.cwd(), '.runtime-data', 'users.json');
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
    const dir = path.dirname(this.usersFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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
  }

  public getSessionByHash(tokenHash: string): StoredSessionRecord | null {
    return this.sessions.get(tokenHash) ?? null;
  }

  public touchSession(tokenHash: string, expiresAt: number): void {
    const existing = this.sessions.get(tokenHash);
    if (existing) {
      this.sessions.set(tokenHash, { ...existing, expiresAt });
    }
  }

  public deleteSession(tokenHash: string): void {
    this.sessions.delete(tokenHash);
  }

  public deleteSessionsByUser(userId: string, exceptTokenHash?: string | null): void {
    for (const [tokenHash, session] of [...this.sessions.entries()]) {
      if (session.userId === userId && tokenHash !== exceptTokenHash) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  public listStoredSessionTokenHashes(): ReadonlyArray<string> {
    return [...this.sessions.keys()];
  }

  public appendLoginAudit(entry: Omit<LoginAuditEntry, 'id'>): LoginAuditEntry {
    const record: LoginAuditEntry = {
      id: this.loginAudit.length + 1,
      ...entry,
    };
    this.loginAudit.push(record);
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

/**
 * PostgreSQL 用户账号/权限阶段/会话/登录审计存储实现
 */
export class PgUserStore implements UserStore {
  private readonly databaseUrl: string;
  private readonly sqlExecutor: PgSqlExecutor;

  public constructor(databaseUrl?: string, sqlExecutor?: PgSqlExecutor) {
    this.databaseUrl = databaseUrl ?? process.env.DATABASE_URL ?? '';
    if (!this.databaseUrl && !sqlExecutor) {
      throw new Error('PgUserStore 需要 DATABASE_URL 环境变量');
    }
    this.sqlExecutor =
      sqlExecutor ??
      ((sql: string, options?: { readOnly?: boolean }): string => {
        if (options?.readOnly) {
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
    try {
      this.sqlExecutor(buildUpsertUserSql(users), { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 保存用户失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  public upsertUser(user: AuthUserRecord): void {
    try {
      this.sqlExecutor(buildUpsertUserSql([user]), { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 更新用户失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  public saveSession(session: StoredSessionRecord): void {
    try {
      this.sqlExecutor(buildSaveSessionSql(session), { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 保存会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  public getSessionByHash(tokenHash: string): StoredSessionRecord | null {
    const query = `
SELECT json_build_object(
  'tokenHash', token_hash,
  'userId', user_id,
  'impersonatedBy', impersonated_by,
  'expiresAt', (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint
)::text
FROM auth_sessions
WHERE token_hash = '${escapeSql(tokenHash)}'
LIMIT 1;
`.trim();
    try {
      const raw = this.sqlExecutor(query, { readOnly: true }).trim();
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as StoredSessionRecord;
      return {
        tokenHash: String(parsed.tokenHash),
        userId: String(parsed.userId),
        impersonatedBy: parsed.impersonatedBy ? String(parsed.impersonatedBy) : null,
        expiresAt: Number(parsed.expiresAt),
      };
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 查询会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
      return null;
    }
  }

  public touchSession(tokenHash: string, expiresAt: number): void {
    const expiresIso = new Date(expiresAt).toISOString();
    const sql = `UPDATE auth_sessions SET last_seen_at = NOW(), expires_at = '${escapeSql(expiresIso)}'::timestamptz WHERE token_hash = '${escapeSql(tokenHash)}';`;
    try {
      this.sqlExecutor(sql, { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 续期会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  public deleteSession(tokenHash: string): void {
    const sql = `DELETE FROM auth_sessions WHERE token_hash = '${escapeSql(tokenHash)}';`;
    try {
      this.sqlExecutor(sql, { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 删除会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }

  public deleteSessionsByUser(userId: string, exceptTokenHash?: string | null): void {
    const exceptClause = exceptTokenHash
      ? ` AND token_hash <> '${escapeSql(exceptTokenHash)}'`
      : '';
    const sql = `DELETE FROM auth_sessions WHERE user_id = '${escapeSql(userId)}'${exceptClause};`;
    try {
      this.sqlExecutor(sql, { readOnly: false });
    } catch (err) {
      console.warn(
        `[D2 Auth] PG 批量清理会话失败: ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
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
  'createdAtIso', t.created_at
)), '[]'::json)::text
FROM (
  SELECT id, username, success, reason, created_at
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
        createdAtIso: string;
      }>;
      return Array.isArray(rows)
        ? rows.map((r) => ({
            id: Number(r.id),
            username: String(r.username),
            success: Boolean(r.success),
            reason: r.reason,
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
}): UserStore {
  const url = options?.databaseUrl ?? process.env.DATABASE_URL ?? '';
  if (url) {
    try {
      return new PgUserStore(url, options?.pgExecutor);
    } catch {
      console.warn('[D2 Auth] DATABASE_URL 存在但 PgUserStore 初始化失败，回落 JSON 模式');
    }
  }
  return new JsonUserStore(options?.usersFilePath);
}
