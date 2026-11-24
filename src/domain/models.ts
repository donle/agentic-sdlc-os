/**
 * @file models.ts
 * @description 领域实体与备忘录对象 (Memento Pattern / Domain Entities)。
 * 封装阶段快照、DAG 分支、Agent 协商记录、人类裁决记录与前端实时提醒对象。
 */

import type { IDomainArtifactContract } from './contracts.ts';
import {
  AgentRole,
  BusinessRiskLevel,
  DecisionVerdict,
  GateActionType,
  NotificationCategory,
  SnapshotLifecycleState,
  WorkflowStageId,
} from './enums.ts';

/**
 * 范围篡改检测报告 (Scope Diff Report — 防“虚假共识”机制产出)
 */
export class ScopeDiffReport {
  public static fromJSON(raw: Record<string, unknown> | undefined | null): ScopeDiffReport {
    const hasBaseline = Array.isArray(raw?.baselineRequirementIds);
    if (!hasBaseline && raw?.hasUnauthorizedScopeReduction === true) {
      const dropped = Array.isArray(raw.droppedRequirementIds)
        ? (raw.droppedRequirementIds as unknown[]).map((x) => String(x))
        : ['__LEGACY_DROPPED__'];
      return new ScopeDiffReport(dropped, []);
    }
    const baseline = hasBaseline ? (raw!.baselineRequirementIds as string[]) : [];
    const current = Array.isArray(raw?.currentRequirementIds)
      ? (raw!.currentRequirementIds as string[])
      : baseline;
    return new ScopeDiffReport(baseline, current);
  }

  public readonly baselineRequirementIds: ReadonlyArray<string>;
  public readonly currentRequirementIds: ReadonlyArray<string>;
  public readonly droppedRequirementIds: ReadonlyArray<string>;
  public readonly hasUnauthorizedScopeReduction: boolean;

  public constructor(
    baselineRequirementIds: ReadonlyArray<string>,
    currentRequirementIds: ReadonlyArray<string>,
  ) {
    this.baselineRequirementIds = [...baselineRequirementIds];
    this.currentRequirementIds = [...currentRequirementIds];
    const currentSet = new Set(currentRequirementIds);
    this.droppedRequirementIds = baselineRequirementIds.filter((id) => !currentSet.has(id));
    this.hasUnauthorizedScopeReduction = this.droppedRequirementIds.length > 0;
  }
}

/**
 * 不可变阶段快照备忘录 (Memento Pattern)
 * 用于在 DAG 状态机中保存每一步的执行快照；当总管 Agent 触发回退时，旧快照被标记为 SUPERSEDED，并从父快照 Fork 新分支。
 */
export class StageSnapshotMemento {
  public readonly snapshotId: string;
  public readonly runId: string;
  public readonly parentSnapshotId: string | null;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly agentRole: AgentRole;
  public readonly modelUsed: string;
  public readonly artifact: IDomainArtifactContract;
  public readonly riskScore: number;
  public readonly riskLevel: BusinessRiskLevel;
  public readonly riskReasons: ReadonlyArray<string>;
  public readonly gateAction: GateActionType;
  public readonly scopeDiffReport: ScopeDiffReport;
  public readonly cacheHit: boolean;
  public readonly retryCount: number;
  public readonly tokensConsumed: number;
  public readonly createdAtIso: string;
  private lifecycleState: SnapshotLifecycleState;

  public constructor(params: {
    snapshotId: string;
    runId: string;
    parentSnapshotId: string | null;
    branchId: string;
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    modelUsed: string;
    artifact: IDomainArtifactContract;
    riskScore: number;
    riskLevel: BusinessRiskLevel;
    riskReasons: ReadonlyArray<string>;
    gateAction: GateActionType;
    scopeDiffReport: ScopeDiffReport;
    cacheHit: boolean;
    retryCount: number;
    tokensConsumed: number;
    initialState: SnapshotLifecycleState;
    createdAtIso?: string;
  }) {
    this.snapshotId = params.snapshotId;
    this.runId = params.runId;
    this.parentSnapshotId = params.parentSnapshotId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.agentRole = params.agentRole;
    this.modelUsed = params.modelUsed;
    this.artifact = params.artifact;
    this.riskScore = params.riskScore;
    this.riskLevel = params.riskLevel;
    this.riskReasons = [...params.riskReasons];
    this.gateAction = params.gateAction;
    this.scopeDiffReport = params.scopeDiffReport;
    this.cacheHit = params.cacheHit;
    this.retryCount = params.retryCount;
    this.tokensConsumed = params.tokensConsumed;
    this.lifecycleState = params.initialState;
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
  }

