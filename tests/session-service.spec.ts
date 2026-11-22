/**
 * @file session-service.spec.ts
 * @description F1 边界单测：SessionService 登录/会话/act-as/改密/用户管理的完整边界覆盖。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { SessionService } from '../src/server/auth/SessionService.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';

describe('F1 — SessionService 边界测试', () => {
  let svc: SessionService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-auth-'));
    svc = new SessionService(path.join(tmpDir, 'users.json'));
  });

  describe('登录', () => {
    it('1. 正确用户名+口令 → 成功返回 token', () => {
      const result = svc.login('admin', 'admin');
      assert.equal(result.ok, true);
      assert.ok((result as { token: string }).token.length > 20);
    });

    it('2. 错误口令 → BAD_PASSWORD（不区分用户不存在）', () => {
      const r1 = svc.login('admin', 'wrong');
      assert.equal(r1.ok, false);
      assert.equal((r1 as { reason: string }).reason, 'BAD_PASSWORD');
      const r2 = svc.login('nonexistent_user_xyz', 'anypassword');
      assert.equal(r2.ok, false);
      assert.equal(
        (r2 as { reason: string }).reason,
        'BAD_PASSWORD',
        '不存在的用户返回相同文案（防枚举）',
      );
    });

    it('3. 连续失败 5 次 → LOCKED 423', () => {
      for (let i = 0; i < 5; i++) {
        svc.login('admin', 'wrong' + i);
      }
      const result = svc.login('admin', 'admin'); // 即使口令正确也锁定
      assert.equal(result.ok, false);
      assert.equal((result as { reason: string }).reason, 'LOCKED');
      assert.ok((result as { retryAfterSec?: number }).retryAfterSec !== undefined);
    });
  });

  describe('会话验证', () => {
    it('4. 有效 token → validate 返回用户', () => {
      const login = svc.login('admin', 'admin') as { ok: true; token: string };
      const user = svc.validate(login.token);
      assert.ok(user);
      assert.equal(user.userId, 'user-admin-01');
      assert.equal(user.tier, 'PROJECT_ADMIN');
    });

    it('5. 伪造 token → null', () => {
      assert.equal(svc.validate('fake_token_12345'), null);
    });

    it('6. 停用用户 → 会话立即失效', () => {
      const login = svc.login('pm', 'pm') as { ok: true; token: string };
      assert.ok(svc.validate(login.token));
      void login;
      // 停用
      svc.updateUser('user-admin-01', 'user-pm-01', { status: 'DISABLED' });
      assert.equal(svc.validate(login.token), null, '停用后会话立即失效');
    });
  });

  describe('act-as（管理员视角切换）', () => {
    it('7. admin act-as pd → 返回 pd 用户', () => {
      const adminLogin = svc.login('admin', 'admin') as { ok: true; token: string };
      const result = svc.actAs(adminLogin.token, 'user-pd-01');
      assert.ok(result);
      assert.equal(result.user.userId, 'user-pd-01');
      // validate 返回被代理用户
      const validated = svc.validate(result.token);
      assert.equal(validated?.userId, 'user-pd-01');
    });

    it('8. 非 admin 用户尝试 act-as → null', () => {
      const pmLogin = svc.login('pm', 'pm') as { ok: true; token: string };
      assert.equal(svc.actAs(pmLogin.token, 'user-qa-01'), null);
    });

    it('9. act-as 到已停用用户 → null', () => {
      const adminLogin = svc.login('admin', 'admin') as { ok: true; token: string };
      svc.updateUser('user-admin-01', 'user-pd-01', { status: 'DISABLED' });
      assert.equal(svc.actAs(adminLogin.token, 'user-pd-01'), null);
    });
  });

  describe('改密', () => {
    it('10. 改密成功 → 旧口令失效', () => {
      const result = svc.changePassword('user-pm-01', 'pm', 'newSecure123');
      assert.equal(result.ok, true);
      const reLogin = svc.login('pm', 'newSecure123');
      assert.equal(reLogin.ok, true);
      const oldLogin = svc.login('pm', 'pm');
      assert.equal(oldLogin.ok, false);
    });

    it('11. 新口令与旧口令相同 → 拒绝', () => {
      // 先改密到 newSecure123（满足长度策略），再尝试改回相同值
      svc.changePassword('user-pm-01', 'pm', 'newSecure123');
      const result = svc.changePassword('user-pm-01', 'newSecure123', 'newSecure123');
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('相同'));
    });

    it('12. 新口令太短 → 拒绝', () => {
      const result = svc.changePassword('user-pm-01', 'pm', 'ab1');
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('8'));
    });
  });

  describe('用户管理', () => {
    it('13. admin 创建新成员 → 成功 + 临时口令', () => {
      const result = svc.createUser('user-admin-01', {
        username: 'newmember',
        displayName: '新成员',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'SOFTWARE_ENGINEERING',
        counterpartAgentRole: 'ENGINEER_AGENT',
        ownedStageIds: ['STAGE_3B_ENGINEER'],
      });
      assert.equal(result.ok, true);
      assert.ok(result.tempPassword);
      // 新成员可用临时口令登录
      const login = svc.login('newmember', result.tempPassword!);
      assert.equal(login.ok, true);
    });

    it('14. 用户名重复 → 409', () => {
      const result = svc.createUser('user-admin-01', {
        username: 'pm',
        displayName: '重复',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'PRODUCT_MANAGEMENT',
        counterpartAgentRole: 'PM_AGENT',
        ownedStageIds: [],
      });
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('已存在'));
    });

    it('15. 停用最后一个 admin → 409', () => {
      // admin 是唯一 PROJECT_ADMIN
      const result = svc.updateUser('user-admin-01', 'user-admin-01', { status: 'DISABLED' });
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('最后一个'));
    });

    it('16. 非管理员尝试创建用户 → 403', () => {
      const result = svc.createUser('user-pm-01', {
        username: 'hacker',
        displayName: 'Hacker',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'SOFTWARE_ENGINEERING',
        counterpartAgentRole: 'ENGINEER_AGENT',
        ownedStageIds: [],
      });
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('管理员'));
    });
  });

  describe('持久化', () => {
    it('17. 重启后用户数据完整（从 JSON 文件恢复）', () => {
      // 第一次实例化创建 seed
      const svc1 = new SessionService(path.join(tmpDir, 'persist.json'));
      svc1.login('admin', 'admin');

      // 第二次实例化（模拟重启）应从 JSON 恢复
      const svc2 = new SessionService(path.join(tmpDir, 'persist.json'));
      const login = svc2.login('admin', 'admin');
      assert.equal(login.ok, true);
      const user = svc2.validate((login as { token: string }).token);
      assert.equal(user?.userId, 'user-admin-01');
    });
  });

  describe('安全加固回归（SHA-256 摘要 / 改密保留当前会话 / 降级保护 / 登录审计）', () => {
    it('18. 服务端仅存 SHA-256(token) 摘要，不存明文 token', () => {
      const login = svc.login('admin', 'admin') as { ok: true; token: string };
      const hashes = svc.getStoredSessionTokenHashes();
      assert.equal(hashes.length, 1);
      assert.equal(hashes[0].length, 64);
      assert.match(hashes[0], /^[0-9a-f]{64}$/);
      assert.notEqual(hashes[0], login.token, '会话表中绝对不能出现明文 token');
    });

    it('19. changePassword(currentToken) 仅吊销其他设备会话，当前会话保持有效', () => {
      const sessionA = svc.login('pm', 'pm') as { ok: true; token: string };
      const sessionB = svc.login('pm', 'pm') as { ok: true; token: string };
      assert.ok(svc.validate(sessionA.token));
      assert.ok(svc.validate(sessionB.token));

      const changed = svc.changePassword('user-pm-01', 'pm', 'newSecure123', sessionA.token);
      assert.equal(changed.ok, true);
      assert.ok(svc.validate(sessionA.token), '发起改密的当前会话必须保持有效');
      assert.equal(svc.validate(sessionB.token), null, '同一用户的其他设备会话必须被吊销');
    });

    it('20. 禁止降级最后一个 ACTIVE 管理员为 STAGE_SPECIALIST', () => {
      const result = svc.updateUser('user-admin-01', 'user-admin-01', {
        tier: 'STAGE_SPECIALIST',
      });
      assert.equal(result.ok, false);
      assert.ok(result.reason?.includes('最后一个'));
    });

    it('21. 登录审计正确记录 UNKNOWN_USER / BAD_PASSWORD / OK / ACT_AS', () => {
      svc.login('nobody', 'bad');
      svc.login('pm', 'wrong');
      const adminLogin = svc.login('admin', 'admin') as { ok: true; token: string };
      svc.actAs(adminLogin.token, 'user-pd-01');

      const entries = svc.getLoginAudit({ limit: 10 });
      const reasons = entries.map((e) => e.reason);
      assert.ok(reasons.includes('UNKNOWN_USER'));
      assert.ok(reasons.includes('BAD_PASSWORD'));
      assert.ok(reasons.includes('OK'));
      assert.ok(reasons.includes('ACT_AS'));
    });
  });
});

interface MockHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly bodyText: string;
  readonly json: Record<string, unknown>;
}

async function dispatchInProcess(
  server: WorkbenchHttpServer,
  params: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  },
): Promise<MockHttpResponse> {
  const chunks = params.body ? [Buffer.from(JSON.stringify(params.body))] : [];
  const req = Readable.from(chunks) as unknown as http.IncomingMessage;
  req.method = params.method;
  req.url = params.url;
  req.headers = { ...(params.headers ?? {}) };

  let statusCode = 200;
  const headers: Record<string, string | string[]> = {};
  const outChunks: Buffer[] = [];

  const res = {
    writeHead(code: number, hdrs?: Record<string, string | string[]>): http.ServerResponse {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
      return res as unknown as http.ServerResponse;
    },
    write(chunk: string | Buffer): boolean {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer): http.ServerResponse {
      if (chunk) {
        outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return res as unknown as http.ServerResponse;
    },
  } as unknown as http.ServerResponse;

  await server.handleHttpRequest(req, res);
  const bodyText = Buffer.concat(outChunks).toString('utf-8');
  let json: Record<string, unknown>;
  try {
    json = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { statusCode, headers, bodyText, json };
}

describe('F1/F2 — WorkbenchHttpServer 认证与路由权限守卫（进程内 HTTP 验证）', () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  function setEnv(key: string, val: string | undefined): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  it('1. AUTH_REQUIRED=true：未登录 401、首登改密拦截 403、改密保留当前会话、权限码越权拦截 403、act-as 与审计查询', async () => {
    setEnv('AUTH_REQUIRED', 'true');
    setEnv('AUTH_DISABLED', undefined);
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-srv-persist-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-srv-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      // 1) 未登录访问 /api/state → 401
      const unauthState = await dispatchInProcess(server, { method: 'GET', url: '/api/state' });
      assert.equal(unauthState.statusCode, 401);

      // 2) PM 登录成功，Set-Cookie 带 sdlc_session
      const pmLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'pm', password: 'pm' },
      });
      assert.equal(pmLogin.statusCode, 200);
      const setCookie = String(pmLogin.headers['set-cookie'] ?? '');
      const pmCookieMatch = setCookie.match(/sdlc_session=([^\s;]+)/);
      assert.ok(pmCookieMatch);
      const pmCookie = `sdlc_session=${pmCookieMatch[1]}`;

      // 3) 首登 mustChangePassword=true → 访问业务端点 403；改密后当前会话保持有效
      const blockedBeforePwd = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/state',
        headers: { cookie: pmCookie },
      });
      assert.equal(blockedBeforePwd.statusCode, 403);
      assert.equal(blockedBeforePwd.json.mustChangePassword, true);

      const changePwd = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: pmCookie },
        body: { oldPassword: 'pm', newPassword: 'PmNewPassword1' },
      });
      assert.equal(changePwd.statusCode, 200);

      const pmMe = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: pmCookie },
      });
      assert.equal(pmMe.statusCode, 200, '改密后原会话 Cookie 必须仍然有效');

      // 4) PM 越权调用 /api/admin/governance → 403
      const pmGovernance = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/admin/governance',
        headers: { cookie: pmCookie },
        body: { maxNegotiationTurns: 5 },
      });
      assert.equal(pmGovernance.statusCode, 403);

      // 5) PD 登录改密后越权调用 POST /api/proposals（缺 CREATE_PROPOSAL 权限码）→ 403
      const pdLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'pd', password: 'pd' },
      });
      const pdCookieMatch = String(pdLogin.headers['set-cookie'] ?? '').match(
        /sdlc_session=([^\s;]+)/,
      );
      assert.ok(pdCookieMatch);
      const pdCookie = `sdlc_session=${pdCookieMatch[1]}`;
      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: pdCookie },
        body: { oldPassword: 'pd', newPassword: 'PdNewPassword1' },
      });
      const pdProposal = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { cookie: pdCookie },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(pdProposal.statusCode, 403);

      // 6) Admin 登录改密 → act-as PM → /api/auth/me 返回 impersonating；登录审计可见
      const adminLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'admin', password: 'admin' },
      });
      const adminCookieMatch = String(adminLogin.headers['set-cookie'] ?? '').match(
        /sdlc_session=([^\s;]+)/,
      );
      assert.ok(adminCookieMatch);
      const adminCookie = `sdlc_session=${adminCookieMatch[1]}`;
      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: adminCookie },
        body: { oldPassword: 'admin', newPassword: 'AdminNewPassword1' },
      });

      const auditRes = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/admin/login-audit?limit=10',
        headers: { cookie: adminCookie },
      });
      assert.equal(auditRes.statusCode, 200);
      const auditData = auditRes.json.data as { entries: unknown[] };
      assert.ok(auditData.entries.length >= 3);

      const actAsRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/act-as',
        headers: { cookie: adminCookie },
        body: { targetUserId: 'user-pm-01' },
      });
      assert.equal(actAsRes.statusCode, 200);
      const actAsCookieMatch = String(actAsRes.headers['set-cookie'] ?? '').match(
        /sdlc_session=([^\s;]+)/,
      );
      assert.ok(actAsCookieMatch);
      const actAsMe = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: `sdlc_session=${actAsCookieMatch[1]}` },
      });
      assert.equal(actAsMe.statusCode, 200);
      const actAsData = actAsMe.json.data as {
        user: { userId: string };
        impersonating: { userId: string } | null;
      };
      assert.equal(actAsData.user.userId, 'user-pm-01');
      assert.equal(actAsData.impersonating?.userId, 'user-admin-01');
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('2. 默认模式下，未认证写请求或未知 X-Actor-Id 绝不静默提权为最高管理员', async () => {
    setEnv('AUTH_REQUIRED', undefined);
    setEnv('AUTH_DISABLED', undefined);
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-srv-strict-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-srv-strict-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      // 无会话、无 X-Actor-Id 直接调用写操作 → 403（绝不回落 user-admin-01）
      const unauthProposal = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(unauthProposal.statusCode, 403);

      const unauthGovernance = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/admin/governance',
        body: { maxNegotiationTurns: 2 },
      });
      assert.equal(unauthGovernance.statusCode, 403);

      // 伪造未知 X-Actor-Id → GET /api/state 返回 401，POST /api/decisions 返回 403
      const unknownState = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/state',
        headers: { 'x-actor-id': 'usr_unknown_hacker' },
      });
      assert.equal(unknownState.statusCode, 401);

      const unknownDecision = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/decisions',
        headers: { 'x-actor-id': 'usr_unknown_hacker' },
        body: { snapshotId: 'SNAP-1', verdict: 'APPROVE' },
      });
      assert.equal(unknownDecision.statusCode, 403);

      // Admin 创建的新专长员工（无 CREATE_PROPOSAL 权限码）不会因不在旧硬编码表而被提权为管理员
      const created = server.sessionService.createUser('user-admin-01', {
        username: 'qa_new',
        displayName: '新测试员',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'QUALITY_ASSURANCE',
        counterpartAgentRole: 'QA_AGENT',
        ownedStageIds: ['STAGE_4_QA'],
      });
      assert.equal(created.ok, true);
      assert.ok(created.user);

      const newUserProposal = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': created.user.userId },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(newUserProposal.statusCode, 403, '新创建员工不可被静默提权为管理员');
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
