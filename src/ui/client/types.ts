/**
 * @file types.ts
 * @description 企业级多角色研发协同系统前端强类型 DTO 接口契约定义。
 */

export interface EnterpriseUserDto {
  readonly userId: string;
  readonly displayName: string;
  readonly jobTitle: string;
  readonly department: string;
  readonly tier: 'PROJECT_ADMIN' | 'STAGE_SPECIALIST';
  readonly specialistDomain: string;
  readonly counterpartAgentRole: string;
  readonly ownedStageIds: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly avatarBadge: string;
  readonly isProjectAdmin: boolean;
}

export interface StageAccessEvaluationDto {
  readonly stageId: string;
  readonly canViewSharedArtifact: boolean;
  readonly canApproveOrArbitrate: boolean;
  readonly isDirectDomainOwner: boolean;
  readonly isAdminOverride: boolean;
  readonly requiredSpecialistRoles: ReadonlyArray<string>;
  readonly denialReason: string | null;
}

export interface RbacContextDto {
  readonly currentUser: EnterpriseUserDto;
  readonly roster: ReadonlyArray<EnterpriseUserDto>;
  readonly stageAccessMatrix: Readonly<Record<string, StageAccessEvaluationDto>>;
  readonly allowSpecialistCrossStageRollback: boolean;
}

export interface RunListItemDto {
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
  readonly activeBranchId: string;
  readonly workflowTemplateId: string;
  readonly initiatorActor: string;
  readonly currentStageId?: string | null;
  readonly completedStagesCount?: number;
  readonly totalStagesCount?: number;
  readonly commentsCount?: number;
  readonly createdAtIso: string;
}

export interface TeamCommentDto {
  readonly commentId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly authorJobTitle: string;
  readonly authorBadge: string;
  readonly content: string;
  readonly category: 'COMMENT' | 'APPROVAL_NOTE' | 'REVISION_REQUEST';
  readonly createdAtIso: string;
}

export interface SnapshotRecordDto {
  readonly snapshotId: string;
  readonly runId: string;
  readonly parentSnapshotId: string | null;
  readonly branchId: string;
  readonly stageId: string;
  readonly agentRole: string;
  readonly modelUsed: string;
  readonly state: string;
  readonly riskScore: number;
  readonly riskLevel: string;
  readonly riskReasons: ReadonlyArray<string>;
  readonly gateAction: string;
  readonly scopeDiff: {
    readonly hasUnauthorizedScopeReduction: boolean;
    readonly droppedRequirementIds: ReadonlyArray<string>;
  };
  readonly cacheHit: boolean;
  readonly retryCount: number;
  readonly tokensConsumed: number;
  readonly artifactSummary: string;
  readonly artifactType: string;
  readonly artifactDetails: Record<string, unknown>;
  readonly createdAtIso: string;
}

export interface NotificationActionOptionDto {
  readonly actionKey: string;
  readonly label: string;
  readonly verdict: string;
}

export interface NotificationDto {
  readonly notificationId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly stageId: string;
  readonly senderRole: string;
  readonly category: string;
  readonly title: string;
  readonly message: string;
  readonly relatedSnapshotId: string;
  readonly requiresHumanAction: boolean;
  readonly resolved: boolean;
  readonly actionOptions: ReadonlyArray<NotificationActionOptionDto>;
  readonly createdAtIso: string;
  readonly accessEvaluation?: StageAccessEvaluationDto;
}

export interface NegotiationTurnDto {
  readonly negotiationId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly turnIndex: number;
  readonly maxTurnsAllowed: number;
  readonly challengerRole: string;
  readonly responderRole: string;
  readonly challengePoint: string;
  readonly responseResolution: string;
  readonly consensusReached: boolean;
  readonly escalatedToSupervisor: boolean;
  readonly optionAProposal: string;
  readonly optionBProposal: string;
  readonly createdAtIso: string;
}

export interface HumanDecisionDto {
  readonly decisionId: string;
  readonly runId: string;
  readonly snapshotId: string;
  readonly branchId: string;
  readonly stageId: string;
  readonly reviewerActor: string;
  readonly verdict: string;
  readonly comment: string;
  readonly createdAtIso: string;
}

export interface NegativeExperienceRecordDto {
  readonly recordId: string;
  readonly stageId: string;
  readonly desensitizedLesson: string;
  readonly createdAtIso: string;
}

export interface RagQueryMatchDto {
  readonly recordId: string;
  readonly stageId: string;
  readonly desensitizedLesson: string;
  readonly similarityScore: number;
}

/** A4：单条模型能力基线体检报告 */
export interface ModelBaselineReportDto {
  readonly tier: string;
  readonly modelIdentifier: string;
  readonly jsonSchemaAdherencePassed: boolean;
  readonly requiredKeysVerified: ReadonlyArray<string>;
  readonly missingKeys: ReadonlyArray<string>;
  readonly desensitizationActive: boolean;
  readonly recommendation: string;
  readonly taskName?: string;
}

