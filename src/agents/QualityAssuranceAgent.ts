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
import { GitWorktreeSandboxManager } from '../sandbox/GitWorktreeSandboxManager.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  AbstractWorkerAgent,
  AgentExecutionInputContext,
  RecognizedStageIntent,
} from './AbstractWorkerAgent.ts';

export class QualityAssuranceAgent extends AbstractWorkerAgent<QaVerificationArtifactContract> {
  private readonly sandboxManager: GitWorktreeSandboxManager;

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

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): QaVerificationArtifactContract {
    const upstreamCode = context.upstreamArtifacts.get(WorkflowStageId.STAGE_3B_ENGINEER) as
      CodeImplementationArtifactContract | undefined;

    const reqIds = upstreamCode
      ? upstreamCode.coreRequirementIds
      : context.proposal.coreRequirementIds;

    // E2：真实执行 node:test 并解析计数/覆盖率（不再使用硬编码套件与覆盖率）
    const verification = this.sandboxManager.executeSandboxVerification({
      runId: context.runId,
      branchId: context.branchId,
      requirementIds: reqIds,
      runSubprocessNodeTest: true,
    });

    const totalCases = verification.totalTestCases;
    // J1 演示开关：强制 QA 失败（驱动 B2 Engineer 修复闭环的可测试路径）
    const forceQaFailure = context.scenarioHints?.forceQaFailure === true;
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
