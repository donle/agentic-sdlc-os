/**
 * @file RiskEvaluationChain.ts
 * @description 责任链模式 (Chain of Responsibility Pattern) 实现的业务风险动态门禁评估器。
 *
 * 业务规则：
 * - 低风险变更（风险分 < 阈值，且无协商熔断/Scope缩减）：自动放行并强制留存审计痕迹 (AUTO_PASS_WITH_AUDIT)。
 * - 高风险变更（涉及 DDL 变更、权限/支付、Scope 缩减、协商超限熔断、或 QA 强制门禁）：阻塞等待人工核验或裁决。
 */

import {
  type IDomainArtifactContract,
  ProjectProposalContract,
  QaVerificationArtifactContract,
  TechSpecArtifactContract,
} from '../domain/contracts.ts';
import { BusinessRiskLevel, GateActionType, WorkflowStageId } from '../domain/enums.ts';
import { ScopeDiffReport } from '../domain/models.ts';

/**
 * 风险评估上下文输入对象
 */
export class RiskEvaluationContext {
  public readonly stageId: WorkflowStageId;
  public readonly proposal: ProjectProposalContract;
  public readonly artifact: IDomainArtifactContract;
  public readonly scopeDiff: ScopeDiffReport;
  public readonly negotiationEscalated: boolean;
  public readonly forceHumanGateForStage: boolean;

  public constructor(params: {
    stageId: WorkflowStageId;
    proposal: ProjectProposalContract;
    artifact: IDomainArtifactContract;
    scopeDiff: ScopeDiffReport;
    negotiationEscalated: boolean;
    forceHumanGateForStage?: boolean;
  }) {
    this.stageId = params.stageId;
    this.proposal = params.proposal;
    this.artifact = params.artifact;
    this.scopeDiff = params.scopeDiff;
    this.negotiationEscalated = params.negotiationEscalated;
    this.forceHumanGateForStage = Boolean(params.forceHumanGateForStage);
  }
}

/**
 * 风险评估累计状态载体
 */
export class RiskEvaluationAccumulator {
  private totalScore: number;
  private readonly reasons: string[];
  private requiresConflictArbitration: boolean;

  public constructor() {
    this.totalScore = 10; // 基础分 10 分
    this.reasons = [];
    this.requiresConflictArbitration = false;
  }

  public addRiskScore(delta: number, reason: string): void {
    this.totalScore = Math.min(100, this.totalScore + delta);
    this.reasons.push(reason);
  }

  public markConflictArbitrationRequired(reason: string): void {
    this.requiresConflictArbitration = true;
    this.addRiskScore(65, reason);
  }

  public getScore(): number {
    return this.totalScore;
  }

  public getReasons(): ReadonlyArray<string> {
    return [...this.reasons];
  }

  public isConflictArbitrationRequired(): boolean {
    return this.requiresConflictArbitration;
  }
}

/**
 * 风险评估最终结果值对象
 */
export class RiskEvaluationVerdict {
  public readonly riskScore: number;
  public readonly riskLevel: BusinessRiskLevel;
  public readonly gateAction: GateActionType;
  public readonly reasons: ReadonlyArray<string>;

  public constructor(params: {
    riskScore: number;
    riskLevel: BusinessRiskLevel;
    gateAction: GateActionType;
    reasons: ReadonlyArray<string>;
  }) {
    this.riskScore = params.riskScore;
    this.riskLevel = params.riskLevel;
    this.gateAction = params.gateAction;
    this.reasons = [...params.reasons];
  }
}

/**
 * 抽象风险评估责任链节点 (Abstract Handler in Chain of Responsibility)
 */
export abstract class AbstractRiskRuleHandler {
  private nextHandler: AbstractRiskRuleHandler | null = null;

  public setNext(handler: AbstractRiskRuleHandler): AbstractRiskRuleHandler {
    this.nextHandler = handler;
    return handler;
  }

  public handle(context: RiskEvaluationContext, accumulator: RiskEvaluationAccumulator): void {
    this.evaluateRule(context, accumulator);
    if (this.nextHandler !== null) {
      this.nextHandler.handle(context, accumulator);
    }
  }

  protected abstract evaluateRule(
    context: RiskEvaluationContext,
    accumulator: RiskEvaluationAccumulator,
  ): void;
}

/**
 * 规则节点 1：检测 Agent 协商熔断升级
 */
export class NegotiationEscalationRiskHandler extends AbstractRiskRuleHandler {
  protected override evaluateRule(
    context: RiskEvaluationContext,
    accumulator: RiskEvaluationAccumulator,
  ): void {
    if (context.negotiationEscalated) {
      accumulator.markConflictArbitrationRequired(
        'Agent 间协商超出最大轮次上限 (Max Turns) 未达成共识，触发总管熔断，必须由人工裁决方案',
      );
    }
  }
}

