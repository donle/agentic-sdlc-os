/**
 * @file agent-context.spec.ts
 * @description Agent 外部知识介入模块单测：UpstreamCompressor（上游产物压缩）/
 *              ToolRegistry（上下文注册表 + 缓存）/ ContextBudgetTrimmer（Token 预算裁剪）。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UpstreamCompressor } from '../src/agents/context/UpstreamCompressor.ts';
import { ToolRegistry } from '../src/agents/context/ToolRegistry.ts';
import { ContextBudgetTrimmer } from '../src/agents/context/ContextBudgetTrimmer.ts';
import { estimateTokens } from '../src/agents/context/types.ts';
import type {
  ContextNeed,
  ContextProvider,
  ContextQuery,
  ContextResult,
  ResolvedContext,
} from '../src/agents/context/types.ts';
import {
  ProjectProposalContract,
  PrdArtifactContract,
  QaVerificationArtifactContract,
} from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';

function makeProposal(): ProjectProposalContract {
  return new ProjectProposalContract({
    proposalId: 'P-TEST-1',
    title: '测试提案',
    summary: '测试摘要',
    requirements: { R1: '需求一', R2: '需求二' },
    involvesDatabaseMigration: true,
  });
}

function makeQuery(runId = 'RUN-1'): ContextQuery {
  return {
    runId,
    stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
    proposal: makeProposal(),
    upstreamSummaries: [],
  };
}

/** 可计数的 Provider 桩（手写字段赋值——strip-types 模式不支持参数属性） */
class CountingProvider implements ContextProvider {
  public callCount = 0;
  public readonly name: string;
  private readonly resolvableTypes: ReadonlyArray<string>;
  private readonly behavior: 'ok' | 'throw';

  public constructor(name: string, resolvableTypes: string[], behavior: 'ok' | 'throw' = 'ok') {
    this.name = name;
    this.resolvableTypes = [...resolvableTypes];
    this.behavior = behavior;
  }

  public canResolve(need: ContextNeed): boolean {
    return this.resolvableTypes.includes(need.type);
  }

  public async resolve(_query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    this.callCount += 1;
    if (this.behavior === 'throw') {
      throw new Error('外部系统不可达');
    }
    return {
      type: need.type,
      content: 'API 列表: /api/runs, /api/decisions',
      tokenEstimate: 20,
      source: this.name,
      isReal: true,
    };
  }
}

describe('Agent 外部知识介入 — UpstreamCompressor', () => {
  const compressor = new UpstreamCompressor();

  it('1. Stage 0 提案契约（扁平结构）→ 提取需求数与风险标记', () => {
    const digests = compressor.compress([
      { stageId: WorkflowStageId.STAGE_0_INITIATION, artifact: makeProposal() },
    ]);
    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].keyFields, {
      requirementCount: 2,
      involvesDatabaseMigration: true,
      involvesPermissionOrPayment: false,
    });
    assert.deepEqual(digests[0].coreRequirementIds, ['R1', 'R2']);
  });

  it('2. Stage 1 PRD 契约 → 提取用户故事数/埋点数/NF 约束（截前 3 条）', () => {
    const prd = new PrdArtifactContract({
      summary: 'PRD 摘要',
      coreRequirementIds: ['R1'],
      userStories: [
        { reqId: 'R1', story: '作为管理员我要看板', acceptanceCriteria: ['AC1'] },
        { reqId: 'R1', story: '作为成员我要提交', acceptanceCriteria: ['AC2'] },
      ],
      trackingPlanEvents: [
        { eventName: 'gate_decision', triggerCondition: '裁决提交', properties: ['verdict'] },
      ],
      nonFunctionalConstraints: ['性能', '安全', '合规', '可用性'],
    });
    const [digest] = compressor.compress([{ stageId: WorkflowStageId.STAGE_1_PM, artifact: prd }]);
    assert.deepEqual(digest.keyFields, {
      userStoryCount: 2,
      trackingEventCount: 1,
      nonFunctionalConstraints: ['性能', '安全', '合规'],
    });
  });

  it('3. Stage 4 QA 契约 → 提取验收结论/安全问题/套件摘要', () => {
    const qa = new QaVerificationArtifactContract({
      summary: 'QA 验证摘要',
      coreRequirementIds: ['R1'],
      testSuitesExecuted: [
        { suiteName: 'server-api', totalCases: 12, passedCases: 12, coveragePercent: 88 },
        { suiteName: 'rbac', totalCases: 9, passedCases: 8, coveragePercent: 80 },
      ],
      securityIssuesFound: 1,
      allAcceptanceCriteriaMet: false,
    });
    const [digest] = compressor.compress([{ stageId: WorkflowStageId.STAGE_4_QA, artifact: qa }]);
    assert.deepEqual(digest.keyFields, {
      allPassed: false,
      securityIssues: 1,
      suiteSummary: ['server-api: 12/12', 'rbac: 8/9'],
    });
  });

  it('4. 单条摘要 token 估算不超过 maxTokensPerItem 上限', () => {
    const prd = new PrdArtifactContract({
      summary: '长'.repeat(5000),
      coreRequirementIds: ['R1'],
      userStories: [{ reqId: 'R1', story: 's', acceptanceCriteria: ['AC1'] }],
      trackingPlanEvents: [{ eventName: 'e', triggerCondition: 't', properties: ['p'] }],
      nonFunctionalConstraints: [],
    });
    const [digest] = compressor.compress(
      [{ stageId: WorkflowStageId.STAGE_1_PM, artifact: prd }],
      100,
    );
    assert.ok(digest.tokenEstimate <= 100);
  });
});

