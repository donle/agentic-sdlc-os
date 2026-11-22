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
  public readonly totalTokensConsumed: number;

  public constructor(turns: ReadonlyArray<NegotiationTurnRecord>, totalTokensConsumed = 0) {
    this.turns = [...turns];
    const last = turns[turns.length - 1];
    this.latestTurn = last;
    this.consensusReached = last.consensusReached;
    this.escalatedToSupervisor = last.escalatedToSupervisor;
    this.totalTokensConsumed = totalTokensConsumed;
  }
}

export type NegotiationAction = 'ACCEPT_AND_PATCH' | 'REBUT_WITH_EVIDENCE' | 'ESCALATE_TRADEOFF';

export interface NegotiationTurnHistorySummary {
  readonly turnIndex: number;
  readonly responderAction?: NegotiationAction;
  readonly responseResolution: string;
  readonly challengerCritique?: string;
}

/** B1 / Pillar 4：对抗式双上下文 LLM 轮次执行器接口（Facade 提供实现，离线降级到剧本路径） */
export interface NegotiationRoundRunner {
  runTurn(input: {
    turnIndex: number;
    maxTurns: number;
    challenger: string;
    responder: string;
    challengeContext: string;
    topic: string;
    previousTurns: ReadonlyArray<NegotiationTurnHistorySummary>;
  }): Promise<{
    responseResolution: string;
    consensusReached: boolean;
    optionAProposal: string;
    optionBProposal: string;
    tokensConsumed?: number;
    responderAction?: NegotiationAction;
    concretePatch?: string;
    challengerVerified?: boolean;
    challengerCritique?: string;
    independentJudgePassed?: boolean;
    independentJudgeReason?: string;
  } | null>;
}

export class BoundedNegotiationMediator {
  private maxNegotiationTurns: number;
  private readonly eventBus: WorkflowEventBus;
  private readonly negotiationHistory: NegotiationTurnRecord[];

  private roundRunner: NegotiationRoundRunner | null = null;

  public constructor(
    eventBus: WorkflowEventBus,
    maxNegotiationTurns = 3,
    roundRunner?: NegotiationRoundRunner,
  ) {
    this.eventBus = eventBus;
    this.maxNegotiationTurns = maxNegotiationTurns;
    this.roundRunner = roundRunner ?? null;
    this.negotiationHistory = [];
  }

  public getMaxNegotiationTurns(): number {
    return this.maxNegotiationTurns;
  }

  public setRoundRunner(runner: NegotiationRoundRunner | null): void {
    this.roundRunner = runner;
  }

  public setMaxNegotiationTurns(turns: number): void {
    if (turns >= 1 && turns <= 10) {
      this.maxNegotiationTurns = turns;
    }
  }

