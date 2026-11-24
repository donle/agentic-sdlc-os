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

import {
  AbstractWorkerAgent,
  AgentExecutionInputContext,
  AgentExecutionOutcome,
  StageContractError,
  TokenBudgetExceededError,
} from '../agents/AbstractWorkerAgent.ts';
import { BoundedNegotiationMediator } from '../agents/BoundedNegotiationMediator.ts';
import { JsonExtractor } from '../agents/prompt/JsonExtractor.ts';
import { DataAnalystAgent } from '../agents/DataAnalystAgent.ts';
import { ProductDesignerAgent } from '../agents/ProductDesignerAgent.ts';
import { ProductManagerAgent } from '../agents/ProductManagerAgent.ts';
import { QualityAssuranceAgent } from '../agents/QualityAssuranceAgent.ts';
import { SoftwareEngineerAgent } from '../agents/SoftwareEngineerAgent.ts';
import { EscalateConflictToHumanCommand, SupervisorAgent } from '../agents/SupervisorAgent.ts';
import { TechLeadAgent } from '../agents/TechLeadAgent.ts';
import {
  PrdArtifactContract,
  ProjectProposalContract,
  QaVerificationArtifactContract,
  TechSpecArtifactContract,
  UiDesignArtifactContract,
} from '../domain/contracts.ts';
import {
  AgentRole,
  DecisionVerdict,
  GateActionType,
  ModelRoutingTier,
  NotificationCategory,
  SnapshotLifecycleState,
  WorkflowStageId,
} from '../domain/enums.ts';
import type { ScenarioHints } from '../domain/scenario.ts';
import {
  AgentUserNotification,
  HumanDecisionRecord,
  StageSnapshotMemento,
  StageTeamCommentRecord,
  type TeamCommentCategory,
} from '../domain/models.ts';
import * as fs from 'node:fs';
import { WorkflowDomainEvent, WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelEndpointDescriptor, ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import { RiskEvaluationContext, RiskEvaluationPipeline } from '../patterns/RiskEvaluationChain.ts';
import { GitWorktreeSandboxManager } from '../sandbox/GitWorktreeSandboxManager.ts';
import { GatewayEmbeddingProvider } from '../telemetry/EmbeddingProvider.ts';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  RetrospectiveEvaluationReport,
  RetrospectiveTaskRunner,
} from '../telemetry/RetrospectiveTaskRunner.ts';
import { DagWorkflowStateEngine, WorkflowRunState } from './DagWorkflowStateEngine.ts';
import { ImmutableAuditLedger } from './ImmutableAuditLedger.ts';
import {
  type PersistedGovernanceConfig,
  PersistenceRepository,
  type PersistenceDriver,
} from './PersistenceRepository.ts';
import { RbacGovernanceService } from './RbacGovernanceService.ts';
import { WorkflowDslConfiguration, WorkflowDslLoader } from './WorkflowDslLoader.ts';
import { StateReconstructor } from './pg/StateReconstructor.ts';
import type { TrimmedContext } from '../agents/context/ContextBudgetTrimmer.ts';
import { DependencyVersionsProvider } from '../agents/context/DependencyVersionsProvider.ts';
import { ToolRegistry } from '../agents/context/ToolRegistry.ts';
import { GitContextProvider } from '../agents/context/GitContextProvider.ts';
import { McpContextProvider } from '../agents/context/McpContextProvider.ts';
import { FigmaStubProvider } from '../agents/context/StubProviders.ts';
import { createAnalyticsProvider } from '../agents/context/WarehouseQueryProvider.ts';
import { ALL_CONTEXT_NEED_TYPES, STAGE_CONTEXT_NEEDS } from '../agents/context/types.ts';
import type { ContextNeed } from '../agents/context/types.ts';

import { MAX_AUTO_REPAIRS } from './repairLoop.ts';

