/**
 * @file StateReconstructor.ts
 * @description D1 启动恢复：把持久化快照（ledger-store.json）重建为内存状态机
 * （WorkflowRunState / 快照 / 协商 / 决策 / RAG / 事件历史）。
 * 边界：schemaVersion 不匹配、字段缺失、JSONL 不重放（防 RAG 双计）。
 */

import { ArtifactContractFactory } from '../../agents/deserialize/ArtifactContractFactory.ts';
import { ProjectProposalContract } from '../../domain/contracts.ts';
import { AgentRole, SnapshotLifecycleState, WorkflowStageId } from '../../domain/enums.ts';
import {
  AgentUserNotification,
  HumanDecisionRecord,
  NegotiationTurnRecord,
  ScopeDiffReport,
  StageSnapshotMemento,
  StageTeamCommentRecord,
} from '../../domain/models.ts';
import type { ScenarioHints } from '../../domain/scenario.ts';
import { WorkflowDomainEvent } from '../../patterns/EventBus.ts';
import type { BoundedNegotiationMediator } from '../../agents/BoundedNegotiationMediator.ts';
import type { DagWorkflowStateEngine } from '../DagWorkflowStateEngine.ts';
import { AuditTrailEntry, type ImmutableAuditLedger } from '../ImmutableAuditLedger.ts';
import type { PersistedLedgerSnapshot, PersistedRunRecord } from '../PersistenceRepository.ts';
import type { WorkflowEventBus } from '../../patterns/EventBus.ts';

export interface RestoreTargets {
  stateEngine: DagWorkflowStateEngine;
  auditLedger: ImmutableAuditLedger;
  mediator: BoundedNegotiationMediator;
  eventBus: WorkflowEventBus;
  restoreTeamComment?: (comment: StageTeamCommentRecord) => void;
}

export class StateReconstructor {
  private readonly targets: RestoreTargets;

  public constructor(targets: RestoreTargets) {
    this.targets = targets;
  }

  /** 全量重建；返回恢复的 runId 列表。损坏数据跳过并收集警告，不中断。 */
  public restore(
    snapshot: PersistedLedgerSnapshot & {
      readonly liveEvents?: ReadonlyArray<Record<string, unknown>>;
    },
    walAuditEntries?: ReadonlyArray<Record<string, unknown>>,
  ): { runIds: string[]; warnings: string[] } {
    const runIds: string[] = [];
    const warnings: string[] = [];

    for (const turn of snapshot.negotiationLogs ?? []) {
      this.targets.mediator.restoreTurn(
        NegotiationTurnRecord.fromJSON(turn as unknown as Record<string, unknown>),
      );
    }
    for (const rec of snapshot.negativeExperienceRecords ?? []) {
      this.targets.auditLedger.ragEngine.restoreRecord(rec);
    }
    for (const decision of snapshot.humanDecisions ?? []) {
      this.targets.auditLedger.restoreDecision(
        HumanDecisionRecord.fromJSON(decision as unknown as Record<string, unknown>),
      );
    }
    for (const event of snapshot.liveEvents ?? []) {
      this.targets.eventBus.restoreEvent(
        WorkflowDomainEvent.fromJSON(event as Record<string, unknown>),
      );
    }
    for (const rawNotif of snapshot.notifications ?? []) {
      try {
        this.targets.eventBus.restoreNotification(AgentUserNotification.fromJSON(rawNotif));
      } catch (err) {
        warnings.push(`通知恢复跳过: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.targets.restoreTeamComment) {
      for (const rawComment of snapshot.teamComments ?? []) {
        try {
          this.targets.restoreTeamComment(StageTeamCommentRecord.fromJSON(rawComment));
        } catch (err) {
          warnings.push(`团队评论恢复跳过: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const auditSource =
      walAuditEntries && walAuditEntries.length > 0
        ? walAuditEntries
        : (snapshot.auditEntries ?? []);
    for (const rawEntry of auditSource) {
      try {
        this.targets.auditLedger.restoreAuditEntry(AuditTrailEntry.fromJSON(rawEntry));
      } catch (err) {
        warnings.push(`审计条目恢复跳过: ${err instanceof Error ? err.message : err}`);
      }
    }

    for (const runRec of snapshot.runs ?? []) {
      try {
        runIds.push(this.restoreRun(runRec, snapshot, warnings));
      } catch (err) {
        warnings.push(`运行 ${runRec.runId} 恢复失败: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { runIds, warnings };
  }

  private restoreRun(
    runRec: PersistedRunRecord,
    snapshot: PersistedLedgerSnapshot,
    warnings: string[],
  ): string {
    const proposal = ProjectProposalContract.fromSerializableRecord(runRec.proposal);
    const runState = this.targets.stateEngine.createRun({
      runId: runRec.runId,
      proposal,
      initiatorActor: runRec.initiatorActor,
      stagePipeline: runRec.stagePipeline as WorkflowStageId[],
      workflowTemplateId: runRec.workflowTemplateId,
      scenarioHints: (runRec.scenarioHints ?? {}) as ScenarioHints,
      tokenBudget: runRec.tokenBudget,
    });

    runState.restoreInternals({
      activeBranchId: runRec.activeBranchId,
      currentStageIndex: runRec.currentStageIndex,
      branchCounter: runRec.branchCounter,
      branchHistory: [...runRec.branchHistory],
      tokensUsedTotal: runRec.tokensUsedTotal,
      status: runRec.status,
      autoRepairCounts: runRec.autoRepairCounts ? { ...runRec.autoRepairCounts } : undefined,
    });

    for (const raw of snapshot.snapshots ?? []) {
      if (raw.runId !== runRec.runId) {
        continue;
      }
      const stageId = String(raw.stageId ?? '') as WorkflowStageId;
      const parsed = ArtifactContractFactory.parse(
        stageId,
        (raw.artifactDetails ?? {}) as Record<string, unknown>,
      );
      if (!parsed.ok || !parsed.artifact) {
        warnings.push(`快照 ${String(raw.snapshotId)} 产物反序列化失败`);
        continue;
      }
      const memento = new StageSnapshotMemento({
        snapshotId: String(raw.snapshotId),
        runId: runRec.runId,
        parentSnapshotId: (raw.parentSnapshotId as string | null) ?? null,
        branchId: String(raw.branchId),
        stageId,
        agentRole: String(raw.agentRole ?? 'PM_AGENT') as AgentRole,
        modelUsed: String(raw.modelUsed ?? ''),
        artifact: parsed.artifact,
        riskScore: Number(raw.riskScore ?? 0),
        riskLevel: (raw.riskLevel as never) ?? 'LOW',
        riskReasons: (raw.riskReasons as string[] | undefined) ?? [],
        gateAction: (raw.gateAction as never) ?? 'AUTO_PASS_WITH_AUDIT',
        scopeDiffReport: ScopeDiffReport.fromJSON(raw.scopeDiff as Record<string, unknown>),
        cacheHit: Boolean(raw.cacheHit),
        retryCount: Number(raw.retryCount ?? 0),
        tokensConsumed: Number(raw.tokensConsumed ?? 0),
        initialState: String(raw.state ?? 'APPROVED') as SnapshotLifecycleState,
        createdAtIso: String(raw.createdAtIso ?? new Date().toISOString()),
      });
      runState.appendSnapshot(memento);
    }

    return runRec.runId;
  }
}