  public getState(): SnapshotLifecycleState {
    return this.lifecycleState;
  }

  public transitionState(targetState: SnapshotLifecycleState): void {
    this.lifecycleState = targetState;
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      snapshotId: this.snapshotId,
      runId: this.runId,
      parentSnapshotId: this.parentSnapshotId,
      branchId: this.branchId,
      stageId: this.stageId,
      agentRole: this.agentRole,
      modelUsed: this.modelUsed,
      state: this.lifecycleState,
      riskScore: this.riskScore,
      riskLevel: this.riskLevel,
      riskReasons: this.riskReasons,
      gateAction: this.gateAction,
      scopeDiff: {
        baselineRequirementIds: [...this.scopeDiffReport.baselineRequirementIds],
        currentRequirementIds: [...this.scopeDiffReport.currentRequirementIds],
        hasUnauthorizedScopeReduction: this.scopeDiffReport.hasUnauthorizedScopeReduction,
        droppedRequirementIds: [...this.scopeDiffReport.droppedRequirementIds],
      },
      cacheHit: this.cacheHit,
      retryCount: this.retryCount,
      tokensConsumed: this.tokensConsumed,
      artifactSummary: this.artifact.summary,
      structuredSummary: {
        headline: this.artifact.summary,
        rationale: this.artifact.agentRationale?.trim() || this.artifact.summary,
        caveats: [
          ...this.riskReasons,
          ...(this.scopeDiffReport.hasUnauthorizedScopeReduction
            ? [`检测到未授权需求删减 (${this.scopeDiffReport.droppedRequirementIds.join(', ')})`]
            : []),
        ],
      },
      artifactType: this.artifact.contractType,
      artifactDetails: this.artifact,
      createdAtIso: this.createdAtIso,
    };
  }
}

/**
 * Agent 间受限协商单轮记录实体
 */
export class NegotiationTurnRecord {
  public static fromJSON(raw: Record<string, unknown>): NegotiationTurnRecord {
    return new NegotiationTurnRecord({
      negotiationId: String(raw.negotiationId ?? ''),
      runId: String(raw.runId ?? ''),
      branchId: String(raw.branchId ?? ''),
      topic: raw.topic ? String(raw.topic) : undefined,
      turnIndex: Number(raw.turnIndex ?? 1),
      maxTurnsAllowed: Number(raw.maxTurnsAllowed ?? 3),
      challengerRole: String(raw.challengerRole ?? 'PD_AGENT') as never,
      responderRole: String(raw.responderRole ?? 'PM_AGENT') as never,
      challengePoint: String(raw.challengePoint ?? ''),
      responseResolution: String(raw.responseResolution ?? ''),
      consensusReached: Boolean(raw.consensusReached),
      escalatedToSupervisor: Boolean(raw.escalatedToSupervisor),
      optionAProposal: raw.optionAProposal ? String(raw.optionAProposal) : undefined,
      optionBProposal: raw.optionBProposal ? String(raw.optionBProposal) : undefined,
      createdAtIso: raw.createdAtIso ? String(raw.createdAtIso) : undefined,
    });
  }

  public readonly negotiationId: string;
  public readonly runId: string;
  public readonly branchId: string;
  /** B2：协商主题（DESIGN_REVIEW / QA_REPAIR），缺省为设计评审 */
  public readonly topic: string;
  public readonly turnIndex: number;
  public readonly maxTurnsAllowed: number;
  public readonly challengerRole: AgentRole;
  public readonly responderRole: AgentRole;
  public readonly challengePoint: string;
  public readonly responseResolution: string;
  public readonly consensusReached: boolean;
  public readonly escalatedToSupervisor: boolean;
  public readonly optionAProposal: string;
  public readonly optionBProposal: string;
  public readonly createdAtIso: string;

