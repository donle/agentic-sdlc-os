/**
 * @file SoftwareEngineerAgent.ts
 * @description Stage 3b: Engineer Agent（软件研发工程师智能体）实现类。
 *
 * ============================================================================
 * 【Engineer Agent 角色职责与详细工作流程说明】
 * ============================================================================
 * 1. 核心职责边界：
 *    - 严格依据 Stage 3a 经批准的《技术架构契约 (`TechSpecArtifactContract`)》以及
 *      Stage 2 的《UI 设计契约 (`UiDesignArtifactContract`)》编写模块化面向对象代码；
 *    - 【沙箱与分支隔离】：每次执行均通过 `GitWorktreeSandboxManager` 绑定独立的
 *      Git Worktree 沙箱分支（如 `worktree/run-xxx/branch-main`），并在隔离目录中真实落盘业务类与单测代码；
 *    - 【本地私有模型路由】：默认绑定 `PRIVACY_SENSITIVE_LOCAL` 模型路由层级（如内网 vLLM 部署的
 *      Qwen2.5-Coder-32B），确保企业核心源码 100% 不出内网，同时大幅降低大规模代码生成的 Token 成本。
 * ============================================================================
 */

import {
  CodeImplementationArtifactContract,
  TechSpecArtifactContract,
} from '../domain/contracts.ts';
import { AgentRole, ModelRoutingTier, WorkflowStageId } from '../domain/enums.ts';
import { WorkflowEventBus } from '../patterns/EventBus.ts';
import { FalseConsensusGuard } from '../patterns/FalseConsensusGuard.ts';
import { ModelRouterGateway } from '../patterns/ModelRouterGateway.ts';
import {
  GitWorktreeSandboxManager,
  type SandboxProvisionResult,
  type SandboxVerificationResult,
} from '../sandbox/GitWorktreeSandboxManager.ts';
import { IntentFulfillmentTracker } from '../telemetry/IntentFulfillmentTracker.ts';
import { PromptCacheManager } from '../telemetry/PromptCacheManager.ts';
import {
  AbstractWorkerAgent,
  AgentExecutionInputContext,
  RecognizedStageIntent,
} from './AbstractWorkerAgent.ts';

interface PreparedSandboxEntry {
  readonly key: string;
  readonly reqIds: ReadonlyArray<string>;
  readonly provisionResult: SandboxProvisionResult;
  readonly selfVerification: SandboxVerificationResult;
}

export class SoftwareEngineerAgent extends AbstractWorkerAgent<CodeImplementationArtifactContract> {
  private readonly sandboxManager: GitWorktreeSandboxManager;
  private readonly preparedSandboxes = new Map<string, PreparedSandboxEntry>();

  public constructor(deps: {
    eventBus: WorkflowEventBus;
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    modelRouter: ModelRouterGateway;
    falseConsensusGuard: FalseConsensusGuard;
    sandboxManager?: GitWorktreeSandboxManager;
  }) {
    super({
      role: AgentRole.SOFTWARE_ENGINEER,
      stageId: WorkflowStageId.STAGE_3B_ENGINEER,
      modelTier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      ...deps,
    });
    this.sandboxManager = deps.sandboxManager ?? new GitWorktreeSandboxManager();
  }

  protected override recognizeStageIntent(
    context: AgentExecutionInputContext,
  ): RecognizedStageIntent {
    return new RecognizedStageIntent(
      `SANDBOX_OOP_IMPLEMENTATION_${context.branchId.toUpperCase()}`,
      `在隔离 Git Worktree 沙箱分支 [${context.branchId}] 中实现面向对象业务类、埋点代码与单元测试`,
      0.96,
    );
  }

  private ensureSandboxProvisioned(context: AgentExecutionInputContext): PreparedSandboxEntry {
    const key = this.buildPreparedContextKey(context);
    const cached = this.preparedSandboxes.get(key);
    if (cached) {
      return cached;
    }

    const upstreamTech = context.upstreamArtifacts.get(WorkflowStageId.STAGE_3A_TECH_SPEC) as
      TechSpecArtifactContract | undefined;

    const reqIds = upstreamTech
      ? upstreamTech.coreRequirementIds
      : context.proposal.coreRequirementIds;

    const provisionResult = this.sandboxManager.provisionWorktreeAndWriteCode({
      runId: context.runId,
      branchId: context.branchId,
      proposalTitle: context.proposal.title,
      requirementIds: reqIds,
      requirementDescriptions: context.proposal.requirementDescriptions,
      ddlStatements: upstreamTech?.databaseDdlStatements ?? [],
      humanDirective: context.humanFeedbackDirective,
    });

    // E2：3b 自测真实化——真实执行 node:test / Docker 并解析结果
    const selfVerification = this.sandboxManager.executeSandboxVerification({
      runId: context.runId,
      branchId: context.branchId,
      requirementIds: reqIds,
      runSubprocessNodeTest: true,
    });

    return this.saveBoundedPreparedState(this.preparedSandboxes, key, {
      key,
      reqIds,
      provisionResult,
      selfVerification,
    });
  }

