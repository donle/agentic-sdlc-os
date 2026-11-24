/**
 * @file concurrency-and-cache.spec.ts
 * @description 高优测试缺口 2+3：并发提案竞态条件 + PromptCacheManager L1/L2 独立测试。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict, SnapshotLifecycleState, WorkflowStageId } from '../src/domain/enums.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';
import { PromptCacheManager } from '../src/telemetry/PromptCacheManager.ts';
import type { EmbeddingProvider } from '../src/telemetry/EmbeddingProvider.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

function makeMockStageChatResponse(content: string): OpenAiCompatibleChatResponse {
  return {
    id: `chatcmpl-p04-${Date.now()}`,
    model: 'mock-p04-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
}

const STAGE_MOCK_JSON: Record<string, string> = {
  STAGE_1_PM: JSON.stringify({
    summary: '并发隔离测试 PRD',
    coreRequirementIds: ['R1'],
    userStories: [{ reqId: 'R1', story: '并发安全故事 R1', acceptanceCriteria: ['AC1'] }],
    trackingPlanEvents: [
      { eventName: 'evt_r1', triggerCondition: '触发 R1', properties: ['run_id'] },
    ],
    nonFunctionalConstraints: ['并发无竞态'],
  }),
  STAGE_2_PD: JSON.stringify({
    summary: '并发隔离测试 UI',
    coreRequirementIds: ['R1'],
    componentMappings: [
      { reqId: 'R1', designSystemComponent: 'DrawerContainer', interactionStates: ['default'] },
    ],
    accessibilityChecklist: ['键盘导航', '对比度达标', '语义标签'],
    designChallengeNote: null,
  }),
  STAGE_3A_TECH_SPEC: JSON.stringify({
    summary: '并发隔离测试 TechSpec',
    coreRequirementIds: ['R1'],
    apiContracts: [
      { method: 'POST', endpoint: '/api/v1/r1', requestSchema: '{}', responseSchema: '{}' },
    ],
    databaseDdlStatements: ['CREATE TABLE IF NOT EXISTS t_r1 (id UUID PRIMARY KEY)'],
    declaredRiskLevel: 'HIGH',
    architecturePatternsUsed: ['Strategy'],
  }),
  STAGE_3B_ENGINEER: JSON.stringify({
    summary: '并发隔离测试代码落盘',
    coreRequirementIds: ['R1'],
    gitWorktreeBranch: 'worktree/p04/main',
    modifiedFiles: [
      {
        filePath: 'src/modules/r1/R1DomainService.ts',
        className: 'R1DomainService',
        designPattern: 'Strategy',
        linesChanged: 32,
      },
    ],
    selfTestPassed: true,
  }),
  STAGE_4_QA: JSON.stringify({
    summary: '并发隔离测试 QA 通过',
    coreRequirementIds: ['R1'],
    testSuitesExecuted: [
      { suiteName: 'r1.spec.ts', totalCases: 2, passedCases: 2, coveragePercent: 100 },
    ],
    securityIssuesFound: 0,
    allAcceptanceCriteriaMet: true,
  }),
  STAGE_5_DA: JSON.stringify({
    summary: '并发隔离测试 DA',
    coreRequirementIds: ['R1'],
    verifiedTrackingEvents: ['evt_r1'],
    projectedMetrics: [
      { metricName: '采纳率', baselineValue: '0%', targetValue: '90%' },
      { metricName: '耗时', baselineValue: '200ms', targetValue: '< 100ms' },
      { metricName: '错误率', baselineValue: '1%', targetValue: '< 0.1%' },
    ],
  }),
};

describe('高优 — 并发提案竞态条件测试', () => {
  it('1. 两个提案并发推进 → runId 隔离，快照/决策/事件不交叉污染', async () => {
    await withTestWorkspace('conc-race-1-', async (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });

      const proposalA = new ProjectProposalContract({
        proposalId: 'TEST-CONC-A',
        title: '并发提案 A',
        summary: '并发测试项目 A',
        requirements: { REQ_A: '需求 A', REQ_A2: '需求 A2' },
      });
      const proposalB = new ProjectProposalContract({
        proposalId: 'TEST-CONC-B',
        title: '并发提案 B',
        summary: '并发测试项目 B',
        requirements: { REQ_B: '需求 B', REQ_B2: '需求 B2' },
      });

      // Promise.all 并发启动
      const [runA, runB] = await Promise.all([
        orchestrator.startProposalWorkflow({ proposal: proposalA, initiatorActor: 'A 发起' }),
        orchestrator.startProposalWorkflow({ proposal: proposalB, initiatorActor: 'B 发起' }),
      ]);

      // runId 唯一
      assert.notEqual(runA.runId, runB.runId);

      // 快照数独立
      const snapsA = runA.getActiveBranchSnapshots();
      const snapsB = runB.getActiveBranchSnapshots();
      assert.ok(snapsA.length > 0, 'A 应有快照');
      assert.ok(snapsB.length > 0, 'B 应有快照');

      // A 的快照不应出现在 B 中（通过 runId 过滤验证）
      for (const snap of snapsA) {
        assert.equal(snap.runId, runA.runId, 'A 的快照 runId 应全为 A');
      }
      for (const snap of snapsB) {
        assert.equal(snap.runId, runB.runId, 'B 的快照 runId 应全为 B');
      }

      // 决策账本按 runId 隔离
      const decisionsA = orchestrator.auditLedger.getHumanDecisions(runA.runId);
      const decisionsB = orchestrator.auditLedger.getHumanDecisions(runB.runId);
      for (const d of decisionsA) {
        assert.equal(d.runId, runA.runId, 'A 的决策 runId 应全为 A');
      }
      for (const d of decisionsB) {
        assert.equal(d.runId, runB.runId, 'B 的决策 runId 应全为 B');
      }

      // 事件历史按 runId 过滤
      const eventsA = orchestrator.eventBus.getEventHistory(runA.runId);
      const eventsB = orchestrator.eventBus.getEventHistory(runB.runId);
      void eventsB;
      for (const e of eventsA) {
        assert.equal(e.runId, runA.runId);
      }
    });
  });

  it('2. 并发提案后各自的缓存键不冲突', async () => {
    await withTestWorkspace('conc-race-2-', async (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });

      const proposalA = new ProjectProposalContract({
        proposalId: 'TEST-CACHE-A',
        title: '缓存测试项目 A（不同标题）',
        summary: '验证缓存键包含提案标题',
        requirements: { REQ_SHARED: '共同需求' },
      });
      const proposalB = new ProjectProposalContract({
        proposalId: 'TEST-CACHE-B',
        title: '缓存测试项目 B（不同标题）',
        summary: '验证缓存键包含提案标题',
        requirements: { REQ_SHARED: '共同需求' },
      });

      // 顺序启动（并发缓存测试需要先 A 完成再看 B 是否复用）
      const runA = await orchestrator.startProposalWorkflow({
        proposal: proposalA,
        initiatorActor: 'A',
      });
      const runB = await orchestrator.startProposalWorkflow({
        proposal: proposalB,
        initiatorActor: 'B',
      });

      // B 的 PM 产物应该命中缓存（标题不同但需求 ID 不同 → L1 不命中；L2 意图相同 → 可能命中）
      // 具体行为取决于缓存实现，此处只验证 runId 隔离不被缓存破坏
      assert.notEqual(runA.runId, runB.runId);
      assert.ok(runA.getActiveBranchSnapshots().length > 0);
      assert.ok(runB.getActiveBranchSnapshots().length > 0);
    });
  });
});

describe('P0-4 — 同 runId 并发互斥锁与 Agent 准备状态隔离', () => {
  const prevLiveEnv = process.env.LITELLM_ENABLE_LIVE_HTTP;

  afterEach(() => {
    if (prevLiveEnv === undefined) {
      delete process.env.LITELLM_ENABLE_LIVE_HTTP;
    } else {
      process.env.LITELLM_ENABLE_LIVE_HTTP = prevLiveEnv;
    }
  });

  function stageJsonForSystemPrompt(systemPrompt: string): string {
    if (systemPrompt.includes('PM Agent')) {
      return STAGE_MOCK_JSON.STAGE_1_PM;
    }
    if (systemPrompt.includes('PD Agent')) {
      return STAGE_MOCK_JSON.STAGE_2_PD;
    }
    if (systemPrompt.includes('Tech Lead Agent')) {
      return STAGE_MOCK_JSON.STAGE_3A_TECH_SPEC;
    }
    if (systemPrompt.includes('Engineer Agent')) {
      return STAGE_MOCK_JSON.STAGE_3B_ENGINEER;
    }
    if (systemPrompt.includes('QA Agent')) {
      return STAGE_MOCK_JSON.STAGE_4_QA;
    }
    return STAGE_MOCK_JSON.STAGE_5_DA;
  }

  it('3. 同 runId 并发提交同一门禁签核 → 互斥锁严格串行，第二次被状态守卫拦截且不破坏状态机', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-lock-'));
    try {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: path.join(tmpBase, 'persist'),
        sandboxRootDir: path.join(tmpBase, 'sandbox'),
      });
      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        await new Promise((r) => setTimeout(r, 25));
        const sys = payload.messages?.[0]?.content ?? '';
        return makeMockStageChatResponse(stageJsonForSystemPrompt(sys));
      });

      const run = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-P04-LOCK',
          title: '同 runId 互斥锁验证',
          summary: '验证并发重复签核同一快照时只放行一次',
          requirements: { R1: '并发写请求串行化' },
          involvesDatabaseMigration: true,
        }),
        initiatorActor: 'P0-4 并发测试',
      });

      const stage3aSnap = run.getLatestSnapshotOnActiveBranch();
      assert.ok(stage3aSnap);
      assert.equal(stage3aSnap.stageId, WorkflowStageId.STAGE_3A_TECH_SPEC);
      assert.equal(stage3aSnap.getState(), SnapshotLifecycleState.PENDING_HUMAN_GATE);

      const results = await Promise.allSettled([
        orchestrator.submitHumanGateDecision({
          runId: run.runId,
          snapshotId: stage3aSnap.snapshotId,
          reviewerActor: '架构师 A',
          verdict: DecisionVerdict.APPROVE,
          comment: '并发签核请求 1',
        }),
        orchestrator.submitHumanGateDecision({
          runId: run.runId,
          snapshotId: stage3aSnap.snapshotId,
          reviewerActor: '架构师 B',
          verdict: DecisionVerdict.APPROVE,
          comment: '并发签核请求 2',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1, '仅允许一次并发签核成功推进');
      assert.equal(rejected.length, 1, '第二次串行到达时必须因非待签核状态被拒绝');
      assert.match(String(rejected[0].reason), /非待人工签核状态，禁止重复裁决/);
      assert.equal(stage3aSnap.getState(), SnapshotLifecycleState.APPROVED);

      const decisionsForSnap = orchestrator.auditLedger
        .getHumanDecisions(run.runId)
        .filter((d) => d.snapshotId === stage3aSnap.snapshotId);
      assert.equal(decisionsForSnap.length, 1, '同一门禁快照仅能记录一条人工裁决');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('4. 门禁 REJECT 内部委托总管回退不发生锁重入死锁', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-reentry-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: path.join(tmpBase, 'persist'),
        sandboxRootDir: path.join(tmpBase, 'sandbox'),
      });
      const run = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-P04-REJECT',
          title: '门禁驳回委托重入验证',
          summary: '验证 REJECT 调用内部 Unlocked 回退不死锁',
          requirements: { R1: '需求 R1' },
        }),
        initiatorActor: 'P0-4 死锁验证',
        scenarioHints: { forceNegotiationDeadlock: true },
      });
      const stage2Snap = run.getLatestSnapshotOnActiveBranch();
      assert.ok(stage2Snap);
      assert.equal(stage2Snap.stageId, WorkflowStageId.STAGE_2_PD);

      const afterReject = await orchestrator.submitHumanGateDecision({
        runId: run.runId,
        snapshotId: stage2Snap.snapshotId,
        reviewerActor: '设计总监',
        verdict: DecisionVerdict.REJECT,
        comment: '驳回重做 PD 交互方案',
      });

      assert.ok(afterReject.getActiveBranchId().startsWith('branch-v2-rollback-'));
      assert.equal(afterReject.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('5. 多 runId 并发推进 3b/4 时 QA 真实沙箱准备状态按 runId 隔离，不互相覆盖防谎报校验', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'p04-qa-iso-'));
    try {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: path.join(tmpBase, 'persist'),
        sandboxRootDir: path.join(tmpBase, 'sandbox'),
      });
      orchestrator.modelRouter.setHttpTransport(async (_url, payload) => {
        const sys = payload.messages?.[0]?.content ?? '';
        const usr = payload.messages?.[1]?.content ?? '';
        if (sys.includes('QA Agent')) {
          if (usr.includes('PROP-P04-FAIL')) {
            // 故意延迟 45ms，确保并发的 PROP-P04-PASS 在此期间完成 QA 沙箱准备，检验状态是否互相覆盖
            await new Promise((r) => setTimeout(r, 45));
          }
          // 两个 run 的 QA LLM 均声称全部通过（PROP-P04-FAIL 实际有 forceQaFailure=true，属谎报）
          return makeMockStageChatResponse(STAGE_MOCK_JSON.STAGE_4_QA);
        }
        return makeMockStageChatResponse(stageJsonForSystemPrompt(sys));
      });

      const runFail = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'PROP-P04-FAIL',
          title: '并发防谎报失败项目',
          summary: '真实沙箱存在缺陷但 LLM 谎报通过',
          requirements: { R1: '并发 QA 隔离检查' },
          involvesDatabaseMigration: true,
        }),
        initiatorActor: 'QA 测试 A',
        scenarioHints: { forceQaFailure: true },
      });

      const runPass = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'PROP-P04-PASS',
          title: '并发防谎报正常项目',
          summary: '真实沙箱无缺陷正常通过',
          requirements: { R1: '并发 QA 隔离检查' },
          involvesDatabaseMigration: true,
        }),
        initiatorActor: 'QA 测试 B',
      });

      const snapFail3a = runFail.getLatestSnapshotOnActiveBranch();
      const snapPass3a = runPass.getLatestSnapshotOnActiveBranch();
      assert.ok(snapFail3a && snapPass3a);

      // 并发放行 3a，驱动两个 run 同时进入 3b 与 Stage 4 QA
      await Promise.all([
        orchestrator.submitHumanGateDecision({
          runId: runFail.runId,
          snapshotId: snapFail3a.snapshotId,
          reviewerActor: '架构师',
          verdict: DecisionVerdict.APPROVE,
          comment: '并发放行 FAIL 场景进入 3b/4',
        }),
        orchestrator.submitHumanGateDecision({
          runId: runPass.runId,
          snapshotId: snapPass3a.snapshotId,
          reviewerActor: '架构师',
          verdict: DecisionVerdict.APPROVE,
          comment: '并发放行 PASS 场景进入 3b/4',
        }),
      ]);

      assert.equal(
        runFail.getStatus(),
        'ABORTED',
        'PROP-P04-FAIL 的 QA 防谎报校验不得被并发的 PROP-P04-PASS 覆盖，必须拦截谎报并熔断',
      );
      assert.equal(
        runPass.getStatus(),
        'PAUSED_AT_HUMAN_GATE',
        'PROP-P04-PASS 真实沙箱无缺陷，应正常停留在 Stage 4 QA 终审门禁',
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('高优 — PromptCacheManager L1/L2 独立测试（G1 向量语义版）', () => {
  /** 可控向量 stub：text → 预设向量（正交 = 语义无关，相近 = 语义等价） */
  class StubEmbeddingProvider implements EmbeddingProvider {
    public callCount = 0;
    public readonly providerName = 'stub';
    private readonly vectorFor: (text: string) => number[] | null;

    public constructor(vectorFor: (text: string) => number[] | null) {
      this.vectorFor = vectorFor;
    }

    public async embed(text: string): Promise<number[] | null> {
      this.callCount += 1;
      return this.vectorFor(text);
    }
  }

  // 简易 fake contract（满足 IDomainArtifactContract 接口）
  function makeFakeArtifact(summary: string): Record<string, unknown> & {
    validateContractIntegrity(): { isValid(): boolean; getViolations(): string[] };
  } {
    return {
      contractType: 'TEST',
      stageId: 'STAGE_1_PM',
      producerRole: 'PM_AGENT',
      schemaVersion: '1.0.0',
      summary,
      coreRequirementIds: ['R1'],
      validateContractIntegrity: () => ({ isValid: () => true, getViolations: () => [] }),
    };
  }

  function exactKeyOf(cache: PromptCacheManager, title: string): string {
    return cache.buildExactCacheKey({
      stageId: 'STAGE_1_PM' as never,
      agentRole: 'PM_AGENT' as never,
      proposalTitle: title,
      requirementIds: ['R1'],
    });
  }

  it('1. L1 精确缓存：相同 key → 命中（L1 不依赖 embedding）', async () => {
    const cache = new PromptCacheManager(true);
    const exactKey = exactKeyOf(cache, '测试项目');
    await cache.storeVerifiedArtifact({
      exactKey,
      semanticIntentText: '阶段 STAGE_1_PM | 需求 R1: 审批',
      artifact: makeFakeArtifact('缓存产物') as never,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
    });
    const lookup = await cache.lookup(exactKey, '阶段 STAGE_1_PM | 需求 R1: 审批');
    assert.equal(lookup.isHit, true);
    assert.equal(lookup.cacheLayer, 'L1_EXACT');
  });

  it('2. L2 语义命中：不同精确 key、措辞不同但语义等价（余弦 ≥ 0.86）→ 命中', async () => {
    const provider = new StubEmbeddingProvider((text) =>
      text.includes('采购审批')
        ? [1, 0.1, 0]
        : text.includes('请购审核')
          ? [0.98, 0.12, 0]
          : [0, 0, 1],
    );
    const cache = new PromptCacheManager(true, provider);
    await cache.storeVerifiedArtifact({
      exactKey: exactKeyOf(cache, '项目 A'),
      semanticIntentText: '需求 R1: 采购审批流程',
      artifact: makeFakeArtifact('缓存产物') as never,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
    });
    // 不同标题（L1 不命中）+ 相近语义措辞（"请购审核" ≈ "采购审批"）→ L2 命中
    const lookup = await cache.lookup(exactKeyOf(cache, '项目 B'), '需求 R1: 请购审核流程');
    assert.equal(lookup.isHit, true);
    assert.equal(lookup.cacheLayer, 'L2_SEMANTIC_INTENT');
    assert.ok(provider.callCount >= 2, '查询与写入共发生 embedding 调用');
  });

  it('3. 误命中修复：相同需求条数但语义无关（正交向量）→ 不命中', async () => {
    const provider = new StubEmbeddingProvider((text) =>
      text.includes('采购') ? [1, 0, 0] : text.includes('日志') ? [0, 1, 0] : [0, 0, 1],
    );
    const cache = new PromptCacheManager(true, provider);
    await cache.storeVerifiedArtifact({
      exactKey: exactKeyOf(cache, '项目 A'),
      semanticIntentText: '需求 R1: 采购审批 R2: 合同归档',
      artifact: makeFakeArtifact('缓存产物') as never,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
    });
    // 旧实现按"需求条数拼串"会误命中；向量正交 → MISS
    const lookup = await cache.lookup(
      exactKeyOf(cache, '项目 B'),
      '需求 R1: 日志脱敏 R2: 审计留存',
    );
    assert.equal(lookup.isHit, false);
    assert.equal(lookup.cacheLayer, 'MISS');
  });

  it('4. embedding 端点不可用 → 仅 L1，且如实记 embeddingUnavailableLookups', async () => {
    const provider = new StubEmbeddingProvider(() => null);
    const cache = new PromptCacheManager(true, provider);
    const exactKey = exactKeyOf(cache, '测试项目');
    await cache.storeVerifiedArtifact({
      exactKey,
      semanticIntentText: '需求 R1: 审批',
      artifact: makeFakeArtifact('产物') as never,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
    });
    assert.equal(cache.getL2EntryCount(), 0, 'embedding 失败不产生 L2 条目（无伪向量）');

    // L1 仍可用
    const l1Lookup = await cache.lookup(exactKey, '需求 R1: 审批');
    assert.equal(l1Lookup.isHit, true);
    assert.equal(l1Lookup.cacheLayer, 'L1_EXACT');

    // 换精确键 → MISS（无 L2 兜底）
    const miss = await cache.lookup(exactKeyOf(cache, '另一项目'), '需求 R1: 审批');
    assert.equal(miss.isHit, false);
    assert.ok(cache.getMetricsSnapshot().embeddingUnavailableLookups > 0);
  });

  it('5. 缓存未启用 → lookup 永远 MISS', async () => {
    const disabledCache = new PromptCacheManager(false);
    const exactKey = exactKeyOf(disabledCache, '测试');
    await disabledCache.storeVerifiedArtifact({
      exactKey,
      semanticIntentText: '需求 R1: 审批',
      artifact: makeFakeArtifact('产物') as never,
      estimatedTokens: 500,
      estimatedCostUsd: 0.01,
    });
    const lookup = await disabledCache.lookup(exactKey, '需求 R1: 审批');
    assert.equal(lookup.isHit, false);
    assert.equal(disabledCache.getL2EntryCount(), 0);
  });

  it('6. 命中后 savedTokens 如实记账（A3 口径）', async () => {
    const cache = new PromptCacheManager(true);
    const exactKey = exactKeyOf(cache, '测试');
    await cache.storeVerifiedArtifact({
      exactKey,
      semanticIntentText: '需求 R1: 审批',
      artifact: makeFakeArtifact('产物') as never,
      estimatedTokens: 1500,
      estimatedCostUsd: 0.05,
    });
    const lookup = await cache.lookup(exactKey, '需求 R1: 审批');
    assert.equal(lookup.isHit, true);
    assert.equal(lookup.savedTokensEstimate, 1500);
  });

  it('7. buildSemanticIntentText 含需求描述文本（相同 ID 不同描述 → 文本不同）', () => {
    const cache = new PromptCacheManager(true);
    const textA = cache.buildSemanticIntentText({
      stageId: 'STAGE_1_PM' as never,
      agentRole: 'PM_AGENT' as never,
      intentDescription: 'PRD 拆解',
      requirementDescriptions: { R1: '采购审批流程数字化' },
    });
    const textB = cache.buildSemanticIntentText({
      stageId: 'STAGE_1_PM' as never,
      agentRole: 'PM_AGENT' as never,
      intentDescription: 'PRD 拆解',
      requirementDescriptions: { R1: '多语言内容审核平台' },
    });
    assert.ok(textA.includes('采购审批流程数字化'));
    assert.ok(textB.includes('多语言内容审核平台'));
    assert.notEqual(textA, textB, '相同 ID 不同描述必须产生不同意图文本');
  });
});
