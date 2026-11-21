/**
 * @file FalseConsensusGuard.ts
 * @description 规约模式 (Specification Pattern) 实现的“防虚假共识守卫”。
 *
 * 设计目的：
 * 大模型在多 Agent 协商时具有讨好与妥协倾向（Sycophancy）。
 * Например, PD Agent 提出某交互实现困难，PM Agent 可能为了“达成一致”擅自删减核心业务需求。
 * 本守卫对比原始提案基准需求 ID 集合与当前阶段交付物需求 ID 集合，一旦发现未经授权的范围缩减，立即生成 ScopeDiffReport 触发高风险门禁。
 */

import { type IDomainArtifactContract, ProjectProposalContract } from '../domain/contracts.ts';
import { ScopeDiffReport } from '../domain/models.ts';

export class FalseConsensusGuard {
  /**
   * 校验当前阶段产出物是否悄悄阉割了原始提案的核心需求条目
   */
  public evaluateScopeIntegrity(
    baselineProposal: ProjectProposalContract,
    candidateArtifact: IDomainArtifactContract,
  ): ScopeDiffReport {
    return new ScopeDiffReport(
      baselineProposal.coreRequirementIds,
      candidateArtifact.coreRequirementIds,
    );
  }
}
