/**
 * @file a4-intent-and-baseline.spec.ts
 * @description A4 测试：①LLM 主输出顺带 __intent 捕获与跨执行复用（规则兜底回归）；
 *              ②POST /api/admin/model-baseline 体检端点（离线零调用 / 在线 2 层级 × 3 任务 / 未认证 403）。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';

const PM_JSON_WITH_INTENT = JSON.stringify({
  summary: '已完成 PRD 拆解（A4 意图测试）',
  coreRequirementIds: ['R1', 'R2'],
  userStories: [
    { reqId: 'R1', story: '故事 R1', acceptanceCriteria: ['AC1', 'AC2'] },
    { reqId: 'R2', story: '故事 R2', acceptanceCriteria: ['AC1'] },
  ],
  trackingPlanEvents: [
    { eventName: 'evt_r1', triggerCondition: '触发 R1', properties: ['run_id'] },
    { eventName: 'evt_r2', triggerCondition: '触发 R2', properties: ['run_id'] },
  ],
  nonFunctionalConstraints: ['响应 < 200ms', '审计全覆盖'],
  __intent: {
    intentCode: 'PRD_LLM_INTENT_E2E',
    intentDescription: 'LLM 识别的 PRD 拆解意图',
    confidenceScore: 0.98,
  },
});

const PM_JSON_BAD_INTENT = JSON.stringify({
  summary: '已完成 PRD 拆解（非法 __intent）',
  coreRequirementIds: ['R1'],
  userStories: [{ reqId: 'R1', story: '故事 R1', acceptanceCriteria: ['AC1'] }],
  trackingPlanEvents: [{ eventName: 'e', triggerCondition: 't', properties: ['p'] }],
  nonFunctionalConstraints: ['c1'],
  __intent: { intentCode: '   ' },
});

function makeResponse(content: string): OpenAiCompatibleChatResponse {
  return {
    id: 'chatcmpl-a4',
    model: 'mock-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
  };
}

describe('A4 — LLM 意图识别（__intent 随主调用返回）', () => {
  let orchestrator: WorkflowOrchestratorFacade | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    if (orchestrator) {
      orchestrator.modelRouter.setHttpTransport(null);
      orchestrator = null;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function saveEnv(keys: string[]): void {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
    }
  }

  it('1. 主调用顺带返回 __intent → 捕获缓存；下一个 run 复用 LLM 意图（无单独 LLM 往返）', async () => {
    saveEnv(['LITELLM_ENABLE_LIVE_HTTP']);
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });

    const stageCalls: string[] = [];
    orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
      const systemPrompt = payload.messages?.[0]?.content ?? '';
      if (systemPrompt.includes('PM Agent')) {
        stageCalls.push(systemPrompt);
        return makeResponse(PM_JSON_WITH_INTENT);
      }
      return makeResponse(PM_JSON_WITH_INTENT);
    });

    // run 1：意图识别发生在 LLM 调用之前 → 走规则意图；LLM 返回后捕获 __intent
    const run1 = await orchestrator.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'A4-RUN-1',
        title: 'A4 意图测试项目一',
        summary: '首次执行，规则意图 + LLM 捕获',
        requirements: { R1: '需求一', R2: '需求二' },
      }),
      initiatorActor: '测试员',
    });
    const run1PmTrace = orchestrator.fulfillmentTracker
      .getTraces(run1.runId)
      .find((t) => t.stageId === WorkflowStageId.STAGE_1_PM);
    assert.ok(run1PmTrace);
    assert.equal(
      run1PmTrace.recognizedIntentCode,
      'PRD_SYNTHESIS_AND_TRACKING_PLAN_2_REQS',
      '首个 run 在 LLM 调用前只能用规则意图（同步签名约束）',
    );

    // run 2：复用 run 1 捕获的 LLM 意图（缓存键依赖同步读取，无额外 LLM 往返）
    const run2 = await orchestrator.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'A4-RUN-2',
        title: 'A4 意图测试项目二（不同标题避免 L1 命中）',
        summary: '第二次执行，应复用上次 LLM 意图',
        requirements: { R1: '需求一', R2: '需求二' },
      }),
      initiatorActor: '测试员',
    });
    const run2PmTraces = orchestrator.fulfillmentTracker
      .getTraces(run2.runId)
      .filter((t) => t.stageId === WorkflowStageId.STAGE_1_PM);
    assert.ok(run2PmTraces.length > 0);
    assert.equal(
      run2PmTraces[0].recognizedIntentCode,
      'PRD_LLM_INTENT_E2E',
      '第二个 run 应复用上次同阶段 LLM 顺带输出的意图',
    );
    void stageCalls;
  });

  it('2. __intent 非法（空 intentCode）→ 静默忽略，回落规则意图', async () => {
    saveEnv(['LITELLM_ENABLE_LIVE_HTTP']);
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    orchestrator.modelRouter.setHttpTransport(async () => makeResponse(PM_JSON_BAD_INTENT));

    const run = await orchestrator.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'A4-RUN-BAD',
        title: 'A4 非法意图测试项目',
        summary: '空 intentCode 必须回落规则',
        requirements: { R1: '需求一' },
      }),
      initiatorActor: '测试员',
    });
    const pmTrace = orchestrator.fulfillmentTracker
      .getTraces(run.runId)
      .find((t) => t.stageId === WorkflowStageId.STAGE_1_PM);
    assert.ok(pmTrace);
    assert.equal(
      pmTrace.recognizedIntentCode,
      'PRD_SYNTHESIS_AND_TRACKING_PLAN_1_REQS',
      '非法 __intent 不应污染意图缓存',
    );
  });
});

describe('A4 — POST /api/admin/model-baseline 体检端点', () => {
  let workbench: WorkbenchHttpServer | null = null;
  let activeServer: import('node:http').Server | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
      activeServer = null;
      workbench = null;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function saveEnv(keys: string[]): void {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
    }
  }

  async function startServer(): Promise<string> {
    const tempPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-a4-persist-'));
    workbench = new WorkbenchHttpServer(0, { persistenceDir: tempPersistDir });
    const server = await workbench.start();
    activeServer = server;
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    return `http://127.0.0.1:${addr.port}`;
  }

  it('3. 离线（未启用 live HTTP）→ offline:true 零网络调用', async () => {
    saveEnv(['AUTH_DISABLED', 'LITELLM_ENABLE_LIVE_HTTP']);
    process.env.AUTH_DISABLED = 'true';
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    const baseUrl = await startServer();

    const res = await fetch(`${baseUrl}/api/admin/model-baseline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-admin-01' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { offline: boolean; reports: unknown[] };
    };
    assert.equal(json.ok, true);
    assert.equal(json.data.offline, true);
    assert.equal(json.data.reports.length, 0);
  });

  it('4. 在线 → 两级端点 × 3 任务 = 6 份报告（含 taskName 与建议）', async () => {
    saveEnv(['AUTH_DISABLED', 'LITELLM_ENABLE_LIVE_HTTP']);
    process.env.AUTH_DISABLED = 'true';
    process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
    const baseUrl = await startServer();

    // 直接向 orchestrator 注入 mock transport（服务器内部网关与 Facade 同实例）
    assert.ok(workbench);
    const facade = workbench.getOrchestrator();
    facade.modelRouter.setHttpTransport(async (_url, payload) => {
      void payload;
      // 一个包含全部体检任务必填键的合规 JSON
      return makeResponse(
        JSON.stringify({
          summary: '基线体检样例',
          count: 3,
          total: 2,
          items: [{ id: 'a1' }],
          status: 'PASS',
          detail: '基线体检',
        }),
      );
    });

    const res = await fetch(`${baseUrl}/api/admin/model-baseline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-admin-01' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        offline: boolean;
        reports: Array<{ tier: string; taskName?: string; jsonSchemaAdherencePassed: boolean }>;
      };
    };
    assert.equal(json.ok, true);
    assert.equal(json.data.offline, false);
    assert.equal(json.data.reports.length, 6, '2 个层级 × 3 个体检任务');
    assert.ok(json.data.reports.every((r) => r.jsonSchemaAdherencePassed));
    assert.ok(json.data.reports.every((r) => typeof r.taskName === 'string'));
  });

  it('5. 未认证（无会话 Cookie）→ 403', async () => {
    saveEnv(['AUTH_DISABLED', 'LITELLM_ENABLE_LIVE_HTTP']);
    delete process.env.AUTH_DISABLED;
    delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    const baseUrl = await startServer();

    const res = await fetch(`${baseUrl}/api/admin/model-baseline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
  });
});
