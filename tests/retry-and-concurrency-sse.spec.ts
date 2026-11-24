/**
 * @file retry-and-concurrency-sse.spec.ts
 * @description AUDIT-10 & AUDIT-13 验收测试套件：
 * 1. AUDIT-10：StageContractError (`ABORTED`) 点击 `RETRY_STAGE` / `POST /api/decisions` 不再 400，安全重启失败阶段并消解通知；
 * 2. AUDIT-10：TokenBudgetExceededError (`ABORTED_TOKEN_BUDGET`) 经 `POST /api/decisions` 或 `POST /api/runs/retry` 补充预算并恢复推进；
 * 3. AUDIT-13：多标签页并发访问不同 `runId`（`GET /api/state` / `POST /api/runs/select` / `/api/comments` / `/api/decisions`）互不篡改默认运行与互相串台；
 * 4. AUDIT-13：SSE `/api/events/stream?runId=...` 按运行实例隔离推送，携带 `Last-Event-ID` 精确增量重放且不泄漏其他 `runId` 事件。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import {
  AgentRole,
  DecisionVerdict,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../src/domain/enums.ts';
import { WorkflowDslConfiguration, WorkflowDslLoader } from '../src/engine/WorkflowDslLoader.ts';
import { WorkflowDomainEvent } from '../src/patterns/EventBus.ts';
import type { OpenAiCompatibleChatRequest } from '../src/patterns/ModelRouterGateway.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';

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
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { statusCode, headers, bodyText, json };
}

async function openInProcessSseStream(
  server: WorkbenchHttpServer,
  params: { url: string; headers?: Record<string, string> },
): Promise<{
  statusCode: number;
  chunks: string[];
  close: () => void;
}> {
  const req = new EventEmitter() as unknown as http.IncomingMessage;
  req.method = 'GET';
  req.url = params.url;
  req.headers = { ...(params.headers ?? {}) };

  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number): http.ServerResponse {
      statusCode = code;
      return res as unknown as http.ServerResponse;
    },
    write(chunk: string | Buffer): boolean {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk);
      return true;
    },
    end(chunk?: string | Buffer): http.ServerResponse {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk);
      }
      return res as unknown as http.ServerResponse;
    },
  } as unknown as http.ServerResponse;

  await server.handleHttpRequest(req, res);
  return {
    statusCode,
    chunks,
    close: () => {
      req.emit('close');
    },
  };
}

describe('AUDIT-10 & AUDIT-13 — 熔断重试恢复、多 Run 并发隔离与 SSE Last-Event-ID 重放验收测试', () => {
  it('1. AUDIT-10：StageContractError 熔断后点击 RETRY_STAGE 不再报 400，可重启失败阶段并消解通知（含历史 ROOT 兼容）', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-contract-db-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-contract-sb-'));
    const prevLiveHttp = process.env.LITELLM_ENABLE_LIVE_HTTP;

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const orchestrator = server.getOrchestrator();
      orchestrator.modelRouter.setHttpTransport(
        async (_url: string, payload: OpenAiCompatibleChatRequest) => {
          const sys = payload.messages?.[0]?.content ?? '';
          if (sys.includes('PM Agent')) {
            return {
              id: 'chatcmpl-bad',
              model: 'mock-model',
              choices: [{ message: { role: 'assistant', content: '这里是一段纯散文，没有 JSON' } }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            };
          }
          return {
            id: 'chatcmpl-other',
            model: 'mock-model',
            choices: [{ message: { role: 'assistant', content: '{}' } }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          };
        },
      );
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';

      const propRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          preset: 'CUSTOM',
          title: 'AUDIT-10 契约熔断重试验证',
          summary: '验证 Stage 1 契约失败后 RETRY_STAGE 恢复',
          requirements: { REQ_RETRY_1: '支持 StageContractError 安全重启' },
        },
      });
      assert.equal(propRes.statusCode, 200);
      const data1 = propRes.json.data as {
        run: { runId: string; status: string };
        notifications: Array<{
          notificationId: string;
          category: string;
          relatedSnapshotId: string;
          resolved: boolean;
        }>;
      };
      const runId = data1.run.runId;
      assert.equal(data1.run.status, 'ABORTED');

      const failNotif = data1.notifications.find((n) => n.category === 'STAGE_CONTRACT_FAILED');
      assert.ok(failNotif, '应发布 STAGE_CONTRACT_FAILED 通知');
      assert.ok(
        failNotif.relatedSnapshotId.startsWith('RETRY:STAGE_1_PM:'),
        `relatedSnapshotId 应绑定真实重试标识而非 ROOT，实际=${failNotif.relatedSnapshotId}`,
      );

      // 恢复环境后模拟前端点击 RETRY_STAGE（POST /api/decisions）
      delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      orchestrator.modelRouter.setHttpTransport(null);

      const retryRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/decisions',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          runId,
          snapshotId: failNotif.relatedSnapshotId,
          verdict: DecisionVerdict.APPROVE,
          comment: '已排查网关并点击 RETRY_STAGE 重试',
        },
      });
      assert.equal(retryRes.statusCode, 200, `RETRY_STAGE 应返回 200，实际: ${retryRes.bodyText}`);

      const runState = orchestrator.stateEngine.getRunOrThrow(runId);
      assert.notEqual(runState.getStatus(), 'ABORTED');
      assert.ok(runState.getAllSnapshots().length > 0, '重试后应成功生成后续阶段快照');
      assert.equal(
        orchestrator.eventBus
          .getNotificationInbox(runId)
          .find((n) => n.notificationId === failNotif.notificationId)
          ?.isResolved(),
        true,
        '重试后原熔断通知应标记为已解决',
      );

      // 兼容验证：若历史通知仍携带 relatedSnapshotId='ROOT' 且处于 ABORTED，同样应正常恢复不报 400
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      orchestrator.modelRouter.setHttpTransport(async () => ({
        id: 'chatcmpl-bad-2',
        model: 'mock-model',
        choices: [{ message: { role: 'assistant', content: '纯散文重试触发第二次熔断' } }],
      }));
      const run2Res = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          preset: 'CUSTOM',
          title: 'AUDIT-10 ROOT 兼容验证',
          summary: '历史 ROOT 标识恢复重试',
          requirements: { REQ_ROOT: '兼容 ROOT 重试入口' },
        },
      });
      const run2Id = (run2Res.json.data as { run: { runId: string } }).run.runId;
      assert.equal(orchestrator.stateEngine.getRunOrThrow(run2Id).getStatus(), 'ABORTED');

      delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      orchestrator.modelRouter.setHttpTransport(null);

      const legacyRetryRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/decisions',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          runId: run2Id,
          snapshotId: 'ROOT',
          verdict: DecisionVerdict.APPROVE,
          comment: '兼容旧 ROOT 按钮点击',
        },
      });
      assert.equal(legacyRetryRes.statusCode, 200);
      assert.notEqual(orchestrator.stateEngine.getRunOrThrow(run2Id).getStatus(), 'ABORTED');
    } finally {
      if (prevLiveHttp === undefined) {
        delete process.env.LITELLM_ENABLE_LIVE_HTTP;
      } else {
        process.env.LITELLM_ENABLE_LIVE_HTTP = prevLiveHttp;
      }
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('2. AUDIT-10：TokenBudgetExceededError 熔断后支持 via /api/decisions 与 /api/runs/retry 追加预算恢复', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-budget-db-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-budget-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const orchestrator = server.getOrchestrator();
      const baseDsl = WorkflowDslLoader.loadFromFile();
      const lowBudgetDsl = new WorkflowDslConfiguration({
        id: baseDsl.id,
        name: baseDsl.name,
        deploymentMode: baseDsl.deploymentMode,
        sourceFilePath: baseDsl.sourceFilePath,
        rawYamlSnapshot: baseDsl.rawYamlSnapshot,
        guardrails: { ...baseDsl.guardrails, tokenBudgetLimit: 1000 },
        modelRouting: baseDsl.modelRouting,
        stages: baseDsl.stages,
      });
      orchestrator.reloadWorkflowDsl(lowBudgetDsl);

      const res1 = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          preset: 'CUSTOM',
          title: 'AUDIT-10 Token 预算超限测试 1',
          summary: '低预算触发 ABORTED_TOKEN_BUDGET 后通过 /api/decisions 扩容恢复',
          requirements: {
            REQ_B1: '需求一描述扩展长度以确保预算守卫拦截超限请求并正确挂起流水线状态',
            REQ_B2: '需求二描述扩展长度以便用户追加预算后无缝继续执行剩余阶段任务',
          },
        },
      });
      assert.equal(res1.statusCode, 200);
      const data1 = res1.json.data as {
        run: { runId: string; status: string };
        notifications: Array<{
          notificationId: string;
          category: string;
          relatedSnapshotId: string;
        }>;
      };
      assert.equal(data1.run.status, 'ABORTED_TOKEN_BUDGET');
      const budgetNotif1 = data1.notifications.find((n) => n.category === 'TOKEN_BUDGET_EXCEEDED');
      assert.ok(budgetNotif1, '应发布 TOKEN_BUDGET_EXCEEDED 通知');

      const recover1 = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/decisions',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          runId: data1.run.runId,
          snapshotId: budgetNotif1.relatedSnapshotId,
          verdict: DecisionVerdict.APPROVE,
          comment: '审批追加 120000 Token 预算',
          extraTokenBudget: 120000,
        },
      });
      assert.equal(recover1.statusCode, 200);
      const runState1 = orchestrator.stateEngine.getRunOrThrow(data1.run.runId);
      assert.ok(runState1.getTokenBudget() >= 120000);
      assert.notEqual(runState1.getStatus(), 'ABORTED_TOKEN_BUDGET');
      assert.ok(runState1.getAllSnapshots().length > 0);

      // 测试专属重试入口 POST /api/runs/retry
      const res2 = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          preset: 'CUSTOM',
          title: 'AUDIT-10 Token 预算超限测试 2',
          summary: '低预算触发后调用 /api/runs/retry 恢复',
          requirements: {
            REQ_B3: '验证专属 /api/runs/retry 端点在追加预算后成功恢复执行工作流',
          },
        },
      });
      const data2 = res2.json.data as {
        run: { runId: string; status: string };
        notifications: Array<{ category: string; relatedSnapshotId: string }>;
      };
      assert.equal(data2.run.status, 'ABORTED_TOKEN_BUDGET');
      const budgetNotif2 = data2.notifications.find((n) => n.category === 'TOKEN_BUDGET_EXCEEDED');
      assert.ok(budgetNotif2);

      const retryEndpointRes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/runs/retry',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          runId: data2.run.runId,
          snapshotId: budgetNotif2.relatedSnapshotId,
          extraTokenBudget: 150000,
          comment: '经 /api/runs/retry 扩容并恢复',
        },
      });
      assert.equal(retryEndpointRes.statusCode, 200);
      const runState2 = orchestrator.stateEngine.getRunOrThrow(data2.run.runId);
      assert.ok(runState2.getTokenBudget() >= 150000);
      assert.notEqual(runState2.getStatus(), 'ABORTED_TOKEN_BUDGET');
      assert.ok(runState2.getAllSnapshots().length > 0);
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('3. AUDIT-13：多标签页并发查询/评论/签核严格按 runId（或 snapshotId）隔离，不篡改全局默认运行', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-conc-db-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-conc-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const propA = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      const propB = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: { preset: 'SCOPE_DIFF_ALERT' },
      });

      const runAId = (propA.json.data as { run: { runId: string } }).run.runId;
      const runBId = (propB.json.data as { run: { runId: string } }).run.runId;
      assert.notEqual(runAId, runBId);

      // 标签页 A 查询 ?runId=runAId 与调用 /api/runs/select 不得污染未带 runId 的默认查询（应仍为 runBId）
      const stateARes = await dispatchInProcess(server, {
        method: 'GET',
        url: `/api/state?runId=${encodeURIComponent(runAId)}`,
        headers: { 'x-actor-id': 'user-admin-01' },
      });
      assert.equal((stateARes.json.data as { run: { runId: string } }).run.runId, runAId);

      const selectARes = await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/runs/select',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: { runId: runAId },
      });
      assert.equal((selectARes.json.data as { run: { runId: string } }).run.runId, runAId);

      const defaultStateRes = await dispatchInProcess(server, {
        method: 'GET',
        url: '/api/state',
        headers: { 'x-actor-id': 'user-admin-01' },
      });
      assert.equal(
        (defaultStateRes.json.data as { run: { runId: string } }).run.runId,
        runBId,
        'GET /api/state?runId 与 POST /api/runs/select 不得修改全局 activeRunId',
      );

      // 并发对 runA 与 runB 发表评论与提交裁决（runA 故意只传 snapshotId 验证 snapshot 反查 runId）
      const orchestrator = server.getOrchestrator();
      const snapA = orchestrator.stateEngine
        .getRunOrThrow(runAId)
        .getLatestSnapshotOnActiveBranch();
      const snapB = orchestrator.stateEngine
        .getRunOrThrow(runBId)
        .getLatestSnapshotOnActiveBranch();
      assert.ok(snapA && snapB);

      const [cmtARes, cmtBRes, decARes, decBRes] = await Promise.all([
        dispatchInProcess(server, {
          method: 'POST',
          url: '/api/comments',
          headers: { 'x-actor-id': 'user-pm-01' },
          body: {
            runId: runAId,
            stageId: WorkflowStageId.STAGE_4_QA,
            content: '并发评论-归属-RunA',
          },
        }),
        dispatchInProcess(server, {
          method: 'POST',
          url: '/api/comments',
          headers: { 'x-actor-id': 'user-qa-01' },
          body: {
            runId: runBId,
            stageId: WorkflowStageId.STAGE_4_QA,
            content: '并发评论-归属-RunB',
          },
        }),
        dispatchInProcess(server, {
          method: 'POST',
          url: '/api/decisions',
          headers: { 'x-actor-id': 'user-admin-01' },
          body: {
            snapshotId: snapA.snapshotId,
            verdict: DecisionVerdict.APPROVE,
            comment: '签核-RunA-经snapshotId精确路由',
          },
        }),
        dispatchInProcess(server, {
          method: 'POST',
          url: '/api/decisions',
          headers: { 'x-actor-id': 'user-admin-01' },
          body: {
            runId: runBId,
            snapshotId: snapB.snapshotId,
            verdict: DecisionVerdict.APPROVE,
            comment: '签核-RunB-显式runId路由',
          },
        }),
      ]);

      assert.equal(cmtARes.statusCode, 200);
      assert.equal(cmtBRes.statusCode, 200);
      assert.equal(decARes.statusCode, 200);
      assert.equal(decBRes.statusCode, 200);

      const commentsA = orchestrator.getAllTeamComments().filter((c) => c.runId === runAId);
      const commentsB = orchestrator.getAllTeamComments().filter((c) => c.runId === runBId);
      assert.ok(commentsA.some((c) => c.content.includes('并发评论-归属-RunA')));
      assert.equal(
        commentsA.some((c) => c.content.includes('并发评论-归属-RunB')),
        false,
      );
      assert.ok(commentsB.some((c) => c.content.includes('并发评论-归属-RunB')));
      assert.equal(
        commentsB.some((c) => c.content.includes('并发评论-归属-RunA')),
        false,
      );

      const decisionsA = orchestrator.auditLedger.getHumanDecisions(runAId);
      const decisionsB = orchestrator.auditLedger.getHumanDecisions(runBId);
      assert.ok(decisionsA.some((d) => d.comment === '签核-RunA-经snapshotId精确路由'));
      assert.equal(
        decisionsA.some((d) => d.comment === '签核-RunB-显式runId路由'),
        false,
      );
      assert.ok(decisionsB.some((d) => d.comment === '签核-RunB-显式runId路由'));
      assert.equal(
        decisionsB.some((d) => d.comment === '签核-RunA-经snapshotId精确路由'),
        false,
      );
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('4. AUDIT-13：SSE /api/events/stream?runId=... 按运行隔离实时推送，且支持 Last-Event-ID 断线增量重放', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-sse-db-'));
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit13-sse-sb-'));

    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const orchestrator = server.getOrchestrator();
      const runs = orchestrator.stateEngine.getAllRuns();
      assert.ok(runs.length >= 2, '播种演示场景应包含至少 2 个运行实例');
      const runAId = runs[0].runId;
      const runBId = runs[1].runId;

      const streamA = await openInProcessSseStream(server, {
        url: `/api/events/stream?runId=${encodeURIComponent(runAId)}&actorId=user-admin-01`,
      });
      const streamB = await openInProcessSseStream(server, {
        url: `/api/events/stream?runId=${encodeURIComponent(runBId)}&actorId=user-admin-01`,
      });

      assert.equal(streamA.statusCode, 200);
      assert.equal(streamB.statusCode, 200);
      assert.ok(streamA.chunks.join('').includes(runAId), 'Stream A 首帧应绑定 Run A');
      assert.ok(streamB.chunks.join('').includes(runBId), 'Stream B 首帧应绑定 Run B');

      // 清空首帧缓冲，检验后续按 runId 隔离广播
      streamA.chunks.length = 0;
      streamB.chunks.length = 0;

      await dispatchInProcess(server, {
        method: 'POST',
        url: '/api/comments',
        headers: { 'x-actor-id': 'user-admin-01' },
        body: {
          runId: runAId,
          stageId: WorkflowStageId.STAGE_1_PM,
          content: 'SSE 隔离推送验证事件',
        },
      });

      orchestrator.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: 'EVT-SSE-ISO-1',
          runId: runAId,
          branchId: 'branch-v1-main',
          stageId: WorkflowStageId.STAGE_1_PM,
          agentRole: AgentRole.PRODUCT_MANAGER,
          lifecycleState: SnapshotLifecycleState.EXECUTING,
          headline: 'SSE_ISOLATED_RUN_A_EVENT',
        }),
      );

      const streamAText = streamA.chunks.join('');
      const streamBText = streamB.chunks.join('');
      assert.ok(streamAText.includes('SSE_ISOLATED_RUN_A_EVENT'));
      assert.ok(streamAText.includes('event: state_updated'));
      assert.equal(
        streamBText.length,
        0,
        '订阅 Run B 的 SSE 客户端绝不应收到 Run A 的事件或状态帧',
      );

      // 从 Stream A 提取最新 id，用于断线后 Last-Event-ID 增量重放
      const idMatches = [...streamAText.matchAll(/^id:\s*(\d+)/gm)];
      assert.ok(idMatches.length > 0, 'SSE 帧应包含递增 id 供断线重放');
      const lastSeenId = Number(idMatches[idMatches.length - 1][1]);

      streamA.close();
      streamB.close();

      // 断线期间发生：2 条 Run A 事件 + 1 条 Run B 事件
      orchestrator.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: 'EVT-REPLAY-A1',
          runId: runAId,
          branchId: 'branch-v1-main',
          stageId: WorkflowStageId.STAGE_2_PD,
          agentRole: AgentRole.PRODUCT_DESIGNER,
          lifecycleState: SnapshotLifecycleState.EXECUTING,
          headline: 'REPLAY_MISSED_A_1',
        }),
      );
      orchestrator.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: 'EVT-REPLAY-B1',
          runId: runBId,
          branchId: 'branch-v1-main',
          stageId: WorkflowStageId.STAGE_2_PD,
          agentRole: AgentRole.PRODUCT_DESIGNER,
          lifecycleState: SnapshotLifecycleState.EXECUTING,
          headline: 'REPLAY_SHOULD_NOT_LEAK_B',
        }),
      );
      orchestrator.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: 'EVT-REPLAY-A2',
          runId: runAId,
          branchId: 'branch-v1-main',
          stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
          agentRole: AgentRole.TECH_LEAD,
          lifecycleState: SnapshotLifecycleState.EXECUTING,
          headline: 'REPLAY_MISSED_A_2',
        }),
      );

      // 携带 Last-Event-ID 重连 Run A 的 SSE 流
      const replayedStream = await openInProcessSseStream(server, {
        url: `/api/events/stream?runId=${encodeURIComponent(runAId)}&actorId=user-admin-01`,
        headers: { 'last-event-id': String(lastSeenId) },
      });
      const replayText = replayedStream.chunks.join('');
      replayedStream.close();

      assert.ok(replayText.includes('event: state_updated'), '重连应推送首帧 state_updated');
      const firstBoundary = replayText.indexOf('\n\n');
      assert.ok(firstBoundary > 0, '应存在首帧结束边界');
      const replayedFramesOnly = replayText.slice(firstBoundary + 2);
      assert.ok(
        replayedFramesOnly.includes('REPLAY_MISSED_A_1'),
        '应重放断线后的第 1 条 Run A 事件',
      );
      assert.ok(
        replayedFramesOnly.includes('REPLAY_MISSED_A_2'),
        '应重放断线后的第 2 条 Run A 事件',
      );
      assert.equal(
        replayedFramesOnly.includes('SSE_ISOLATED_RUN_A_EVENT'),
        false,
        'id <= Last-Event-ID 的已接收事件不应重复重放',
      );
      assert.equal(
        replayText.includes('REPLAY_SHOULD_NOT_LEAK_B'),
        false,
        'Run A 重放不得泄漏断线期间的 Run B 事件',
      );
    } finally {
      fs.rmSync(persistDir, { recursive: true, force: true });
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});