/** A4：模型体检汇总（offline = 未启用在线网关，未执行） */
export interface ModelBaselineCheckDto {
  readonly offline: boolean;
  readonly reports: ReadonlyArray<ModelBaselineReportDto>;
}

export interface RetrospectiveDiagnosisDto {
  readonly metricName: string;
  readonly targetThreshold: string;
  readonly observedValue: string;
  readonly passedSla: boolean;
  readonly optimizationAction: string;
}

export interface RetrospectiveReportDto {
  readonly overallHealthy: boolean;
  readonly costSavingsRatioPercent: number;
  readonly cacheMetrics: {
    readonly cacheHitRatePercent: number;
    readonly totalHits: number;
    readonly totalLookups: number;
    readonly savedTokensTotal: number;
  };
  readonly fulfillmentMetrics: {
    readonly fulfillmentRatePercent: number;
    readonly firstPassSuccessRatePercent: number;
    readonly averageRetriesPerInvocation: number;
    readonly totalCostUsd: number;
    readonly retryDistribution: {
      readonly zeroRetries: number;
      readonly oneRetry: number;
      readonly twoOrMoreRetries: number;
    };
  };
  readonly diagnoses: ReadonlyArray<RetrospectiveDiagnosisDto>;
}

export interface AuditEntryDto {
  readonly entryId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly stageId: string;
  readonly actor: string;
  readonly actionType: string;
  readonly summary: string;
  readonly timestampIso: string;
}

/**
 * Agent 生命周期实时事件 (对应后端 WorkflowDomainEvent，经 liveInteractionStream 下发)
 */
export interface WorkflowDomainEventDto {
  readonly eventId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly stageId: string;
  readonly agentRole: string;
  readonly lifecycleState: string;
  readonly headline: string;
  readonly detailPayload: Readonly<Record<string, unknown>>;
  readonly timestampIso: string;
}

export interface RunSummaryDto {
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
  readonly initiatorActor: string;
  readonly workflowTemplateId?: string;
  readonly status: string;
  readonly activeBranchId: string;
  readonly branches: ReadonlyArray<string>;
  readonly currentStageId: string | null;
  readonly currentStageIndex: number;
  readonly coreRequirementIds?: ReadonlyArray<string>;
  readonly requirementDescriptions?: Readonly<Record<string, string>>;
  readonly involvesDatabaseMigration?: boolean;
  readonly involvesPermissionOrPayment?: boolean;
  readonly snapshots: ReadonlyArray<SnapshotRecordDto>;
}

export interface DashboardStateDto {
  readonly hasActiveRun: boolean;
  readonly stagePipelineOrder: ReadonlyArray<string>;
  readonly rbacContext?: RbacContextDto;
  readonly allRunsList?: ReadonlyArray<RunListItemDto>;
  readonly run?: RunSummaryDto;
  readonly notifications?: ReadonlyArray<NotificationDto>;
  readonly negotiationLogs?: ReadonlyArray<NegotiationTurnDto>;
  readonly humanDecisions?: ReadonlyArray<HumanDecisionDto>;
  readonly teamComments?: ReadonlyArray<TeamCommentDto>;
  readonly negativeExperienceRecords?: ReadonlyArray<NegativeExperienceRecordDto>;
  readonly auditTimeline?: ReadonlyArray<AuditEntryDto>;
  readonly liveInteractionStream?: ReadonlyArray<WorkflowDomainEventDto>;
  readonly retrospectiveReport?: RetrospectiveReportDto;
  readonly workflowDslSummary?: {
    readonly workflowId: string;
    readonly workflowName: string;
    readonly deploymentMode: string;
    readonly activeTemplateFile: string;
    readonly stageCount: number;
    readonly maxNegotiationTurns: number;
    readonly highRiskScoreThreshold: number;
    readonly rawYamlSnapshot?: string;
  };
  readonly sandboxWorkspaceSummary?: {
    readonly activeWorktreeBranch: string;
    readonly worktreePath: string;
    readonly generatedFiles: ReadonlyArray<{
      readonly relativePath: string;
      readonly sizeBytes: number;
      readonly previewSnippet: string;
    }>;
    readonly latestTestCommandOutput: string;
  };
  readonly persistenceSummary?: {
    readonly storageDriver: string;
    readonly persistedRunsCount: number;
    readonly persistedSnapshotsCount: number;
    readonly negativeExperienceLessonsCount: number;
    readonly lastSyncedAtIso: string;
  };
}

/** 流程图单个阶段节点的渲染输入 */
export interface FlowNodeInput {
  readonly stageId: string;
  readonly activeBranchSnapshot: SnapshotRecordDto | null;
  readonly supersededVersionCount: number;
  readonly rejectedCount: number;
  readonly hasPendingGateNotification: boolean;
}

/** PM↔PD 协商弧线提示 */
export interface FlowNegotiationHint {
  readonly turnIndex: number;
  readonly maxTurnsAllowed: number;
  readonly escalated: boolean;
}
