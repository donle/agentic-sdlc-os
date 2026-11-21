/**
 * @file WorkflowOrchestratorFacade.ts
 * @description 外观模式 (Facade Pattern) 实现的多智能体研发协同管理总控门面。
 *
 * 将以下子系统组装为统一、内聚的面向对象服务接口：
 * 1. `DagWorkflowStateEngine` (DAG 状态机、不可变快照、分叉回退)
 * 2. 六大专业职能 Agent (`PM`, `PD`, `TechLead`, `Engineer`, `QA`, `DA`) + `SupervisorAgent`
 * 3. `BoundedNegotiationMediator` (受限轮次协商与超限熔断)
 * 4. `RiskEvaluationPipeline` (基于业务风险的动态门禁评估责任链)
 * 5. `PromptCacheManager` & `IntentFulfillmentTracker` & `RetrospectiveTaskRunner` (成本控制与复盘检测)
 * 6. `ImmutableAuditLedger` & `WorkflowEventBus` (全链路审计账本与实时前端通知推送)
 */

import { AbstractWorkerAgent, AgentExecutionInputContext } from '../agents/AbstractWorkerAgent.ts';
import { BoundedNegotiationMediator } from '../agents/BoundedNegotiationMediator.ts';
import { DataAnalystAgent } from '../agents/DataAnalystAgent.ts';
import { ProductDesignerAgent } from '../agents/ProductDesignerAgent.ts';
import { ProductManagerAgent } from '../agents/ProductManagerAgent.ts';
import { QualityAssuranceAgent } from '../agents/QualityAssuranceAgent.ts';
import { SoftwareEngineerAgent } from '../agents/SoftwareEngineerAgent.ts';
import { EscalateConflictToHumanCommand, SupervisorAgent } from '../agents/SupervisorAgent.ts';
import { TechLeadAgent } from '../agents/TechLeadAgent.ts';
import { ProjectProposalContract, UiDesignArtifactContract } from '../domain/contracts.ts';
import {
  AgentRole,
  DecisionVerdict,
  GateActionType,
  NotificationCategory,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../domain/enums.ts';
import {
  AgentUserNotification,
  HumanDecisionRecord,
  StageSnapshotMemento,
  StageTeamCommentRecord,
  type TeamCommentCategory,
} from '../domain/models.ts';
import { WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelEndpointDescriptor, ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import { RiskEvaluationContext, RiskEvaluationPipeline } from '../patterns/RiskEvaluationChain.ts';
import { GitWorktreeSandboxManager } from '../sandbox/GitWorktreeSandboxManager.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  RetrospectiveEvaluationReport,
  RetrospectiveTaskRunner,
} from '../telemetry/RetrospectiveTaskRunner.ts';
import { DagWorkflowStateEngine, WorkflowRunState } from './DagWorkflowStateEngine.ts';
import { ImmutableAuditLedger } from './ImmutableAuditLedger.ts';
import { PersistenceRepository } from './PersistenceRepository.ts';
import { RbacGovernanceService } from './RbacGovernanceService.ts';
import { WorkflowDslConfiguration, WorkflowDslLoader } from './WorkflowDslLoader.ts';

export class WorkflowOrchestratorFacade {
  public readonly eventBus: WorkflowEventBus;
  public readonly persistenceRepo: PersistenceRepository;
  public readonly sandboxManager: GitWorktreeSandboxManager;
  public readonly rbacService: RbacGovernanceService;
  public readonly auditLedger: ImmutableAuditLedger;
  public readonly cacheManager: PromptCacheManager;
  public readonly fulfillmentTracker: IntentFulfillmentTracker;
  public readonly modelRouter: ModelRouterGateway;
  public readonly falseConsensusGuard: FalseConsensusGuard;
  public readonly riskPipeline: RiskEvaluationPipeline;
  public readonly negotiationMediator: BoundedNegotiationMediator;
  public readonly supervisorAgent: SupervisorAgent;
  public readonly stateEngine: DagWorkflowStateEngine;
  public readonly retrospectiveRunner: RetrospectiveTaskRunner;
  private dslConfig: WorkflowDslConfiguration;
  private readonly agentRegistry: Map<WorkflowStageId, AbstractWorkerAgent>;
  private readonly teamComments: StageTeamCommentRecord[];

  public constructor(params?: {
    maxNegotiationTurns?: number;
    highRiskThreshold?: number;
    dslConfigPath?: string;
    dslConfiguration?: WorkflowDslConfiguration;
    persistenceDir?: string;
    sandboxRootDir?: string;
  }) {
    this.dslConfig =
      params?.dslConfiguration ?? WorkflowDslLoader.loadFromFile(params?.dslConfigPath);

    this.persistenceRepo = new PersistenceRepository(params?.persistenceDir);
    this.sandboxManager = new GitWorktreeSandboxManager(params?.sandboxRootDir);
    this.rbacService = new RbacGovernanceService();
    this.eventBus = new WorkflowEventBus();
    this.auditLedger = new ImmutableAuditLedger(this.persistenceRepo);
    this.eventBus.registerObserver(this.auditLedger);

    this.cacheManager = new PromptCacheManager(this.dslConfig.guardrails.enableSemanticCache);
    this.fulfillmentTracker = new IntentFulfillmentTracker();
    this.modelRouter = new ModelRouterGateway();
    for (const [tier, cfg] of this.dslConfig.modelRouting.entries()) {
      this.modelRouter.registerEndpoint(
        new ModelEndpointDescriptor({
          tier,
          providerName: cfg.provider,
          modelIdentifier: cfg.modelName,
          costPer1kTokensUsd: cfg.costPer1kTokensUsd,
          isLocalPrivateModel: cfg.provider.toLowerCase().includes('local'),
        }),
      );
    }

    this.falseConsensusGuard = new FalseConsensusGuard();
    this.riskPipeline = new RiskEvaluationPipeline(
      params?.highRiskThreshold ?? this.dslConfig.guardrails.highRiskScoreThreshold,
    );
    this.negotiationMediator = new BoundedNegotiationMediator(
      this.eventBus,
      params?.maxNegotiationTurns ?? this.dslConfig.guardrails.maxNegotiationTurns,
    );
    this.supervisorAgent = new SupervisorAgent(this.eventBus);
    this.stateEngine = new DagWorkflowStateEngine();
    this.retrospectiveRunner = new RetrospectiveTaskRunner({
      cacheManager: this.cacheManager,
      fulfillmentTracker: this.fulfillmentTracker,
    });

    const sharedAgentDeps = {
      eventBus: this.eventBus,
      cacheManager: this.cacheManager,
      fulfillmentTracker: this.fulfillmentTracker,
      modelRouter: this.modelRouter,
      falseConsensusGuard: this.falseConsensusGuard,
      sandboxManager: this.sandboxManager,
    };

    this.agentRegistry = new Map<WorkflowStageId, AbstractWorkerAgent>([
      [WorkflowStageId.STAGE_1_PM, new ProductManagerAgent(sharedAgentDeps)],
      [WorkflowStageId.STAGE_2_PD, new ProductDesignerAgent(sharedAgentDeps)],
      [WorkflowStageId.STAGE_3A_TECH_SPEC, new TechLeadAgent(sharedAgentDeps)],
      [WorkflowStageId.STAGE_3B_ENGINEER, new SoftwareEngineerAgent(sharedAgentDeps)],
      [WorkflowStageId.STAGE_4_QA, new QualityAssuranceAgent(sharedAgentDeps)],
      [WorkflowStageId.STAGE_5_DA, new DataAnalystAgent(sharedAgentDeps)],
    ]);
    this.teamComments = [];
  }

  public addTeamComment(params: {
    runId: string;
    stageId: WorkflowStageId;
    actorUserId: string;
    content: string;
    category?: TeamCommentCategory;
  }): StageTeamCommentRecord {
    const user = this.rbacService.getUserOrDefault(params.actorUserId);
    const comment = new StageTeamCommentRecord({
      commentId: `CMT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      runId: params.runId,
      stageId: params.stageId,
      authorUserId: user.userId,
      authorName: user.displayName,
      authorJobTitle: user.jobTitle,
      authorBadge: user.avatarBadge,
      content: params.content,
      category: params.category ?? 'COMMENT',
    });
    this.teamComments.push(comment);
    return comment;
  }

  public getTeamComments(
    runId: string,
    stageId?: WorkflowStageId,
  ): ReadonlyArray<StageTeamCommentRecord> {
    return this.teamComments.filter(
      (c) => c.runId === runId && (stageId === undefined || c.stageId === stageId),
    );
  }

  private seedInitialTeamCommentsForRun(runState: WorkflowRunState): void {
    const runId = runState.runId;
    const reqList = runState.proposal.coreRequirementIds.join(', ');
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_1_PM,
      actorUserId: 'user-pm-01',
      content: `已完成《${runState.proposal.title}》核心需求（${reqList}）与埋点事件对齐，请各位同事在各环节评审时重点关注权限边界与响应耗时。`,
      category: 'COMMENT',
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_1_PM,
      actorUserId: 'user-tech-01',
      content:
        '收到，架构组已审阅 Stage 1 的非功能性约束，后续在 Stage 3a 会同步设计多租户 RBAC 索引与幂等防重机制。',
      category: 'COMMENT',
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_2_PD,
      actorUserId: 'user-pd-01',
      content:
        'PD Agent 评估三维实时画布在移动端存在首屏性能瓶颈，我倾向于采纳方案 A（企业标准双栏折叠抽屉组件），既符合现有设计系统又不会拖慢排期。',
      category: 'COMMENT',
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      actorUserId: 'user-eng-01',
      content:
        '研发侧已预检接口契约，一旦架构师签核完 Stage 3a 的表结构变更，Engineer Agent 即可在独立 Worktree 分支落盘领域服务代码。',
      category: 'COMMENT',
    });
  }

  public getWorkflowDslConfig(): WorkflowDslConfiguration {
    return this.dslConfig;
  }

  public reloadWorkflowDsl(dslOrPath: WorkflowDslConfiguration | string): WorkflowDslConfiguration {
    this.dslConfig =
      typeof dslOrPath === 'string' ? WorkflowDslLoader.loadFromFile(dslOrPath) : dslOrPath;
    return this.dslConfig;
  }

  /**
   * 发起新研发提案并自动推进流水线，直到遇到高风险/冲突人工门禁或全部完成
   */
  public startProposalWorkflow(params: {
    proposal: ProjectProposalContract;
    initiatorActor: string;
    simulateTransientRetryOnStage1?: boolean;
  }): WorkflowRunState {
    const validation = params.proposal.validateContractIntegrity();
    if (!validation.isValid()) {
      throw new Error(`提案契约校验不通过：${validation.getViolations().join('; ')}`);
    }

    const runId = `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const runState = this.stateEngine.createRun({
      runId,
      proposal: params.proposal,
      initiatorActor: params.initiatorActor,
      stagePipeline: this.dslConfig.getStageOrder(),
      workflowTemplateId: this.dslConfig.id,
    });

    this.seedInitialTeamCommentsForRun(runState);

    this.continueExecutionUntilGateOrComplete(
      runId,
      Boolean(params.simulateTransientRetryOnStage1),
    );
    return runState;
  }

  /**
   * 持续推进当前活跃分支的下一个阶段，直至触发高风险门禁/冲突熔断暂停，或全部阶段跑完
   */
  public continueExecutionUntilGateOrComplete(
    runId: string,
    simulateTransientRetryOnFirstStage = false,
  ): WorkflowRunState {
    const runState = this.stateEngine.getRunOrThrow(runId);

    while (runState.getStatus() === 'RUNNING') {
      const currentStageId = runState.getCurrentStageId();
      if (currentStageId === null) {
        runState.setStatus('COMPLETED');
        break;
      }

      const workerAgent = this.agentRegistry.get(currentStageId);
      if (!workerAgent) {
        throw new Error(`阶段 [${currentStageId}] 未注册对应的职能 Agent`);
      }

      const parentSnapshot = runState.getLatestSnapshotOnActiveBranch();
      const rollbackDirective = runState.consumePendingRollbackDirective();
      const historicalLessons = this.auditLedger.getRejectionLessonsForStage(
        currentStageId,
        `${runState.proposal.title} ${runState.proposal.summary}`,
      );

      const inputContext = new AgentExecutionInputContext({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        proposal: runState.proposal,
        upstreamArtifacts: runState.getApprovedUpstreamArtifactsMap(),
        historicalRejectionLessons: historicalLessons,
        humanFeedbackDirective: rollbackDirective,
        forceTransientRetryOnce:
          simulateTransientRetryOnFirstStage && currentStageId === WorkflowStageId.STAGE_1_PM,
      });

      const executionOutcome = workerAgent.executeStagePipeline(inputContext);

      // 检查是否需要触发受限轮次协商（如 Stage 2 PD 发现交互冲突向 Stage 1 PM 发起质询）
      let negotiationEscalated = false;
      let deadlockedTurn = null;
      if (
        currentStageId === WorkflowStageId.STAGE_2_PD &&
        executionOutcome.artifact instanceof UiDesignArtifactContract &&
        executionOutcome.artifact.designChallengeNote !== null
      ) {
        const negResult = this.negotiationMediator.mediateChallenge({
          runId: runState.runId,
          branchId: runState.getActiveBranchId(),
          stageId: currentStageId,
          challengerRole: AgentRole.PRODUCT_DESIGNER,
          responderRole: AgentRole.PRODUCT_MANAGER,
          initialChallengePoint: executionOutcome.artifact.designChallengeNote,
          forceDeadlockToMaxTurns:
            runState.proposal.simulateNegotiationConflict && !rollbackDirective,
        });
        negotiationEscalated = negResult.escalatedToSupervisor;
        deadlockedTurn = negResult.latestTurn;
      }

      // 根据 YAML DSL 的 gatePolicy 动态判断是否强制阻塞等待人工签核
      const forceHumanGateForStage = this.dslConfig.isForceHumanGate(currentStageId);

      const riskVerdict = this.riskPipeline.evaluate(
        new RiskEvaluationContext({
          stageId: currentStageId,
          proposal: runState.proposal,
          artifact: executionOutcome.artifact,
          scopeDiff: executionOutcome.scopeDiffReport,
          negotiationEscalated,
          forceHumanGateForStage,
        }),
      );

      const shouldBlockForHuman =
        riskVerdict.gateAction === GateActionType.BLOCK_FOR_CONFLICT_ARBITRATION ||
        riskVerdict.gateAction === GateActionType.BLOCK_FOR_HUMAN_VERIFICATION;

      const snapshot = new StageSnapshotMemento({
        snapshotId: `SNAP-${currentStageId.replace('STAGE_', '')}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        runId: runState.runId,
        parentSnapshotId: parentSnapshot ? parentSnapshot.snapshotId : null,
        branchId: runState.getActiveBranchId(),
        stageId: currentStageId,
        agentRole: workerAgent.role,
        modelUsed: executionOutcome.modelUsed,
        artifact: executionOutcome.artifact,
        riskScore: riskVerdict.riskScore,
        riskLevel: riskVerdict.riskLevel,
        riskReasons: riskVerdict.reasons,
        gateAction: riskVerdict.gateAction,
        scopeDiffReport: executionOutcome.scopeDiffReport,
        cacheHit: executionOutcome.cacheHit,
        retryCount: executionOutcome.retryCount,
        tokensConsumed: executionOutcome.tokensConsumed,
        initialState: shouldBlockForHuman
          ? SnapshotLifecycleState.PENDING_HUMAN_GATE
          : SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK,
      });

      runState.appendSnapshot(snapshot);

      if (shouldBlockForHuman) {
        runState.setStatus('PAUSED_AT_HUMAN_GATE');
        if (
          riskVerdict.gateAction === GateActionType.BLOCK_FOR_CONFLICT_ARBITRATION &&
          deadlockedTurn !== null
        ) {
          this.supervisorAgent.executeCommand(
            new EscalateConflictToHumanCommand({
              eventBus: this.eventBus,
              snapshot,
              deadlockedTurn,
            }),
          );
        } else {
          this.supervisorAgent.notifyHumanVerificationRequired(snapshot);
        }
        break;
      }

      // 低风险自动放行：强制写入责任追踪账本并发送留痕提醒
      this.auditLedger.recordDecision(
        new HumanDecisionRecord({
          decisionId: `DEC-AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          runId: runState.runId,
          snapshotId: snapshot.snapshotId,
          branchId: snapshot.branchId,
          stageId: snapshot.stageId,
          reviewerActor: 'SYSTEM_RISK_POLICY_ENGINE (Low-Risk Auto-Pass)',
          verdict: DecisionVerdict.AUTO_PASS_LOW_RISK,
          comment: `风险评分 ${snapshot.riskScore}/100 低于阻塞阈值，自动放行并留存快照审计痕迹`,
        }),
      );
      this.supervisorAgent.notifyLowRiskAutoPassed(snapshot);
      runState.advanceToNextStage();
    }

    this.syncPersistenceState();
    return runState;
  }

  private syncPersistenceState(): void {
    this.persistenceRepo.persistFullState({
      runs: this.stateEngine.getAllRuns(),
      negotiationLogs: this.negotiationMediator.getNegotiationHistory(),
      humanDecisions: this.auditLedger.getHumanDecisions(),
      negativeExperienceRecords: this.auditLedger.ragEngine.getAllRecords(),
    });
  }

  /**
   * 人工在前端审核门禁或冲突裁决台提交决定（批准 / 选方案 A / 选方案 B / 驳回重做）
   * 若传入 actorUserId，强制执行 RBAC 阶段专长责任人或顶层管理员权限校验。
   */
  public submitHumanGateDecision(params: {
    runId: string;
    snapshotId: string;
    reviewerActor: string;
    actorUserId?: string;
    verdict: DecisionVerdict;
    comment: string;
  }): WorkflowRunState {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const snapshot = runState.findSnapshotById(params.snapshotId);
    if (!snapshot) {
      throw new Error(`未找到待审核快照 [${params.snapshotId}]`);
    }

    let effectiveReviewerLabel = params.reviewerActor;
    if (params.actorUserId) {
      const authResult = this.rbacService.assertCanApproveStageGate(
        params.actorUserId,
        snapshot.stageId,
      );
      effectiveReviewerLabel = authResult.formattedActorLabel;
    }

    this.auditLedger.recordDecision(
      new HumanDecisionRecord({
        decisionId: `DEC-HUMAN-${Date.now()}`,
        runId: params.runId,
        snapshotId: params.snapshotId,
        branchId: snapshot.branchId,
        stageId: snapshot.stageId,
        reviewerActor: effectiveReviewerLabel,
        verdict: params.verdict,
        comment: params.comment,
      }),
    );

    this.addTeamComment({
      runId: params.runId,
      stageId: snapshot.stageId,
      actorUserId: params.actorUserId ?? 'user-admin-01',
      content: `[步骤签核决定: ${params.verdict}] ${params.comment}`,
      category: params.verdict === DecisionVerdict.REJECT ? 'REVISION_REQUEST' : 'APPROVAL_NOTE',
    });

    this.eventBus.resolveNotificationBySnapshotId(params.snapshotId);

    if (
      params.verdict === DecisionVerdict.APPROVE ||
      params.verdict === DecisionVerdict.ARBITRATE_OPTION_A ||
      params.verdict === DecisionVerdict.ARBITRATE_OPTION_B
    ) {
      snapshot.transitionState(SnapshotLifecycleState.APPROVED);
      runState.advanceToNextStage();
      return this.continueExecutionUntilGateOrComplete(params.runId, false);
    }

    // 若人工选择驳回（REJECT），自动委托总管 Agent 在当前阶段执行 Fork 回退重做
    snapshot.transitionState(SnapshotLifecycleState.REJECTED);
    return this.invokeSupervisorConversationalRollback({
      runId: params.runId,
      humanActor: effectiveReviewerLabel,
      actorUserId: params.actorUserId,
      dialogueInstruction: `人工门禁驳回重做：${params.comment}`,
      explicitTargetStageId: snapshot.stageId,
    });
  }

  /**
   * 人类与总管 Agent (SupervisorAgent) 对话，回退到任意指定阶段与职能 Agent 重新执行
   */
  public invokeSupervisorConversationalRollback(params: {
    runId: string;
    humanActor: string;
    actorUserId?: string;
    dialogueInstruction: string;
    explicitTargetStageId?: WorkflowStageId;
  }): WorkflowRunState {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const parsedDirective = this.supervisorAgent.parseNaturalLanguageRollback(
      params.dialogueInstruction,
      params.explicitTargetStageId,
    );

    let effectiveActor = params.humanActor;
    if (params.actorUserId) {
      const user = this.rbacService.assertCanInvokeRollback(
        params.actorUserId,
        parsedDirective.targetStageId,
      );
      effectiveActor = `${user.displayName} (${user.jobTitle})`;
    }

    const forkOutcome = runState.forkAndRollbackToStage(
      parsedDirective.targetStageId,
      parsedDirective.cleanInstruction,
    );

    this.auditLedger.recordDecision(
      new HumanDecisionRecord({
        decisionId: `DEC-ROLLBACK-${Date.now()}`,
        runId: params.runId,
        snapshotId: forkOutcome.supersededSnapshotIds[0] ?? 'ROOT',
        branchId: forkOutcome.newBranchId,
        stageId: parsedDirective.targetStageId,
        reviewerActor: `${effectiveActor} (via SupervisorAgent)`,
        verdict: DecisionVerdict.SUPERVISOR_ROLLBACK,
        comment: `通过总管 Agent 对话回退至 [${parsedDirective.targetStageId} / ${parsedDirective.targetAgentRole}]，从旧分支 [${forkOutcome.previousBranchId}] 分叉创建新分支 [${forkOutcome.newBranchId}]，废弃旧快照 ${forkOutcome.supersededSnapshotIds.length} 个。指令：${parsedDirective.cleanInstruction}`,
      }),
    );

    this.addTeamComment({
      runId: params.runId,
      stageId: parsedDirective.targetStageId,
      actorUserId: params.actorUserId ?? 'user-admin-01',
      content: `[总管调度回退至本步骤 -> 新分支 ${forkOutcome.newBranchId}] 团队修改指令：${parsedDirective.cleanInstruction}`,
      category: 'REVISION_REQUEST',
    });

    this.eventBus.publishNotification(
      new AgentUserNotification({
        notificationId: `NOTIF-RB-${Date.now()}`,
        runId: params.runId,
        branchId: forkOutcome.newBranchId,
        stageId: parsedDirective.targetStageId,
        senderRole: AgentRole.SUPERVISOR,
        category: NotificationCategory.ROLLBACK_EXECUTED,
        title: `【总管回退已执行】已分叉新分支 [${forkOutcome.newBranchId}] 并唤醒 ${parsedDirective.targetAgentRole}`,
        message: `旧分支 [${forkOutcome.previousBranchId}] 下游 ${forkOutcome.supersededSnapshotIds.length} 个快照已标记为 SUPERSEDED；正在按新指令重新执行：${parsedDirective.cleanInstruction}`,
        relatedSnapshotId: forkOutcome.forkedFromParentSnapshotId ?? 'ROOT',
        requiresHumanAction: false,
      }),
    );

    return this.continueExecutionUntilGateOrComplete(params.runId, false);
  }

  /**
   * 【最上层管理员专属】动态调整系统工作流治理参数（最大协商轮次、高风险分数阈值、跨阶段回退策略）
   */
  public updateAdminGovernanceConfig(params: {
    actorUserId: string;
    maxNegotiationTurns?: number;
    highRiskScoreThreshold?: number;
    allowSpecialistCrossStageRollback?: boolean;
  }): {
    readonly updatedBy: string;
    readonly maxNegotiationTurns: number;
    readonly highRiskScoreThreshold: number;
    readonly allowSpecialistCrossStageRollback: boolean;
  } {
    const adminUser = this.rbacService.assertIsProjectAdmin(params.actorUserId);

    if (typeof params.maxNegotiationTurns === 'number') {
      this.negotiationMediator.setMaxNegotiationTurns(params.maxNegotiationTurns);
    }
    if (typeof params.highRiskScoreThreshold === 'number') {
      this.riskPipeline.setHighRiskThreshold(params.highRiskScoreThreshold);
    }
    if (typeof params.allowSpecialistCrossStageRollback === 'boolean') {
      this.rbacService.setAllowSpecialistCrossStageRollback(
        params.allowSpecialistCrossStageRollback,
      );
    }

    this.syncPersistenceState();

    return {
      updatedBy: `${adminUser.displayName} (${adminUser.jobTitle})`,
      maxNegotiationTurns: this.negotiationMediator.getMaxNegotiationTurns(),
      highRiskScoreThreshold: this.riskPipeline.getHighRiskThreshold(),
      allowSpecialistCrossStageRollback:
        this.rbacService.isCrossStageRollbackAllowedForSpecialists(),
    };
  }

  /**
   * 触发复盘与成本控制指标检测任务
   */
  public runRetrospectiveEvaluation(): RetrospectiveEvaluationReport {
    return this.retrospectiveRunner.executeRetrospectiveCheck();
  }

  /**
   * 组装前端多视图协同系统所需的完整实时状态快照（含共享工作流视图与当前用户的 RBAC 权限上下文）
   */
  public buildWorkbenchDashboardState(
    runId?: string,
    actorUserId = 'user-admin-01',
  ): Record<string, unknown> {
    const allRuns = this.stateEngine.getAllRuns();
    const targetRun = runId ? this.stateEngine.getRunOrThrow(runId) : allRuns[allRuns.length - 1];

    const currentUser = this.rbacService.getUserOrDefault(actorUserId);
    const stageAccessMatrix = this.rbacService.evaluateAllStagesForUser(currentUser.userId);
    const rbacContext = {
      currentUser: currentUser.toSerializableRecord(),
      roster: this.rbacService.getAllUsers().map((u) => u.toSerializableRecord()),
      stageAccessMatrix,
      allowSpecialistCrossStageRollback:
        this.rbacService.isCrossStageRollbackAllowedForSpecialists(),
    };

    const allRunsList = allRuns.map((r) => ({
      runId: r.runId,
      title: r.proposal.title,
      summary: r.proposal.summary,
      status: r.getStatus(),
      activeBranchId: r.getActiveBranchId(),
      workflowTemplateId: r.workflowTemplateId,
      initiatorActor: r.initiatorActor,
      currentStageId: r.getCurrentStageId(),
      completedStagesCount: r.getActiveBranchSnapshots().length,
      totalStagesCount: r.getStagePipeline().length,
      commentsCount: this.getTeamComments(r.runId).length,
      createdAtIso: r.createdAtIso,
    }));

    const retrospectiveReport = this.runRetrospectiveEvaluation();
    const workflowDslSummary = {
      workflowId: this.dslConfig.id,
      workflowName: this.dslConfig.name,
      deploymentMode: this.dslConfig.deploymentMode,
      activeTemplateFile: this.dslConfig.sourceFilePath,
      stageCount: this.dslConfig.stages.length,
      maxNegotiationTurns: this.negotiationMediator.getMaxNegotiationTurns(),
      highRiskScoreThreshold: this.riskPipeline.getHighRiskThreshold(),
      rawYamlSnapshot: this.dslConfig.rawYamlSnapshot,
    };
    const totalSnapshotsCount = allRuns.reduce((acc, r) => acc + r.getAllSnapshots().length, 0);
    const persistenceSummary = {
      storageDriver: 'Dual-Mode (Local JSONL WAL + PostgreSQL 16 pgvector SQL Sync)',
      persistedRunsCount: allRuns.length,
      persistedSnapshotsCount: totalSnapshotsCount,
      negativeExperienceLessonsCount: this.auditLedger.ragEngine.getAllRecords().length,
      lastSyncedAtIso: this.persistenceRepo.getLastSyncedAtIso(),
    };

    if (!targetRun) {
      return {
        hasActiveRun: false,
        stagePipelineOrder: this.dslConfig.getStageOrder(),
        rbacContext,
        allRunsList,
        workflowDslSummary,
        persistenceSummary,
        retrospectiveReport,
      };
    }

    const sandboxWorkspaceSummary = this.sandboxManager.getWorkspaceSummary(
      targetRun.runId,
      targetRun.getActiveBranchId(),
    );

    return {
      hasActiveRun: true,
      stagePipelineOrder: targetRun.getStagePipeline(),
      rbacContext,
      allRunsList,
      workflowDslSummary,
      persistenceSummary,
      sandboxWorkspaceSummary,
      run: {
        runId: targetRun.runId,
        title: targetRun.proposal.title,
        summary: targetRun.proposal.summary,
        initiatorActor: targetRun.initiatorActor,
        workflowTemplateId: targetRun.workflowTemplateId,
        status: targetRun.getStatus(),
        activeBranchId: targetRun.getActiveBranchId(),
        branches: targetRun.getBranches(),
        currentStageId: targetRun.getCurrentStageId(),
        currentStageIndex: targetRun.getCurrentStageIndex(),
        coreRequirementIds: targetRun.proposal.coreRequirementIds,
        requirementDescriptions: targetRun.proposal.requirementDescriptions,
        involvesDatabaseMigration: targetRun.proposal.involvesDatabaseMigration,
        involvesPermissionOrPayment: targetRun.proposal.involvesPermissionOrPayment,
        snapshots: targetRun.getAllSnapshots().map((s) => s.toSerializableRecord()),
      },
      notifications: this.eventBus.getNotificationInbox(targetRun.runId).map((n) => ({
        notificationId: n.notificationId,
        runId: n.runId,
        branchId: n.branchId,
        stageId: n.stageId,
        senderRole: n.senderRole,
        category: n.category,
        title: n.title,
        message: n.message,
        relatedSnapshotId: n.relatedSnapshotId,
        requiresHumanAction: n.requiresHumanAction,
        resolved: n.isResolved(),
        actionOptions: n.actionOptions,
        createdAtIso: n.createdAtIso,
        accessEvaluation: this.rbacService.evaluateStageAccess(currentUser.userId, n.stageId),
      })),
      liveInteractionStream: this.eventBus.getEventHistory(targetRun.runId).slice(-40).reverse(),
      negotiationLogs: this.negotiationMediator.getNegotiationHistory(targetRun.runId),
      humanDecisions: this.auditLedger.getHumanDecisions(targetRun.runId),
      teamComments: this.getTeamComments(targetRun.runId),
      negativeExperienceRecords: this.auditLedger.ragEngine.getAllRecords(),
      auditTimeline: this.auditLedger.getAuditTimeline(targetRun.runId).slice(-40).reverse(),
      retrospectiveReport,
    };
  }
}
