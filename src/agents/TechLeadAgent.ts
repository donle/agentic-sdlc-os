/**
 * @file TechLeadAgent.ts
 * @description Stage 3a: Tech Lead Agent（架构师与技术负责人智能体）实现类。
 *
 * ============================================================================
 * 【Tech Lead Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 为什么需要将 Stage 3 拆分为 3a (Tech Lead) 与 3b (Engineer)？
 *    - 在真实企业研发中，若让编码 Agent 拿到 PRD 和 UI 后直接动手写业务代码，
 *      一旦底层表结构（DDL）或接口契约设计不合理，生成的所有代码文件都将报废重来。
 *    - 因此 Tech Lead Agent 专门负责“先定契约、再写代码”：输出 API 接口规范、数据库变更 DDL
 *      以及强制采用的面向对象设计模式清单。
 *
 * 2. 动态风险门禁联动：
 *    - 当提案涉及数据库 Schema 变更 (`involvesDatabaseMigration`) 或权限/支付域时，
 *      Tech Lead Agent 生成的 `databaseDdlStatements` 会被 `DatabaseDdlRiskHandler` 自动识别，
 *      将风险分拉高至 60 分以上，从而在 Stage 3a 自动阻塞并向人类架构师发送【待核验】提醒！
 * ============================================================================
 */

import { TechSpecArtifactContract, UiDesignArtifactContract } from '../domain/contracts.ts';
import {
  AgentRole,
  BusinessRiskLevel,
  ModelRoutingTier,
  WorkflowStageId,
} from '../domain/enums.ts';
import { WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  AbstractWorkerAgent,
  AgentExecutionInputContext,
  RecognizedStageIntent,
} from './AbstractWorkerAgent.ts';

export class TechLeadAgent extends AbstractWorkerAgent<TechSpecArtifactContract> {
  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
  }) {
    super({
      role: AgentRole.TECH_LEAD,
      stageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
      modelTier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      ...deps,
    });
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    const hasDdl = context.proposal.involvesDatabaseMigration;
    return new RecognizedStageIntent(
      hasDdl ? 'ARCH_CONTRACT_WITH_DDL_MIGRATION' : 'ARCH_CONTRACT_STATELESS_API',
      hasDdl
        ? '制定面向对象模块架构契约、REST API 规范及高风险数据库 DDL 迁移脚本'
        : '制定无破坏性变更的面向对象模块契约与 API 接口规范',
      0.98,
    );
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): TechSpecArtifactContract {
    const upstreamUi = context.upstreamArtifacts.get(WorkflowStageId.STAGE_2_PD) as
      UiDesignArtifactContract | undefined;

    const reqIds = upstreamUi ? upstreamUi.coreRequirementIds : context.proposal.coreRequirementIds;

    const apiContracts = reqIds.map((reqId) => ({
      method: 'POST',
      endpoint: `/api/v1/workflows/${reqId.toLowerCase()}/execute`,
      requestSchema: `${reqId}CommandPayload`,
      responseSchema: `${reqId}SnapshotEnvelope`,
    }));

    const ddlStatements = context.proposal.involvesDatabaseMigration
      ? [
          "ALTER TABLE stage_snapshots ADD COLUMN IF NOT EXISTS scope_diff_json JSONB NOT NULL DEFAULT '{}';",
          'CREATE INDEX CONCURRENTLY idx_stage_snapshots_branch_state ON stage_snapshots (branch_id, state);',
        ]
      : [];

    const declaredRiskLevel =
      ddlStatements.length > 0 || context.proposal.involvesPermissionOrPayment
        ? BusinessRiskLevel.HIGH
        : BusinessRiskLevel.LOW;

    return new TechSpecArtifactContract({
      summary: `已输出技术架构契约：定义 ${apiContracts.length} 个标准接口，${ddlStatements.length} 条数据库 DDL 变更，强制采用 Template Method / Memento / Chain of Responsibility 模式`,
      coreRequirementIds: reqIds,
      apiContracts,
      databaseDdlStatements: ddlStatements,
      declaredRiskLevel,
      architecturePatternsUsed: [
        'Template Method Pattern (AbstractWorkerAgent)',
        'Memento Pattern (StageSnapshotMemento & DAG Branching)',
        'Chain of Responsibility Pattern (RiskEvaluationPipeline)',
        'Mediator & Command Pattern (SupervisorAgent & BoundedNegotiationMediator)',
      ],
    });
  }
}
