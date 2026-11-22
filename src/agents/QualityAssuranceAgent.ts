/**
 * @file QualityAssuranceAgent.ts
 * @description Stage 4: QA Agent（质量保证与自动化测试智能体）实现类。
 *
 * ============================================================================
 * 【QA Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 核心职责边界：
 *    - 同时读取 Stage 1 的《PRD 验收标准 (`PrdArtifactContract`)》与 Stage 3b 的
 *      《沙箱代码产物 (`CodeImplementationArtifactContract`)》；
 *    - 调用 `GitWorktreeSandboxManager` 在隔离沙箱工作区对真实落盘的代码与测试文件执行校验与静态安全扫描；
 *    - 若发现未通过的测试用例或安全漏洞，通过 `BoundedNegotiationMediator` 打回给
 *      `SoftwareEngineerAgent` 进行受限轮次修复；
 *    - 作为上线前最后一道技术关卡，Stage 4 默认配置为强制人工终审门禁（或高风险阻塞），
 *      确保人类 QA/发布负责人掌握最终上线放行权。
 * ============================================================================
 */

import {
  CodeImplementationArtifactContract,
  QaVerificationArtifactContract,
} from '../domain/contracts.ts';
import { AgentRole, ModelRoutingTier, WorkflowStageId } from '../domain/enums.ts';
import { WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import {
  GitWorktreeSandboxManager,
  type SandboxVerificationResult,
} from '../sandbox/GitWorktreeSandboxManager.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  AbstractWorkerAgent,
  AgentExecutionInputContext,
  RecognizedStageIntent,
} from './AbstractWorkerAgent.ts';

