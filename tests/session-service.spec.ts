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

    it('9b. P0-3：act-as 支持替身态连续切换、切回自身及 exitActAs 退出恢复（吊销旧替身令牌并记录 EXIT_ACT_AS）', () => {
      const adminLogin = svc.login('admin', 'admin') as { ok: true; token: string };
      // 1) admin -> pd
      const pdAct = svc.actAs(adminLogin.token, 'user-pd-01');
      assert.ok(pdAct);
      assert.equal(pdAct.impersonating?.userId, 'user-admin-01');

      // 2) 在 pd 替身态下连续切换 -> pm（旧 pd 替身 token 应失效）
      const pmAct = svc.actAs(pdAct.token, 'user-pm-01');
      assert.ok(pmAct);
      assert.equal(pmAct.user.userId, 'user-pm-01');
      assert.equal(pmAct.impersonating?.userId, 'user-admin-01');
      assert.equal(svc.validate(pdAct.token), null, '连续切换后旧替身令牌必须失效');

      // 3) exitActAs 恢复为管理员，旧 pm 替身令牌失效，原管理员令牌仍可用或新管理员令牌可用
      const exited = svc.exitActAs(pmAct.token);
      assert.ok(exited);
      assert.equal(exited.user.userId, 'user-admin-01');
      assert.equal(svc.validate(pmAct.token), null, '退出 act-as 后原替身令牌必须失效');
      assert.equal(svc.isImpersonating(exited.token), null);
      assert.equal(svc.exitActAs(exited.token), null, '非替身会话不可重复 exitActAs');

      // 4) 再次 act-as 到 qa 后通过 actAs(target=admin) 直接切回自身
      const qaAct = svc.actAs(exited.token, 'user-qa-01');
      assert.ok(qaAct);
      const backToSelf = svc.actAs(qaAct.token, 'user-admin-01');
      assert.ok(backToSelf);
      assert.equal(backToSelf.user.userId, 'user-admin-01');
      assert.equal(backToSelf.impersonating, null);
      assert.equal(svc.isImpersonating(backToSelf.token), null);

      const reasons = svc.getLoginAudit({ limit: 20 }).map((e) => e.reason);
      assert.ok(reasons.includes('EXIT_ACT_AS'));
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

  it('3. P0-3：HTTP act-as 连续切换与 /api/auth/exit-act-as 可逆恢复，且业务审计自动记录 "(via <admin>)"', async () => {
    setEnv('AUTH_REQUIRED', 'true');
    setEnv('AUTH_DISABLED', undefined);
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-srv-persist-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-srv-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      // 1) Admin 与 PD 各自登录改密
      const adminLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'admin', password: 'admin' },
      });
      const adminCookie = `sdlc_session=${
        String(adminLogin.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;
      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: adminCookie },
        body: { oldPassword: 'admin', newPassword: 'AdminNewPassword1' },
      });

      const pdLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'pd', password: 'pd' },
      });
      const pdNormalCookie = `sdlc_session=${
        String(pdLogin.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;
      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: pdNormalCookie },
        body: { oldPassword: 'pd', newPassword: 'PdNewPassword1' },
      });

      // 非管理员禁止 act-as
      const pdTryActAs = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/act-as',
        headers: { cookie: pdNormalCookie },
        body: { targetUserId: 'user-pm-01' },
      });
      assert.equal(pdTryActAs.statusCode, 403);

      // 2) Admin act-as -> PD -> 再连续切换至 PM（不再 403 锁死）
      const actPdRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/act-as',
        headers: { cookie: adminCookie },
        body: { targetUserId: 'user-pd-01' },
      });
      assert.equal(actPdRes.statusCode, 200);
      const actPdCookie = `sdlc_session=${
        String(actPdRes.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;

      const actPmRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/act-as',
        headers: { cookie: actPdCookie },
        body: { targetUserId: 'user-pm-01' },
      });
      assert.equal(actPmRes.statusCode, 200, '在非管理员替身态下管理员必须可以继续切换角色');
      const actPmCookie = `sdlc_session=${
        String(actPmRes.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;

      // 旧替身 cookie 已失效
      const stalePdMe = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: actPdCookie },
      });
      assert.equal(stalePdMe.statusCode, 401);

      // 3) 替身态下发表评论、签核拍板、总管回退与立项均记录 "(via 王总管)"
      const stateRes = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/state',
        headers: { cookie: actPmCookie },
      });
      assert.equal(stateRes.statusCode, 200);
      const stateData = stateRes.json.data as {
        run: {
          runId: string;
          snapshots: Array<{ snapshotId: string; stageId: string; state: string }>;
        };
      };
      const pendingSnap = stateData.run.snapshots.find((s) => s.state === 'PENDING_HUMAN_GATE');
      assert.ok(pendingSnap, '默认演示运行应存在待签核快照');

      const commentRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/comments',
        headers: { cookie: actPmCookie },
        body: {
          runId: stateData.run.runId,
          stageId: pendingSnap.stageId,
          content: '代班评审确认交互规格',
        },
      });
      assert.equal(commentRes.statusCode, 200);
      const afterCommentData = commentRes.json.data as {
        teamComments: Array<{ authorName: string; content: string }>;
      };
      const latestComment = afterCommentData.teamComments[afterCommentData.teamComments.length - 1];
      assert.ok(latestComment.authorName.includes('(via 王总管)'));

      const decisionRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/decisions',
        headers: { cookie: actPmCookie },
        body: {
          runId: stateData.run.runId,
          snapshotId: pendingSnap.snapshotId,
          verdict: 'ARBITRATE_OPTION_A',
          comment: '替身态签核拍板方案A',
        },
      });
      assert.equal(decisionRes.statusCode, 200);
      const afterDecisionData = decisionRes.json.data as {
        humanDecisions: Array<{ reviewerActor: string; verdict: string }>;
      };
      const latestDecision =
        afterDecisionData.humanDecisions[afterDecisionData.humanDecisions.length - 1];
      assert.ok(latestDecision.reviewerActor.includes('(via 王总管)'));
      assert.equal(
        latestDecision.reviewerActor.match(/\(via 王总管\)/g)?.length,
        1,
        '归属标签不得重复追加',
      );

      const rollbackRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/supervisor/rollback',
        headers: { cookie: actPmCookie },
        body: {
          runId: stateData.run.runId,
          targetStageId: 'STAGE_2_PD',
          dialogueInstruction: '回退到 PD 微调组件说明',
        },
      });
      assert.equal(rollbackRes.statusCode, 200);
      const afterRollbackData = rollbackRes.json.data as {
        humanDecisions: Array<{ reviewerActor: string; verdict: string }>;
      };
      const rollbackDecision =
        afterRollbackData.humanDecisions[afterRollbackData.humanDecisions.length - 1];
      assert.equal(rollbackDecision.verdict, 'SUPERVISOR_ROLLBACK');
      assert.ok(rollbackDecision.reviewerActor.includes('(via SupervisorAgent)'));
      assert.ok(rollbackDecision.reviewerActor.includes('(via 王总管)'));

      const propRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { cookie: actPmCookie },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(propRes.statusCode, 200);
      const propRun = (propRes.json.data as { run: { initiatorActor: string } }).run;
      assert.ok(propRun.initiatorActor.includes('(via 王总管)'));

      // 4) 调用 /api/auth/exit-act-as 退出替身恢复管理员，并清理旧替身令牌
      const exitRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/exit-act-as',
        headers: { cookie: actPmCookie },
      });
      assert.equal(exitRes.statusCode, 200);
      const restoredCookie = `sdlc_session=${
        String(exitRes.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;

      const oldPmMe = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: actPmCookie },
      });
      assert.equal(oldPmMe.statusCode, 401);

      const restoredMe = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: restoredCookie },
      });
      assert.equal(restoredMe.statusCode, 200);
      const restoredData = restoredMe.json.data as {
        user: { userId: string };
        impersonating: unknown;
      };
      assert.equal(restoredData.user.userId, 'user-admin-01');
      assert.equal(restoredData.impersonating, null);

      const doubleExit = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/exit-act-as',
        headers: { cookie: restoredCookie },
      });
      assert.equal(doubleExit.statusCode, 400);

      const auditRes = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/admin/login-audit?limit=20',
        headers: { cookie: restoredCookie },
      });
      assert.equal(auditRes.statusCode, 200);
      const auditEntries = (auditRes.json.data as { entries: Array<{ reason: string }> }).entries;
      assert.ok(auditEntries.some((e) => e.reason === 'EXIT_ACT_AS'));
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('4. P1-2：HTTP 登录与会话续期采集来源 IP 与 User-Agent 并写入 auth_login_audit', async () => {
    setEnv('AUTH_REQUIRED', 'true');
    setEnv('AUTH_DISABLED', undefined);
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-ip-persist-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-ip-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const badLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          'x-forwarded-for': '203.0.113.77, 10.0.0.1',
          'user-agent': 'SecurityProbe/9.0',
        },
        body: { username: 'admin', password: 'wrong' },
      });
      assert.equal(badLogin.statusCode, 401);

      const adminLogin = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          'x-forwarded-for': '198.51.100.42',
          'user-agent': 'EnterpriseChrome/130.0',
        },
        body: { username: 'admin', password: 'admin' },
      });
      assert.equal(adminLogin.statusCode, 200);
      const adminCookie = `sdlc_session=${
        String(adminLogin.headers['set-cookie'] ?? '').match(/sdlc_session=([^\s;]+)/)![1]
      }`;

      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: {
          cookie: adminCookie,
          'x-forwarded-for': '198.51.100.42',
          'user-agent': 'EnterpriseChrome/130.0',
        },
        body: { oldPassword: 'admin', newPassword: 'AdminNewPassword1' },
      });

      const auditRes = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/admin/login-audit?username=admin&limit=10',
        headers: {
          cookie: adminCookie,
          'x-forwarded-for': '198.51.100.42',
          'user-agent': 'EnterpriseChrome/130.0',
        },
      });
      assert.equal(auditRes.statusCode, 200);
      const entries = (
        auditRes.json.data as {
          entries: Array<{ reason: string; ip?: string | null }>;
        }
      ).entries;
      assert.ok(entries.some((e) => e.reason === 'BAD_PASSWORD' && e.ip === '203.0.113.77'));
      assert.ok(entries.some((e) => e.reason === 'OK' && e.ip === '198.51.100.42'));
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