  /**
   * A1 + E1/E2 闭环：无论 LLM 在线还是离线，在步骤 4 推理前先执行真实 Git Worktree 沙箱落盘与自测，
   * 并将分支名、落盘文件列表与真实自测结果注入 Prompt 的 sandboxVerification 字段。
   */
  protected override prepareStageEnvironment(
    context: AgentExecutionInputContext,
  ): Record<string, unknown> {
    const { provisionResult, selfVerification } = this.ensureSandboxProvisioned(context);
    return {
      gitWorktreeBranch: provisionResult.gitWorktreeBranch,
      workspacePath: provisionResult.workspacePath,
      simulated: provisionResult.simulated,
      modifiedFiles: provisionResult.generatedFiles.map((f) => ({
        filePath: f.filePath,
        className: f.className,
        designPattern: f.designPattern,
        linesChanged: f.linesChanged,
      })),
      selfTestPassed:
        selfVerification.failedTestCases === 0 && selfVerification.securityIssuesFound === 0,
      totalTestCases: selfVerification.totalTestCases,
      passedTestCases: selfVerification.passedTestCases,
      failedTestCases: selfVerification.failedTestCases,
      securityIssuesFound: selfVerification.securityIssuesFound,
      runtime: selfVerification.runtime,
    };
  }

  protected override applyLlmPostProcessing(
    _candidate: CodeImplementationArtifactContract,
    rawCandidate: Record<string, unknown>,
    context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    if (!Array.isArray(rawCandidate.filePatches) || rawCandidate.filePatches.length === 0) {
      return [];
    }

    const patches: Array<{ filePath: string; content: string }> = [];
    for (const item of rawCandidate.filePatches) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.filePath === 'string' &&
          rec.filePath.trim().length > 0 &&
          typeof rec.content === 'string'
        ) {
          patches.push({ filePath: rec.filePath.trim(), content: rec.content });
        }
      }
    }
    if (patches.length === 0) {
      return [];
    }

    const prepared = this.ensureSandboxProvisioned(context);
    const patchOutcome = this.sandboxManager.applyFilePatches({
      runId: context.runId,
      branchId: context.branchId,
      patches,
    });
    if (patchOutcome.rejectedFiles.length > 0) {
      return patchOutcome.rejectedFiles.map(
        (r) => `filePatches 路径被沙箱安全策略拒绝 [${r.filePath}]: ${r.reason}`,
      );
    }

    const reVerification = this.sandboxManager.executeSandboxVerification({
      runId: context.runId,
      branchId: context.branchId,
      requirementIds: prepared.reqIds,
      runSubprocessNodeTest: true,
    });

    this.saveBoundedPreparedState(this.preparedSandboxes, prepared.key, {
      ...prepared,
      selfVerification: reVerification,
    });

    return [];
  }

  protected override validateStageSpecificConstraints(
    candidate: CodeImplementationArtifactContract,
    context: AgentExecutionInputContext,
  ): ReadonlyArray<string> {
    const key = this.buildPreparedContextKey(context);
    const prepared = this.preparedSandboxes.get(key);
    if (!prepared) {
      return [];
    }
    const { selfVerification } = prepared;
    const realPassed =
      selfVerification.failedTestCases === 0 && selfVerification.securityIssuesFound === 0;
    if (!realPassed && candidate.selfTestPassed) {
      return [
        `Engineer 沙箱真实自测未通过（失败用例 ${selfVerification.failedTestCases} 条，安全漏洞 ${selfVerification.securityIssuesFound} 个），selfTestPassed 严禁谎报为 true`,
      ];
    }
    return [];
  }

  protected override synthesizeTemplateArtifact(
    context: AgentExecutionInputContext,
    _attemptIndex: number,
  ): CodeImplementationArtifactContract {
    const { reqIds, provisionResult, selfVerification } = this.ensureSandboxProvisioned(context);

    const modifiedFiles = provisionResult.generatedFiles.map((f) => ({
      filePath: f.filePath,
      className: f.className,
      designPattern: f.designPattern,
      linesChanged: f.linesChanged,
    }));

    return new CodeImplementationArtifactContract({
      summary: `已在隔离沙箱分支 [${provisionResult.gitWorktreeBranch}] 真实落盘 ${modifiedFiles.length} 个核心面向对象模块与配套单测文件${provisionResult.simulated ? '（模拟 HEAD 模式）' : ''}；自测 ${selfVerification.passedTestCases}/${selfVerification.totalTestCases} 通过`,
      coreRequirementIds: reqIds,
      gitWorktreeBranch: provisionResult.gitWorktreeBranch,
      modifiedFiles,
      selfTestPassed:
        selfVerification.failedTestCases === 0 && selfVerification.securityIssuesFound === 0,
      agentRationale: `Engineer 在隔离 Git Worktree 分支 [${provisionResult.gitWorktreeBranch}] 中按 3a 架构契约完成 ${modifiedFiles.length} 个文件落地，并执行真实子进程自测（${selfVerification.passedTestCases}/${selfVerification.totalTestCases} 通过，安全告警 ${selfVerification.securityIssuesFound} 项）。`,
      keyDecisions: [
        {
          decision: `隔离分支 ${provisionResult.gitWorktreeBranch} + 增量面向对象模块实现`,
          rationale: '将业务代码与主干工作区物理隔离，确保任何回退/返修不会污染既有分支快照',
          tradeoffs: ['维护独立 Worktree 磁盘空间', '获得可独立编译/单测/回溯的代码沙箱'],
        },
      ],
    });
  }
}