/**
 * 规则节点 2：检测“虚假共识”导致的核心需求范围缩减 (Scope Cut)
 */
export class ScopeReductionRiskHandler extends AbstractRiskRuleHandler {
  protected override evaluateRule(
    context: RiskEvaluationContext,
    accumulator: RiskEvaluationAccumulator,
  ): void {
    if (context.scopeDiff.hasUnauthorizedScopeReduction) {
      const dropped = context.scopeDiff.droppedRequirementIds.join(', ');
      accumulator.addRiskScore(
        60,
        `检测到核心需求范围缩减 (Scope Diff 告警)：条目 [${dropped}] 在协商中被删减，需人工确认`,
      );
    }
  }
}

/**
 * 规则节点 3：检测数据库 DDL 结构变更风险
 */
export class DatabaseDdlRiskHandler extends AbstractRiskRuleHandler {
  protected override evaluateRule(
    context: RiskEvaluationContext,
    accumulator: RiskEvaluationAccumulator,
  ): void {
    if (context.artifact instanceof TechSpecArtifactContract) {
      if (context.artifact.databaseDdlStatements.length > 0) {
        accumulator.addRiskScore(
          55,
          `技术方案包含 ${context.artifact.databaseDdlStatements.length} 条数据库 Schema DDL 变更，触发架构师高风险审核门禁`,
        );
      }
    }
  }
}

/**
 * 规则节点 4：检测涉及权限/支付核心域或 QA 阶段安全缺陷
 */
export class SecurityAndCoreDomainRiskHandler extends AbstractRiskRuleHandler {
  protected override evaluateRule(
    context: RiskEvaluationContext,
    accumulator: RiskEvaluationAccumulator,
  ): void {
    if (
      context.proposal.involvesPermissionOrPayment &&
      context.stageId === WorkflowStageId.STAGE_3A_TECH_SPEC
    ) {
      accumulator.addRiskScore(45, '提案涉及权限或支付核心安全域，技术契约需人工复核');
    }
    if (context.artifact instanceof QaVerificationArtifactContract) {
      if (context.artifact.securityIssuesFound > 0 || !context.artifact.allAcceptanceCriteriaMet) {
        accumulator.addRiskScore(70, 'QA 自动化验证发现未闭合缺陷或安全隐患，强制阻塞发布');
      }
    }
    if (context.forceHumanGateForStage) {
      accumulator.addRiskScore(55, `阶段 [${context.stageId}] 配置为上线前强制人工签核门禁`);
    }
  }
}

/**
 * 业务风险评估管道门面类 ( assembling the Chain of Responsibility )
 */
export class RiskEvaluationPipeline {
  private readonly headHandler: AbstractRiskRuleHandler;
  private highRiskThreshold: number;

  public constructor(highRiskThreshold = 60) {
    this.highRiskThreshold = highRiskThreshold;
    const escalationHandler = new NegotiationEscalationRiskHandler();
    const scopeHandler = new ScopeReductionRiskHandler();
    const ddlHandler = new DatabaseDdlRiskHandler();
    const securityHandler = new SecurityAndCoreDomainRiskHandler();

    escalationHandler.setNext(scopeHandler).setNext(ddlHandler).setNext(securityHandler);
    this.headHandler = escalationHandler;
  }

  public getHighRiskThreshold(): number {
    return this.highRiskThreshold;
  }

  public setHighRiskThreshold(threshold: number): void {
    if (threshold >= 20 && threshold <= 100) {
      this.highRiskThreshold = threshold;
    }
  }

  public evaluate(context: RiskEvaluationContext): RiskEvaluationVerdict {
    const accumulator = new RiskEvaluationAccumulator();
    this.headHandler.handle(context, accumulator);

    const score = accumulator.getScore();
    let riskLevel: BusinessRiskLevel = BusinessRiskLevel.LOW;
    if (score >= 80) {
      riskLevel = BusinessRiskLevel.CRITICAL;
    } else if (score >= this.highRiskThreshold) {
      riskLevel = BusinessRiskLevel.HIGH;
    } else if (score >= 35) {
      riskLevel = BusinessRiskLevel.MEDIUM;
    }

    let gateAction: GateActionType = GateActionType.AUTO_PASS_WITH_AUDIT;
    if (accumulator.isConflictArbitrationRequired()) {
      gateAction = GateActionType.BLOCK_FOR_CONFLICT_ARBITRATION;
    } else if (score >= this.highRiskThreshold) {
      gateAction = GateActionType.BLOCK_FOR_HUMAN_VERIFICATION;
    }

    const reasons =
      accumulator.getReasons().length > 0
        ? accumulator.getReasons()
        : ['常规低风险增量产出，契约完整性校验通过，符合自动放行并留存审计轨迹策略'];

    return new RiskEvaluationVerdict({
      riskScore: score,
      riskLevel,
      gateAction,
      reasons,
    });
  }
}
