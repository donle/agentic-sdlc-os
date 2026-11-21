/**
 * @file BoundedNegotiationMediator.ts
 * @description 中介者模式 (Mediator Pattern) 实现的受限轮次多智能体协商器。
 *
 * ============================================================================
 * 【受限协商与防死循环熔断机制说明】
 * ============================================================================
 * 1. 为什么必须引入协商中介者？
 *    - 若允许 PD Agent 与 PM Agent（或 QA Agent 与 Engineer Agent）直接点对点自由循环对话，
 *      极易陷入无限客套、反复拉锯的死循环，瞬间烧穿企业的 Token 预算。
 * 2. 核心工作流：
 *    - 当下游 Agent（如 PD Agent）产出 `designChallengeNote` 质询上游 Agent（如 PM Agent）时，
 *      由 `BoundedNegotiationMediator` 接管对话循环；
 *    - 强制执行 `maxNegotiationTurns`（默认最多 3 轮）：
 *      * 每进行一轮，通过 EventBus 向前端实时推送 `NEGOTIATING (Turn k/N)` 状态；
 *      * 若在 N 轮内达成共识，输出 `consensusReached = true` 的协商记录，进入防虚假共识校验；
 *      * 若达到 `maxNegotiationTurns` 仍未达成一致，立即触发**熔断 (`escalatedToSupervisor = true`)**，
 *        停止双方继续消耗 Token，并将争议上下文移交 `SupervisorAgent` 生成冲突裁决卡片交由人类拍板。
 * ============================================================================
 */

import { AgentRole, SnapshotLifecycleState, WorkflowStageId } from '../domain/enums.ts';
import { NegotiationTurnRecord } from '../domain/models.ts';
import { WorkflowDomainEvent, WorkflowEventBus } from '../patterns/EventBus.ts';

export class BoundedNegotiationOutcome {
  public readonly turns: ReadonlyArray<NegotiationTurnRecord>;
  public readonly consensusReached: boolean;
  public readonly escalatedToSupervisor: boolean;
  public readonly latestTurn: NegotiationTurnRecord;

  public constructor(turns: ReadonlyArray<NegotiationTurnRecord>) {
    this.turns = [...turns];
    const last = turns[turns.length - 1];
    this.latestTurn = last;
    this.consensusReached = last.consensusReached;
    this.escalatedToSupervisor = last.escalatedToSupervisor;
  }
}

export class BoundedNegotiationMediator {
  private maxNegotiationTurns: number;
  private readonly eventBus: WorkflowEventBus;
  private readonly negotiationHistory: NegotiationTurnRecord[];

  public constructor(eventBus: WorkflowEventBus, maxNegotiationTurns = 3) {
    this.eventBus = eventBus;
    this.maxNegotiationTurns = maxNegotiationTurns;
    this.negotiationHistory = [];
  }

  public getMaxNegotiationTurns(): number {
    return this.maxNegotiationTurns;
  }

  public setMaxNegotiationTurns(turns: number): void {
    if (turns >= 1 && turns <= 10) {
      this.maxNegotiationTurns = turns;
    }
  }

  /**
   * 协调下游质询 Agent 与上游响应 Agent 的受限轮次博弈
   */
  public mediateChallenge(params: {
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    challengerRole: AgentRole;
    responderRole: AgentRole;
    initialChallengePoint: string;
    forceDeadlockToMaxTurns: boolean;
  }): BoundedNegotiationOutcome {
    const turns: NegotiationTurnRecord[] = [];
    const totalTurnsToRun = params.forceDeadlockToMaxTurns ? this.maxNegotiationTurns : 1;

    for (let turnIndex = 1; turnIndex <= totalTurnsToRun; turnIndex += 1) {
      const reachedMax = turnIndex === this.maxNegotiationTurns;
      const consensusReached = !params.forceDeadlockToMaxTurns;
      const escalated = params.forceDeadlockToMaxTurns && reachedMax;

      const responseText = consensusReached
        ? `[${params.responderRole}] 已采纳 [${params.challengerRole}] 的工程约束反馈，补充了异常边界说明且未删减核心业务范围。`
        : `[第 ${turnIndex}/${this.maxNegotiationTurns} 轮分歧] [${params.responderRole}] 坚持保留原高复杂度实时交互指标，而 [${params.challengerRole}] 评估现有组件库与工期无法同时满足。`;

      this.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: `EVT-NEG-${Date.now()}-${turnIndex}`,
          runId: params.runId,
          branchId: params.branchId,
          stageId: params.stageId,
          agentRole: params.challengerRole,
          lifecycleState: SnapshotLifecycleState.NEGOTIATING,
          headline: `[协商第 ${turnIndex}/${this.maxNegotiationTurns} 轮] ${params.challengerRole} ↔ ${params.responderRole}：${escalated ? '达到最大讨论限制未达成一致，触发总管熔断！' : consensusReached ? '已达成结构化共识' : '双方存在方案分歧，继续下一轮对齐'}`,
          detailPayload: {
            turnIndex,
            maxTurns: this.maxNegotiationTurns,
            challengePoint: params.initialChallengePoint,
            responseResolution: responseText,
            escalated,
          },
        }),
      );

      const record = new NegotiationTurnRecord({
        negotiationId: `NEG-${Date.now()}-${turnIndex}`,
        runId: params.runId,
        branchId: params.branchId,
        turnIndex,
        maxTurnsAllowed: this.maxNegotiationTurns,
        challengerRole: params.challengerRole,
        responderRole: params.responderRole,
        challengePoint: params.initialChallengePoint,
        responseResolution: responseText,
        consensusReached,
        escalatedToSupervisor: escalated,
        optionAProposal:
          '方案 A（PD 推荐）：采用企业标准双栏折叠抽屉组件替代三维实时画布（零额外工期，符合 Design System 规范）',
        optionBProposal:
          '方案 B（PM 推荐）：立项扩展自定义 WebGL 画布组件以保留完整视觉交互（工期增加 2 人日，需前端架构师协审）',
      });

      turns.push(record);
      this.negotiationHistory.push(record);
    }

    return new BoundedNegotiationOutcome(turns);
  }

  public getNegotiationHistory(runId?: string): ReadonlyArray<NegotiationTurnRecord> {
    if (!runId) {
      return [...this.negotiationHistory];
    }
    return this.negotiationHistory.filter((item) => item.runId === runId);
  }
}
