/**
 * @file EventBus.ts
 * @description 观察者模式 (Observer Pattern) 实现的事件总线。
 * 用于解耦：
 * 1. 状态机与 Agent 的实时交互状态流转广播；
 * 2. Agent 向前端推送的待核验/待裁决提醒 (AgentUserNotification)；
 * 3. 只读审计账本 (ImmutableAuditLedger) 的自动落盘。
 */

import { AgentRole, SnapshotLifecycleState, WorkflowStageId } from '../domain/enums.ts';
import { AgentUserNotification } from '../domain/models.ts';

/**
 * 强类型工作流事件对象
 */
export class WorkflowDomainEvent {
  public static fromJSON(raw: Record<string, unknown>): WorkflowDomainEvent {
    return new WorkflowDomainEvent({
      eventId: String(raw.eventId ?? ''),
      runId: String(raw.runId ?? ''),
      branchId: String(raw.branchId ?? ''),
      stageId: String(raw.stageId ?? 'STAGE_1_PM') as never,
      agentRole: String(raw.agentRole ?? 'PM_AGENT') as never,
      lifecycleState: String(raw.lifecycleState ?? 'IDLE') as never,
      headline: String(raw.headline ?? ''),
      detailPayload: (raw.detailPayload as Record<string, unknown> | undefined) ?? {},
      timestampIso: raw.timestampIso ? String(raw.timestampIso) : undefined,
    });
  }

  public readonly eventId: string;
  public readonly runId: string;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly agentRole: AgentRole;
  public readonly lifecycleState: SnapshotLifecycleState;
  public readonly headline: string;
  public readonly detailPayload: Readonly<Record<string, unknown>>;
  public readonly timestampIso: string;

  public constructor(params: {
    eventId: string;
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    lifecycleState: SnapshotLifecycleState;
    headline: string;
    detailPayload?: Record<string, unknown>;
    timestampIso?: string;
  }) {
    this.eventId = params.eventId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.agentRole = params.agentRole;
    this.lifecycleState = params.lifecycleState;
    this.headline = params.headline;
    this.detailPayload = params.detailPayload ? { ...params.detailPayload } : {};
    this.timestampIso = params.timestampIso ?? new Date().toISOString();
  }
}

/**
 * 工作流事件观察者接口 (Observer Interface)
 */
export interface IWorkflowEventObserver {
  onWorkflowEvent(event: WorkflowDomainEvent): void;
  onUserNotification(notification: AgentUserNotification): void;
}

/**
 * 工作流事件总线主题类 (Subject in Observer Pattern)
 */
export class WorkflowEventBus {
  private readonly observers: Set<IWorkflowEventObserver>;
  private readonly eventHistory: WorkflowDomainEvent[];
  private readonly notificationInbox: AgentUserNotification[];

  public constructor() {
    this.observers = new Set<IWorkflowEventObserver>();
    this.eventHistory = [];
    this.notificationInbox = [];
  }

  public registerObserver(observer: IWorkflowEventObserver): void {
    this.observers.add(observer);
  }

  public unregisterObserver(observer: IWorkflowEventObserver): void {
    this.observers.delete(observer);
  }

  public publishEvent(event: WorkflowDomainEvent): void {
    this.eventHistory.push(event);
    for (const observer of this.observers) {
      observer.onWorkflowEvent(event);
    }
  }

  /** D1：恢复历史事件（不广播观察者，审计已随快照恢复） */
  public restoreEvent(event: WorkflowDomainEvent): void {
    this.eventHistory.push(event);
  }

  /** D1：恢复历史通知收件箱（保留原有最新在前顺序，不触发观察者写 WAL） */
  public restoreNotification(notification: AgentUserNotification): void {
    const exists = this.notificationInbox.some(
      (item) => item.notificationId === notification.notificationId,
    );
    if (!exists) {
      this.notificationInbox.push(notification);
    }
  }

  public publishNotification(notification: AgentUserNotification): void {
    this.notificationInbox.unshift(notification);
    for (const observer of this.observers) {
      observer.onUserNotification(notification);
    }
  }

  public getEventHistory(runId?: string): ReadonlyArray<WorkflowDomainEvent> {
    if (!runId) {
      return [...this.eventHistory];
    }
    return this.eventHistory.filter((item) => item.runId === runId);
  }

  /** G3：按 runId、stageId 与时间范围倒序分页查询交互事件链 */
  public getEventHistoryPage(params: {
    runId: string;
    stageId?: string;
    sinceIso?: string;
    untilIso?: string;
    offset?: number;
    limit?: number;
  }): {
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
    readonly events: ReadonlyArray<WorkflowDomainEvent>;
  } {
    const sinceMs = params.sinceIso ? Date.parse(params.sinceIso) : Number.NaN;
    const untilMs = params.untilIso ? Date.parse(params.untilIso) : Number.NaN;
    const filtered = this.eventHistory
      .filter((item) => {
        if (item.runId !== params.runId) {
          return false;
        }
        if (params.stageId && item.stageId !== params.stageId) {
          return false;
        }
        if (Number.isFinite(sinceMs) || Number.isFinite(untilMs)) {
          const ts = Date.parse(item.timestampIso);
          if (Number.isFinite(sinceMs) && ts < sinceMs) {
            return false;
          }
          if (Number.isFinite(untilMs) && ts > untilMs) {
            return false;
          }
        }
        return true;
      })
      .reverse();

    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const rawLimit = Math.floor(params.limit ?? 40);
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 40));

    return {
      total: filtered.length,
      offset,
      limit,
      events: filtered.slice(offset, offset + limit),
    };
  }

  public getNotificationInbox(runId?: string): ReadonlyArray<AgentUserNotification> {
    if (!runId) {
      return [...this.notificationInbox];
    }
    return this.notificationInbox.filter((item) => item.runId === runId);
  }

  public resolveNotificationBySnapshotId(snapshotId: string): void {
    for (const item of this.notificationInbox) {
      if (item.relatedSnapshotId === snapshotId) {
        item.markResolved();
      }
    }
  }

  /** AUDIT-10：按 runId + stageId 消解熔断/预算超限通知 */
  public resolveFailureNotificationsForStage(runId: string, stageId: WorkflowStageId): void {
    for (const item of this.notificationInbox) {
      if (
        item.runId === runId &&
        item.stageId === stageId &&
        (item.category === 'STAGE_CONTRACT_FAILED' || item.category === 'TOKEN_BUDGET_EXCEEDED')
      ) {
        item.markResolved();
      }
    }
  }
}