function appendImpersonationAttribution(actorLabel: string, impersonatedByLabel?: string): string {
  const cleanAdmin = impersonatedByLabel?.trim();
  if (!cleanAdmin) {
    return actorLabel;
  }
  const tag = `(via ${cleanAdmin})`;
  if (actorLabel.includes(tag)) {
    return actorLabel;
  }
  return `${actorLabel} ${tag}`;
}

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
  private activeRunIdAfterRestore: string | null = null;
  private contextRegistry: ToolRegistry | null = null;
  private readonly agentRegistry: Map<WorkflowStageId, AbstractWorkerAgent>;
  private readonly teamComments: StageTeamCommentRecord[];
  private readonly runExecutionLocks = new Map<string, Promise<void>>();

  public constructor(params?: {
    maxNegotiationTurns?: number;
    highRiskThreshold?: number;
    dslConfigPath?: string;
    dslConfiguration?: WorkflowDslConfiguration;
    persistenceDir?: string;
    sandboxRootDir?: string;
    databaseUrl?: string;
    persistenceDriver?: PersistenceDriver | null;
  }) {
    this.dslConfig =
      params?.dslConfiguration ?? WorkflowDslLoader.loadFromFile(params?.dslConfigPath);

    this.persistenceRepo = new PersistenceRepository(params?.persistenceDir, {
      databaseUrl: params?.databaseUrl,
      driver: params?.persistenceDriver,
    });
    this.sandboxManager = new GitWorktreeSandboxManager(params?.sandboxRootDir);
    this.rbacService = new RbacGovernanceService();
    this.eventBus = new WorkflowEventBus();
    this.modelRouter = new ModelRouterGateway();
    // G2：RAG 负向经验在 provider 在位时后台升级为真实 embedding（离线保持哈希降级）
    this.auditLedger = new ImmutableAuditLedger(
      this.persistenceRepo,
      new GatewayEmbeddingProvider(this.modelRouter),
    );
    this.eventBus.registerObserver(this.auditLedger);

    // G1：L2 语义缓存经网关 `/v1/embeddings` 取向量；端点不可用时平滑降级为仅 L1
    this.cacheManager = new PromptCacheManager(
      this.dslConfig.guardrails.enableSemanticCache,
      new GatewayEmbeddingProvider(this.modelRouter),
    );
    this.fulfillmentTracker = new IntentFulfillmentTracker();
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
    // B1 + Pillar 4：注入对抗式双上下文 + 无历史盲审裁判执行器（同时兼容旧单回合 JSON mock；离线降级剧本）
    this.negotiationMediator.setRoundRunner({
      runTurn: async (input) => {
        try {
          const historyText =
            input.previousTurns.length > 0
              ? `\n\n历史交锋记录：\n${input.previousTurns
                  .map(
                    (t) =>
                      `- 第 ${t.turnIndex} 轮 [${t.responderAction ?? 'PROPOSAL'}]: ${t.responseResolution}${
                        t.challengerCritique ? ` | 挑战方否决意见: ${t.challengerCritique}` : ''
                      }`,
                  )
                  .join('\n')}`
              : '';

          // Step A：响应方独立调用
          const responderLlm = await this.modelRouter.invokeChatCompletion({
            tier: 'HIGH_REASONING_HYBRID' as never,
            systemPrompt: `你是研发流水线受限协商中的响应方（${input.responder}）。
当前是第 ${input.turnIndex}/${input.maxTurns} 轮。挑战方：${input.challenger}，响应方：${input.responder}。
协商主题：${input.topic}。
强制纪律：必须保住核心业务需求与验收标准，严禁为了结束对话而私自删减功能或用占位词降级；若无法在不降级范围/不增工期的前提下解决分歧，必须选 ESCALATE_TRADEOFF 交由人类拍板。
仅输出 JSON：{"action":"ACCEPT_AND_PATCH|REBUT_WITH_EVIDENCE|ESCALATE_TRADEOFF","responseResolution":"回应内容","concretePatch":"具体修改方案","optionAProposal":"方案A","optionBProposal":"方案B"}`,
            userPrompt: `质询焦点：${input.challengeContext}${historyText}`,
            fallbackContentGenerator: () => '',
          });
          if (!responderLlm.usedLiveGateway) {
            return null;
          }
          const responderParsed = JsonExtractor.extract(responderLlm.content);
          if (!responderParsed.ok) {
            return null;
          }
          const parsed = responderParsed.value as Record<string, unknown>;
          let totalTokens = responderLlm.receipt.totalTokens;

          const rawAction = parsed.action;
          const isAdversarialProtocol =
            rawAction === 'ACCEPT_AND_PATCH' ||
            rawAction === 'REBUT_WITH_EVIDENCE' ||
            rawAction === 'ESCALATE_TRADEOFF';

          // 向后兼容旧版单调用 mock（返回 consensusReached 且不带 action）
          if (!isAdversarialProtocol) {
            if (
              typeof parsed.responseResolution !== 'string' ||
              parsed.responseResolution.trim().length === 0 ||
              typeof parsed.consensusReached !== 'boolean'
            ) {
              return null;
            }
            return {
              responseResolution: parsed.responseResolution.trim(),
              consensusReached: parsed.consensusReached,
              optionAProposal: String(parsed.optionAProposal ?? ''),
              optionBProposal: String(parsed.optionBProposal ?? ''),
              tokensConsumed: totalTokens,
            };
          }

          if (
            typeof parsed.responseResolution !== 'string' ||
            parsed.responseResolution.trim().length === 0
          ) {
            return null;
          }
          const responseResolution = parsed.responseResolution.trim();
          const concretePatch = String(parsed.concretePatch ?? '').trim();
          const optionAProposal = String(parsed.optionAProposal ?? '');
          const optionBProposal = String(parsed.optionBProposal ?? '');

          // 触及权衡即刻上报人类，不空转剩余轮次
          if (rawAction === 'ESCALATE_TRADEOFF') {
            return {
              responseResolution,
              consensusReached: false,
              responderAction: 'ESCALATE_TRADEOFF',
              concretePatch,
              optionAProposal,
              optionBProposal,
              tokensConsumed: totalTokens,
            };
          }

          // Step B：挑战方独立复核调用（不与响应方共享同一调用与角色）
          const challengerLlm = await this.modelRouter.invokeChatCompletion({
            tier: 'HIGH_REASONING_HYBRID' as never,
            systemPrompt: `你是研发流水线对峙协商的挑战方独立复核者（${input.challenger}）。
你的职责是质量与工程边界守门人：
1. 若响应方未给出可落地的具体修补（concretePatch）或充分反驳证据，触发熔断交给人类拍板是完全正确的决定，严禁为了追求和谐而妥协；
2. 若发现回应中暗含需求缩水/验收降级，必须拒绝并标记 containsImplicitScopeCut=true。
仅输出 JSON：{"accepted":true/false,"critique":"复核结论","containsImplicitScopeCut":true/false}`,
            userPrompt: `原始质询：${input.challengeContext}\n响应方动作：${rawAction}\n响应内容：${responseResolution}\n具体修补方案：${concretePatch || '无'}${historyText}`,
            fallbackContentGenerator: () => '',
          });
          totalTokens += challengerLlm.receipt.totalTokens;
          const challengerParsed = challengerLlm.usedLiveGateway
            ? JsonExtractor.extract(challengerLlm.content)
            : { ok: false, value: null };
          if (!challengerParsed.ok) {
            return {
              responseResolution,
              consensusReached: false,
              responderAction: rawAction,
              concretePatch,
              challengerVerified: false,
              challengerCritique: '挑战方独立复核输出格式无效，禁止草率达成共识',
              optionAProposal,
              optionBProposal,
              tokensConsumed: totalTokens,
            };
          }
          const cObj = challengerParsed.value as Record<string, unknown>;
          const challengerAccepted =
            cObj.accepted === true && cObj.containsImplicitScopeCut !== true;
          const challengerCritique = String(cObj.critique ?? '').trim();
          if (!challengerAccepted) {
            return {
              responseResolution,
              consensusReached: false,
              responderAction: rawAction,
              concretePatch,
              challengerVerified: false,
              challengerCritique:
                challengerCritique || '挑战方独立复核认定当前修补仍无法消除工程风险或隐含范围缩水',
              optionAProposal,
              optionBProposal,
              tokensConsumed: totalTokens,
            };
          }

          // Step C：无历史盲审裁判（Fresh-Context Blind Judge：不传聊天历史，仅查 Diff/修补是否存在迎合式软降级）
          const judgeLlm = await this.modelRouter.invokeChatCompletion({
            tier: 'HIGH_REASONING_HYBRID' as never,
            systemPrompt: `你是研发流水线的防伪共识独立盲审裁判（Anti-Sycophancy Blind Judge）。
你看不到双方协商对话客套过程，仅审视原始问题与最终承诺的修补方案：
一旦发现任何隐性功能阉割、指标/验收标准放宽或占位延迟兑现，必须判定 hasImplicitDowngrade=true。
仅输出 JSON：{"hasImplicitDowngrade":true/false,"reason":"盲审结论"}`,
            userPrompt: `原始分歧：${input.challengeContext}\n响应方承诺：${responseResolution}\n具体修补：${concretePatch || '无'}`,
            fallbackContentGenerator: () => '',
          });
          totalTokens += judgeLlm.receipt.totalTokens;
          const judgeParsed = judgeLlm.usedLiveGateway
            ? JsonExtractor.extract(judgeLlm.content)
            : { ok: false, value: null };
          if (!judgeParsed.ok) {
            return {
              responseResolution,
              consensusReached: false,
              responderAction: rawAction,
              concretePatch,
              challengerVerified: true,
              challengerCritique,
              independentJudgePassed: false,
              independentJudgeReason: '盲审裁判未返回有效 JSON 判定，保守拦截共识',
              optionAProposal,
              optionBProposal,
              tokensConsumed: totalTokens,
            };
          }
          const jObj = judgeParsed.value as Record<string, unknown>;
          const judgePassed = jObj.hasImplicitDowngrade !== true;
          const judgeReason = String(jObj.reason ?? '').trim();

          return {
            responseResolution,
            consensusReached: judgePassed,
            responderAction: rawAction,
            concretePatch,
            challengerVerified: true,
            challengerCritique,
            independentJudgePassed: judgePassed,
            independentJudgeReason: judgeReason || undefined,
            optionAProposal,
            optionBProposal,
            tokensConsumed: totalTokens,
          };
        } catch {
          return null;
        }
      },
    });
    this.supervisorAgent = new SupervisorAgent(this.eventBus, this.modelRouter);
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
      maxExecutionRetries: this.dslConfig.guardrails.maxExecutionRetries,
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

    // C1：创建 ToolRegistry 并注册 ContextProvider（E1 用 GIT_REPO_PATH 时启用；P1-3 接入依赖版本 Provider）
    this.contextRegistry = new ToolRegistry(4000);
    const gitRepoPath = process.env.GIT_REPO_PATH ?? '';
    if (gitRepoPath && fs.existsSync(gitRepoPath)) {
      this.contextRegistry.register(new GitContextProvider(gitRepoPath));
    }
    this.contextRegistry.register(
      new DependencyVersionsProvider(
        gitRepoPath && fs.existsSync(gitRepoPath) ? gitRepoPath : process.cwd(),
      ),
    );
    // 步骤 3：Figma(2)/数仓(5)——配置了 MCP URL 时走真实 MCP server，否则确定性 stub 补位（D-2）
    const figmaMcpUrl = process.env.FIGMA_MCP_URL ?? '';
    if (figmaMcpUrl) {
      this.contextRegistry.register(
        new McpContextProvider({
          name: 'figma-mcp',
          serverUrl: figmaMcpUrl,
          resolvableTypes: ['figma_components'],
          toolName: 'get_figma_components',
        }),
      );
    } else {
      this.contextRegistry.register(new FigmaStubProvider());
    }
    // G11：analytics_metrics 的 Provider 由工厂按 env 选择（MCP > 只读数仓直连 > stub）
    this.contextRegistry.register(createAnalyticsProvider());
    // 注入到所有 Agent
    for (const agent of this.agentRegistry.values()) {
      agent.setContextRegistry(this.contextRegistry);
    }
  }

  public addTeamComment(params: {
    runId: string;
    stageId: WorkflowStageId;
    actorUserId: string;
    content: string;
    category?: TeamCommentCategory;
    persist?: boolean;
    impersonatedByLabel?: string;
  }): StageTeamCommentRecord {
    const user = this.rbacService.getUserOrDefault(params.actorUserId);
    const attributedAuthorName = appendImpersonationAttribution(
      user.displayName,
      params.impersonatedByLabel,
    );
    const comment = new StageTeamCommentRecord({
      commentId: `CMT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      runId: params.runId,
      stageId: params.stageId,
      authorUserId: user.userId,
      authorName: attributedAuthorName,
      authorJobTitle: user.jobTitle,
      authorBadge: user.avatarBadge,
      content: params.content,
      category: params.category ?? 'COMMENT',
    });
    this.teamComments.push(comment);
    if (params.persist !== false && this.stateEngine.getAllRuns().length > 0) {
      this.syncPersistenceState();
    }
    return comment;
  }

  /** AUDIT-9：恢复持久化的团队评论（幂等去重，不重新触发持久化） */
  public restoreTeamComment(comment: StageTeamCommentRecord): void {
    const exists = this.teamComments.some((c) => c.commentId === comment.commentId);
    if (!exists) {
      this.teamComments.push(comment);
    }
  }

  public getAllTeamComments(): ReadonlyArray<StageTeamCommentRecord> {
    return [...this.teamComments];
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
      persist: false,
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_1_PM,
      actorUserId: 'user-tech-01',
      content:
        '收到，架构组已审阅 Stage 1 的非功能性约束，后续在 Stage 3a 会同步设计多租户 RBAC 索引与幂等防重机制。',
      category: 'COMMENT',
      persist: false,
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_2_PD,
      actorUserId: 'user-pd-01',
      content:
        'PD Agent 评估三维实时画布在移动端存在首屏性能瓶颈，我倾向于采纳方案 A（企业标准双栏折叠抽屉组件），既符合现有设计系统又不会拖慢排期。',
      category: 'COMMENT',
      persist: false,
    });
    this.addTeamComment({
      runId,
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      actorUserId: 'user-eng-01',
      content:
        '研发侧已预检接口契约，一旦架构师签核完 Stage 3a 的表结构变更，Engineer Agent 即可在独立 Worktree 分支落盘领域服务代码。',
      category: 'COMMENT',
      persist: false,
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
   * 发起新研发提案并自动推进流水线，直到遇到高风险/冲突人工门禁或全部完成。
   * A1：Agent 内部为真实 LLM 调用（异步）；演示开关经 scenarioHints 注入（J1）。
   */
  public async startProposalWorkflow(params: {
    proposal: ProjectProposalContract;
    initiatorActor: string;
    initiatorUserId?: string;
    scenarioHints?: ScenarioHints;
  }): Promise<WorkflowRunState> {
    const validation = params.proposal.validateContractIntegrity();
    if (!validation.isValid()) {
      throw new Error(`提案契约校验不通过：${validation.getViolations().join('; ')}`);
    }

    const runId = `RUN-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const runState = this.stateEngine.createRun({
      runId,
      proposal: params.proposal,
      initiatorActor: params.initiatorActor,
      createdByUserId: params.initiatorUserId,
      stagePipeline: this.dslConfig.getStageOrder(),
      workflowTemplateId: this.dslConfig.id,
      scenarioHints: params.scenarioHints,
      tokenBudget: this.dslConfig.guardrails.tokenBudgetLimit,
    });

    this.seedInitialTeamCommentsForRun(runState);

    await this.withRunLock(runId, async () => {
      await this.continueExecutionUntilGateOrCompleteUnlocked(runId);
    });
    return runState;
  }

  /**
   * P0-4：按 runId 隔离的异步互斥锁（Promise 链排队），确保同一运行实例的推进/签核/回退/重试串行执行，
   * 避免并发请求交错篡改快照状态机；内部委托必须调用 *Unlocked 方法以免锁重入死锁。
   */
  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runExecutionLocks.get(runId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const currentTail = previous.then(() => currentGate);
    this.runExecutionLocks.set(runId, currentTail);
    await previous;
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.runExecutionLocks.get(runId) === currentTail) {
        this.runExecutionLocks.delete(runId);
      }
    }
  }

  /**
   * 步骤 4：轻量 LLM 意图分析——针对本提案推断动态上下文需求（静态 STAGE_CONTEXT_NEEDS 之外）。
   * 防线：①仅在线时执行（离线零调用）；②类型必须命中 ALL_CONTEXT_NEED_TYPES 白名单（枚举外丢弃，注入拦截）；
   * ③一律 required=false（动态增强不阻塞流水线）+ 上限 3 条。
   */
  private async inferDynamicContextNeeds(
    runState: WorkflowRunState,
    currentStageId: WorkflowStageId,
  ): Promise<ReadonlyArray<ContextNeed>> {
    if (process.env.LITELLM_ENABLE_LIVE_HTTP !== 'true') {
      return [];
    }
    const plannerSystem =
      '你是研发流水线的上下文规划器。判断当前阶段除了标准配置外，还需要哪些外部知识。仅输出一个 JSON 对象。';
    const plannerUser = JSON.stringify({
      stageId: currentStageId,
      提案: runState.proposal.toSerializableRecord(),
      可选知识类型目录: [...ALL_CONTEXT_NEED_TYPES],
      输出格式:
        '{ "needs": [ { "type": "目录中的类型", "reason": "一句话理由" } ] }（最多 3 条，无关则空数组）',
    });

    try {
      const result = await this.modelRouter.invokeChatCompletion({
        tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
        systemPrompt: plannerSystem,
        userPrompt: plannerUser,
        fallbackContentGenerator: () => '{"needs":[]}',
      });
      if (!result.usedLiveGateway) {
        return [];
      }
      const extracted = JsonExtractor.extract(result.content);
      if (!extracted.ok) {
        return [];
      }
      const parsed = extracted.value as { needs?: unknown };
      if (!Array.isArray(parsed.needs)) {
        return [];
      }
      const dynamicNeeds: ContextNeed[] = [];
      for (const item of parsed.needs.slice(0, 3)) {
        const type = String((item as { type?: unknown })?.type ?? '');
        if (ALL_CONTEXT_NEED_TYPES.has(type)) {
          dynamicNeeds.push({ type, required: false, maxTokens: 800 });
        }
      }
      return dynamicNeeds;
    } catch {
      return [];
    }
  }

  public getContextRegistry(): ToolRegistry | null {
    return this.contextRegistry;
  }

  /**
   * I3 / P1-3：run 终态钩子（COMPLETED / ABORTED / ABORTED_TOKEN_BUDGET）——
   * 触发 worktree 保留策略（保留最近 N=10 个 run，env SANDBOX_WORKTREE_RETENTION 可调）并释放该 run 的上下文缓存；
   * 活跃（RUNNING/PAUSED）与刚终态的 run 受保护，绝不误删。失败不抛出（清理属于旁路）。
   */
  private onRunReachedTerminalState(runState: WorkflowRunState): void {
    this.contextRegistry?.clearRunCache(runState.runId);
    try {
      const protectRunIds = this.stateEngine
        .getAllRuns()
        .filter((r) => r.getStatus() === 'RUNNING' || r.getStatus() === 'PAUSED_AT_HUMAN_GATE')
        .map((r) => r.runId);
      protectRunIds.push(runState.runId);
      const result = this.sandboxManager.enforceWorktreeRetention({ protectRunIds });
      if (result.removedRunIds.length > 0) {
        console.info(
          `[Retention] 已清理 ${result.removedRunIds.length} 个历史 run 的沙箱 worktree: ${result.removedRunIds.slice(0, 5).join(', ')}`,
        );
      }
    } catch (err) {
      console.warn(
        `[Retention] worktree 保留策略执行失败（不影响主流程）: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
      );
    }
  }

  /**
   * 持续推进当前活跃分支的下一个阶段，直至触发高风险门禁/冲突熔断/预算或契约失败暂停。
   */
  public async continueExecutionUntilGateOrComplete(runId: string): Promise<WorkflowRunState> {
    return await this.withRunLock(runId, () =>
      this.continueExecutionUntilGateOrCompleteUnlocked(runId),
    );
  }

  private async continueExecutionUntilGateOrCompleteUnlocked(
    runId: string,
  ): Promise<WorkflowRunState> {
    const runState = this.stateEngine.getRunOrThrow(runId);
    let terminalHookFired = false;

    while (runState.getStatus() === 'RUNNING') {
      const currentStageId = runState.getCurrentStageId();
      if (currentStageId === null) {
        runState.setStatus('COMPLETED');
        this.onRunReachedTerminalState(runState);
        terminalHookFired = true;
        break;
      }

      const workerAgent = this.agentRegistry.get(currentStageId);
      if (!workerAgent) {
        // J2：自定义节点（注册表声明、无自动执行体）= 编排检查点——广播通知后跳过推进
        const customDescriptor = AgentRegistry.default().getCustomStage(currentStageId);
        if (!customDescriptor) {
          throw new Error(`阶段 [${currentStageId}] 未注册对应的职能 Agent`);
        }
        this.eventBus.publishNotification(
          new AgentUserNotification({
            notificationId: `NOTIF-CUSTOM-CHECKPOINT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            runId: runState.runId,
            branchId: runState.getActiveBranchId(),
            stageId: currentStageId,
            senderRole: customDescriptor.agentRole as AgentRole,
            category: NotificationCategory.STAGE_PROGRESS,
            title: `【编排检查点】${customDescriptor.displayName} 已通过（自定义节点）`,
            message: `自定义节点 [${currentStageId}] 无自动执行体（可插拔节点 J2），流水线继续推进；RBAC 门禁角色：${(AgentRegistry.default().getRequiredHumanRoles(currentStageId) ?? []).join('、')}`,
            relatedSnapshotId: 'ROOT',
            requiresHumanAction: false,
            actionOptions: [],
          }),
        );
        runState.advanceToNextStage();
        continue;
      }

      const parentSnapshot = runState.getLatestSnapshotOnActiveBranch();
      const rollbackDirective = runState.consumePendingRollbackDirective();
      const historicalLessons = await this.auditLedger.getRejectionLessonsForStage(
        currentStageId,
        `${runState.proposal.title} ${runState.proposal.summary}`,
      );

      // 步骤 4：LLM 动态上下文需求推断（离线为空数组，零调用）
      const dynamicContextNeeds = await this.inferDynamicContextNeeds(runState, currentStageId);

      // C1 + 步骤 4 + P1-3：预取并经 ContextBudgetTrimmer 裁剪后注入外部上下文
      let trimmedExternalContext: TrimmedContext | null = null;
      if (this.contextRegistry) {
        const staticNeeds = STAGE_CONTEXT_NEEDS[currentStageId] ?? [];
        const dynamicExtras = dynamicContextNeeds.filter(
          (n) => !staticNeeds.some((s) => s.type === n.type),
        );
        trimmedExternalContext = await this.contextRegistry.resolve(
          [...staticNeeds, ...dynamicExtras],
          {
            runId: runState.runId,
            stageId: currentStageId,
            proposal: runState.proposal,
            upstreamSummaries: runState.getActiveBranchSnapshots().map((s) => ({
              stageId: s.stageId,
              summary: s.artifact.summary,
            })),
          },
        );
      }

      const inputContext = new AgentExecutionInputContext({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        proposal: runState.proposal,
        upstreamArtifacts: runState.getApprovedUpstreamArtifactsMap(),
        historicalRejectionLessons: historicalLessons,
        humanFeedbackDirective: rollbackDirective,
        scenarioHints: runState.scenarioHints,
        tokenBudgetRemaining: Math.max(
          0,
          runState.getTokenBudget() - runState.getTokensUsedTotal(),
        ),
        dynamicContextNeeds,
        trimmedExternalContext,
      });

      let executionOutcome: AgentExecutionOutcome;
      try {
        executionOutcome = await workerAgent.executeStagePipeline(inputContext);
      } catch (err) {
        // D-5：契约/预算失败必须有"人可读 + 可操作"的出口，禁止打穿 HTTP（A2/B3）
        const isBudget = err instanceof TokenBudgetExceededError;
        runState.setStatus(isBudget ? 'ABORTED_TOKEN_BUDGET' : 'ABORTED');
        this.onRunReachedTerminalState(runState);
        const violations =
          err instanceof StageContractError
            ? err.violations
            : [String(err instanceof Error ? err.message : err)];
        this.eventBus.publishNotification(
          new AgentUserNotification({
            notificationId: `NOTIF-FAIL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            runId: runState.runId,
            branchId: runState.getActiveBranchId(),
            stageId: currentStageId,
            senderRole: workerAgent.role,
            category: isBudget
              ? NotificationCategory.TOKEN_BUDGET_EXCEEDED
              : NotificationCategory.STAGE_CONTRACT_FAILED,
            title: isBudget
              ? `【Token 预算熔断】${currentStageId} 剩余预算不足`
              : `【阶段契约失败】${currentStageId} 自愈重试后仍未达标`,
            message:
              (err instanceof Error ? err.message : String(err)) +
              (violations.length > 0 ? `\n违规项：${violations.join('；')}` : ''),
            relatedSnapshotId: `RETRY:${currentStageId}:${Date.now()}`,
            requiresHumanAction: true,
            actionOptions: [
              {
                actionKey: 'RETRY_STAGE',
                label: '已排查原因，重试本阶段',
                verdict: DecisionVerdict.APPROVE,
              },
            ],
          }),
        );
        this.syncPersistenceState();
        return runState;
      }

      // B3：累计真实 Token 消耗（预算守卫在下一轮循环头/Agent 内继续生效）
      runState.recordTokenUsage(executionOutcome.tokensConsumed);

      // B2：协商路由按 DSL negotiateWithStageId 声明（PD→PM 设计质询；QA→Engineer 修复闭环）
      let negotiationEscalated = false;
      let deadlockedTurn = null;
      let autoRepairDirective: string | null = null;
      const negotiationTarget = this.dslConfig.findNegotiationTarget(currentStageId);
      const negotiationOutcome = this.evaluateStageNegotiation(
        currentStageId,
        negotiationTarget,
        runState,
        executionOutcome.artifact,
      );
      if (negotiationOutcome) {
        const negResult = await this.negotiationMediator.mediateChallenge({
          runId: runState.runId,
          branchId: runState.getActiveBranchId(),
          stageId: currentStageId,
          challengerRole: negotiationOutcome.challengerRole,
          responderRole: negotiationOutcome.responderRole,
          initialChallengePoint: negotiationOutcome.challengePoint,
          topic: negotiationOutcome.topic,
          forceDeadlockToMaxTurns: negotiationOutcome.forceDeadlock,
        });
        runState.recordTokenUsage(negResult.totalTokensConsumed);
        negotiationEscalated = negResult.escalatedToSupervisor;
        deadlockedTurn = negResult.latestTurn;

        // B2：QA 修复闭环——协商一致后自动分叉回退到 Engineer 阶段，携带约定的修复指令
        if (
          currentStageId === WorkflowStageId.STAGE_4_QA &&
          negotiationTarget === WorkflowStageId.STAGE_3B_ENGINEER &&
          negResult.consensusReached &&
          runState.getAutoRepairCount('QA_TO_ENG') < MAX_AUTO_REPAIRS
        ) {
          const repairRound = runState.recordAutoRepair('QA_TO_ENG');
          autoRepairDirective = `QA 修复第 ${repairRound} 轮：${negResult.latestTurn.responseResolution}`;
          negotiationEscalated = false;
          deadlockedTurn = null;
        }
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

      // B2：QA 修复闭环——协商一致后自动分叉回退 3b 重新编码（旧 QA 快照被 SUPERSEDED，指令入审计）
      if (autoRepairDirective !== null) {
        const forkOutcome = runState.forkAndRollbackToStage(
          WorkflowStageId.STAGE_3B_ENGINEER,
          autoRepairDirective,
        );
        this.auditLedger.recordDecision(
          new HumanDecisionRecord({
            decisionId: `DEC-REPAIR-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            runId: runState.runId,
            snapshotId: forkOutcome.supersededSnapshotIds[0] ?? snapshot.snapshotId,
            branchId: forkOutcome.newBranchId,
            stageId: WorkflowStageId.STAGE_3B_ENGINEER,
            reviewerActor: `${workerAgent.role} (QA_REPAIR_LOOP)`,
            verdict: DecisionVerdict.REJECT,
            comment: `${autoRepairDirective}；旧分支 [${forkOutcome.previousBranchId}] 下游 ${forkOutcome.supersededSnapshotIds.length} 个快照已废弃`,
          }),
        );
        this.eventBus.publishNotification(
          new AgentUserNotification({
            notificationId: `NOTIF-REPAIR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            runId: runState.runId,
            branchId: forkOutcome.newBranchId,
            stageId: WorkflowStageId.STAGE_3B_ENGINEER,
            senderRole: workerAgent.role,
            category: NotificationCategory.ROLLBACK_EXECUTED,
            title: `【QA 修复闭环】已分叉 [${forkOutcome.newBranchId}] 打回 Engineer Agent 重编码`,
            message: autoRepairDirective,
            relatedSnapshotId: forkOutcome.forkedFromParentSnapshotId ?? snapshot.snapshotId,
            requiresHumanAction: false,
          }),
        );
        this.syncPersistenceState();
        continue; // 以新分支重新进入循环（3b → QA）
      }

      if (shouldBlockForHuman) {
        runState.setStatus('PAUSED_AT_HUMAN_GATE');
        this.publishSnapshotGateEvent({
          snapshot,
          lifecycleState: SnapshotLifecycleState.PENDING_HUMAN_GATE,
          headline: `步骤 [${currentStageId}] 暂停等待人工签核/拍板（风险分 ${snapshot.riskScore}/100 · ${snapshot.riskLevel}）`,
        });
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
      this.publishSnapshotGateEvent({
        snapshot,
        lifecycleState: SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK,
        headline: `步骤 [${currentStageId}] 低风险自动放行（风险分 ${snapshot.riskScore}/100）`,
      });
      this.supervisorAgent.notifyLowRiskAutoPassed(snapshot);
      runState.advanceToNextStage();
    }

    if (!terminalHookFired && runState.getStatus() === 'COMPLETED') {
      this.onRunReachedTerminalState(runState);
    }

    this.syncPersistenceState();
    return runState;
  }

  /** G2：统一发布门禁/签核生命周期事件及机器可读 detailPayload */
  private publishSnapshotGateEvent(params: {
    snapshot: StageSnapshotMemento;
    lifecycleState: SnapshotLifecycleState;
    headline: string;
    extraPayload?: Record<string, unknown>;
  }): void {
    this.eventBus.publishEvent(
      new WorkflowDomainEvent({
        eventId: `EVT-GATE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        runId: params.snapshot.runId,
        branchId: params.snapshot.branchId,
        stageId: params.snapshot.stageId,
        agentRole: params.snapshot.agentRole,
        lifecycleState: params.lifecycleState,
        headline: params.headline,
        detailPayload: {
          snapshotId: params.snapshot.snapshotId,
          riskScore: params.snapshot.riskScore,
          riskLevel: params.snapshot.riskLevel,
          gateAction: params.snapshot.gateAction,
          droppedRequirementIds: [...params.snapshot.scopeDiffReport.droppedRequirementIds],
          ...(params.extraPayload ?? {}),
        },
      }),
    );
  }

  /**
   * B2 + G4：按阶段判定是否发起受限协商，并生成质询内容。
   * - PM 阶段：启用扩展同侪协商或 DSL 声明时，由 DA 核验前置埋点契约
   * - PD 阶段：UI 设计质询 PM（交互可行性冲突）
   * - Tech Spec 阶段：启用扩展同侪协商或 DSL 声明时，由 Engineer 复核接口/DDL 可实现性
   * - QA 阶段：验证失败质询 Engineer（修复闭环；超限后强制熔断上仲裁）
   */
  private evaluateStageNegotiation(
    stageId: WorkflowStageId,
    target: WorkflowStageId | null,
    runState: WorkflowRunState,
    artifact: import('../domain/contracts.ts').IDomainArtifactContract,
  ): {
    challengerRole: AgentRole;
    responderRole: AgentRole;
    challengePoint: string;
    topic: string;
    forceDeadlock: boolean;
  } | null {
    const extendedPeer = runState.scenarioHints?.enableExtendedPeerNegotiation === true;

    if (
      stageId === WorkflowStageId.STAGE_1_PM &&
      (target !== null || extendedPeer) &&
      artifact instanceof PrdArtifactContract
    ) {
      return {
        challengerRole: AgentRole.DATA_ANALYST,
        responderRole: AgentRole.PRODUCT_MANAGER,
        challengePoint: `DA 复核前置埋点契约（共 ${artifact.trackingPlanEvents.length} 个事件），确认 run_id/branch_id/actor_role 属性对齐转化归因口径`,
        topic: 'PRD_TRACKING_ALIGNMENT',
        forceDeadlock: false,
      };
    }

    if (
      stageId === WorkflowStageId.STAGE_3A_TECH_SPEC &&
      (target !== null || extendedPeer) &&
      artifact instanceof TechSpecArtifactContract
    ) {
      return {
        challengerRole: AgentRole.SOFTWARE_ENGINEER,
        responderRole: AgentRole.TECH_LEAD,
        challengePoint: `Engineer 复核架构契约（${artifact.apiContracts.length} 个 API / ${artifact.databaseDdlStatements.length} 条 DDL），确认隔离 Worktree 沙箱可无歧义编码落地`,
        topic: 'TECH_SPEC_REVIEW',
        forceDeadlock: false,
      };
    }

    if (target === null) {
      return null;
    }

    if (stageId === WorkflowStageId.STAGE_2_PD && target === WorkflowStageId.STAGE_1_PM) {
      if (
        !(artifact instanceof UiDesignArtifactContract) ||
        artifact.designChallengeNote === null
      ) {
        return null;
      }
      return {
        challengerRole: AgentRole.PRODUCT_DESIGNER,
        responderRole: AgentRole.PRODUCT_MANAGER,
        challengePoint: artifact.designChallengeNote,
        topic: 'DESIGN_REVIEW',
        forceDeadlock: runState.scenarioHints?.forceNegotiationDeadlock === true,
      };
    }

    if (stageId === WorkflowStageId.STAGE_4_QA && target === WorkflowStageId.STAGE_3B_ENGINEER) {
      if (!(artifact instanceof QaVerificationArtifactContract)) {
        return null;
      }
      const failed = !artifact.allAcceptanceCriteriaMet || artifact.securityIssuesFound > 0;
      if (!failed) {
        return null;
      }
      const repairRound = runState.getAutoRepairCount('QA_TO_ENG');
      return {
        challengerRole: AgentRole.QUALITY_ASSURANCE,
        responderRole: AgentRole.SOFTWARE_ENGINEER,
        challengePoint: `QA 验证未通过（安全漏洞 ${artifact.securityIssuesFound} 个，验收达成 ${artifact.allAcceptanceCriteriaMet}）：${artifact.summary}`,
        topic: 'QA_REPAIR',
        forceDeadlock: repairRound >= MAX_AUTO_REPAIRS,
      };
    }

    return null;
  }

  /**
   * D1：从持久化快照恢复全部运行状态（幂等，无数据时返回 false）。
   * 恢复失败（schema 不匹配/损坏）返回 false 并由调用方决定是否播种演示数据。
   */
  public restoreFromPersistence(): { restored: boolean; runIds: string[]; warnings: string[] } {
    const persisted = this.persistenceRepo.loadPersistedSnapshot();
    const applyGovernanceConfig = (cfg: PersistedGovernanceConfig): void => {
      if (typeof cfg.maxNegotiationTurns === 'number') {
        this.negotiationMediator.setMaxNegotiationTurns(cfg.maxNegotiationTurns);
      }
      if (typeof cfg.highRiskScoreThreshold === 'number') {
        this.riskPipeline.setHighRiskThreshold(cfg.highRiskScoreThreshold);
      }
      if (typeof cfg.allowSpecialistCrossStageRollback === 'boolean') {
        this.rbacService.setAllowSpecialistCrossStageRollback(
          cfg.allowSpecialistCrossStageRollback,
        );
      }
    };
    if (persisted?.governanceConfig && (!persisted.runs || persisted.runs.length === 0)) {
      applyGovernanceConfig(persisted.governanceConfig);
    }
    if (persisted?.cacheTelemetry && (!persisted.runs || persisted.runs.length === 0)) {
      this.cacheManager.restoreTelemetryCounters(persisted.cacheTelemetry);
    }
    if (!persisted || (persisted.runs?.length ?? 0) === 0) {
      return { restored: false, runIds: [], warnings: ['无持久化数据'] };
    }
    if (persisted.schemaVersion < '1.1.0') {
      return {
        restored: false,
        runIds: [],
        warnings: [`schemaVersion ${persisted.schemaVersion} 过旧`],
      };
    }
    const reconstructor = new StateReconstructor({
      stateEngine: this.stateEngine,
      auditLedger: this.auditLedger,
      mediator: this.negotiationMediator,
      eventBus: this.eventBus,
      restoreTeamComment: (comment) => this.restoreTeamComment(comment),
      cacheManager: this.cacheManager,
      fulfillmentTracker: this.fulfillmentTracker,
      restoreGovernanceConfig: applyGovernanceConfig,
    });
    const walEntries = this.persistenceRepo.readAuditWalEntries();
    const result = reconstructor.restore(persisted, walEntries);
    for (const warning of result.warnings) {
      console.warn(`[D1 Restore] ${warning}`);
    }
    this.activeRunIdAfterRestore = result.runIds[result.runIds.length - 1] ?? null;
    return { restored: result.runIds.length > 0, runIds: result.runIds, warnings: result.warnings };
  }

  /** D1：恢复后的最新 runId（服务器以此设置 activeRunId） */
  public getRestoredActiveRunId(): string | null {
    return this.activeRunIdAfterRestore;
  }

  private syncPersistenceState(): void {
    this.persistenceRepo.persistFullState({
      runs: this.stateEngine.getAllRuns(),
      negotiationLogs: this.negotiationMediator.getNegotiationHistory(),
      humanDecisions: this.auditLedger.getHumanDecisions(),
      negativeExperienceRecords: this.auditLedger.ragEngine.getAllRecords(),
      liveEvents: this.eventBus.getEventHistory().map((e) => ({
        eventId: e.eventId,
        runId: e.runId,
        branchId: e.branchId,
        stageId: e.stageId,
        agentRole: e.agentRole,
        lifecycleState: e.lifecycleState,
        headline: e.headline,
        detailPayload: { ...e.detailPayload },
        timestampIso: e.timestampIso,
      })),
      notifications: this.eventBus.getNotificationInbox().map((n) => n.toSerializableRecord()),
      teamComments: this.teamComments.map((c) => c.toSerializableRecord()),
      auditEntries: this.auditLedger.getAuditTimeline().map((e) => ({
        entryId: e.entryId,
        runId: e.runId,
        branchId: e.branchId,
        stageId: e.stageId,
        actor: e.actor,
        actionType: e.actionType,
        summary: e.summary,
        metadata: { ...e.metadata },
        timestampIso: e.timestampIso,
      })),
      governanceConfig: {
        maxNegotiationTurns: this.negotiationMediator.getMaxNegotiationTurns(),
        highRiskScoreThreshold: this.riskPipeline.getHighRiskThreshold(),
        allowSpecialistCrossStageRollback:
          this.rbacService.isCrossStageRollbackAllowedForSpecialists(),
      },
      cacheTelemetry: this.cacheManager.getMetricsSnapshot(),
      intentTraces: this.fulfillmentTracker.getTraces().map((t) => t.toSerializableRecord()),
    });
  }

  /**
   * AUDIT-10：从契约失败（ABORTED）或预算超限（ABORTED_TOKEN_BUDGET）状态恢复重试当前阻塞阶段
   */
  public async retryAbortedStage(params: {
    runId: string;
    reviewerActor: string;
    actorUserId?: string;
    comment?: string;
    targetSnapshotOrRetryId?: string;
    extraTokenBudget?: number;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    return await this.withRunLock(params.runId, () => this.retryAbortedStageUnlocked(params));
  }

  private async retryAbortedStageUnlocked(params: {
    runId: string;
    reviewerActor: string;
    actorUserId?: string;
    comment?: string;
    targetSnapshotOrRetryId?: string;
    extraTokenBudget?: number;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const status = runState.getStatus();
    if (status !== 'ABORTED' && status !== 'ABORTED_TOKEN_BUDGET') {
      throw new Error(`运行 [${params.runId}] 当前状态 [${status}] 无需熔断重试`);
    }
    const currentStageId = runState.getCurrentStageId();
    if (!currentStageId) {
      throw new Error(`运行 [${params.runId}] 无可重试的当前阶段`);
    }

    let effectiveReviewerLabel = params.reviewerActor;
    if (params.actorUserId) {
      const authResult = this.rbacService.assertCanApproveStageGate(
        params.actorUserId,
        currentStageId,
      );
      effectiveReviewerLabel = authResult.formattedActorLabel;
    }
    effectiveReviewerLabel = appendImpersonationAttribution(
      effectiveReviewerLabel,
      params.impersonatedByLabel,
    );

    if (status === 'ABORTED_TOKEN_BUDGET') {
      const topUp = params.extraTokenBudget ?? Math.max(20000, runState.getTokenBudget());
      runState.increaseTokenBudget(topUp);
    }

    if (params.targetSnapshotOrRetryId) {
      this.eventBus.resolveNotificationBySnapshotId(params.targetSnapshotOrRetryId);
    }
    this.eventBus.resolveFailureNotificationsForStage(params.runId, currentStageId);

    const retryComment =
      params.comment?.trim() ||
      (status === 'ABORTED_TOKEN_BUDGET'
        ? `追加 Token 预算至 ${runState.getTokenBudget()} 并重试阶段 ${currentStageId}`
        : `已排查原因并重试阶段 ${currentStageId}`);

    this.auditLedger.recordDecision(
      new HumanDecisionRecord({
        decisionId: `DEC-RETRY-${Date.now()}`,
        runId: params.runId,
        snapshotId: params.targetSnapshotOrRetryId ?? `RETRY:${currentStageId}`,
        branchId: runState.getActiveBranchId(),
        stageId: currentStageId,
        reviewerActor: effectiveReviewerLabel,
        reviewerUserId: params.actorUserId,
        verdict: DecisionVerdict.APPROVE,
        comment: retryComment,
      }),
    );

    this.addTeamComment({
      runId: params.runId,
      stageId: currentStageId,
      actorUserId: params.actorUserId ?? 'user-admin-01',
      content: `[熔断重试恢复] ${retryComment}`,
      category: 'APPROVAL_NOTE',
      persist: false,
      impersonatedByLabel: params.impersonatedByLabel,
    });

    runState.setStatus('RUNNING');
    this.syncPersistenceState();
    return await this.continueExecutionUntilGateOrCompleteUnlocked(params.runId);
  }

  /**
   * 人工在前端审核门禁或冲突裁决台提交决定（批准 / 选方案 A / 选方案 B / 驳回重做）
   * 若传入 actorUserId，强制执行 RBAC 阶段专长责任人或顶层管理员权限校验。
   */
  public async submitHumanGateDecision(params: {
    runId: string;
    snapshotId: string;
    reviewerActor: string;
    actorUserId?: string;
    verdict: DecisionVerdict;
    comment: string;
    extraTokenBudget?: number;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    return await this.withRunLock(params.runId, () => this.submitHumanGateDecisionUnlocked(params));
  }

  private async submitHumanGateDecisionUnlocked(params: {
    runId: string;
    snapshotId: string;
    reviewerActor: string;
    actorUserId?: string;
    verdict: DecisionVerdict;
    comment: string;
    extraTokenBudget?: number;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const snapshot = runState.findSnapshotById(params.snapshotId);
    if (!snapshot) {
      const isRetryTarget = params.snapshotId === 'ROOT' || params.snapshotId.startsWith('RETRY:');
      const status = runState.getStatus();
      const isAborted = status === 'ABORTED' || status === 'ABORTED_TOKEN_BUDGET';
      if (isRetryTarget && isAborted && params.verdict === DecisionVerdict.APPROVE) {
        return await this.retryAbortedStageUnlocked({
          runId: params.runId,
          reviewerActor: params.reviewerActor,
          actorUserId: params.actorUserId,
          comment: params.comment,
          targetSnapshotOrRetryId: params.snapshotId,
          extraTokenBudget: params.extraTokenBudget,
          impersonatedByLabel: params.impersonatedByLabel,
        });
      }
      throw new Error(`未找到待审核快照 [${params.snapshotId}]`);
    }
    if (snapshot.getState() !== SnapshotLifecycleState.PENDING_HUMAN_GATE) {
      throw new Error(
        `快照 [${params.snapshotId}] 当前状态为 [${snapshot.getState()}]，非待人工签核状态，禁止重复裁决`,
      );
    }

    let effectiveReviewerLabel = params.reviewerActor;
    if (params.actorUserId) {
      const authResult = this.rbacService.assertCanApproveStageGate(
        params.actorUserId,
        snapshot.stageId,
      );
      effectiveReviewerLabel = authResult.formattedActorLabel;
    }
    effectiveReviewerLabel = appendImpersonationAttribution(
      effectiveReviewerLabel,
      params.impersonatedByLabel,
    );

    this.auditLedger.recordDecision(
      new HumanDecisionRecord({
        decisionId: `DEC-HUMAN-${Date.now()}`,
        runId: params.runId,
        snapshotId: params.snapshotId,
        branchId: snapshot.branchId,
        stageId: snapshot.stageId,
        reviewerActor: effectiveReviewerLabel,
        reviewerUserId: params.actorUserId,
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
      impersonatedByLabel: params.impersonatedByLabel,
    });

    this.eventBus.resolveNotificationBySnapshotId(params.snapshotId);

    if (
      params.verdict === DecisionVerdict.APPROVE ||
      params.verdict === DecisionVerdict.ARBITRATE_OPTION_A ||
      params.verdict === DecisionVerdict.ARBITRATE_OPTION_B
    ) {
      snapshot.transitionState(SnapshotLifecycleState.APPROVED);
      this.publishSnapshotGateEvent({
        snapshot,
        lifecycleState: SnapshotLifecycleState.APPROVED,
        headline: `[${effectiveReviewerLabel}] 已签核通过步骤 [${snapshot.stageId}]（${params.verdict}）`,
        extraPayload: {
          verdict: params.verdict,
          reviewerActor: effectiveReviewerLabel,
        },
      });
      runState.advanceToNextStage();
      return await this.continueExecutionUntilGateOrCompleteUnlocked(params.runId);
    }

    // 若人工选择驳回（REJECT），自动委托总管 Agent 在当前阶段执行 Fork 回退重做
    snapshot.transitionState(SnapshotLifecycleState.REJECTED);
    this.publishSnapshotGateEvent({
      snapshot,
      lifecycleState: SnapshotLifecycleState.REJECTED,
      headline: `[${effectiveReviewerLabel}] 已驳回步骤 [${snapshot.stageId}] 触发重做`,
      extraPayload: {
        verdict: params.verdict,
        reviewerActor: effectiveReviewerLabel,
      },
    });
    return await this.invokeSupervisorConversationalRollbackUnlocked({
      runId: params.runId,
      humanActor: effectiveReviewerLabel,
      actorUserId: params.actorUserId,
      dialogueInstruction: `人工门禁驳回重做：${params.comment}`,
      explicitTargetStageId: snapshot.stageId,
      impersonatedByLabel: params.impersonatedByLabel,
    });
  }

  /**
   * 人类与总管 Agent (SupervisorAgent) 对话，回退到任意指定阶段与职能 Agent 重新执行
   */
  public async invokeSupervisorConversationalRollback(params: {
    runId: string;
    humanActor: string;
    actorUserId?: string;
    dialogueInstruction: string;
    explicitTargetStageId?: WorkflowStageId;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    return await this.withRunLock(params.runId, () =>
      this.invokeSupervisorConversationalRollbackUnlocked(params),
    );
  }

  private async invokeSupervisorConversationalRollbackUnlocked(params: {
    runId: string;
    humanActor: string;
    actorUserId?: string;
    dialogueInstruction: string;
    explicitTargetStageId?: WorkflowStageId;
    impersonatedByLabel?: string;
  }): Promise<WorkflowRunState> {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const parsedDirective = await this.supervisorAgent.parseNaturalLanguageRollback(
      params.dialogueInstruction,
      params.explicitTargetStageId,
      runState.getStagePipeline(),
    );

    let effectiveActor = params.humanActor;
    if (params.actorUserId) {
      const user = this.rbacService.assertCanInvokeRollback(
        params.actorUserId,
        parsedDirective.targetStageId,
      );
      effectiveActor = `${user.displayName} (${user.jobTitle})`;
    }
    const attributedReviewerActor = appendImpersonationAttribution(
      `${effectiveActor} (via SupervisorAgent)`,
      params.impersonatedByLabel,
    );

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
        reviewerActor: attributedReviewerActor,
        reviewerUserId: params.actorUserId,
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
      impersonatedByLabel: params.impersonatedByLabel,
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

    return await this.continueExecutionUntilGateOrCompleteUnlocked(params.runId);
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
      liveInteractionStreamTotal: this.eventBus.getEventHistory(targetRun.runId).length,
      negotiationLogs: this.negotiationMediator.getNegotiationHistory(targetRun.runId),
      humanDecisions: this.auditLedger.getHumanDecisions(targetRun.runId),
      teamComments: this.getTeamComments(targetRun.runId),
      negativeExperienceRecords: this.auditLedger.ragEngine.getAllRecords(),
      auditTimeline: this.auditLedger.getAuditTimeline(targetRun.runId).slice(-40).reverse(),
      retrospectiveReport,
    };
  }
}
