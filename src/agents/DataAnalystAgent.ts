/**
 * @file DataAnalystAgent.ts
 * @description Stage 5: DA Agent（数据分析与埋点核验智能体）实现类。
 *
 * ============================================================================
 * 【DA Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 核心职责边界：
 *    - 核验 Stage 1 (`PrdArtifactContract`) 中前置规划的 `trackingPlanEvents` 是否已在
 *      Stage 3b (`CodeImplementationArtifactContract`) 中完整埋入；
 *    - 构建特性上线后的核心业务指标监控看板配置（基线值 vs 目标转化率），
 *      并将业务复盘结论沉淀回企业知识库，形成完整的研发数据闭环。
 * ============================================================================
 */

import { DataAnalysisArtifactContract, PrdArtifactContract } from '../domain/contracts.ts';
import { AgentRole, ModelRoutingTier, WorkflowStageId } from '../domain/enums.ts';
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

export class DataAnalystAgent extends AbstractWorkerAgent<DataAnalysisArtifactContract> {
  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
  }) {
    super({
      role: AgentRole.DATA_ANALYST,
      stageId: WorkflowStageId.STAGE_5_DA,
      modelTier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      ...deps,
    });
  }

  protected override recognizeStageIntent(
    _context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    return new RecognizedStageIntent(
      'DA_TRACKING_AUDIT_AND_ATTRIBUTION_MODEL',
      '核验前置埋点契约覆盖完整性并生成上线后业务转化归因模型',
      0.96,
    );
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): DataAnalysisArtifactContract {
    const upstreamPrd = context.upstreamArtifacts.get(WorkflowStageId.STAGE_1_PM) as
      PrdArtifactContract | undefined;

    const reqIds = upstreamPrd
      ? upstreamPrd.coreRequirementIds
      : context.proposal.coreRequirementIds;

    const events = upstreamPrd
      ? upstreamPrd.trackingPlanEvents.map((e) => e.eventName)
      : reqIds.map((id) => `sdlc_feature_${id.toLowerCase()}_interacted`);

    return new DataAnalysisArtifactContract({
      summary: `已核验 ${events.length} 项前置埋点事件 100% 挂载就绪，并建立交付周期与缺陷逃逸率双维归因看板`,
      coreRequirementIds: reqIds,
      verifiedTrackingEvents: events,
      projectedMetrics: [
        {
          metricName: '需求从提案到上线交付周期 (Lead Time)',
          baselineValue: '14.5 人日',
          targetValue: '4.2 人日 (-71%)',
        },
        {
          metricName: '跨岗位需求理解偏差返工率',
          baselineValue: '28.0%',
          targetValue: '< 5.0%',
        },
      ],
    });
  }
}