describe('Agent 外部知识介入 — ToolRegistry', () => {
  it('5. Provider 匹配 → resolve 成功且同 run 同类型第二次走缓存（不重复调外部系统）', async () => {
    const provider = new CountingProvider('git', ['code_structure']);
    const registry = new ToolRegistry(4000);
    registry.register(provider);

    const query = makeQuery();
    const first = await registry.resolve(
      [{ type: 'code_structure', required: true, maxTokens: 2000 }],
      query,
    );
    assert.equal(first.included.length, 1);
    assert.equal(first.totalTokens, 10);

    const second = await registry.resolve(
      [{ type: 'code_structure', required: true, maxTokens: 2000 }],
      query,
    );
    assert.equal(second.included.length, 1);
    assert.equal(provider.callCount, 1, '第二次应命中 runCache 而非再调 Provider');
  });

  it('6. required 需求无 Provider → 记入 truncated（提示 Provider 未能提供）', async () => {
    const registry = new ToolRegistry(4000);
    const result = await registry.resolve(
      [
        { type: 'figma_components', required: true, maxTokens: 2000 },
        { type: 'code_structure', required: false, maxTokens: 500 },
      ],
      makeQuery(),
    );
    assert.equal(result.included.length, 0);
    assert.ok(
      result.truncated.some((t) => t.type === 'figma_components' && t.reason.includes('required')),
      'required 缺失必须显式可见',
    );
    assert.equal(
      result.truncated.some((t) => t.type === 'code_structure'),
      false,
      'optional 缺失静默降级，不产生 truncated',
    );
  });

  it('7. Provider 抛错（required）→ 静默降级为 blocked，不向上抛异常', async () => {
    const throwing = new CountingProvider('broken-git', ['code_structure'], 'throw');
    const registry = new ToolRegistry(4000);
    registry.register(throwing);
    const result = await registry.resolve(
      [{ type: 'code_structure', required: true, maxTokens: 2000 }],
      makeQuery(),
    );
    assert.equal(result.included.length, 0);
    assert.ok(result.truncated.some((t) => t.type === 'code_structure'));
  });
});

describe('Agent 外部知识介入 — ContextBudgetTrimmer', () => {
  const trimmer = new ContextBudgetTrimmer(400);

  function makeResolved(need: ContextNeed, content: string): ResolvedContext {
    return {
      need,
      result: {
        type: need.type,
        content,
        tokenEstimate: estimateTokens(content),
        source: 'test',
        isReal: true,
      },
      blocked: false,
    };
  }

  it('8. 预算紧张时 required 优先保留，optional 被截断到剩余预算', () => {
    const needA: ContextNeed = { type: 'db_schema', required: true, maxTokens: 500 };
    const needB: ContextNeed = { type: 'code_structure', required: false, maxTokens: 3000 };
    const resolved = [
      makeResolved(needB, 'x'.repeat(2000)), // 500 tokens
      makeResolved(needA, '数'.repeat(200)), // 200 tokens
    ];
    const result = trimmer.trim([needA, needB], resolved);
    assert.equal(result.included.length, 2);
    assert.equal(result.included[0].need.type, 'db_schema', 'required 排在最前');
    assert.equal(result.totalTokens, 400);
    const truncatedB = result.truncated.find((t) => t.type === 'code_structure');
    assert.ok(truncatedB, 'optional 上下文被截断并记录原因');
    assert.ok(truncatedB.reason.includes('截断'));
  });

  it('9. 内容超过 need.maxTokens 声明 → 按 maxTokens 计入预算', () => {
    const tiny = new ContextBudgetTrimmer(4000);
    const need: ContextNeed = { type: 'metrics_baseline', required: true, maxTokens: 10 };
    const result = tiny.trim([need], [makeResolved(need, '中'.repeat(100))]);
    assert.equal(result.totalTokens, 10, 'effectiveTokens = min(content, maxTokens)');
  });

  it('10. 剩余预算不足 100 tokens → 直接跳过而非注入截断片段', () => {
    const tiny = new ContextBudgetTrimmer(150);
    const needA: ContextNeed = { type: 'db_schema', required: true, maxTokens: 500 };
    const needB: ContextNeed = { type: 'ci_cd_status', required: false, maxTokens: 500 };
    const resolved = [makeResolved(needA, '数'.repeat(50)), makeResolved(needB, 'x'.repeat(800))];
    const result = tiny.trim([needA, needB], resolved);
    assert.equal(result.included.length, 1);
    assert.ok(
      result.truncated.some((t) => t.type === 'ci_cd_status' && t.reason.includes('预算不足')),
    );
  });

  it('11. estimateTokens：中文按字计、英文按 4 字符计', () => {
    assert.equal(estimateTokens('需求确认'), 4);
    assert.equal(estimateTokens('abcdefgh'), 2);
    assert.equal(estimateTokens('需求require'), 2 + Math.ceil(7 / 4));
  });
});
