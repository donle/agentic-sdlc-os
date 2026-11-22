/**
 * @file SupervisorAgent.ts
 * @description 总管 Agent（Supervisor / PMO 调度官智能体）—— 采用【命令模式 (Command Pattern)】实现。
 *
 * ============================================================================
 * 【总管 Agent 角色边界与核心工作流说明】
 * ============================================================================
 * 1. 黄金架构铁律：只做“PMO 调度官与状态机路由器”，绝不亲自下场改 PRD 或写代码！
 *    - 防止总管 Agent 变成上下文爆炸的“万能保姆”，确保各专业职能 Agent 的契约隔离与权责清晰。
 *
 * 2. 总管 Agent 的三大核心工作机制（封装为三个标准面向对象 Command 类）：
 *    - [机制一：异常接管与冲突提炼 (`EscalateConflictToHumanCommand`)]
 *      当两个职能 Agent（如 PM 与 PD）讨论达到 `maxNegotiationTurns` 仍未达成一致触发熔断时，
 *      总管 Agent 立即接管，将冗长的多轮争论提炼为一张高度结构化的《冲突裁决卡》（含分歧焦点、
 *      方案 A、方案 B），向前端用户推送 `CONFLICT_ARBITRATION_REQUIRED` 实时提醒。
 *
 *    - [机制二：对话式任意节点时间旅行与 DAG 分叉回退 (`ConversationalRollbackCommand`)]
 *      用户随时可以通过自然语言与总管 Agent 对话（例如：“回退到 PD Agent，把弹窗改成侧边抽屉重新走流程”）。
 *      总管 Agent 解析出目标阶段（如 `STAGE_2_PD`）和修正指令，调用 DAG 状态机：
 *      (1) 将当前分支从目标阶段往后的所有旧快照全部标记为 `SUPERSEDED（已废弃）`，彻底隔离脏数据；
 *      (2) 从目标阶段的上游父快照 Fork 出一条全新执行分支（如 `branch-v2`）；
 *      (3) 携带人类的修正指令重新唤醒对应的职能 Agent，并继续向下游推进。
 *
 *    - [机制三：门禁人工核验与责任落账 (`HumanGateVerdictCommand`)]
 *      接收人类在前端对高风险门禁或冲突卡片做出的拍板决定（通过 / 驳回 / 选方案 A / 选方案 B），
 *      写入不可变审计账本 (`ImmutableAuditLedger`)；若为驳回，还将驳回理由沉淀至“负向经验飞轮”。
 * ============================================================================
 */

import {
  AgentRole,
  DecisionVerdict,
  NotificationCategory,
  WorkflowStageId,
} from '../domain/enums.ts';
import {
  AgentUserNotification,
  NegotiationTurnRecord,
  StageSnapshotMemento,
} from '../domain/models.ts';
import { WorkflowEventBus } from '../patterns/EventBus.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import { AgentRegistry } from './AgentRegistry.ts';
import { JsonExtractor } from './prompt/JsonExtractor.ts';

/**
 * 命令模式顶层接口 (Command Interface)
 */
export interface ISupervisorCommand<TResult = void> {
  readonly commandName: string;
  execute(): TResult;
}

/**
 * 自然语言回退意图解析结果值对象
 */
export class ParsedRollbackDirective {
  public readonly targetStageId: WorkflowStageId;
  public readonly targetAgentRole: AgentRole;
  public readonly cleanInstruction: string;

  public constructor(params: {
    targetStageId: WorkflowStageId;
    targetAgentRole: AgentRole;
    cleanInstruction: string;
  }) {
    this.targetStageId = params.targetStageId;
    this.targetAgentRole = params.targetAgentRole;
    this.cleanInstruction = params.cleanInstruction;
  }
}

/**
 * 命令 1：将达到讨论上限的 Agent 冲突提炼为前端待拍板提醒卡片
 */
export class EscalateConflictToHumanCommand implements ISupervisorCommand<AgentUserNotification> {
  public readonly commandName = 'EscalateConflictToHumanCommand';
  private readonly eventBus: WorkflowEventBus;
  private readonly snapshot: StageSnapshotMemento;
  private readonly deadlockedTurn: NegotiationTurnRecord;

