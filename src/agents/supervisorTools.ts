/**
 * @file supervisorTools.ts
 * @description C2 总管 Agent 四工具契约（BACKEND_TODO_DESIGN C2）：
 * 蓝图 §4.2 的 get_run_overview / summarize_conflict / rollback_and_fork / override_gate。
 * 四个函数是**唯一入口**，为 M3 的 LLM function-calling 预留 schema；
 * 严禁总管直接修改业务产物（黄金架构铁律）。
 */

import type { DecisionVerdict } from '../domain/enums.ts';
import type { WorkflowRunState } from '../engine/DagWorkflowStateEngine.ts';
import type { WorkflowOrchestratorFacade } from '../engine/WorkflowOrchestratorFacade.ts';

/** 工具 1：获取运行实例全景（阶段状态 / 活跃分支 / 卡点摘要） */
export interface RunOverviewSummary {
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly activeBranchId: string;
  readonly branches: ReadonlyArray<string>;
  readonly currentStageId: string | null;
  readonly completedStages: number;
  readonly totalStages: number;
  readonly pendingGateCount: number;
  readonly unresolvedNotifications: ReadonlyArray<{ title: string; category: string }>;
  readonly tokenUsed: number;
}

export function getRunOverview(
  facade: WorkflowOrchestratorFacade,
  runId: string,
): RunOverviewSummary {
  const runState = facade.stateEngine.getRunOrThrow(runId);
  const notifications = facade.eventBus
    .getNotificationInbox(runId)
    .filter((n) => n.requiresHumanAction && !n.isResolved());

  return {
    runId: runState.runId,
    title: runState.proposal.title,
    status: runState.getStatus(),
    activeBranchId: runState.getActiveBranchId(),
    branches: [...runState.getBranches()],
    currentStageId: runState.getCurrentStageId(),
    completedStages: runState.getActiveBranchSnapshots().length,
    totalStages: runState.getStagePipeline().length,
    pendingGateCount: notifications.length,
    unresolvedNotifications: notifications.map((n) => ({ title: n.title, category: n.category })),
    tokenUsed: runState.getTokensUsedTotal(),
  };
}

/** 工具 2：从 NegotiationLog 提炼冲突裁决卡 */
export interface ConflictArbitrationCard {
  readonly negotiationId: string;
  readonly challengerRole: string;
  readonly responderRole: string;
  readonly topic: string;
  readonly turnCount: number;
  readonly maxTurns: number;
  readonly challengePoint: string;
  readonly optionA: string;
  readonly optionB: string;
  readonly escalated: boolean;
}

export function summarizeConflict(
  facade: WorkflowOrchestratorFacade,
  runId: string,
  negotiationId: string,
): ConflictArbitrationCard | null {
  const logs = facade.negotiationMediator.getNegotiationHistory(runId);
  const turns = logs.filter(
    (t) => t.negotiationId.startsWith(negotiationId) || t.negotiationId === negotiationId,
  );
  if (turns.length === 0) {
    return null;
  }
  const latest = turns[turns.length - 1];
  return {
    negotiationId: latest.negotiationId,
    challengerRole: latest.challengerRole,
    responderRole: latest.responderRole,
    topic: latest.topic,
    turnCount: turns.length,
    maxTurns: latest.maxTurnsAllowed,
    challengePoint: latest.challengePoint,
    optionA: latest.optionAProposal,
    optionB: latest.optionBProposal,
    escalated: latest.escalatedToSupervisor,
  };
}

/** 工具 3：人工门禁覆写（RBAC 校验内建在 facade.submitHumanGateDecision 中） */
export async function overrideGate(
  facade: WorkflowOrchestratorFacade,
  params: {
    runId: string;
    snapshotId: string;
    reviewerActor: string;
    actorUserId?: string;
    verdict: DecisionVerdict;
    reason: string;
  },
): Promise<WorkflowRunState> {
  return facade.submitHumanGateDecision({
    runId: params.runId,
    snapshotId: params.snapshotId,
    reviewerActor: params.reviewerActor,
    actorUserId: params.actorUserId,
    verdict: params.verdict,
    comment: params.reason,
  });
}

/** 工具 4：对话式 DAG 回退（RBAC 校验内建） */
export async function rollbackAndFork(
  facade: WorkflowOrchestratorFacade,
  params: {
    runId: string;
    directive: string;
    actorUserId?: string;
    targetStageId?: string;
  },
): Promise<WorkflowRunState> {
  return facade.invokeSupervisorConversationalRollback({
    runId: params.runId,
    humanActor: '总管 Agent (via tool)',
    actorUserId: params.actorUserId,
    dialogueInstruction: params.directive,
    explicitTargetStageId: params.targetStageId as never,
  });
}

/** 工具 schema（供 M3 LLM function-calling 注册） */
export const SUPERVISOR_TOOL_SCHEMAS = [
  {
    name: 'get_run_overview',
    description: '获取运行实例的阶段状态/活跃分支/卡点摘要',
    params: ['runId'],
  },
  {
    name: 'summarize_conflict',
    description: '从协商日志提炼冲突裁决卡',
    params: ['runId', 'negotiationId'],
  },
  {
    name: 'override_gate',
    description: '人工门禁覆写（需 RBAC 校验）',
    params: ['runId', 'snapshotId', 'verdict', 'reason'],
  },
  {
    name: 'rollback_and_fork',
    description: '对话式 DAG 回退（需 RBAC 校验）',
    params: ['runId', 'directive'],
  },
] as const;
