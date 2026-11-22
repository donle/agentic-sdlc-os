/**
 * @file SessionService.ts
 * @description F1 认证与会话服务：scrypt 口令哈希、SHA-256 token 会话、act-as 管理员视角切换。
 * 存储驱动：无 DATABASE_URL 时 JSON 文件（单机降级），PG 直连后切换（D2）。
 * 参考：docs/USER_SYSTEM_DESIGN.md §3。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

export interface AuthUserView {
  userId: string;
  username: string;
  displayName: string;
  jobTitle: string;
  department: string;
  tier: string;
  specialistDomain: string;
  counterpartAgentRole: string;
  avatarBadge: string;
  ownedStageIds: string[];
  mustChangePassword: boolean;
  status: string;
}

export type LoginResult =
  | { ok: true; token: string; user: AuthUserView }
  | {
      ok: false;
      reason: 'BAD_PASSWORD' | 'UNKNOWN_USER' | 'LOCKED' | 'DISABLED';
      retryAfterSec?: number;
    };

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 60 * 1000; // 60s

function scryptHash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('base64url');
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [algo, saltB64, hashB64] = storedHash.split(':');
  if (algo !== 'scrypt') {
    return false;
  }
  const computed = scryptHash(password, saltB64);
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hashB64));
}

export class SessionService {
  private users!: AuthUserRecord[];
  private readonly usersFilePath: string;
  private readonly sessions = new Map<
    string,
    { userId: string; impersonatedBy: string | null; expiresAt: number }
  >();

  public constructor(usersFilePath?: string) {
    this.usersFilePath =
      usersFilePath ?? path.resolve(process.cwd(), '.runtime-data', 'users.json');
    this.loadUsers();
  }

  private loadUsers(): void {
    if (fs.existsSync(this.usersFilePath)) {
      this.users = JSON.parse(fs.readFileSync(this.usersFilePath, 'utf-8'));
    } else {
      // 首次初始化：播种 7 个企业成员（口令=username，首登强制改密）
      const seedDefs: Array<{
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
      }> = [
        {
          userId: 'user-admin-01',
          username: 'admin',
          displayName: '王总管',
          jobTitle: '研发体系最高管理员 / PMO 总监',
          department: '企业研发效能与架构治理委员会',
          tier: 'PROJECT_ADMIN',
          specialistDomain: 'GLOBAL_ADMINISTRATION',
          counterpartAgentRole: 'SUPERVISOR_AGENT',
          avatarBadge: '👑 ADMIN',
          ownedStageIds: [
            'STAGE_1_PM',
            'STAGE_2_PD',
            'STAGE_3A_TECH_SPEC',
            'STAGE_3B_ENGINEER',
            'STAGE_4_QA',
            'STAGE_5_DA',
          ],
        },
        {
          userId: 'user-pm-01',
          username: 'pm',
          displayName: '陈工',
          jobTitle: '资深产品经理',
          department: 'B端核心业务产品部',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'PRODUCT_MANAGEMENT',
          counterpartAgentRole: 'PM_AGENT',
          avatarBadge: '📋 PM',
          ownedStageIds: ['STAGE_1_PM', 'STAGE_2_PD'],
        },
        {
          userId: 'user-pd-01',
          username: 'pd',
          displayName: '林工',
          jobTitle: '主任体验与交互设计师',
          department: '企业级设计系统中心 (UED)',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'PRODUCT_DESIGN_UX',
          counterpartAgentRole: 'PD_AGENT',
          avatarBadge: '🎨 PD/UX',
          ownedStageIds: ['STAGE_2_PD'],
        },
        {
          userId: 'user-tech-01',
          username: 'arch',
          displayName: '赵工',
          jobTitle: '首席系统架构师',
          department: '平台架构与数据安全委员会',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'SYSTEM_ARCHITECTURE',
          counterpartAgentRole: 'TECH_LEAD_AGENT',
          avatarBadge: '🏛️ ARCH',
          ownedStageIds: ['STAGE_3A_TECH_SPEC', 'STAGE_3B_ENGINEER'],
        },
        {
          userId: 'user-eng-01',
          username: 'eng',
          displayName: '刘工',
          jobTitle: '高级核心研发工程师',
          department: '核心业务研发工程部',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'SOFTWARE_ENGINEERING',
          counterpartAgentRole: 'ENGINEER_AGENT',
          avatarBadge: '💻 ENG',
          ownedStageIds: ['STAGE_3B_ENGINEER'],
        },
        {
          userId: 'user-qa-01',
          username: 'qa',
          displayName: '孙工',
          jobTitle: '质量保证与自动化测试负责人',
          department: '质量工程与发布保障部',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'QUALITY_ASSURANCE',
          counterpartAgentRole: 'QA_AGENT',
          avatarBadge: '🛡️ QA',
          ownedStageIds: ['STAGE_4_QA'],
        },
        {
          userId: 'user-da-01',
          username: 'da',
          displayName: '周工',
          jobTitle: '资深数据分析师',
          department: '商业智能与数据科学部 (BI)',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'DATA_ANALYTICS',
          counterpartAgentRole: 'DA_AGENT',
          avatarBadge: '📊 DA',
          ownedStageIds: ['STAGE_5_DA'],
        },
      ];
      this.users = seedDefs.map((def): AuthUserRecord => ({
        ...def,
        ...def,
        passwordHash: this.hashPassword(def.username),
        mustChangePassword: true,
        status: 'ACTIVE' as const,
        failedLoginCount: 0,
        lockedUntil: null,
      }));
      this.persistUsers();
    }
  }

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('base64url');
    return `scrypt:${salt}:${scryptHash(password, salt)}`;
  }

  private persistUsers(): void {
    const dir = path.dirname(this.usersFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.usersFilePath, JSON.stringify(this.users, null, 2), 'utf-8');
  }

  private toView(user: AuthUserRecord): AuthUserView {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      jobTitle: user.jobTitle,
      department: user.department,
      tier: user.tier,
      specialistDomain: user.specialistDomain,
      counterpartAgentRole: user.counterpartAgentRole,
      avatarBadge: user.avatarBadge,
      ownedStageIds: [...user.ownedStageIds],
      mustChangePassword: user.mustChangePassword,
      status: user.status,
    };
  }

  public login(username: string, password: string): LoginResult {
    const normalized = username.trim().toLowerCase();
    const user = this.users.find((u) => u.username === normalized);
    if (!user) {
      return { ok: false, reason: 'BAD_PASSWORD' };
    }
    if (user.status === 'DISABLED') {
      return { ok: false, reason: 'DISABLED' };
    }
    if (user.lockedUntil && Date.now() < Date.parse(user.lockedUntil)) {
      const retryAfterSec = Math.ceil((Date.parse(user.lockedUntil) - Date.now()) / 1000);
      return { ok: false, reason: 'LOCKED', retryAfterSec };
    }

    if (!verifyPassword(password, user.passwordHash)) {
      user.failedLoginCount += 1;
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        user.failedLoginCount = 0;
      }
      this.persistUsers();
      return { ok: false, reason: 'BAD_PASSWORD' };
    }

    user.failedLoginCount = 0;
    user.lockedUntil = null;
    this.persistUsers();

    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, {
      userId: user.userId,
      impersonatedBy: null,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { ok: true, token, user: this.toView(user) };
  }

  public validate(token: string): AuthUserView | null {
    const session = this.sessions.get(token);
    if (!session || Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    const user = this.users.find((u) => u.userId === session.userId);
    if (!user || user.status !== 'ACTIVE') {
      this.sessions.delete(token);
      return null;
    }
    // 滑动续期
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    // act-as 视角：session.userId = 被代理用户，validate 始终返回被代理用户
    // impersonatedBy 仅用于审计与 isImpersonating()
    void session;
    return this.toView(user);
  }

  public logout(token: string): void {
    this.sessions.delete(token);
  }

  /** 管理员切换视角（act-as） */
  public actAs(
    adminToken: string,
    targetUserId: string,
  ): { token: string; user: AuthUserView } | null {
    const session = this.sessions.get(adminToken);
    if (!session || Date.now() > session.expiresAt) {
      return null;
    }
    const admin = this.users.find((u) => u.userId === session.userId);
    if (!admin || admin.tier !== 'PROJECT_ADMIN') {
      return null;
    }
    const target = this.users.find((u) => u.userId === targetUserId && u.status === 'ACTIVE');
    if (!target) {
      return null;
    }
    const newToken = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(newToken, {
      userId: targetUserId,
      impersonatedBy: admin.userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token: newToken, user: this.toView(target) };
  }

  public isImpersonating(token: string): AuthUserView | null {
    const session = this.sessions.get(token);
    if (!session || session.impersonatedBy === null) {
      return null;
    }
    const admin = this.users.find((u) => u.userId === session.impersonatedBy);
    return admin ? this.toView(admin) : null;
  }

  public changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): { ok: boolean; reason?: string } {
    const user = this.users.find((u) => u.userId === userId);
    if (!user || !verifyPassword(oldPassword, user.passwordHash)) {
      return { ok: false, reason: '旧口令错误' };
    }
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return { ok: false, reason: '口令至少 8 位且需包含字母与数字' };
    }
    if (newPassword === oldPassword) {
      return { ok: false, reason: '新口令不能与旧口令相同' };
    }
    user.passwordHash = this.hashPassword(newPassword);
    user.mustChangePassword = false;
    this.persistUsers();
    // 吊销其他会话（保留当前）
    const currentSessions = [...this.sessions.entries()];
    for (const [token, session] of currentSessions) {
      if (session.userId === userId && token !== userId) {
        this.sessions.delete(token);
      }
    }
    return { ok: true };
  }

  public listUsers(): AuthUserView[] {
    return this.users.map((u) => this.toView(u));
  }

  public getUserById(userId: string): AuthUserView | null {
    const user = this.users.find((u) => u.userId === userId);
    return user ? this.toView(user) : null;
  }

  public createUser(
    adminUserId: string,
    input: {
      username: string;
      displayName: string;
      jobTitle?: string;
      department?: string;
      tier: string;
      specialistDomain: string;
      counterpartAgentRole: string;
      ownedStageIds: string[];
      avatarBadge?: string;
      tempPassword?: string;
    },
  ): { ok: boolean; user?: AuthUserView; tempPassword?: string; reason?: string } {
    const admin = this.users.find((u) => u.userId === adminUserId);
    if (!admin || admin.tier !== 'PROJECT_ADMIN') {
      return { ok: false, reason: '仅项目管理员可创建成员' };
    }
    const normalized = input.username.trim().toLowerCase();
    if (this.users.some((u) => u.username === normalized)) {
      return { ok: false, reason: '用户名已存在' };
    }
    const tempPassword = input.tempPassword ?? crypto.randomBytes(6).toString('base64url');
    const newUser: AuthUserRecord = {
      userId: `usr_${Date.now().toString(36)}`,
      username: normalized,
      displayName: input.displayName,
      jobTitle: input.jobTitle ?? '团队成员',
      department: input.department ?? '',
      tier: input.tier === 'PROJECT_ADMIN' ? 'PROJECT_ADMIN' : 'STAGE_SPECIALIST',
      specialistDomain: input.specialistDomain,
      counterpartAgentRole: input.counterpartAgentRole,
      avatarBadge: input.avatarBadge ?? '👤',
      ownedStageIds: [...input.ownedStageIds],
      passwordHash: this.hashPassword(tempPassword),
      mustChangePassword: true,
      status: 'ACTIVE',
      failedLoginCount: 0,
      lockedUntil: null,
    };
    this.users.push(newUser);
    this.persistUsers();
    return { ok: true, user: this.toView(newUser), tempPassword };
  }

  public updateUser(
    adminUserId: string,
    targetUserId: string,
    patch: {
      displayName?: string;
      jobTitle?: string;
      ownedStageIds?: string[];
      status?: 'ACTIVE' | 'DISABLED';
    },
  ): { ok: boolean; user?: AuthUserView; reason?: string } {
    const admin = this.users.find((u) => u.userId === adminUserId);
    if (!admin || admin.tier !== 'PROJECT_ADMIN') {
      return { ok: false, reason: '仅项目管理员可修改成员' };
    }
    const target = this.users.find((u) => u.userId === targetUserId);
    if (!target) {
      return { ok: false, reason: '目标用户不存在' };
    }
    if (patch.status === 'DISABLED' && target.tier === 'PROJECT_ADMIN') {
      const activeAdmins = this.users.filter(
        (u) => u.tier === 'PROJECT_ADMIN' && u.status === 'ACTIVE' && u.userId !== targetUserId,
      );
      if (activeAdmins.length === 0) {
        return { ok: false, reason: '不能停用最后一个 ACTIVE 管理员' };
      }
    }
    if (patch.displayName !== undefined) {
      target.displayName = patch.displayName;
    }
    if (patch.jobTitle !== undefined) {
      target.jobTitle = patch.jobTitle;
    }
    if (patch.ownedStageIds !== undefined) {
      target.ownedStageIds = [...patch.ownedStageIds];
    }
    if (patch.status !== undefined) {
      target.status = patch.status;
      if (patch.status === 'DISABLED') {
        // 吊销全部会话
        for (const [token, session] of this.sessions.entries()) {
          if (session.userId === targetUserId) {
            this.sessions.delete(token);
          }
        }
      }
    }
    this.persistUsers();
    return { ok: true, user: this.toView(target) };
  }

  public resetPassword(adminUserId: string, targetUserId: string): { tempPassword: string } | null {
    const admin = this.users.find((u) => u.userId === adminUserId);
    if (!admin || admin.tier !== 'PROJECT_ADMIN') {
      return null;
    }
    const target = this.users.find((u) => u.userId === targetUserId);
    if (!target) {
      return null;
    }
    const tempPassword = crypto.randomBytes(6).toString('base64url');
    target.passwordHash = this.hashPassword(tempPassword);
    target.mustChangePassword = true;
    this.persistUsers();
    // 吊销全部会话
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === targetUserId) {
        this.sessions.delete(token);
      }
    }
    return { tempPassword };
  }
}