  public constructor(params: {
    eventBus: WorkflowEventBus;
    snapshot: StageSnapshotMemento;
    deadlockedTurn: NegotiationTurnRecord;
  }) {
    this.eventBus = params.eventBus;
    this.snapshot = params.snapshot;
    this.deadlockedTurn = params.deadlockedTurn;
  }

  public execute(): AgentUserNotification {
    const notification = new AgentUserNotification({
      notificationId: `NOTIF-CONFLICT-${Date.now()}`,
      runId: this.snapshot.runId,
      branchId: this.snapshot.branchId,
      stageId: this.snapshot.stageId,
      senderRole: AgentRole.SUPERVISOR,
      category: NotificationCategory.CONFLICT_ARBITRATION_REQUIRED,
      title: `【总管熔断接管 · 待人工拍板】${this.deadlockedTurn.challengerRole} 与 ${this.deadlockedTurn.responderRole} 经 ${this.deadlockedTurn.maxTurnsAllowed} 轮协商未达成一致`,
      message: `分歧焦点：${this.deadlockedTurn.challengePoint}。\n• ${this.deadlockedTurn.optionAProposal}\n• ${this.deadlockedTurn.optionBProposal}`,
      relatedSnapshotId: this.snapshot.snapshotId,
      requiresHumanAction: true,
      actionOptions: [
        {
          actionKey: 'CHOOSE_OPTION_A',
          label: '拍板采用方案 A（标准组件降级，零工期延误）',
          verdict: DecisionVerdict.ARBITRATE_OPTION_A,
        },
        {
          actionKey: 'CHOOSE_OPTION_B',
          label: '拍板采用方案 B（扩展定制组件，工期 +2 人日）',
          verdict: DecisionVerdict.ARBITRATE_OPTION_B,
        },
        {
          actionKey: 'REJECT_AND_REWORK',
          label: '全部驳回并要求重做',
          verdict: DecisionVerdict.REJECT,
        },
      ],
    });

    this.eventBus.publishNotification(notification);
    return notification;
  }
}

/**
 * 总管 Agent 主类
 */
export class SupervisorAgent {
  public readonly role = AgentRole.SUPERVISOR;
  private readonly eventBus: WorkflowEventBus;

  private modelRouter: ModelRouterGateway | null;

  public constructor(eventBus: WorkflowEventBus, modelRouter?: ModelRouterGateway) {
    this.eventBus = eventBus;
    this.modelRouter = modelRouter ?? null;
  }

  /**
   * 统一命令调用器 (Invoker in Command Pattern)
   */
  public executeCommand<TResult>(command: ISupervisorCommand<TResult>): TResult {
    return command.execute();
  }

  /**
   * 解析人类与总管 Agent 的自然语言对话指令，定位要回退到的目标阶段与职能 Agent
   * 支持显式指定 targetStageId，也支持直接从自然语言（如“回退到 PD 把布局改成侧边抽屉”）自动识别。
   */
  public async parseNaturalLanguageRollback(
    userDialogue: string,
    explicitTargetStageId?: WorkflowStageId,
    allowedStages?: ReadonlyArray<WorkflowStageId>,
  ): Promise<ParsedRollbackDirective> {
    const text = userDialogue.trim();
    if (explicitTargetStageId) {
      return new ParsedRollbackDirective({
        targetStageId: explicitTargetStageId,
        targetAgentRole: this.mapStageToRole(explicitTargetStageId),
        cleanInstruction: text,
      });
    }

    // C3：先尝试 LLM 解析（离线/失败 → 回退到关键词匹配）
    const llmResult = await this.tryLlmParse(text, allowedStages);
    if (llmResult) {
      return llmResult;
    }
    return this.keywordParse(text, allowedStages);
  }

