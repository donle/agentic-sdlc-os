/**
 * @file UpstreamCompressor.ts
 * @description 省 Token 核心改进：上游产物摘要压缩器。
 * 将上游完整产物 JSON（可能数千 tokens）压缩为结构化摘要（数百 tokens），
 * 只保留对当前阶段有决策价值的字段，丢弃冗余描述。
 */

import type { IDomainArtifactContract } from '../../domain/contracts.ts';
import { WorkflowStageId } from '../../domain/enums.ts';

export interface UpstreamDigest {
  readonly stageId: WorkflowStageId;
  readonly summary: string;
  readonly coreRequirementIds: ReadonlyArray<string>;
  /** 阶段关键决策字段（按类型提取，非全文） */
  readonly keyFields: Readonly<Record<string, unknown>>;
  /** 估算 token 数 */
  readonly tokenEstimate: number;
}

/** 每个 stage 关心的上游产物关键字段（其余省略） */
const KEY_FIELD_EXTRACTORS: Record<
  WorkflowStageId,
  (details: Record<string, unknown>) => Record<string, unknown>
> = {
  STAGE_0_INITIATION: (d) => ({
    requirementCount: Object.keys(
      (d.requirementDescriptions as Record<string, string> | undefined) ?? {},
    ).length,
    involvesDatabaseMigration: Boolean(d.involvesDatabaseMigration),
    involvesPermissionOrPayment: Boolean(d.involvesPermissionOrPayment),
  }),
  STAGE_1_PM: (d) => ({
    userStoryCount: ((d.userStories as unknown[]) ?? []).length,
    trackingEventCount: ((d.trackingPlanEvents as unknown[]) ?? []).length,
    nonFunctionalConstraints: ((d.nonFunctionalConstraints as string[]) ?? []).slice(0, 3),
  }),
  STAGE_2_PD: (d) => ({
    componentMappings: (
      (d.componentMappings as Array<{ reqId: string; designSystemComponent: string }>) ?? []
    )
      .slice(0, 5)
      .map((m) => `${m.reqId}→${m.designSystemComponent}`),
    designChallengeNote: d.designChallengeNote ?? null,
  }),
  STAGE_3A_TECH_SPEC: (d) => ({
    apiEndpoints: ((d.apiContracts as Array<{ method: string; endpoint: string }>) ?? [])
      .slice(0, 5)
      .map((a) => `${a.method} ${a.endpoint}`),
    ddlCount: ((d.databaseDdlStatements as string[] | undefined) ?? []).length,
    patterns: ((d.architecturePatternsUsed as string[]) ?? []).slice(0, 3),
  }),
  STAGE_3B_ENGINEER: (d) => ({
    branch: d.gitWorktreeBranch,
    fileCount: ((d.modifiedFiles as unknown[]) ?? []).length,
    selfTestPassed: d.selfTestPassed,
  }),
  STAGE_4_QA: (d) => ({
    allPassed: d.allAcceptanceCriteriaMet,
    securityIssues: d.securityIssuesFound,
    suiteSummary: (
      (d.testSuitesExecuted as Array<{
        suiteName: string;
        passedCases: number;
        totalCases: number;
      }>) ?? []
    )
      .slice(0, 3)
      .map((s) => `${s.suiteName}: ${s.passedCases}/${s.totalCases}`),
  }),
  STAGE_5_DA: (d) => ({
    verifiedEvents: ((d.verifiedTrackingEvents as string[] | undefined) ?? []).length,
    metricCount: ((d.projectedMetrics as unknown[] | undefined) ?? []).length,
  }),
};

export class UpstreamCompressor {
  /**
   * 将上游产物压缩为结构化摘要（关键决策字段 + 一行 summary），
   * 不注入完整 JSON（省 Token 核心改进）。
   */
  public compress(
    artifacts: ReadonlyArray<{ stageId: WorkflowStageId; artifact: IDomainArtifactContract }>,
    maxTokensPerItem = 300,
  ): ReadonlyArray<UpstreamDigest> {
    return artifacts.map(({ stageId, artifact }) => {
      const extractor = KEY_FIELD_EXTRACTORS[stageId];
      // 各 *ArtifactContract 为扁平强类型结构，关键字段直接在产物对象上（提案亦然）
      const keyFields = extractor ? extractor(artifact as unknown as Record<string, unknown>) : {};

      const digestText = JSON.stringify({
        summary: artifact.summary.slice(0, 100),
        reqIds: [...artifact.coreRequirementIds],
        ...keyFields,
      });

      return {
        stageId,
        summary: artifact.summary,
        coreRequirementIds: [...artifact.coreRequirementIds],
        keyFields,
        tokenEstimate: Math.min(Math.ceil(digestText.length / 2), maxTokensPerItem),
      };
    });
  }
}
