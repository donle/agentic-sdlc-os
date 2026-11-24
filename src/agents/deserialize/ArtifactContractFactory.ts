/**
 * @file ArtifactContractFactory.ts
 * @description LLM JSON 输出 → 强类型 *ArtifactContract（BACKEND_TODO_DESIGN A1）。
 * 只做字段映射与默认值填充（容错），业务校验仍由各契约的 validateContractIntegrity() 负责，
 * 校验失败产生的违规项交由 AbstractWorkerAgent 自愈重试循环（A2）。
 * 同时服务于 D1 启动恢复：持久化的 artifactDetails 走同一工厂反序列化为强类型契约。
 */

import {
  type ArtifactKeyDecision,
  CodeImplementationArtifactContract,
  DataAnalysisArtifactContract,
  PrdArtifactContract,
  QaVerificationArtifactContract,
  TechSpecArtifactContract,
  UiDesignArtifactContract,
} from '../../domain/contracts.ts';
import { AgentRole, BusinessRiskLevel, WorkflowStageId } from '../../domain/enums.ts';

export interface ArtifactParseResult {
  readonly ok: boolean;
  readonly artifact?: import('../../domain/contracts.ts').IDomainArtifactContract;
  readonly violations: ReadonlyArray<string>;
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
}

function asNumber(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function asBoolean(raw: unknown): boolean {
  return raw === true;
}

function riskLevel(raw: unknown): BusinessRiskLevel {
  return raw === 'LOW' || raw === 'MEDIUM' || raw === 'HIGH' || raw === 'CRITICAL'
    ? raw
    : BusinessRiskLevel.MEDIUM;
}

function parseRationaleMeta(raw: Record<string, unknown>): {
  readonly agentRationale?: string;
  readonly keyDecisions?: ReadonlyArray<ArtifactKeyDecision>;
} {
  const agentRationale =
    typeof raw.agentRationale === 'string' && raw.agentRationale.trim().length > 0
      ? raw.agentRationale.trim()
      : undefined;
  const keyDecisions = Array.isArray(raw.keyDecisions)
    ? raw.keyDecisions
        .filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object'),
        )
        .map((item) => ({
          decision: String(item.decision ?? '').trim(),
          rationale: String(item.rationale ?? '').trim(),
          tradeoffs: asStringArray(item.tradeoffs),
        }))
        .filter((item) => item.decision.length > 0 || item.rationale.length > 0)
    : undefined;
  return {
    agentRationale,
    keyDecisions: keyDecisions && keyDecisions.length > 0 ? keyDecisions : undefined,
  };
}

export class ArtifactContractFactory {
  /**
   * 按阶段把 LLM/持久化的原始 JSON 映射为强类型契约。
   * 缺失的必填数组按空数组处理（由契约校验产生违规 → 触发自愈重试）。
   */
  public static parse(stageId: WorkflowStageId, raw: Record<string, unknown>): ArtifactParseResult {
    const coreIds = asStringArray(raw.coreRequirementIds);
    const summary = String(raw.summary ?? '');
    const producer = AgentRole.SUPERVISOR; // 以 stageId 为准，producerRole 由各契约类常量决定
    const rationaleMeta = parseRationaleMeta(raw);

    try {
      switch (stageId) {
        case WorkflowStageId.STAGE_1_PM: {
          const artifact = new PrdArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            userStories: (
              (raw.userStories as Array<Record<string, unknown>> | undefined) ?? []
            ).map((s) => ({
              reqId: String(s.reqId ?? ''),
              story: String(s.story ?? ''),
              acceptanceCriteria: asStringArray(s.acceptanceCriteria),
            })),
            trackingPlanEvents: (
              (raw.trackingPlanEvents as Array<Record<string, unknown>> | undefined) ?? []
            ).map((ev) => ({
              eventName: String(ev.eventName ?? ''),
              triggerCondition: String(ev.triggerCondition ?? ''),
              properties: asStringArray(ev.properties),
            })),
            nonFunctionalConstraints: asStringArray(raw.nonFunctionalConstraints),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        case WorkflowStageId.STAGE_2_PD: {
          const artifact = new UiDesignArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            componentMappings: (
              (raw.componentMappings as Array<Record<string, unknown>> | undefined) ?? []
            ).map((m) => ({
              reqId: String(m.reqId ?? ''),
              designSystemComponent: String(m.designSystemComponent ?? ''),
              interactionStates: asStringArray(m.interactionStates),
            })),
            accessibilityChecklist: asStringArray(raw.accessibilityChecklist),
            designChallengeNote:
              raw.designChallengeNote === null || raw.designChallengeNote === undefined
                ? null
                : String(raw.designChallengeNote),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        case WorkflowStageId.STAGE_3A_TECH_SPEC: {
          const artifact = new TechSpecArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            apiContracts: (
              (raw.apiContracts as Array<Record<string, unknown>> | undefined) ?? []
            ).map((api) => ({
              method: String(api.method ?? 'GET').toUpperCase(),
              endpoint: String(api.endpoint ?? ''),
              requestSchema: String(api.requestSchema ?? '{}'),
              responseSchema: String(api.responseSchema ?? '{}'),
            })),
            databaseDdlStatements: asStringArray(raw.databaseDdlStatements),
            declaredRiskLevel: riskLevel(raw.declaredRiskLevel),
            architecturePatternsUsed: asStringArray(raw.architecturePatternsUsed),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        case WorkflowStageId.STAGE_3B_ENGINEER: {
          const artifact = new CodeImplementationArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            gitWorktreeBranch: String(raw.gitWorktreeBranch ?? ''),
            modifiedFiles: (
              (raw.modifiedFiles as Array<Record<string, unknown>> | undefined) ?? []
            ).map((f) => ({
              filePath: String(f.filePath ?? ''),
              className: String(f.className ?? ''),
              designPattern: String(f.designPattern ?? ''),
              linesChanged: asNumber(f.linesChanged, 0),
            })),
            selfTestPassed: asBoolean(raw.selfTestPassed),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        case WorkflowStageId.STAGE_4_QA: {
          const artifact = new QaVerificationArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            testSuitesExecuted: (
              (raw.testSuitesExecuted as Array<Record<string, unknown>> | undefined) ?? []
            ).map((s) => ({
              suiteName: String(s.suiteName ?? ''),
              totalCases: asNumber(s.totalCases, 0),
              passedCases: asNumber(s.passedCases, 0),
              coveragePercent: asNumber(s.coveragePercent, 0),
            })),
            securityIssuesFound: asNumber(raw.securityIssuesFound, 0),
            allAcceptanceCriteriaMet: asBoolean(raw.allAcceptanceCriteriaMet),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        case WorkflowStageId.STAGE_5_DA: {
          const artifact = new DataAnalysisArtifactContract({
            summary,
            coreRequirementIds: coreIds,
            verifiedTrackingEvents: asStringArray(raw.verifiedTrackingEvents),
            projectedMetrics: (
              (raw.projectedMetrics as Array<Record<string, unknown>> | undefined) ?? []
            ).map((m) => ({
              metricName: String(m.metricName ?? ''),
              baselineValue: String(m.baselineValue ?? ''),
              targetValue: String(m.targetValue ?? ''),
            })),
            ...rationaleMeta,
          });
          return { ok: true, artifact, violations: [] };
        }
        default:
          return { ok: false, violations: [`未知阶段 ${String(stageId)}，无法反序列化产物`] };
      }
    } catch (err) {
      void producer;
      return {
        ok: false,
        violations: [
          `产物反序列化异常: ${err instanceof Error ? err.message.slice(0, 160) : '未知错误'}`,
        ],
      };
    }
  }
}