  /** C3：LLM 结构化输出 {targetStageId, cleanInstruction}；支持当前流水线启用阶段与 J2 自定义节点白名单校验 */
  private async tryLlmParse(
    text: string,
    allowedStages?: ReadonlyArray<WorkflowStageId>,
  ): Promise<ParsedRollbackDirective | null> {
    if (!this.modelRouter) {
      return null;
    }
    try {
      const candidateStages: string[] =
        allowedStages && allowedStages.length > 0
          ? allowedStages.filter((id) => id !== 'STAGE_0_INITIATION')
          : [
              ...Object.values(WorkflowStageId).filter((id) => id !== 'STAGE_0_INITIATION'),
              ...AgentRegistry.default()
                .listCustomStages()
                .map((s) => s.stageId),
            ];
      const validStageSet = new Set<string>(candidateStages);
      const stageList = candidateStages.join(', ');
      const llm = await this.modelRouter.invokeChatCompletion({
        tier: 'HIGH_REASONING_HYBRID' as never,
        systemPrompt: `你是研发流水线总管 Agent。用户会给你一段中文回退指令。请从中解析出目标阶段 ID。
可选阶段 ID（必须精确匹配其中一个）：${stageList}
仅输出 JSON：{"targetStageId": "...", "cleanInstruction": "改写后的可执行指令"}。不要输出其他内容。`,
        userPrompt: text,
        fallbackContentGenerator: () => '',
      });
      if (!llm.usedLiveGateway) {
        return null;
      }
      const extracted = JsonExtractor.extract(llm.content);
      if (!extracted.ok) {
        return null;
      }
      const parsed = extracted.value as { targetStageId?: string; cleanInstruction?: string };
      const stageId = parsed.targetStageId;
      if (!stageId || !validStageSet.has(stageId)) {
        return null;
      }
      return new ParsedRollbackDirective({
        targetStageId: stageId as WorkflowStageId,
        targetAgentRole: this.mapStageToRole(stageId as WorkflowStageId),
        cleanInstruction: parsed.cleanInstruction ?? text,
      });
    } catch {
      return null;
    }
  }

  private keywordParse(
    text: string,
    allowedStages?: ReadonlyArray<WorkflowStageId>,
  ): ParsedRollbackDirective {
    const upper = text.toUpperCase();
    const isAllowed = (st: WorkflowStageId): boolean =>
      !allowedStages || allowedStages.length === 0 || allowedStages.includes(st);

    if (
      (upper.includes('PM') || text.includes('需求') || text.includes('PRD')) &&
      isAllowed(WorkflowStageId.STAGE_1_PM)
    ) {
      return new ParsedRollbackDirective({
        targetStageId: WorkflowStageId.STAGE_1_PM,
        targetAgentRole: AgentRole.PRODUCT_MANAGER,
        cleanInstruction: text,
      });
    }
    if (
      (upper.includes('PD') ||
        upper.includes('UI') ||
        text.includes('设计') ||
        text.includes('交互') ||
        text.includes('抽屉') ||
        text.includes('弹窗')) &&
      isAllowed(WorkflowStageId.STAGE_2_PD)
    ) {
      return new ParsedRollbackDirective({
        targetStageId: WorkflowStageId.STAGE_2_PD,
        targetAgentRole: AgentRole.PRODUCT_DESIGNER,
        cleanInstruction: text,
      });
    }
    if (
      (upper.includes('TECH') ||
        text.includes('架构') ||
        text.includes('表结构') ||
        upper.includes('DDL')) &&
      isAllowed(WorkflowStageId.STAGE_3A_TECH_SPEC)
    ) {
      return new ParsedRollbackDirective({
        targetStageId: WorkflowStageId.STAGE_3A_TECH_SPEC,
        targetAgentRole: AgentRole.TECH_LEAD,
        cleanInstruction: text,
      });
    }
    if ((upper.includes('QA') || text.includes('测试')) && isAllowed(WorkflowStageId.STAGE_4_QA)) {
      return new ParsedRollbackDirective({
        targetStageId: WorkflowStageId.STAGE_4_QA,
        targetAgentRole: AgentRole.QUALITY_ASSURANCE,
        cleanInstruction: text,
      });
    }

    const fallbackStage = isAllowed(WorkflowStageId.STAGE_3B_ENGINEER)
      ? WorkflowStageId.STAGE_3B_ENGINEER
      : (allowedStages?.[0] ?? WorkflowStageId.STAGE_3B_ENGINEER);
    return new ParsedRollbackDirective({
      targetStageId: fallbackStage,
      targetAgentRole: this.mapStageToRole(fallbackStage),
      cleanInstruction: text,
    });
  }

