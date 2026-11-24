/**
 * @file artifactParsers.ts
 * @description G5: 六类阶段交付物契约的运行时安全解析器与缺字段兜底模型。
 */

import type { ArtifactKeyDecisionDto } from '../types.ts';

export interface ParsedPrdStory {
  readonly reqId: string;
  readonly story: string;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}

export interface ParsedTrackingEvent {
  readonly eventName: string;
  readonly triggerCondition: string;
  readonly properties: ReadonlyArray<string>;
}

export interface ParsedComponentMapping {
  readonly reqId: string;
  readonly designSystemComponent: string;
  readonly interactionStates: ReadonlyArray<string>;
}

export interface ParsedApiContract {
  readonly method: string;
  readonly endpoint: string;
  readonly requestSchema: string;
  readonly responseSchema: string;
}

export interface ParsedModifiedFile {
  readonly filePath: string;
  readonly className: string;
  readonly designPattern: string;
  readonly linesChanged: number;
}

export interface ParsedTestSuite {
  readonly suiteName: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly coveragePercent: number;
}

export interface ParsedProjectedMetric {
  readonly metricName: string;
  readonly baselineValue: string;
  readonly targetValue: string;
}

export interface ParsedArtifactBase {
  readonly summary: string;
  readonly coreRequirementIds: ReadonlyArray<string>;
  readonly agentRationale: string | null;
  readonly keyDecisions: ReadonlyArray<ArtifactKeyDecisionDto>;
  readonly missingFields: ReadonlyArray<string>;
}

export type ParsedStageArtifact =
  | (ParsedArtifactBase & {
      readonly kind: 'PRD';
      readonly userStories: ReadonlyArray<ParsedPrdStory>;
      readonly trackingPlanEvents: ReadonlyArray<ParsedTrackingEvent>;
      readonly nonFunctionalConstraints: ReadonlyArray<string>;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'UI_DESIGN';
      readonly componentMappings: ReadonlyArray<ParsedComponentMapping>;
      readonly accessibilityChecklist: ReadonlyArray<string>;
      readonly designChallengeNote: string | null;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'TECH_SPEC';
      readonly apiContracts: ReadonlyArray<ParsedApiContract>;
      readonly databaseDdlStatements: ReadonlyArray<string>;
      readonly declaredRiskLevel: string;
      readonly architecturePatternsUsed: ReadonlyArray<string>;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'CODE_IMPL';
      readonly gitWorktreeBranch: string;
      readonly modifiedFiles: ReadonlyArray<ParsedModifiedFile>;
      readonly selfTestPassed: boolean | null;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'QA';
      readonly testSuitesExecuted: ReadonlyArray<ParsedTestSuite>;
      readonly securityIssuesFound: number | null;
      readonly allAcceptanceCriteriaMet: boolean | null;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'DATA_ANALYSIS';
      readonly verifiedTrackingEvents: ReadonlyArray<string>;
      readonly projectedMetrics: ReadonlyArray<ParsedProjectedMetric>;
    })
  | (ParsedArtifactBase & {
      readonly kind: 'GENERIC';
      readonly rawDetails: Readonly<Record<string, unknown>>;
    });

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object'),
  );
}

function parseKeyDecisions(value: unknown): ArtifactKeyDecisionDto[] {
  return asObjectArray(value)
    .map((item) => ({
      decision: String(item.decision ?? '').trim(),
      rationale: String(item.rationale ?? '').trim(),
      tradeoffs: toStringArray(item.tradeoffs),
    }))
    .filter((item) => item.decision.length > 0 || item.rationale.length > 0);
}

