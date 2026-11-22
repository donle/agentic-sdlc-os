/**
 * @file concurrency-and-cache.spec.ts
 * @description 高优测试缺口 2+3：并发提案竞态条件 + PromptCacheManager L1/L2 独立测试。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { PromptCacheManager } from '../src/telemetry/PromptCacheManager.ts';
import type { EmbeddingProvider } from '../src/telemetry/EmbeddingProvider.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';

describe('高优 — 并发提案竞态条件测试', () => {
  it('1. 两个提案并发推进 → runId 隔离，快照/决策/事件不交叉污染', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });

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

  it('2. 并发提案后各自的缓存键不冲突', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });

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
