/**
 * @file session-service.spec.ts
 * @description F1 边界单测：SessionService 登录/会话/act-as/改密/用户管理的完整边界覆盖。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, beforeEach } from 'node:test';

import { SessionService } from '../src/server/auth/SessionService.ts';

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
});
