/**
 * @file ProductDesignerAgent.ts
 * @description Stage 2: PD Agent（产品交互与 UI 设计师智能体）实现类。
 *
 * ============================================================================
 * 【PD Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 核心职责边界：
 *    - 接收 Stage 1 经门禁放行的《结构化 PRD (`PrdArtifactContract`)》；
 *    - 将每条 User Story 映射至企业标准设计系统组件库（Design System Components），
 *      并补全空状态、加载态、错误态等交互边界以及无障碍（A11y）检查项；
 *    - 【反向挑战机制】：若发现 PRD 中存在超出当前组件库规范、交互矛盾或实现代价极高的设计，
 *      自动生成 `designChallengeNote`，触发与 `ProductManagerAgent` 的受限轮次协商。
 *
 * 2. 输入契约：
 *    - 上游 `PrdArtifactContract`
 *    - 企业 UI 设计系统规范与人类回退指令（若有）
 *
 * 3. 输出契约：
 *    - `UiDesignArtifactContract`（包含组件库映射清单、交互状态机、无障碍清单、质询意见）
 * ============================================================================
 */

import {
  containsPlaceholderText,
  PrdArtifactContract,
  UiDesignArtifactContract,
} from '../domain/contracts.ts';
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

export class ProductDesignerAgent extends AbstractWorkerAgent<UiDesignArtifactContract> {
  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
  }) {
    super({
      role: AgentRole.PRODUCT_DESIGNER,
      stageId: WorkflowStageId.STAGE_2_PD,
      modelTier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      ...deps,
    });
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    const hasFeedback = Boolean(context.humanFeedbackDirective);
    return new RecognizedStageIntent(
      hasFeedback
        ? 'UI_SPEC_REDESIGN_FROM_SUPERVISOR_ROLLBACK'
        : 'UI_COMPONENT_MAPPING_AND_UX_AUDIT',
      hasFeedback
        ? `根据总管回退指令重塑 UI 交互布局：${context.humanFeedbackDirective}`
        : '将 PRD 用户故事映射为企业 Design System 组件树并校验交互可行性',
      0.95,
    );
  }

  protected override validateStageSpecificConstraints(
    candidate: UiDesignArtifactContract,
    _context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    const violations: string[] = [];
    if (containsPlaceholderText(candidate.summary, true)) {
      violations.push('UI 设计 summary 不得为空或包含 TBD/待定 等未完成占位词');
    }
    const coveredReqIds = new Set<string>();
    for (const mapping of candidate.componentMappings) {
      coveredReqIds.add(mapping.reqId);
      if (containsPlaceholderText(mapping.designSystemComponent)) {
        violations.push(`需求 [${mapping.reqId}] 映射的 Design System 组件名无效或包含占位符`);
      }
      if (mapping.interactionStates.length === 0) {
        violations.push(`需求 [${mapping.reqId}] 缺少交互状态机声明`);
      } else if (mapping.interactionStates.some((s) => containsPlaceholderText(s))) {
        violations.push(`需求 [${mapping.reqId}] 的交互状态包含空值或占位符`);
      }
    }
    for (const reqId of candidate.coreRequirementIds) {
      if (!coveredReqIds.has(reqId)) {
        violations.push(`核心需求 [${reqId}] 缺少 UI 组件映射`);
      }
    }
    return violations;
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): UiDesignArtifactContract {
    const upstreamPrd = context.upstreamArtifacts.get(WorkflowStageId.STAGE_1_PM) as
      PrdArtifactContract | undefined;

    const reqIds = upstreamPrd
      ? upstreamPrd.coreRequirementIds
      : context.proposal.coreRequirementIds;

    const preferredContainer =
      context.humanFeedbackDirective && context.humanFeedbackDirective.includes('抽屉')
        ? 'EnterpriseSideDrawerContainer'
        : 'EnterpriseSplitViewWorkbench';

    const componentMappings = reqIds.map((reqId, idx) => ({
      reqId,
      designSystemComponent:
        idx === 0 ? `${preferredContainer} + DagBranchCanvas` : `ActionableCardGrid::${reqId}`,
      interactionStates: [
        'DEFAULT',
        'LOADING_SKELETON',
        'EMPTY_STATE',
        'ERROR_RETRY',
        'DIFF_HIGHLIGHT',
      ],
    }));

    const challengeNote =
      context.scenarioHints?.forceNegotiationDeadlock === true
        ? 'PD 质询：PRD 要求的「移动端三维实时拓扑拖拽」超出当前企业组件库性能边界，建议降级为双栏折叠抽屉或申请 2 人日新增自定义画布组件'
        : null;

    return new UiDesignArtifactContract({
      summary: `已产出 UI/UX 组件规范（采用 ${preferredContainer} 布局，映射 ${componentMappings.length} 组核心视图）${context.humanFeedbackDirective ? ` [已执行回退修正: ${context.humanFeedbackDirective}]` : ''}`,
      coreRequirementIds: reqIds,
      componentMappings,
      accessibilityChecklist: [
        'WCAG 2.1 AA 对比度校验通过',
        '所有人工门禁裁决按钮支持键盘快捷键与二次确认防误触',
      ],
      designChallengeNote: challengeNote,
    });
  }
}
