/**
 * @file FalseConsensusGuard.ts
 * @description 规约模式 (Specification Pattern) 实现的“防虚假共识守卫”。
 *
 * 设计目的：
 * 大模型在多 Agent 协商时具有讨好与妥协倾向（Sycophancy）。
 * Например, PD Agent 提出某交互实现困难，PM Agent 可能为了“达成一致”擅自删减核心业务需求。
 * 本守卫对比原始提案基准需求 ID 集合与当前阶段交付物需求 ID 集合，一旦发现未经授权的范围缩减，立即生成 ScopeDiffReport 触发高风险门禁。
 */

import {
  containsPlaceholderText,
  type IDomainArtifactContract,
  ProjectProposalContract,
  QaVerificationArtifactContract,
  TechSpecArtifactContract,
} from '../domain/contracts.ts';
import { BusinessRiskLevel } from '../domain/enums.ts';
import { ScopeDiffReport } from '../domain/models.ts';

export interface SemanticInvariantReport {
  readonly scopeDiff: ScopeDiffReport;
  readonly hasSemanticViolation: boolean;
  readonly violationReasons: ReadonlyArray<string>;
}

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

  /**
   * 语义不变量防伪共识校验（Pillar 4 / AC-11）：
   * 除需求 ID 差集外，进一步拦截“留着 ID 但软阉割内容/低报风险/带漏洞宣称全部通过”的伪共识交付物
   */
  public evaluateSemanticInvariants(
    baselineProposal: ProjectProposalContract,
    candidateArtifact: IDomainArtifactContract,
  ): SemanticInvariantReport {
    const scopeDiff = this.evaluateScopeIntegrity(baselineProposal, candidateArtifact);
    const violationReasons: string[] = [];

    if (scopeDiff.hasUnauthorizedScopeReduction) {
      violationReasons.push(
        `未经授权删减了核心需求: [${scopeDiff.droppedRequirementIds.join(', ')}]`,
      );
    }

    if (containsPlaceholderText(candidateArtifact.summary, true)) {
      violationReasons.push('阶段摘要包含空值或 TBD/待定/暂不实现 等软阉割占位措辞');
    }

    const serializedBody = JSON.stringify(candidateArtifact);
    if (/(?:\bTBD\b|\bTODO\b|待定|后续补充|暂不实现)/i.test(serializedBody)) {
      violationReasons.push('交付物字段内含延迟兑现或占位承诺（TBD/待定/暂不实现/后续补充）');
    }

    if (candidateArtifact instanceof TechSpecArtifactContract) {
      const highRiskProposal =
        baselineProposal.involvesDatabaseMigration ||
        baselineProposal.involvesPermissionOrPayment ||
        candidateArtifact.databaseDdlStatements.length > 0;
      if (highRiskProposal && candidateArtifact.declaredRiskLevel === BusinessRiskLevel.LOW) {
        violationReasons.push('高危提案（涉 DDL 或权限支付域）在技术契约中被低报为 LOW 风险');
      }
    }

    if (candidateArtifact instanceof QaVerificationArtifactContract) {
      if (candidateArtifact.allAcceptanceCriteriaMet && candidateArtifact.securityIssuesFound > 0) {
        violationReasons.push(
          `QA 契约自相矛盾：存在 ${candidateArtifact.securityIssuesFound} 个安全漏洞却宣称 allAcceptanceCriteriaMet=true`,
        );
      }
    }

    return {
      scopeDiff,
      hasSemanticViolation: violationReasons.length > 0,
      violationReasons,
    };
  }
}
