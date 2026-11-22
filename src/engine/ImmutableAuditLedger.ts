/**
 * @file ImmutableAuditLedger.ts
 * @description 全链路只读追加审计账本与“负向经验飞轮 (Rejected History RAG)”服务。
 *
 * 设计职责：
 * 1. 实现 `IWorkflowEventObserver` 接口，自动监听并持久化每一次人工和 Agent 的操作事件（写入 Append-Only JSONL WAL）；
 * 2. 保存所有被认可（Approved / Auto-Passed）、被驳回（Rejected）和被回退废弃（Superseded）的快照记录，
 *    明确记录“谁在什么时候批准/驳回了哪一版方案”，支撑事后反向追查与责任复盘；
 * 3. 【企业级避坑知识飞轮】：将所有被人类驳回或回退的理由通过 `NegativeExperienceRagEngine` 自动脱敏并向量化沉淀，
 *    当下次同职能 Agent 再次执行时，基于余弦相似度自动检索 Top-K `historicalRejectionLessons` 注入。
 */

import { DecisionVerdict, WorkflowStageId } from '../domain/enums.ts';
import { AgentUserNotification, HumanDecisionRecord } from '../domain/models.ts';
import { type IWorkflowEventObserver, WorkflowDomainEvent } from '../patterns/EventBus.ts';
import { NegativeExperienceRagEngine } from './NegativeExperienceRagEngine.ts';
import type { PersistenceRepository } from './PersistenceRepository.ts';
import type { EmbeddingProvider } from '../telemetry/EmbeddingProvider.ts';

export class AuditTrailEntry {
  public readonly entryId: string;
  public readonly runId: string;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly actor: string;
  public readonly actionType: string;
  public readonly summary: string;
  public readonly metadata: Readonly<Record<string, unknown>>;
  public readonly timestampIso: string;

  public constructor(params: {
    entryId: string;
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    actor: string;
    actionType: string;
    summary: string;
    metadata?: Record<string, unknown>;
    /** I3：条目时间（缺省取当前时间）——WAL 按月归档的归属依据 */
    timestampIso?: string;
  }) {
    this.entryId = params.entryId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.actor = params.actor;
    this.actionType = params.actionType;
    this.summary = params.summary;
    this.metadata = params.metadata ? { ...params.metadata } : {};
    this.timestampIso = params.timestampIso ?? new Date().toISOString();
  }
}

export class ImmutableAuditLedger implements IWorkflowEventObserver {
  private readonly auditEntries: AuditTrailEntry[];
  private readonly humanDecisions: HumanDecisionRecord[];
  private readonly rejectedLessonsByStage: Map<WorkflowStageId, string[]>;
  public readonly ragEngine: NegativeExperienceRagEngine;
  private readonly persistenceRepo: PersistenceRepository | null;

  public constructor(
    persistenceRepo?: PersistenceRepository | null,
    embeddingProvider?: EmbeddingProvider | null,
  ) {
    this.auditEntries = [];
    this.humanDecisions = [];
    this.rejectedLessonsByStage = new Map<WorkflowStageId, string[]>();
    this.ragEngine = new NegativeExperienceRagEngine([], embeddingProvider ?? null);
    this.persistenceRepo = persistenceRepo ?? null;
  }

  private recordAuditEntry(entry: AuditTrailEntry): void {
    this.auditEntries.push(entry);
    if (this.persistenceRepo) {
      this.persistenceRepo.appendAuditEntryToWal(entry);
    }
  }

  public onWorkflowEvent(event: WorkflowDomainEvent): void {
    this.recordAuditEntry(
      new AuditTrailEntry({
        entryId: `AUDIT-EVT-${this.auditEntries.length + 1}`,
        runId: event.runId,
        branchId: event.branchId,
        stageId: event.stageId,
        actor: event.agentRole,
        actionType: `AGENT_${event.lifecycleState}`,
        summary: event.headline,
        metadata: { ...event.detailPayload },
      }),
    );
  }

  public onUserNotification(notification: AgentUserNotification): void {
    this.recordAuditEntry(
      new AuditTrailEntry({
        entryId: `AUDIT-NOTIF-${this.auditEntries.length + 1}`,
        runId: notification.runId,
        branchId: notification.branchId,
        stageId: notification.stageId,
        actor: notification.senderRole,
        actionType: `NOTIFICATION_${notification.category}`,
        summary: notification.title,
        metadata: {
          notificationId: notification.notificationId,
          requiresHumanAction: notification.requiresHumanAction,
          relatedSnapshotId: notification.relatedSnapshotId,
        },
      }),
    );
  }

  /**
   * 记录人工或策略门禁的裁决结果（批准、驳回、冲突二选一、自动放行、总管回退）
   */
  public recordDecision(decision: HumanDecisionRecord): void {
    this.humanDecisions.push(decision);
    this.recordAuditEntry(
      new AuditTrailEntry({
        entryId: `AUDIT-DEC-${this.auditEntries.length + 1}`,
        runId: decision.runId,
        branchId: decision.branchId,
        stageId: decision.stageId,
        actor: decision.reviewerActor,
        actionType: `VERDICT_${decision.verdict}`,
        summary: `[责任签核: ${decision.reviewerActor}] 对快照 [${decision.snapshotId}] 做出裁决 [${decision.verdict}]：${decision.comment}`,
        metadata: {
          decisionId: decision.decisionId,
          snapshotId: decision.snapshotId,
          verdict: decision.verdict,
        },
      }),
    );

    if (
      decision.verdict === DecisionVerdict.REJECT ||
      decision.verdict === DecisionVerdict.SUPERVISOR_ROLLBACK
    ) {
      this.registerRejectionLesson(
        decision.stageId,
        `[${decision.reviewerActor} 驳回/回退记录] ${decision.comment}`,
      );
    }
  }

  /** D1：恢复决策账本（不触发 RAG 沉淀——负向经验已随快照恢复） */
  public restoreDecision(decision: HumanDecisionRecord): void {
    this.humanDecisions.push(decision);
  }

  public registerRejectionLesson(stageId: WorkflowStageId, lesson: string): void {
    const ragRecord = this.ragEngine.ingestRejectionLesson(stageId, lesson);
    const existing = this.rejectedLessonsByStage.get(stageId) ?? [];
    existing.push(ragRecord.desensitizedLesson);
    this.rejectedLessonsByStage.set(stageId, existing);
  }

  public async getRejectionLessonsForStage(
    stageId: WorkflowStageId,
    queryText?: string,
    topK = 5,
  ): Promise<ReadonlyArray<string>> {
    if (queryText && queryText.trim().length > 0) {
      const retrieved = await this.ragEngine.retrieveTopKSimilarLessons({
        stageId,
        queryText,
        topK,
      });
      return retrieved.map((r) => r.desensitizedLesson);
    }
    return [...(this.rejectedLessonsByStage.get(stageId) ?? [])];
  }

  public getHumanDecisions(runId?: string): ReadonlyArray<HumanDecisionRecord> {
    if (!runId) {
      return [...this.humanDecisions];
    }
    return this.humanDecisions.filter((d) => d.runId === runId);
  }

  public getAuditTimeline(runId?: string): ReadonlyArray<AuditTrailEntry> {
    if (!runId) {
      return [...this.auditEntries];
    }
    return this.auditEntries.filter((e) => e.runId === runId);
  }
}