  /**
   * 当高风险门禁或 Scope Diff 触发阻塞时，由总管或阶段 Agent 向前端发送【待核验】提醒
   */
  public notifyHumanVerificationRequired(snapshot: StageSnapshotMemento): AgentUserNotification {
    const isScopeWarning = snapshot.scopeDiffReport.hasUnauthorizedScopeReduction;
    const category = isScopeWarning
      ? NotificationCategory.SCOPE_DIFF_WARNING
      : NotificationCategory.PENDING_VERIFICATION;

    const title = isScopeWarning
      ? `【防虚假共识告警 · 待核验】${snapshot.agentRole} 产出物检测到原始需求范围缩减`
      : `【高风险门禁阻塞 · 待核验】${snapshot.stageId} (风险分 ${snapshot.riskScore}/100) 等待人工审核`;

    const message = `${snapshot.artifact.summary}\n触发原因：${snapshot.riskReasons.join('；')}`;

    const notification = new AgentUserNotification({
      notificationId: `NOTIF-GATE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      runId: snapshot.runId,
      branchId: snapshot.branchId,
      stageId: snapshot.stageId,
      senderRole: snapshot.agentRole,
      category,
      title,
      message,
      relatedSnapshotId: snapshot.snapshotId,
      requiresHumanAction: true,
      actionOptions: [
        {
          actionKey: 'APPROVE_GATE',
          label: '核验通过，放行进入下一阶段',
          verdict: DecisionVerdict.APPROVE,
        },
        {
          actionKey: 'REJECT_GATE',
          label: '驳回方案并沉淀至避坑知识库',
          verdict: DecisionVerdict.REJECT,
        },
      ],
    });

    this.eventBus.publishNotification(notification);
    return notification;
  }

  /**
   * 当低风险阶段自动放行时，推送【自动放行追踪痕迹】提醒，确保全程可追溯
   */
  public notifyLowRiskAutoPassed(snapshot: StageSnapshotMemento): AgentUserNotification {
    const notification = new AgentUserNotification({
      notificationId: `NOTIF-AUTOPASS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      runId: snapshot.runId,
      branchId: snapshot.branchId,
      stageId: snapshot.stageId,
      senderRole: snapshot.agentRole,
      category: NotificationCategory.AUTO_PASSED_TRACE,
      title: `【低风险自动放行 · 已留痕】${snapshot.stageId} (${snapshot.agentRole}) 风险分 ${snapshot.riskScore}/100`,
      message: `${snapshot.artifact.summary}（可随时通过总管 Agent 对话回退至此节点）`,
      relatedSnapshotId: snapshot.snapshotId,
      requiresHumanAction: false,
    });

    this.eventBus.publishNotification(notification);
    return notification;
  }

  private mapStageToRole(stageId: WorkflowStageId): AgentRole {
    const custom = AgentRegistry.default().getCustomStage(String(stageId));
    if (custom) {
      return custom.agentRole as AgentRole;
    }
    switch (stageId) {
      case WorkflowStageId.STAGE_1_PM:
        return AgentRole.PRODUCT_MANAGER;
      case WorkflowStageId.STAGE_2_PD:
        return AgentRole.PRODUCT_DESIGNER;
      case WorkflowStageId.STAGE_3A_TECH_SPEC:
        return AgentRole.TECH_LEAD;
      case WorkflowStageId.STAGE_3B_ENGINEER:
        return AgentRole.SOFTWARE_ENGINEER;
      case WorkflowStageId.STAGE_4_QA:
        return AgentRole.QUALITY_ASSURANCE;
      case WorkflowStageId.STAGE_5_DA:
        return AgentRole.DATA_ANALYST;
      default:
        return AgentRole.SUPERVISOR;
    }
  }
}
