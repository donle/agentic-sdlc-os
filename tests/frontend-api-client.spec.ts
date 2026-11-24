/**
 * @file frontend-api-client.spec.ts
 * @description P0-2 验收测试：通过真实监听端口的 WorkbenchHttpServer (AUTH_REQUIRED=true) 验证前端
 * WorkbenchApiClient 的 Cookie 会话登录、首登强制改密 403 拦截、act-as/exit-act-as、F2 成员 CRUD 与登录审计闭环。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';
import { ApiHttpError, WorkbenchApiClient } from '../src/ui/client/WorkbenchApiClient.ts';
import type { NotificationDto, WorkflowDomainEventDto } from '../src/ui/client/types.ts';

describe('P0-2 — WorkbenchApiClient F1/F2 鉴权与用户管理真实 HTTP 联调', () => {
  const savedEnv: Record<string, string | undefined> = {};

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

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('1. 完整认证闭环：401 拦截 → 登录 → 403 首登改密 → 改密放行 → act-as/exit-act-as → F2 CRUD/审计 → 登出', async () => {
    setEnv('AUTH_REQUIRED', 'true');
    setEnv('AUTH_DISABLED', undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-ui-client-'));
    const workbench = new WorkbenchHttpServer(0, {
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    const server = await workbench.start();

    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      let unauthorizedCount = 0;
      let mustChangeCount = 0;
      const client = new WorkbenchApiClient({ baseUrl, cookieJar: true });
      client.setAuthCallbacks({
        onUnauthorized: () => {
          unauthorizedCount += 1;
        },
        onMustChangePassword: () => {
          mustChangeCount += 1;
        },
      });

      // 1) 未登录探测 /api/auth/me 抛 401（不触发全局回调），调用业务接口触发 onUnauthorized
      await assert.rejects(
        client.fetchAuthMe(),
        (err: unknown) => err instanceof ApiHttpError && err.statusCode === 401,
      );
      await assert.rejects(
        client.fetchDashboardState(),
        (err: unknown) => err instanceof ApiHttpError && err.statusCode === 401,
      );
      assert.equal(unauthorizedCount, 1);

      // 2) 管理员首次登录 → 返回 mustChangePassword=true，访问 /api/state 触发 onMustChangePassword
      const loggedIn = await client.login('admin', 'admin');
      assert.equal(loggedIn.userId, 'user-admin-01');
      assert.equal(loggedIn.mustChangePassword, true);
      assert.equal(client.isSessionAuthenticated(), true);

      await assert.rejects(
        client.fetchDashboardState(),
        (err: unknown) =>
          err instanceof ApiHttpError && err.statusCode === 403 && err.mustChangePassword,
      );
      assert.equal(mustChangeCount, 1);

      // 3) 改密后正常访问 /api/state 与 /api/auth/me
      await client.changePassword('admin', 'AdminNewPassword1');
      const dash = await client.fetchDashboardState();
      assert.equal(dash.hasActiveRun, true);
      assert.equal(dash.rbacContext?.currentUser.userId, 'user-admin-01');

      // 4) actAs -> PM -> exitActAs 恢复管理员
      const actPm = await client.actAs('user-pm-01');
      assert.equal(actPm.user.userId, 'user-pm-01');
      assert.equal(actPm.impersonating?.userId, 'user-admin-01');

      const meDuringAct = await client.fetchAuthMe();
      assert.equal(meDuringAct.user.userId, 'user-pm-01');
      assert.equal(meDuringAct.impersonating?.userId, 'user-admin-01');

      const exited = await client.exitActAs();
      assert.equal(exited.user.userId, 'user-admin-01');
      assert.equal(exited.impersonating, null);

      // 5) F2 成员目录 CRUD + 重置口令 + 登录审计查询
      const initialUsers = await client.listAdminUsers();
      assert.ok(initialUsers.length >= 7);

      const created = await client.createAdminUser({
        username: 'ui_tester',
        displayName: '前端测试成员',
        jobTitle: '高级测试工程师',
        department: '质量工程部',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'QUALITY_ASSURANCE',
        counterpartAgentRole: 'QA_AGENT',
        ownedStageIds: ['STAGE_4_QA'],
      });
      assert.equal(created.user.username, 'ui_tester');
      assert.ok(created.tempPassword && created.tempPassword.length >= 6);

      const updated = await client.updateAdminUser(created.user.userId, {
        ownedStageIds: ['STAGE_4_QA', 'STAGE_5_DA'],
        status: 'DISABLED',
      });
      assert.equal(updated.status, 'DISABLED');
      assert.deepEqual(updated.ownedStageIds, ['STAGE_4_QA', 'STAGE_5_DA']);

      const resetRes = await client.resetAdminUserPassword(created.user.userId);
      assert.ok(resetRes.tempPassword && resetRes.tempPassword.length >= 6);

      const auditEntries = await client.fetchLoginAudit({ limit: 20 });
      const reasons = auditEntries.map((e) => e.reason);
      assert.ok(reasons.includes('OK'));
      assert.ok(reasons.includes('ACT_AS'));
      assert.ok(reasons.includes('EXIT_ACT_AS'));

      // 6) 登出后 Cookie 清理，业务请求再抛 401 并回调 onUnauthorized
      await client.logout();
      assert.equal(client.isSessionAuthenticated(), false);
      await assert.rejects(
        client.fetchDashboardState(),
        (err: unknown) => err instanceof ApiHttpError && err.statusCode === 401,
      );
      assert.equal(unauthorizedCount, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('P1-1 — WorkbenchApiClient 模板列表、熔断重试、沙箱结果与 SSE 增量事件流', () => {
  it('1. listWorkflowTemplates / triggerLiveSandboxVerification / retryAbortedRun 联调通过', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-ui-client-'));
    const workbench = new WorkbenchHttpServer(0, {
      persistenceDir: path.join(tmpDir, 'persist'),
      sandboxRootDir: path.join(tmpDir, 'sandbox'),
    });
    const server = await workbench.start();

    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const client = new WorkbenchApiClient({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        cookieJar: true,
      });

      // 演示模式下使用 admin 身份拉取动态模板并触发沙箱测试
      const tplRes = await client.listWorkflowTemplates();
      assert.ok(tplRes.templates.some((t) => t.fileName === 'enterprise_sdlc.yaml'));
      assert.ok(tplRes.templates.some((t) => t.fileName === 'backend_api_only.yaml'));

      // 选中已有源码的第一个演示运行（PROP-ENT-2026-00）执行真实沙箱验证
      const initDash = await client.fetchDashboardState();
      const firstRun = initDash.allRunsList?.[0];
      assert.ok(firstRun);
      const verifyOut = await client.triggerLiveSandboxVerification(firstRun.runId);
      assert.ok(typeof verifyOut.verification.totalTestCases === 'number');
      assert.ok(typeof verifyOut.verification.passedTestCases === 'number');
      assert.ok(typeof verifyOut.verification.securityIssuesFound === 'number');
      assert.equal(verifyOut.dashboardState.run?.runId, firstRun.runId);

      // 构造预算极低触发 ABORTED_TOKEN_BUDGET 的运行，验证 retryAbortedRun(extraTokenBudget) 恢复推进
      const orchestrator = workbench.getOrchestrator();
      const dsl = orchestrator.getWorkflowDslConfig();
      const lowBudgetRun = orchestrator.stateEngine.createRun({
        runId: 'RUN-P11-RETRY',
        proposal: new ProjectProposalContract({
          proposalId: 'PROP-P11-RETRY',
          title: '前端熔断重试联调测试',
          summary: '验证 retryAbortedRun 携带 extraTokenBudget 恢复执行',
          requirements: { REQ_1: '熔断后可补充预算重试' },
        }),
        initiatorActor: '测试员',
        stagePipeline: dsl.getStageOrder(),
        workflowTemplateId: dsl.id,
        tokenBudget: 1,
      });
      await orchestrator.continueExecutionUntilGateOrComplete(lowBudgetRun.runId);
      assert.equal(lowBudgetRun.getStatus(), 'ABORTED_TOKEN_BUDGET');

      const retriedDash = await client.retryAbortedRun({
        runId: lowBudgetRun.runId,
        comment: '前端扩容重试',
        extraTokenBudget: 50000,
      });
      assert.notEqual(retriedDash.run?.status, 'ABORTED_TOKEN_BUDGET');
      assert.equal(retriedDash.run?.runId, lowBudgetRun.runId);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. subscribeRealtimeEventStream 按 runId 建连、接收增量 run_event/user_notification 并在 cleanup 关闭', () => {
    const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
    const listeners = new Map<string, Array<(ev: Event) => void>>();
    let createdUrl = '';
    let closeCalls = 0;

    class MockEventSource {
      public constructor(url: string) {
        createdUrl = url;
      }

      public addEventListener(type: string, cb: (ev: Event) => void): void {
        const list = listeners.get(type) ?? [];
        list.push(cb);
        listeners.set(type, list);
      }

      public close(): void {
        closeCalls += 1;
      }
    }

    (globalThis as { EventSource?: unknown }).EventSource = MockEventSource;
    try {
      const client = new WorkbenchApiClient({ baseUrl: 'http://127.0.0.1:4300' });
      const receivedEvents: WorkflowDomainEventDto[] = [];
      const receivedNotifs: NotificationDto[] = [];
      let connectedState = false;

      const unsubscribe = client.subscribeRealtimeEventStream(
        () => undefined,
        (connected) => {
          connectedState = connected;
        },
        'RUN-SSE-TARGET',
        {
          onRunEvent: (ev) => receivedEvents.push(ev),
          onUserNotification: (notif) => receivedNotifs.push(notif),
        },
      );

      assert.ok(createdUrl.includes('runId=RUN-SSE-TARGET'));
      for (const cb of listeners.get('open') ?? []) {
        cb({} as Event);
      }
      assert.equal(connectedState, true);

      const sampleEvent: WorkflowDomainEventDto = {
        eventId: 'EVT-1',
        runId: 'RUN-SSE-TARGET',
        branchId: 'branch-v1-main',
        stageId: 'STAGE_1_PM',
        agentRole: 'PM_AGENT',
        lifecycleState: 'EXECUTING',
        headline: '增量事件推送',
        detailPayload: {},
        timestampIso: new Date().toISOString(),
      };
      for (const cb of listeners.get('run_event') ?? []) {
        cb({ data: JSON.stringify(sampleEvent) } as unknown as Event);
      }
      assert.equal(receivedEvents.length, 1);
      assert.equal(receivedEvents[0].eventId, 'EVT-1');

      const sampleNotif: NotificationDto = {
        notificationId: 'NOTIF-1',
        runId: 'RUN-SSE-TARGET',
        branchId: 'branch-v1-main',
        stageId: 'STAGE_2_PD',
        senderRole: 'PD_AGENT',
        category: 'HUMAN_GATE_REQUIRED',
        title: '待确认',
        message: '请确认设计',
        relatedSnapshotId: 'SNAP-1',
        requiresHumanAction: true,
        resolved: false,
        actionOptions: [],
        createdAtIso: new Date().toISOString(),
      };
      for (const cb of listeners.get('user_notification') ?? []) {
        cb({ data: JSON.stringify(sampleNotif) } as unknown as Event);
      }
      assert.equal(receivedNotifs.length, 1);
      assert.equal(receivedNotifs[0].notificationId, 'NOTIF-1');

      unsubscribe();
      assert.equal(closeCalls, 1, 'cleanup 必须关闭 EventSource 防止多 Run 串台泄漏');
    } finally {
      if (originalEventSource === undefined) {
        delete (globalThis as { EventSource?: unknown }).EventSource;
      } else {
        (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
      }
    }
  });
});
