/**
 * @file ProductManagerAgent.ts
 * @description Stage 1: PM Agent（产品经理智能体）实现类。
 *
 * ============================================================================
 * 【PM Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 核心职责边界：
 *    - 接收业务发起人在 Stage 0 提交的《项目原始提案 (`ProjectProposalContract`)》；
 *    - 自动结合企业历史驳回库中的负向经验（Negative RAG），将模糊业务诉求拆解为具有严格边界的
 *      User Stories 和可量化验收标准（Acceptance Criteria）；
 *    - 【关键遗漏补全 — 埋点前置协同】：在 PRD 生成阶段同步定义《数据埋点规划 (`trackingPlanEvents`)》，
 *      确保上线后 Stage 5 的 DA Agent 有据可查。
 *
 * 2. 输入契约：
 *    - `ProjectProposalContract`（包含核心需求字典 `requirementDescriptions` 与安全/DB 标记）
 *    - `historicalRejectionLessons`（历史被人类驳回的经验教训）
 *    - `humanFeedbackDirective`（若发生由总管 Agent 调度的 Fork 回退，附带人类修正指令）
 *
 * 3. 输出契约：
 *    - `PrdArtifactContract`（包含 User Stories、验收标准、埋点事件清单、非功能性约束）
 *
 * 4. 下游协同与反哺：
 *    - 输出的 PRD 快照将移交至 Stage 2 的 `ProductDesignerAgent`；
 *    - 若 `ProductDesignerAgent` 在 UI 规范映射中发现可行性冲突，PM Agent 将作为协商响应方
 *      在 `BoundedNegotiationMediator` 的管控下进行受限轮次（Max Turns）对齐。
 * ============================================================================
 */

import { containsPlaceholderText, PrdArtifactContract } from '../domain/contracts.ts';
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

export class ProductManagerAgent extends AbstractWorkerAgent<PrdArtifactContract> {
  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
  }) {
    super({
      role: AgentRole.PRODUCT_MANAGER,
      stageId: WorkflowStageId.STAGE_1_PM,
      modelTier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      ...deps,
    });
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    const reqCount = context.proposal.coreRequirementIds.length;
    const hasFeedback = Boolean(context.humanFeedbackDirective);
    const intentCode = hasFeedback
      ? `PRD_REVISION_WITH_DIRECTIVE_${reqCount}_REQS`
      : `PRD_SYNTHESIS_AND_TRACKING_PLAN_${reqCount}_REQS`;

    return new RecognizedStageIntent(
      intentCode,
      `拆解 ${reqCount} 项核心业务需求为结构化 User Stories，并同步生成前置埋点规划`,
      0.97,
    );
  }

  protected override validateStageSpecificConstraints(
    candidate: PrdArtifactContract,
    _context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    const violations: string[] = [];
    if (containsPlaceholderText(candidate.summary, true)) {
      violations.push('PRD summary 不得为空或包含 TBD/待定 等未完成占位词');
    }
    const coveredReqIds = new Set<string>();
    for (const story of candidate.userStories) {
      coveredReqIds.add(story.reqId);
      if (containsPlaceholderText(story.story)) {
        violations.push(`需求 [${story.reqId}] 的 User Story 包含空值或占位符`);
      }
      if (story.acceptanceCriteria.length === 0) {
        violations.push(`需求 [${story.reqId}] 缺少可量化验收标准 (acceptanceCriteria)`);
      } else {
        for (const ac of story.acceptanceCriteria) {
          if (containsPlaceholderText(ac)) {
            violations.push(`需求 [${story.reqId}] 的验收标准包含空值或占位符 [${ac}]`);
          }
        }
      }
    }
    for (const reqId of candidate.coreRequirementIds) {
      if (!coveredReqIds.has(reqId)) {
        violations.push(`核心需求 [${reqId}] 未被任何 User Story 覆盖`);
      }
    }
    for (const evt of candidate.trackingPlanEvents) {
      if (containsPlaceholderText(evt.eventName) || containsPlaceholderText(evt.triggerCondition)) {
        violations.push(`埋点事件 [${evt.eventName || '(空)'}] 包含空值或占位符`);
      }
    }
    return violations;
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): PrdArtifactContract {
    const allReqIds = [...context.proposal.coreRequirementIds];
    // 如果提案配置了“模拟虚假共识删减需求”，则故意在协商后丢弃最后一项需求，用于触发 FalseConsensusGuard 告警
    const effectiveReqIds =
      context.scenarioHints?.forceScopeReduction === true && allReqIds.length > 1
        ? allReqIds.slice(0, allReqIds.length - 1)
        : allReqIds;

    const userStories = effectiveReqIds.map((reqId) => {
      const desc = context.proposal.requirementDescriptions[reqId] ?? reqId;
      return {
        reqId,
        story: `作为企业角色用户，我希望实现【${desc}】，以提升跨岗位研发交付效率。`,
        acceptanceCriteria: [
          `AC-1: [${reqId}] 必须支持全链路状态可观测与异常回退`,
          `AC-2: [${reqId}] 响应延迟 < 200ms 且所有变更写入不可变审计日志`,
        ],
      };
    });

    const trackingPlanEvents = effectiveReqIds.map((reqId, idx) => ({
      eventName: `sdlc_feature_${reqId.toLowerCase()}_interacted`,
      triggerCondition: `当用户完成需求项 #${idx + 1} (${reqId}) 的核心交互动作时触发`,
      properties: ['run_id', 'branch_id', 'actor_role', 'latency_ms'],
    }));

    const nonFunctionalConstraints = [
      '单机私有化内网环境零外部云依赖运行',
      '所有人工审批与策略自动放行均须携带快照签名',
    ];
    if (context.historicalRejectionLessons.length > 0) {
      nonFunctionalConstraints.push(
        `历史驳回避坑约束：${context.historicalRejectionLessons.join('；')}`,
      );
    }
    if (context.humanFeedbackDirective) {
      nonFunctionalConstraints.push(`总管回退人工修正指令：${context.humanFeedbackDirective}`);
    }

    return new PrdArtifactContract({
      summary: `已完成《${context.proposal.title}》结构化 PRD（含 ${userStories.length} 条 User Stories 与 ${trackingPlanEvents.length} 项前置埋点事件）${context.humanFeedbackDirective ? ` [已应用人工回退指令: ${context.humanFeedbackDirective}]` : ''}`,
      coreRequirementIds: effectiveReqIds,
      userStories,
      trackingPlanEvents,
      nonFunctionalConstraints,
      agentRationale: `PM 基于原始提案的 ${allReqIds.length} 项诉求拆解可量化验收标准，并与前置埋点方案强绑定，结合 ${context.historicalRejectionLessons.length} 条历史驳回教训约束交付边界。`,
      keyDecisions: [
        {
          decision: `为 ${userStories.length} 条 User Stories 前置挂载 ${trackingPlanEvents.length} 项标准归因埋点事件`,
          rationale:
            '在需求阶段前置对齐埋点字段（run_id/branch_id/actor_role/latency_ms），避免上线后数据盲区与返工',
          tradeoffs: ['PRD 编写期增加埋点属性确认动作', '换取 Stage 5 DA 自动核验与零后期返工'],
        },
      ],
    });
  }
}
