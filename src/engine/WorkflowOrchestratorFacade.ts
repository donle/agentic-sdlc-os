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
  ProjectProposalContract,
  QaVerificationArtifactContract,
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
import { WorkflowEventBus } from '../patterns/EventBus.ts';
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
import { PersistenceRepository } from './PersistenceRepository.ts';
import { RbacGovernanceService } from './RbacGovernanceService.ts';
import { WorkflowDslConfiguration, WorkflowDslLoader } from './WorkflowDslLoader.ts';
import { StateReconstructor } from './pg/StateReconstructor.ts';
import { ToolRegistry } from '../agents/context/ToolRegistry.ts';
import { GitContextProvider } from '../agents/context/GitContextProvider.ts';
import { McpContextProvider } from '../agents/context/McpContextProvider.ts';
import { FigmaStubProvider } from '../agents/context/StubProviders.ts';
import { createAnalyticsProvider } from '../agents/context/WarehouseQueryProvider.ts';
import { ALL_CONTEXT_NEED_TYPES, STAGE_CONTEXT_NEEDS } from '../agents/context/types.ts';
import type { ContextNeed } from '../agents/context/types.ts';

import { MAX_AUTO_REPAIRS } from './repairLoop.ts';

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
    // B1：注入 LLM 轮次执行器（网关在线时用 LLM 生成真实协商内容；离线走剧本降级）
    this.negotiationMediator.setRoundRunner({
      runTurn: async (input) => {
        try {
          const llm = await this.modelRouter.invokeChatCompletion({
            tier: 'HIGH_REASONING_HYBRID' as never,
            systemPrompt: `你是研发流水线中的两个智能体角色正在进行受限协商。
当前是第 ${input.turnIndex}/${input.maxTurns} 轮。挑战方：${input.challenger}，响应方：${input.responder}。
分歧焦点：${input.challengeContext}。
协商主题：${input.topic}。
请以响应方视角输出 JSON：{"responseResolution": "响应内容", "consensusReached": true/false, "optionAProposal": "方案A", "optionBProposal": "方案B"}
consensusReached=true 表示双方达成一致。仅输出 JSON。`,
            userPrompt: input.challengeContext,
            fallbackContentGenerator: () => '',
          });
          if (!llm.usedLiveGateway) {
            return null;
          }
          const extracted = JsonExtractor.extract(llm.content);
          if (!extracted.ok) {
            return null;
          }
          const parsed = extracted.value as Record<string, unknown>;
          return {
            responseResolution: String(parsed.responseResolution ?? ''),
            consensusReached: parsed.consensusReached === true,
            optionAProposal: String(parsed.optionAProposal ?? ''),
            optionBProposal: String(parsed.optionBProposal ?? ''),
          };
        } catch {
          return null;
        }
      },
    });
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

    // C1：创建 ToolRegistry 并注册 ContextProvider（E1 用 GIT_REPO_PATH 时启用）
    this.contextRegistry = new ToolRegistry(4000);
    const gitRepoPath = process.env.GIT_REPO_PATH ?? '';
    if (gitRepoPath && fs.existsSync(gitRepoPath)) {
      this.contextRegistry.register(new GitContextProvider(gitRepoPath));
    }
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
   * 发起新研发提案并自动推进流水线，直到遇到高风险/冲突人工门禁或全部完成。
   * A1：Agent 内部为真实 LLM 调用（异步）；演示开关经 scenarioHints 注入（J1）。
   */
  public async startProposalWorkflow(params: {
    proposal: ProjectProposalContract;
    initiatorActor: string;
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
      stagePipeline: this.dslConfig.getStageOrder(),
      workflowTemplateId: this.dslConfig.id,
      scenarioHints: params.scenarioHints,
    });

    this.seedInitialTeamCommentsForRun(runState);

    await this.continueExecutionUntilGateOrComplete(runId);
    return runState;
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

  /**
   * I3：run 终态钩子（COMPLETED / ABORTED / ABORTED_TOKEN_BUDGET）——
   * 触发 worktree 保留策略（保留最近 N=10 个 run，env SANDBOX_WORKTREE_RETENTION 可调）；
   * 活跃（RUNNING/PAUSED）与刚终态的 run 受保护，绝不误删。失败不抛出（清理属于旁路）。
   */
  private onRunReachedTerminalState(runState: WorkflowRunState): void {
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
    const runState = this.stateEngine.getRunOrThrow(runId);
    const tokenBudgetLimit = this.dslConfig.guardrails.tokenBudgetLimit;

    while (runState.getStatus() === 'RUNNING') {
      const currentStageId = runState.getCurrentStageId();
      if (currentStageId === null) {
        runState.setStatus('COMPLETED');
        this.onRunReachedTerminalState(runState);
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

      const inputContext = new AgentExecutionInputContext({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        proposal: runState.proposal,
        upstreamArtifacts: runState.getApprovedUpstreamArtifactsMap(),
        historicalRejectionLessons: historicalLessons,
        humanFeedbackDirective: rollbackDirective,
        scenarioHints: runState.scenarioHints,
        tokenBudgetRemaining: tokenBudgetLimit - runState.getTokensUsedTotal(),
        dynamicContextNeeds,
      });

      // C1 + 步骤 4：预取外部上下文（静态声明 + LLM 动态需求合并；离线时动态项为空）
      if (this.contextRegistry) {
        const staticNeeds = STAGE_CONTEXT_NEEDS[currentStageId] ?? [];
        const dynamicExtras = dynamicContextNeeds.filter(
          (n) => !staticNeeds.some((s) => s.type === n.type),
        );
        await this.contextRegistry.resolve([...staticNeeds, ...dynamicExtras], {
          runId: runState.runId,
          stageId: currentStageId,
          proposal: runState.proposal,
          upstreamSummaries: runState.getActiveBranchSnapshots().map((s) => ({
            stageId: s.stageId,
            summary: s.artifact.summary,
          })),
        });
      }

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
            relatedSnapshotId: 'ROOT',
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

  /**
   * B2：按阶段判定是否发起受限协商，并生成质询内容。
   * - PD 阶段：UI 设计质询 PM（交互可行性冲突）
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
    });
    const result = reconstructor.restore(persisted);
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
    });
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
  }): Promise<WorkflowRunState> {
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
      return await this.continueExecutionUntilGateOrComplete(params.runId);
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
  public async invokeSupervisorConversationalRollback(params: {
    runId: string;
    humanActor: string;
    actorUserId?: string;
    dialogueInstruction: string;
    explicitTargetStageId?: WorkflowStageId;
  }): Promise<WorkflowRunState> {
    const runState = this.stateEngine.getRunOrThrow(params.runId);
    const parsedDirective = await this.supervisorAgent.parseNaturalLanguageRollback(
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

    return await this.continueExecutionUntilGateOrComplete(params.runId);
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