  public constructor(params: {
    negotiationId: string;
    runId: string;
    branchId: string;
    topic?: string;
    turnIndex: number;
    maxTurnsAllowed: number;
    challengerRole: AgentRole;
    responderRole: AgentRole;
    challengePoint: string;
    responseResolution: string;
    consensusReached: boolean;
    escalatedToSupervisor: boolean;
    optionAProposal?: string;
    optionBProposal?: string;
    createdAtIso?: string;
  }) {
    this.negotiationId = params.negotiationId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.topic = params.topic ?? 'DESIGN_REVIEW';
    this.turnIndex = params.turnIndex;
    this.maxTurnsAllowed = params.maxTurnsAllowed;
    this.challengerRole = params.challengerRole;
    this.responderRole = params.responderRole;
    this.challengePoint = params.challengePoint;
    this.responseResolution = params.responseResolution;
    this.consensusReached = params.consensusReached;
    this.escalatedToSupervisor = params.escalatedToSupervisor;
    this.optionAProposal =
      params.optionAProposal ?? '方案 A：遵循当前组件库/架构约束进行标准降级实现（工期零延误）';
    this.optionBProposal =
      params.optionBProposal ?? '方案 B：扩展定制组件/底层数据结构以完整保留原方案（工期 +2 人日）';
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
  }
}

/**
 * 人类或自动策略门禁裁决账本记录实体 (核心追责依据)
 */
export class HumanDecisionRecord {
  public static fromJSON(raw: Record<string, unknown>): HumanDecisionRecord {
    return new HumanDecisionRecord({
      decisionId: String(raw.decisionId ?? ''),
      runId: String(raw.runId ?? ''),
      snapshotId: String(raw.snapshotId ?? ''),
      branchId: String(raw.branchId ?? ''),
      stageId: String(raw.stageId ?? 'STAGE_1_PM') as never,
      reviewerActor: String(raw.reviewerActor ?? ''),
      reviewerUserId: raw.reviewerUserId ? String(raw.reviewerUserId) : undefined,
      verdict: String(raw.verdict ?? 'APPROVE') as never,
      comment: String(raw.comment ?? ''),
      createdAtIso: raw.createdAtIso ? String(raw.createdAtIso) : undefined,
    });
  }

  public readonly decisionId: string;
  public readonly runId: string;
  public readonly snapshotId: string;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly reviewerActor: string;
  public readonly reviewerUserId?: string;
  public readonly verdict: DecisionVerdict;
  public readonly comment: string;
  public readonly createdAtIso: string;

  public constructor(params: {
    decisionId: string;
    runId: string;
    snapshotId: string;
    branchId: string;
    stageId: WorkflowStageId;
    reviewerActor: string;
    reviewerUserId?: string;
    verdict: DecisionVerdict;
    comment: string;
    createdAtIso?: string;
  }) {
    this.decisionId = params.decisionId;
    this.runId = params.runId;
    this.snapshotId = params.snapshotId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.reviewerActor = params.reviewerActor;
    this.reviewerUserId = params.reviewerUserId;
    this.verdict = params.verdict;
    this.comment = params.comment;
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
  }
}

/**
 * Agent 发送给前端用户的实时提醒实体（包括待核验门禁、待拍板冲突裁决、Scope 变更预警、自动放行留痕）
 */
export class AgentUserNotification {
  public static fromJSON(raw: Record<string, unknown>): AgentUserNotification {
    const rawOptions = Array.isArray(raw.actionOptions) ? raw.actionOptions : [];
    return new AgentUserNotification({
      notificationId: String(raw.notificationId ?? ''),
      runId: String(raw.runId ?? ''),
      branchId: String(raw.branchId ?? ''),
      stageId: String(raw.stageId ?? 'STAGE_1_PM') as WorkflowStageId,
      senderRole: String(raw.senderRole ?? 'SUPERVISOR_AGENT') as AgentRole,
      category: String(raw.category ?? 'STAGE_PROGRESS') as NotificationCategory,
      title: String(raw.title ?? ''),
      message: String(raw.message ?? ''),
      relatedSnapshotId: String(raw.relatedSnapshotId ?? ''),
      requiresHumanAction: Boolean(raw.requiresHumanAction),
      resolved: raw.resolved === undefined ? undefined : Boolean(raw.resolved),
      createdAtIso: raw.createdAtIso ? String(raw.createdAtIso) : undefined,
      actionOptions: rawOptions.map((item) => {
        const opt = item as Record<string, unknown>;
        return {
          actionKey: String(opt.actionKey ?? ''),
          label: String(opt.label ?? ''),
          verdict: String(opt.verdict ?? 'APPROVE') as DecisionVerdict,
        };
      }),
    });
  }

