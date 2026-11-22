/**
 * @file supervisor-tools.spec.ts
 * @description C2 总管四工具契约测试：验证四个工具函数的可调用性与返回结构。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import {
  getRunOverview,
  summarizeConflict,
  overrideGate,
  SUPERVISOR_TOOL_SCHEMAS,
} from '../src/agents/supervisorTools.ts';

describe('C2 — 总管四工具契约测试', () => {
  it('1. get_run_overview 应返回完整运行状态摘要', async () => {
    const facade = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    const runState = await facade.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'TEST-C2-001',
        title: '工具测试项目',
        summary: '验证 getRunOverview',
        requirements: { R1: '需求 1' },
      }),
      initiatorActor: '工具测试',
    });

    const overview = getRunOverview(facade, runState.runId);
    assert.equal(overview.runId, runState.runId);
    assert.equal(overview.title, '工具测试项目');
    assert.equal(overview.status, 'PAUSED_AT_HUMAN_GATE');
    assert.ok(overview.branches.length > 0);
    assert.ok(overview.completedStages > 0);
    assert.ok(overview.pendingGateCount > 0, '应有待人工门禁');
  });

  it('2. summarizeConflict 应从协商日志提炼裁决卡', async () => {
    const facade = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    const runState = await facade.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'TEST-C2-002',
        title: '协商冲突工具测试',
        summary: 'PM-PD 熔断后测试冲突提炼',
        requirements: { R1: '需求 1', R2: '需求 2' },
      }),
      initiatorActor: '工具测试',
      scenarioHints: { forceNegotiationDeadlock: true },
    });

    // 协商熔断后应有 NegotiationLog
    const logs = facade.negotiationMediator.getNegotiationHistory(runState.runId);
    assert.ok(logs.length > 0, '应有协商记录');
    const negId = logs[logs.length - 1].negotiationId;

    const card = summarizeConflict(facade, runState.runId, negId);
    assert.ok(card);
    assert.ok(card.challengePoint.length > 0, '应有分歧焦点');
    assert.ok(card.optionA.length > 0, '应有方案 A');
    assert.ok(card.optionB.length > 0, '应有方案 B');
    assert.equal(card.escalated, true, '应有熔断标记');
  });

  it('3. override_gate 应通过 RBAC 后正常推进', async () => {
    const facade = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    const runState = await facade.startProposalWorkflow({
      proposal: new ProjectProposalContract({
        proposalId: 'TEST-C2-003',
        title: '门禁覆写工具测试',
        summary: '验证 overrideGate 推进',
        requirements: { R1: '需求 1' },
      }),
      initiatorActor: '工具测试',
    });

    const snapshot = runState.getLatestSnapshotOnActiveBranch();
    assert.ok(snapshot);

    const result = (await overrideGate(facade, {
      runId: runState.runId,
      snapshotId: snapshot.snapshotId,
      reviewerActor: '王总管',
      verdict: DecisionVerdict.APPROVE,
      reason: '工具覆写测试',
    })) as { getStatus(): string };

    assert.notEqual(result.getStatus(), 'ABORTED');
  });

  it('4. 工具 schema 应包含 4 个工具定义', () => {
    assert.equal(SUPERVISOR_TOOL_SCHEMAS.length, 4);
    const names = SUPERVISOR_TOOL_SCHEMAS.map((s) => s.name);
    assert.deepEqual(names, [
      'get_run_overview',
      'summarize_conflict',
      'override_gate',
      'rollback_and_fork',
    ]);
  });
});