export function parseStageArtifact(
  artifactType: string,
  details: Record<string, unknown> | undefined | null,
): ParsedStageArtifact {
  const safe = details && typeof details === 'object' ? details : {};
  const missingFields: string[] = [];

  const summary = typeof safe.summary === 'string' ? safe.summary : '';
  const coreRequirementIds = toStringArray(safe.coreRequirementIds);
  const rawChallengeNote =
    typeof safe.designChallengeNote === 'string' && safe.designChallengeNote.trim()
      ? safe.designChallengeNote.trim()
      : null;
  const agentRationale =
    typeof safe.agentRationale === 'string' && safe.agentRationale.trim()
      ? safe.agentRationale.trim()
      : rawChallengeNote;
  const keyDecisions = parseKeyDecisions(safe.keyDecisions);

  const base: ParsedArtifactBase = {
    summary,
    coreRequirementIds,
    agentRationale,
    keyDecisions,
    missingFields,
  };

  switch (artifactType) {
    case 'PRD_ARTIFACT_CONTRACT': {
      if (!Array.isArray(safe.userStories)) {
        missingFields.push('userStories');
      }
      if (!Array.isArray(safe.trackingPlanEvents)) {
        missingFields.push('trackingPlanEvents');
      }
      return {
        ...base,
        kind: 'PRD',
        userStories: asObjectArray(safe.userStories).map((s) => ({
          reqId: String(s.reqId ?? 'REQ'),
          story: String(s.story ?? ''),
          acceptanceCriteria: toStringArray(s.acceptanceCriteria),
        })),
        trackingPlanEvents: asObjectArray(safe.trackingPlanEvents).map((ev) => ({
          eventName: String(ev.eventName ?? 'evt_unknown'),
          triggerCondition: String(ev.triggerCondition ?? ''),
          properties: toStringArray(ev.properties),
        })),
        nonFunctionalConstraints: toStringArray(safe.nonFunctionalConstraints),
      };
    }

    case 'UI_DESIGN_ARTIFACT_CONTRACT': {
      if (!Array.isArray(safe.componentMappings)) {
        missingFields.push('componentMappings');
      }
      return {
        ...base,
        kind: 'UI_DESIGN',
        componentMappings: asObjectArray(safe.componentMappings).map((m) => ({
          reqId: String(m.reqId ?? 'REQ'),
          designSystemComponent: String(m.designSystemComponent ?? ''),
          interactionStates: toStringArray(m.interactionStates),
        })),
        accessibilityChecklist: toStringArray(safe.accessibilityChecklist),
        designChallengeNote: rawChallengeNote,
      };
    }

    case 'TECH_SPEC_ARTIFACT_CONTRACT': {
      if (!Array.isArray(safe.apiContracts)) {
        missingFields.push('apiContracts');
      }
      return {
        ...base,
        kind: 'TECH_SPEC',
        apiContracts: asObjectArray(safe.apiContracts).map((api) => ({
          method: String(api.method ?? 'GET').toUpperCase(),
          endpoint: String(api.endpoint ?? ''),
          requestSchema: String(api.requestSchema ?? '{}'),
          responseSchema: String(api.responseSchema ?? '{}'),
        })),
        databaseDdlStatements: toStringArray(safe.databaseDdlStatements),
        declaredRiskLevel:
          typeof safe.declaredRiskLevel === 'string' ? safe.declaredRiskLevel : 'UNKNOWN',
        architecturePatternsUsed: toStringArray(safe.architecturePatternsUsed),
      };
    }

    case 'CODE_IMPLEMENTATION_ARTIFACT_CONTRACT': {
      if (typeof safe.gitWorktreeBranch !== 'string' || !safe.gitWorktreeBranch.trim()) {
        missingFields.push('gitWorktreeBranch');
      }
      if (!Array.isArray(safe.modifiedFiles)) {
        missingFields.push('modifiedFiles');
      }
      return {
        ...base,
        kind: 'CODE_IMPL',
        gitWorktreeBranch: typeof safe.gitWorktreeBranch === 'string' ? safe.gitWorktreeBranch : '',
        modifiedFiles: asObjectArray(safe.modifiedFiles).map((f) => ({
          filePath: String(f.filePath ?? ''),
          className: String(f.className ?? ''),
          designPattern: String(f.designPattern ?? ''),
          linesChanged: typeof f.linesChanged === 'number' ? f.linesChanged : 0,
        })),
        selfTestPassed: typeof safe.selfTestPassed === 'boolean' ? safe.selfTestPassed : null,
      };
    }

    case 'QA_VERIFICATION_ARTIFACT_CONTRACT': {
      if (!Array.isArray(safe.testSuitesExecuted)) {
        missingFields.push('testSuitesExecuted');
      }
      return {
        ...base,
        kind: 'QA',
        testSuitesExecuted: asObjectArray(safe.testSuitesExecuted).map((s) => ({
          suiteName: String(s.suiteName ?? 'suite'),
          totalCases: typeof s.totalCases === 'number' ? s.totalCases : 0,
          passedCases: typeof s.passedCases === 'number' ? s.passedCases : 0,
          coveragePercent: typeof s.coveragePercent === 'number' ? s.coveragePercent : 0,
        })),
        securityIssuesFound:
          typeof safe.securityIssuesFound === 'number' ? safe.securityIssuesFound : null,
        allAcceptanceCriteriaMet:
          typeof safe.allAcceptanceCriteriaMet === 'boolean' ? safe.allAcceptanceCriteriaMet : null,
      };
    }

    case 'DATA_ANALYSIS_ARTIFACT_CONTRACT': {
      if (!Array.isArray(safe.verifiedTrackingEvents)) {
        missingFields.push('verifiedTrackingEvents');
      }
      if (!Array.isArray(safe.projectedMetrics)) {
        missingFields.push('projectedMetrics');
      }
      return {
        ...base,
        kind: 'DATA_ANALYSIS',
        verifiedTrackingEvents: toStringArray(safe.verifiedTrackingEvents),
        projectedMetrics: asObjectArray(safe.projectedMetrics).map((m) => ({
          metricName: String(m.metricName ?? ''),
          baselineValue: String(m.baselineValue ?? ''),
          targetValue: String(m.targetValue ?? ''),
        })),
      };
    }

    default:
      return {
        ...base,
        kind: 'GENERIC',
        rawDetails: safe,
      };
  }
}
