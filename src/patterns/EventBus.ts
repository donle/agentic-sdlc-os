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
  }) {
    this.eventId = params.eventId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.agentRole = params.agentRole;
    this.lifecycleState = params.lifecycleState;
    this.headline = params.headline;
    this.detailPayload = params.detailPayload ? { ...params.detailPayload } : {};
    this.timestampIso = new Date().toISOString();
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
}