  /**
   * 协调下游质询 Agent 与上游响应 Agent 的受限轮次博弈
   */
  public async mediateChallenge(params: {
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    challengerRole: AgentRole;
    responderRole: AgentRole;
    initialChallengePoint: string;
    topic?: string;
    forceDeadlockToMaxTurns: boolean;
  }): Promise<BoundedNegotiationOutcome> {
    const turns: NegotiationTurnRecord[] = [];
    const previousTurns: NegotiationTurnHistorySummary[] = [];
    const topic = params.topic ?? 'DESIGN_REVIEW';
    let totalTokensConsumed = 0;

    for (let turnIndex = 1; turnIndex <= this.maxNegotiationTurns; turnIndex += 1) {
      const reachedMax = turnIndex === this.maxNegotiationTurns;

      // B1 / Pillar 4：对抗式双上下文 LLM 轮次执行（携带历史交锋并支持即时 ESCALATE_TRADEOFF 与盲审否决）
      let responseText = '';
      let llmConsensus: boolean | null = null;
      let llmOptionA = '';
      let llmOptionB = '';
      let responderAction: NegotiationAction | undefined;
      let challengerVerified: boolean | undefined;
      let challengerCritique: string | undefined;
      let independentJudgePassed: boolean | undefined;
      let independentJudgeReason: string | undefined;

      if (this.roundRunner) {
        const llmTurn = await this.roundRunner.runTurn({
          turnIndex,
          maxTurns: this.maxNegotiationTurns,
          challenger: params.challengerRole,
          responder: params.responderRole,
          challengeContext: params.initialChallengePoint,
          topic,
          previousTurns: [...previousTurns],
        });
        if (llmTurn) {
          responseText = llmTurn.responseResolution;
          llmConsensus = llmTurn.consensusReached;
          llmOptionA = llmTurn.optionAProposal;
          llmOptionB = llmTurn.optionBProposal;
          totalTokensConsumed += llmTurn.tokensConsumed ?? 0;
          responderAction = llmTurn.responderAction;
          challengerVerified = llmTurn.challengerVerified;
          challengerCritique = llmTurn.challengerCritique;
          independentJudgePassed = llmTurn.independentJudgePassed;
          independentJudgeReason = llmTurn.independentJudgeReason;
        }
      }

      const explicitTradeoffEscalation = responderAction === 'ESCALATE_TRADEOFF';
      let finalConsensusReached: boolean;
      let escalated: boolean;

      if (params.forceDeadlockToMaxTurns) {
        finalConsensusReached = false;
        escalated = reachedMax;
      } else if (explicitTradeoffEscalation) {
        finalConsensusReached = false;
        escalated = true;
      } else if (challengerVerified === false || independentJudgePassed === false) {
        finalConsensusReached = false;
        escalated = reachedMax;
      } else {
        finalConsensusReached = llmConsensus !== null ? llmConsensus : true;
        escalated = !finalConsensusReached && reachedMax;
      }

      if (!responseText) {
        responseText = finalConsensusReached
          ? `[${params.responderRole}] 已采纳 [${params.challengerRole}] 的工程约束反馈，补充了异常边界说明且未删减核心业务范围。`
          : `[第 ${turnIndex}/${this.maxNegotiationTurns} 轮分歧] [${params.responderRole}] 坚持保留原高复杂度方案指标，而 [${params.challengerRole}] 评估当前工程边界与质量门禁无法同时满足。`;
      }

      if (challengerVerified === false && challengerCritique) {
        responseText = `${responseText} [挑战方独立复核否决: ${challengerCritique}]`;
      } else if (independentJudgePassed === false && independentJudgeReason) {
        responseText = `${responseText} [防伪共识盲审否决: ${independentJudgeReason}]`;
      }

      previousTurns.push({
        turnIndex,
        responderAction,
        responseResolution: responseText,
        challengerCritique,
      });

      const defaultOptionA =
        topic === 'QA_REPAIR'
          ? '方案 A（QA 推荐）：回退至 Engineer 阶段补充边界防护与修复单测后重新验证（保障零缺陷上线）'
          : '方案 A（PD 推荐）：采用企业标准双栏折叠抽屉组件替代三维实时画布（零额外工期，符合 Design System 规范）';
      const defaultOptionB =
        topic === 'QA_REPAIR'
          ? '方案 B（特批带病放行）：将未闭合的非阻断项转为下期技术债工单，由质量负责人签字特批放行'
          : '方案 B（PM 推荐）：立项扩展自定义 WebGL 画布组件以保留完整视觉交互（工期增加 2 人日，需前端架构师协审）';

      this.eventBus.publishEvent(
        new WorkflowDomainEvent({
          eventId: `EVT-NEG-${Date.now()}-${turnIndex}`,
          runId: params.runId,
          branchId: params.branchId,
          stageId: params.stageId,
          agentRole: params.challengerRole,
          lifecycleState: SnapshotLifecycleState.NEGOTIATING,
          headline: `[协商第 ${turnIndex}/${this.maxNegotiationTurns} 轮] ${params.challengerRole} ↔ ${params.responderRole}：${escalated ? '达到最大讨论限制未达成一致，触发总管熔断！' : finalConsensusReached ? '已达成结构化共识' : '双方存在方案分歧，继续下一轮对齐'}`,
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
        topic,
        turnIndex,
        maxTurnsAllowed: this.maxNegotiationTurns,
        challengerRole: params.challengerRole,
        responderRole: params.responderRole,
        challengePoint: params.initialChallengePoint,
        responseResolution: responseText,
        consensusReached: finalConsensusReached,
        escalatedToSupervisor: escalated,
        optionAProposal: llmOptionA || defaultOptionA,
        optionBProposal: llmOptionB || defaultOptionB,
      });

      turns.push(record);
      this.negotiationHistory.push(record);

      // 一旦达成共识或明确上交权衡熔断（ESCALATE_TRADEOFF），立即结束协商，避免白烧后续轮次 Token
      if (finalConsensusReached || escalated) {
        break;
      }
    }

    return new BoundedNegotiationOutcome(turns, totalTokensConsumed);
  }

  /** D1：恢复历史协商记录（不广播观察者） */
  public restoreTurn(record: NegotiationTurnRecord): void {
    this.negotiationHistory.push(record);
  }

  public getNegotiationHistory(runId?: string): ReadonlyArray<NegotiationTurnRecord> {
    if (!runId) {
      return [...this.negotiationHistory];
    }
    return this.negotiationHistory.filter((item) => item.runId === runId);
  }
}