  public readonly notificationId: string;
  public readonly runId: string;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly senderRole: AgentRole;
  public readonly category: NotificationCategory;
  public readonly title: string;
  public readonly message: string;
  public readonly relatedSnapshotId: string;
  public readonly requiresHumanAction: boolean;
  public readonly actionOptions: ReadonlyArray<{
    readonly actionKey: string;
    readonly label: string;
    readonly verdict: DecisionVerdict;
  }>;
  public readonly createdAtIso: string;
  private resolvedFlag: boolean;

  public constructor(params: {
    notificationId: string;
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    senderRole: AgentRole;
    category: NotificationCategory;
    title: string;
    message: string;
    relatedSnapshotId: string;
    requiresHumanAction: boolean;
    resolved?: boolean;
    createdAtIso?: string;
    actionOptions?: ReadonlyArray<{
      actionKey: string;
      label: string;
      verdict: DecisionVerdict;
    }>;
  }) {
    this.notificationId = params.notificationId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.senderRole = params.senderRole;
    this.category = params.category;
    this.title = params.title;
    this.message = params.message;
    this.relatedSnapshotId = params.relatedSnapshotId;
    this.requiresHumanAction = params.requiresHumanAction;
    this.actionOptions = params.actionOptions ? [...params.actionOptions] : [];
    this.resolvedFlag = params.resolved ?? !params.requiresHumanAction;
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
  }

  public isResolved(): boolean {
    return this.resolvedFlag;
  }

  public markResolved(): void {
    this.resolvedFlag = true;
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      notificationId: this.notificationId,
      runId: this.runId,
      branchId: this.branchId,
      stageId: this.stageId,
      senderRole: this.senderRole,
      category: this.category,
      title: this.title,
      message: this.message,
      relatedSnapshotId: this.relatedSnapshotId,
      requiresHumanAction: this.requiresHumanAction,
      resolved: this.resolvedFlag,
      actionOptions: this.actionOptions.map((opt) => ({ ...opt })),
      createdAtIso: this.createdAtIso,
    };
  }
}

export type TeamCommentCategory = 'COMMENT' | 'APPROVAL_NOTE' | 'REVISION_REQUEST';

/**
 * 团队成员在项目各步骤留下的协同评论与评审意见实体
 */
export class StageTeamCommentRecord {
  public static fromJSON(raw: Record<string, unknown>): StageTeamCommentRecord {
    return new StageTeamCommentRecord({
      commentId: String(raw.commentId ?? ''),
      runId: String(raw.runId ?? ''),
      stageId: String(raw.stageId ?? 'STAGE_0_INITIATION') as WorkflowStageId,
      authorUserId: String(raw.authorUserId ?? ''),
      authorName: String(raw.authorName ?? ''),
      authorJobTitle: String(raw.authorJobTitle ?? ''),
      authorBadge: String(raw.authorBadge ?? ''),
      content: String(raw.content ?? ''),
      category: (raw.category as TeamCommentCategory | undefined) ?? 'COMMENT',
      createdAtIso: raw.createdAtIso ? String(raw.createdAtIso) : undefined,
    });
  }

  public readonly commentId: string;
  public readonly runId: string;
  public readonly stageId: WorkflowStageId;
  public readonly authorUserId: string;
  public readonly authorName: string;
  public readonly authorJobTitle: string;
  public readonly authorBadge: string;
  public readonly content: string;
  public readonly category: TeamCommentCategory;
  public readonly createdAtIso: string;

  public constructor(params: {
    commentId: string;
    runId: string;
    stageId: WorkflowStageId;
    authorUserId: string;
    authorName: string;
    authorJobTitle: string;
    authorBadge: string;
    content: string;
    category?: TeamCommentCategory;
    createdAtIso?: string;
  }) {
    this.commentId = params.commentId;
    this.runId = params.runId;
    this.stageId = params.stageId;
    this.authorUserId = params.authorUserId;
    this.authorName = params.authorName;
    this.authorJobTitle = params.authorJobTitle;
    this.authorBadge = params.authorBadge;
    this.content = params.content;
    this.category = params.category ?? 'COMMENT';
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      commentId: this.commentId,
      runId: this.runId,
      stageId: this.stageId,
      authorUserId: this.authorUserId,
      authorName: this.authorName,
      authorJobTitle: this.authorJobTitle,
      authorBadge: this.authorBadge,
      content: this.content,
      category: this.category,
      createdAtIso: this.createdAtIso,
    };
  }
}
