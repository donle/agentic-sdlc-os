/**
 * @file qa-repair-loop.spec.ts
 * @description B2 QA↔Engineer 修复闭环测试（BACKEND_TODO B2）：
 * forceQaFailure 场景下，QA 失败 → 协商一致 → 自动分叉 3b 重编码 → 2 轮后超限熔断上人工仲裁。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict, NotificationCategory, WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { MAX_AUTO_REPAIRS } from '../src/engine/repairLoop.ts';

describe('B2 — QA↔Engineer 修复闭环 (QA Repair Loop) 测试套件', () => {
  it('1. QA 失败应自动分叉 3b 重新编码，累计 2 轮修复后超限熔断上人工仲裁', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-QA-REPAIR-001',
      title: '修复闭环驱动测试项目',
      summary: 'QA 注入失败缺陷以驱动 Engineer 自动修复闭环',
      requirements: {
        REQ_REPAIR_A: '支持修复闭环路径 A',
        REQ_REPAIR_B: '支持修复闭环路径 B',
      },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '测试发起人',
      scenarioHints: { forceQaFailure: true },
    });

    // 前 2 轮自动修复：每次都分叉新分支并打回 3b
    const branches = runState.getBranches();
    assert.equal(
      runState.getAutoRepairCount('QA_TO_ENG'),
      MAX_AUTO_REPAIRS,
      `应累计 ${MAX_AUTO_REPAIRS} 轮自动修复`,
    );
    assert.ok(branches.length >= MAX_AUTO_REPAIRS + 1, '每次修复都应分叉出新分支（含 v1 主干）');

    // 修复轮次产生的决策账本（REJECT → 负向经验飞轮沉淀）
    const decisions = orchestrator.auditLedger.getHumanDecisions(runState.runId);
    const repairDecisions = decisions.filter((d) => d.verdict === DecisionVerdict.REJECT);
    assert.equal(repairDecisions.length, MAX_AUTO_REPAIRS);
    assert.ok(
      repairDecisions.every((d) => d.comment.includes('QA 修复第')),
      '修复指令应带轮次前缀（防止缓存命中同一失败产物）',
    );

    // 第 3 次 QA 失败：超限强制熔断 → 停在 QA 门禁等待人工仲裁
    assert.equal(runState.getStatus(), 'PAUSED_AT_HUMAN_GATE');
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_4_QA);

    // 通知中心应包含修复闭环回退提醒与仲裁请求
    const inbox = orchestrator.eventBus.getNotificationInbox(runState.runId);
    assert.ok(
      inbox.some(
        (n) =>
          n.category === NotificationCategory.ROLLBACK_EXECUTED && n.title.includes('QA 修复闭环'),
      ),
      '应有修复闭环回退提醒',
    );
    assert.ok(
      inbox.some((n) => n.category === NotificationCategory.CONFLICT_ARBITRATION_REQUIRED),
      '超限后应有仲裁请求',
    );

    // 修复指令入负向经验飞轮（REJECT 沉淀，挂 Engineer 阶段）
    const lessons = await orchestrator.auditLedger.getRejectionLessonsForStage(
      WorkflowStageId.STAGE_3B_ENGINEER,
      '修复闭环',
    );
    assert.ok(lessons.length > 0, 'REJECT 决策应沉淀为负向经验教训');
  });

  it('2. QA 通过时不应触发修复闭环（正常路径回归）', async () => {
    const orchestrator = new WorkflowOrchestratorFacade({ maxNegotiationTurns: 3 });
    const proposal = new ProjectProposalContract({
      proposalId: 'TEST-QA-REPAIR-002',
      title: '正常路径回归项目',
      summary: 'QA 全部通过，不应触发修复分叉',
      requirements: {
        REQ_OK: '正常需求',
      },
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal,
      initiatorActor: '测试发起人',
    });

    assert.equal(runState.getAutoRepairCount('QA_TO_ENG'), 0);
    // QA 失败会强制人工门禁；未失败且无 DDL/权限风险 → 可能自动放行直至完成或停在 QA 终审
    assert.notEqual(runState.getStatus(), 'ABORTED');
  });
});