export class QualityAssuranceAgent extends AbstractWorkerAgent<QaVerificationArtifactContract> {
  private readonly sandboxManager: GitWorktreeSandboxManager;
  private lastPreparedVerification: {
    readonly key: string;
    readonly reqIds: ReadonlyArray<string>;
    readonly verification: SandboxVerificationResult;
    readonly forceQaFailure: boolean;
  } | null = null;

  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
    sandboxManager?: GitWorktreeSandboxManager;
  }) {
    super({
      role: AgentRole.QUALITY_ASSURANCE,
      stageId: WorkflowStageId.STAGE_4_QA,
      modelTier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      ...deps,
    });
    this.sandboxManager = deps.sandboxManager ?? new GitWorktreeSandboxManager();
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    return new RecognizedStageIntent(
      `QA_CONTRACT_AND_SECURITY_VERIFICATION_${context.proposal.coreRequirementIds.length}_REQS`,
      '对照 PRD 验收标准在隔离沙箱中执行自动化单测、契约集成测试与静态安全漏洞扫描',
      0.97,
    );
  }

  private ensureSandboxVerified(context: AgentExecutionInputContext): {
    readonly key: string;
    readonly reqIds: ReadonlyArray<string>;
    readonly verification: SandboxVerificationResult;
    readonly forceQaFailure: boolean;
  } {
    const key = `${context.runId}::${context.branchId}::${context.humanFeedbackDirective ?? ''}`;
    if (this.lastPreparedVerification && this.lastPreparedVerification.key === key) {
      return this.lastPreparedVerification;
    }

    const upstreamCode = context.upstreamArtifacts.get(WorkflowStageId.STAGE_3B_ENGINEER) as
      CodeImplementationArtifactContract | undefined;

    const reqIds = upstreamCode
      ? upstreamCode.coreRequirementIds
      : context.proposal.coreRequirementIds;

    // E2/E3：真实执行 node:test / Docker 容器并解析计数/覆盖率
    const verification = this.sandboxManager.executeSandboxVerification({
      runId: context.runId,
      branchId: context.branchId,
      requirementIds: reqIds,
      runSubprocessNodeTest: true,
    });

    const forceQaFailure = context.scenarioHints?.forceQaFailure === true;
    this.lastPreparedVerification = { key, reqIds, verification, forceQaFailure };
    return this.lastPreparedVerification;
  }

  /**
   * A1 + E2/E3 闭环：在进入 LLM 推理前先执行真实沙箱 node:test / Docker 测试与静态安全扫描，
   * 并将真实测试套件结果注入 Prompt 的 sandboxVerification 字段（对齐 StagePromptSpecs 声明）。
   */
  protected override prepareStageEnvironment(
    context: AgentExecutionInputContext,
  ): Record<string, unknown> {
    const { verification, forceQaFailure } = this.ensureSandboxVerified(context);
    const effectiveSecurityIssues = forceQaFailure
      ? verification.securityIssuesFound + 1
      : verification.securityIssuesFound;
    return {
      filesVerifiedCount: verification.filesVerifiedCount,
      totalTestCases: verification.totalTestCases,
      passedTestCases: verification.passedTestCases,
      failedTestCases: verification.failedTestCases,
      coveragePercent: verification.coveragePercent,
      securityIssuesFound: effectiveSecurityIssues,
      allAcceptanceCriteriaMet:
        verification.failedTestCases === 0 && effectiveSecurityIssues === 0 && !forceQaFailure,
      runtime: verification.runtime,
      suites: verification.suites.map((suite) => ({
        suiteName: suite.suiteName,
        totalCases: suite.totalCases,
        passedCases: suite.passedCases,
        failedCases: suite.failedCases,
        coveragePercent: suite.coveragePercent ?? 0,
      })),
    };
  }

  /**
   * 防 LLM 谎报校验：对比真实沙箱测试结果与 LLM 输出的 QaVerificationArtifactContract，
   * 若真实沙箱存在失败单测或安全漏洞但 LLM 谎报 allAcceptanceCriteriaMet=true，直接产生违规触发 A2 自愈重试。
   */
  protected override validateStageSpecificConstraints(
    candidate: QaVerificationArtifactContract,
    context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    const key = `${context.runId}::${context.branchId}::${context.humanFeedbackDirective ?? ''}`;
    if (!this.lastPreparedVerification || this.lastPreparedVerification.key !== key) {
      return [];
    }
    const { verification, forceQaFailure } = this.lastPreparedVerification;
    const effectiveSecurityIssues = forceQaFailure
      ? verification.securityIssuesFound + 1
      : verification.securityIssuesFound;
    const realHasFailure =
      verification.failedTestCases > 0 || effectiveSecurityIssues > 0 || forceQaFailure;

    const violations: string[] = [];
    if (realHasFailure && candidate.allAcceptanceCriteriaMet) {
      violations.push(
        `QA 真实沙箱验证未通过（失败单测 ${verification.failedTestCases} 条，高危安全漏洞 ${effectiveSecurityIssues} 个），allAcceptanceCriteriaMet 严禁谎报为 true`,
      );
    }
    if (effectiveSecurityIssues > 0 && candidate.securityIssuesFound < effectiveSecurityIssues) {
      violations.push(
        `QA 真实沙箱扫描发现 ${effectiveSecurityIssues} 个高危安全漏洞，报告不得瞒报（当前填报 ${candidate.securityIssuesFound}）`,
      );
    }
    return violations;
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): QaVerificationArtifactContract {
    const { reqIds, verification, forceQaFailure } = this.ensureSandboxVerified(context);

    const totalCases = verification.totalTestCases;
    const coverageText =
      verification.coveragePercent !== null
        ? `，平均行覆盖率 ${verification.coveragePercent}%`
        : '';
    return new QaVerificationArtifactContract({
      summary: `已完成沙箱自动化测试验证（校验落盘文件 ${verification.filesVerifiedCount} 个）：共执行 ${totalCases} 条真实 node:test 用例，通过 ${verification.passedTestCases} 条${coverageText}，高危安全漏洞 ${verification.securityIssuesFound} 个${forceQaFailure ? '（演示场景：注入未通过缺陷以驱动修复闭环）' : ''}`,
      coreRequirementIds: reqIds,
      testSuitesExecuted: verification.suites.map((suite) => ({
        suiteName: suite.suiteName,
        totalCases: suite.totalCases,
        passedCases: suite.passedCases,
        coveragePercent: suite.coveragePercent ?? 0,
      })),
      securityIssuesFound: forceQaFailure
        ? verification.securityIssuesFound + 1
        : verification.securityIssuesFound,
      allAcceptanceCriteriaMet:
        verification.failedTestCases === 0 &&
        verification.securityIssuesFound === 0 &&
        !forceQaFailure,
    });
  }
}
