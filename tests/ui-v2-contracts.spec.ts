/**
 * @file ui-v2-contracts.spec.ts
 * @description P2-2 & UI_SYSTEM_DESIGN_MAP §14 (G1–G6 + 视角状态机 + 防编造与 7 视图 Kit 接入回归)。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { ArtifactContractFactory } from '../src/agents/deserialize/ArtifactContractFactory.ts';
import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict, SnapshotLifecycleState, WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';
import { WorkbenchApiClient } from '../src/ui/client/WorkbenchApiClient.ts';
import { parseStageArtifact } from '../src/ui/client/lib/artifactParsers.ts';
import { derivePerspective } from '../src/ui/client/lib/perspective.ts';
import type { RbacContextDto } from '../src/ui/client/types.ts';

async function dispatchInProcessHttp(
  server: WorkbenchHttpServer,
  method: string,
  url: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const reqStream = new Readable({ read() {} });
  if (body !== undefined) {
    reqStream.push(JSON.stringify(body));
  }
  reqStream.push(null);

  const req = reqStream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' } });

  const chunks: Buffer[] = [];
  let statusCode = 200;

  const res = {
    writeHead(code: number): ServerResponse {
      statusCode = code;
      return this as unknown as ServerResponse;
    },
    end(chunk?: string | Buffer): void {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
      }
    },
  } as unknown as ServerResponse;

  await server.handleHttpRequest(req, res);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return {
    status: statusCode,
    json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

describe('P2-2 & §14 Backend G1-G4/G6 + UI v2 契约与 Meridian Kit 接入校验', () => {
  it('1. G1 & G6：全流程产出含 agentRationale/keyDecisions，快照附带 structuredSummary，且 Factory 保留 LLM 决策字段', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p22-g1g6-'));
    try {
      const facade = new WorkflowOrchestratorFacade({
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sb'),
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-G1-G6',
        title: 'G1/G6 结构化自述与关键权衡测试',
        summary: '验证所有阶段均产出真实自述、关键决策与结构化摘要',
        requirements: { REQ_CORE: '实现可审阅的多智能体阶段摘要' },
        involvesDatabaseMigration: true,
      });

      const runState = await facade.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工',
        initiatorUserId: 'user-pm-01',
      });

      const dashboard = facade.buildWorkbenchDashboardState(runState.runId, 'user-admin-01') as {
        run: {
          snapshots: Array<{
            stageId: string;
            artifactSummary: string;
            structuredSummary?: {
              headline: string;
              rationale: string;
              caveats: string[];
            };
            artifactDetails: {
              agentRationale?: string;
              keyDecisions?: Array<{ decision: string; rationale: string; tradeoffs: string[] }>;
            };
          }>;
        };
      };

      assert.ok(dashboard.run.snapshots.length >= 3);
      for (const snap of dashboard.run.snapshots) {
        assert.ok(snap.artifactSummary.length > 0);
        assert.ok(snap.structuredSummary, `${snap.stageId} 应包含 structuredSummary`);
        assert.equal(snap.structuredSummary.headline, snap.artifactSummary);
        assert.ok(snap.structuredSummary.rationale.length > 0);
        assert.ok(Array.isArray(snap.structuredSummary.caveats));
        assert.ok(snap.artifactDetails.agentRationale, `${snap.stageId} 应填充 agentRationale`);
        assert.ok(
          (snap.artifactDetails.keyDecisions?.length ?? 0) >= 1,
          `${snap.stageId} 应至少包含 1 条 keyDecisions`,
        );
      }

      // Factory 保留 LLM 返回的 agentRationale 与 keyDecisions
      const parsed = ArtifactContractFactory.parse(WorkflowStageId.STAGE_1_PM, {
        summary: 'LLM PRD Summary',
        coreRequirementIds: ['R1'],
        userStories: [{ reqId: 'R1', story: 'User Story', acceptanceCriteria: ['<200ms'] }],
        trackingPlanEvents: [
          { eventName: 'evt_r1', triggerCondition: 'click', properties: ['run_id'] },
        ],
        nonFunctionalConstraints: ['内网私有化'],
        agentRationale: '优先采用异步事件流以防止阻塞主请求',
        keyDecisions: [
          {
            decision: '解耦事件队列',
            rationale: '降低数据库写锁争用',
            tradeoffs: ['最终一致性', '吞吐提升 3x'],
          },
        ],
      });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.artifact?.agentRationale, '优先采用异步事件流以防止阻塞主请求');
      assert.equal(parsed.artifact?.keyDecisions?.length, 1);
      assert.equal(parsed.artifact?.keyDecisions?.[0]?.decision, '解耦事件队列');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. G2：挂起 PENDING_HUMAN_GATE / 自动放行 AUTO_APPROVED_LOW_RISK / 签核 APPROVED / 驳回 REJECTED 均附带完整 detailPayload', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p22-g2-'));
    try {
      const facade = new WorkflowOrchestratorFacade({
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sb'),
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-G2',
        title: 'G2 门禁事件详情 payload 验证',
        summary: '验证门禁挂起、自动放行、人工通过与驳回事件携带机器可读字段',
        requirements: { REQ_GATE: '带 DDL 的门禁与自动放行事件透传' },
        involvesDatabaseMigration: true,
        involvesPermissionOrPayment: true,
      });

      const runState = await facade.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工',
        initiatorUserId: 'user-pm-01',
      });

      const pendingSnap = runState
        .getAllSnapshots()
        .find((s) => s.getState() === SnapshotLifecycleState.PENDING_HUMAN_GATE);
      assert.ok(pendingSnap, '高风险 DDL 应在 Stage 3a 触发 PENDING_HUMAN_GATE');

      const eventsBefore = facade.eventBus.getEventHistory(runState.runId);
      const autoEv = eventsBefore.find(
        (e) => e.lifecycleState === SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK,
      );
      const pendingEv = eventsBefore.find(
        (e) => e.lifecycleState === SnapshotLifecycleState.PENDING_HUMAN_GATE,
      );
      assert.ok(autoEv, '应发布 AUTO_APPROVED_LOW_RISK 事件');
      assert.ok(pendingEv, '应发布 PENDING_HUMAN_GATE 事件');
      for (const ev of [autoEv, pendingEv]) {
        assert.ok(typeof ev.detailPayload.snapshotId === 'string');
        assert.ok(typeof ev.detailPayload.riskScore === 'number');
        assert.ok(typeof ev.detailPayload.riskLevel === 'string');
        assert.ok(typeof ev.detailPayload.gateAction === 'string');
        assert.ok(Array.isArray(ev.detailPayload.droppedRequirementIds));
      }

      // 人工审批通过
      await facade.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: pendingSnap.snapshotId,
        reviewerActor: '架构师',
        actorUserId: 'user-admin-01',
        verdict: DecisionVerdict.APPROVE,
        comment: 'G2 审批通过',
      });

      const afterApprove = facade.eventBus
        .getEventHistory(runState.runId)
        .find(
          (e) =>
            e.lifecycleState === SnapshotLifecycleState.APPROVED &&
            e.detailPayload.snapshotId === pendingSnap.snapshotId,
        );
      assert.ok(afterApprove, '审批通过应广播带 detailPayload 的 APPROVED 事件');
      assert.equal(afterApprove.detailPayload.verdict, DecisionVerdict.APPROVE);

      // 接着对 Stage 4 人工门禁执行 REJECT，验证 REJECTED 事件携带 detailPayload
      const qaPending = runState
        .getAllSnapshots()
        .find((s) => s.getState() === SnapshotLifecycleState.PENDING_HUMAN_GATE);
      assert.ok(qaPending, '应推进到 QA 待人工确认');
      await facade.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: qaPending.snapshotId,
        reviewerActor: 'QA',
        actorUserId: 'user-admin-01',
        verdict: DecisionVerdict.REJECT,
        comment: 'G2 驳回补充边界测试',
      });

      const afterReject = facade.eventBus
        .getEventHistory(runState.runId)
        .find(
          (e) =>
            e.lifecycleState === SnapshotLifecycleState.REJECTED &&
            e.detailPayload.snapshotId === qaPending.snapshotId,
        );
      assert.ok(afterReject, '驳回操作应广播带 detailPayload 的 REJECTED 事件');
      assert.equal(afterReject.detailPayload.verdict, DecisionVerdict.REJECT);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. G3：GET /api/events/history 与 WorkbenchApiClient.fetchEventHistory 支持 stageId/时间筛选与分页', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p22-g3-'));
    const prevAuthReq = process.env.AUTH_REQUIRED;
    try {
      process.env.AUTH_REQUIRED = 'false';
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sb'),
      });
      await server.waitUntilReady();

      const stateRes = await dispatchInProcessHttp(server, 'GET', '/api/state', undefined, {
        'x-actor-id': 'user-admin-01',
      });
      assert.equal(stateRes.status, 200);
      const stateData = stateRes.json.data as {
        run: { runId: string };
        liveInteractionStreamTotal?: number;
      };
      const runId = stateData.run.runId;
      assert.ok((stateData.liveInteractionStreamTotal ?? 0) > 0, 'Dashboard 应返回事件总数');

      const page1 = await dispatchInProcessHttp(
        server,
        'GET',
        `/api/events/history?runId=${encodeURIComponent(runId)}&offset=0&limit=3`,
        undefined,
        { 'x-actor-id': 'user-admin-01' },
      );
      assert.equal(page1.status, 200);
      const p1Data = page1.json.data as {
        total: number;
        offset: number;
        limit: number;
        events: Array<{ stageId: string; eventId: string }>;
      };
      assert.equal(p1Data.limit, 3);
      assert.equal(p1Data.events.length, Math.min(3, p1Data.total));

      const stageFiltered = await dispatchInProcessHttp(
        server,
        'GET',
        `/api/events/history?runId=${encodeURIComponent(runId)}&stageId=STAGE_1_PM`,
        undefined,
        { 'x-actor-id': 'user-admin-01' },
      );
      assert.equal(stageFiltered.status, 200);
      const sfData = stageFiltered.json.data as { events: Array<{ stageId: string }> };
      assert.ok(sfData.events.length > 0);
      assert.ok(sfData.events.every((e) => e.stageId === 'STAGE_1_PM'));

      // future `since` should yield 0 events cleanly
      const futureRes = await dispatchInProcessHttp(
        server,
        'GET',
        `/api/events/history?runId=${encodeURIComponent(runId)}&since=${encodeURIComponent('2099-01-01T00:00:00.000Z')}`,
        undefined,
        { 'x-actor-id': 'user-admin-01' },
      );
      assert.equal(futureRes.status, 200);
      assert.equal((futureRes.json.data as { events: unknown[] }).events.length, 0);

      // Verify WorkbenchApiClient.fetchEventHistory wrapper cleanly against mocked fetch
      const client = new WorkbenchApiClient({ baseUrl: 'http://unit.local' });
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        const pathWithQuery = new URL(urlStr).pathname + new URL(urlStr).search;
        const r = await dispatchInProcessHttp(server, 'GET', pathWithQuery, undefined, {
          'x-actor-id': 'user-admin-01',
        });
        return new Response(JSON.stringify(r.json), { status: r.status });
      }) as typeof fetch;
      try {
        const clientPage = await client.fetchEventHistory({
          runId,
          stageId: 'STAGE_1_PM',
          offset: 0,
          limit: 5,
        });
        assert.ok(clientPage.events.every((e) => e.stageId === 'STAGE_1_PM'));
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      if (prevAuthReq === undefined) {
        delete process.env.AUTH_REQUIRED;
      } else {
        process.env.AUTH_REQUIRED = prevAuthReq;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. G4：启用 enableExtendedPeerNegotiation 后，步骤 1 (PM↔DA) 与步骤 3a (TechLead↔Engineer) 产生真实协商记录', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p22-g4-'));
    try {
      const facade = new WorkflowOrchestratorFacade({
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sb'),
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'PROP-G4',
        title: 'G4 扩展步骤 1 与步骤 3a 协商',
        summary: '验证 PM↔DA 与 TechLead↔Engineer 真实协商日志',
        requirements: { REQ_PEER: '全阶段跨角色协同校验' },
        involvesDatabaseMigration: false,
        involvesPermissionOrPayment: false,
      });

      const runState = await facade.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工',
        initiatorUserId: 'user-pm-01',
        scenarioHints: { enableExtendedPeerNegotiation: true },
      });

      const logs = facade.negotiationMediator.getNegotiationHistory(runState.runId);
      assert.ok(
        logs.some((l) => l.topic === 'PRD_TRACKING_ALIGNMENT'),
        'Stage 1 应产出 PRD_TRACKING_ALIGNMENT 协商记录',
      );
      assert.ok(
        logs.some((l) => l.topic === 'TECH_SPEC_REVIEW'),
        'Stage 3a 应产出 TECH_SPEC_REVIEW 协商记录',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. G5 & §12：artifactParsers 兼容全部 6 类交付物 + 缺字段降级，且 perspective 正确区分 L3 管理员与 L2/L1 专家', () => {
    const daParsed = parseStageArtifact('DATA_ANALYSIS_ARTIFACT_CONTRACT', {
      summary: 'DA OK',
      coreRequirementIds: ['R1'],
      verifiedTrackingEvents: ['evt_1', 'evt_2'],
      projectedMetrics: [{ metricName: '交付周期', baselineValue: '14d', targetValue: '4d' }],
      agentRationale: '指标可闭环归因',
      keyDecisions: [
        { decision: '锁定核心漏斗', rationale: '减少埋点噪音', tradeoffs: ['+1字段'] },
      ],
    });
    assert.equal(daParsed.kind, 'DATA_ANALYSIS');
    assert.equal(daParsed.missingFields.length, 0);
    assert.equal(daParsed.agentRationale, '指标可闭环归因');

    const incompletePrd = parseStageArtifact('PRD_ARTIFACT_CONTRACT', {
      summary: '缺字段 PRD',
      coreRequirementIds: ['R1'],
    });
    assert.equal(incompletePrd.kind, 'PRD');
    assert.ok(incompletePrd.missingFields.includes('userStories'));
    assert.ok(incompletePrd.missingFields.includes('trackingPlanEvents'));

    const generic = parseStageArtifact('CUSTOM_UNKNOWN_CONTRACT', {
      summary: 'Custom payload',
      foo: 'bar',
    });
    assert.equal(generic.kind, 'GENERIC');

    const pmRbac: RbacContextDto = {
      currentUser: {
        userId: 'user-pm-01',
        displayName: '陈工 (PM)',
        jobTitle: '产品经理',
        department: '产研部',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'PRODUCT_MANAGEMENT',
        counterpartAgentRole: 'PM_AGENT',
        ownedStageIds: ['STAGE_1_PM'],
        permissions: ['VIEW_SHARED_WORKFLOW', 'APPROVE_ASSIGNED_STAGE_GATE'],
        avatarBadge: 'PM',
        isProjectAdmin: false,
      },
      roster: [],
      stageAccessMatrix: {
        STAGE_1_PM: {
          stageId: 'STAGE_1_PM',
          canViewSharedArtifact: true,
          canApproveOrArbitrate: true,
          isDirectDomainOwner: true,
          isAdminOverride: false,
          requiredSpecialistRoles: ['PM_AGENT'],
          denialReason: null,
        },
        STAGE_3A_TECH_SPEC: {
          stageId: 'STAGE_3A_TECH_SPEC',
          canViewSharedArtifact: true,
          canApproveOrArbitrate: false,
          isDirectDomainOwner: false,
          isAdminOverride: false,
          requiredSpecialistRoles: ['TECH_LEAD_AGENT'],
          denialReason: '仅技术负责人可签核架构门禁',
        },
      },
      allowSpecialistCrossStageRollback: true,
    };

    const specialistPerspective = derivePerspective(pmRbac);
    assert.equal(specialistPerspective.level, 'L2_L1');
    assert.equal(specialistPerspective.getStageDensity('STAGE_1_PM'), 'L2');
    assert.equal(specialistPerspective.getStageDensity('STAGE_3A_TECH_SPEC'), 'L1');
    assert.equal(specialistPerspective.canApproveStage('STAGE_1_PM'), true);
    assert.equal(specialistPerspective.canApproveStage('STAGE_3A_TECH_SPEC'), false);
    assert.equal(
      specialistPerspective.getDenialReason('STAGE_3A_TECH_SPEC'),
      '仅技术负责人可签核架构门禁',
    );

    const adminPerspective = derivePerspective({
      ...pmRbac,
      currentUser: { ...pmRbac.currentUser, tier: 'PROJECT_ADMIN', isProjectAdmin: true },
    });
    assert.equal(adminPerspective.level, 'L3');
    assert.equal(adminPerspective.getStageDensity('STAGE_3A_TECH_SPEC'), 'L2');
  });

  it('6. P2-2 防编造与 Meridian UI Kit 全视图接入静态审计', () => {
    const stageContentPath = path.resolve(process.cwd(), 'src/ui/client/lib/stageContent.tsx');
    const stageContentSrc = fs.readFileSync(stageContentPath, 'utf-8');
    assert.ok(!stageContentSrc.includes('ACTIONS_BY_STAGE'), '不得保留硬编码 ACTIONS_BY_STAGE');
    assert.ok(!stageContentSrc.includes('STAGE_DISCUSSIONS'), '不得保留硬编码 STAGE_DISCUSSIONS');

    const businessViews = [
      'ProjectsHubView.tsx',
      'WorkspaceView.tsx',
      'GateCenterView.tsx',
      'DagSupervisorView.tsx',
      'SandboxExplorerView.tsx',
      'AuditRagView.tsx',
      'AdminGovernanceView.tsx',
    ];
    for (const fileName of businessViews) {
      const fullPath = path.resolve(process.cwd(), 'src/ui/client/views', fileName);
      const src = fs.readFileSync(fullPath, 'utf-8');
      assert.ok(
        src.includes("from '../../kit/index.ts'"),
        `${fileName} 必须实际接入 Meridian UI Kit (../../kit/index.ts)`,
      );
    }

    const cssPath = path.resolve(process.cwd(), 'src/ui/styles/workbench.css');
    const cssSrc = fs.readFileSync(cssPath, 'utf-8');
    assert.ok(cssSrc.includes('.app-sidebar') && cssSrc.includes('position: static'));
    assert.ok(cssSrc.includes('.gate-center-split') && cssSrc.includes('.review-panel-grid'));
  });
});
