/**
 * @file SseBridge.ts
 * @description C1 SSE 逐事件桥：实现 IWorkflowEventObserver，把 Agent 生命周期事件
 * 实时推送给所有已连接 SSE 客户端（不等全量帧）。支持 Last-Event-ID 重放（D3）。
 */

import type { IWorkflowEventObserver, WorkflowDomainEvent } from '../patterns/EventBus.ts';
import type { AgentUserNotification } from '../domain/models.ts';

export type SseFrameWriter = (
  frame: string,
  eventName: string,
  seqId: string,
  runId?: string,
) => void;

export class SseBridge implements IWorkflowEventObserver {
  private seq = 0;
  private readonly eventBuffer: Array<{
    id: string;
    eventName: string;
    data: string;
    runId?: string;
  }> = [];
  private readonly bufferLimit = 200;
  private readonly broadcast: SseFrameWriter;

  public constructor(broadcast: SseFrameWriter) {
    this.broadcast = broadcast;
  }

  public getLatestEventId(): number {
    return this.seq;
  }

  public onWorkflowEvent(event: WorkflowDomainEvent): void {
    const data = JSON.stringify({ type: 'run_event', event: { ...event } });
    this.push(data, 'run_event', event.runId);
  }

  public onUserNotification(notification: AgentUserNotification): void {
    const data = JSON.stringify({ type: 'user_notification', notification: { ...notification } });
    this.push(data, 'user_notification', notification.runId);
  }

  /** D3 / AUDIT-13：重放 >clientLastId 的缓冲事件，支持按订阅 runId 过滤 */
  public replay(
    clientLastId: number,
    write: (frame: string, eventName: string, id: string) => void,
    filterRunId?: string,
  ): number {
    let replayedCount = 0;
    for (const item of this.eventBuffer) {
      const seqNum = Number(item.id);
      const matchesRun = !filterRunId || !item.runId || item.runId === filterRunId;
      if (seqNum > clientLastId && matchesRun) {
        write(item.data, item.eventName, item.id);
        replayedCount += 1;
      }
    }
    return replayedCount;
  }

  private push(data: string, eventName: string, runId?: string): void {
    this.seq += 1;
    const id = String(this.seq);
    this.eventBuffer.push({ id, eventName, data, runId });
    if (this.eventBuffer.length > this.bufferLimit) {
      this.eventBuffer.shift();
    }
    this.broadcast(data, eventName, id, runId);
  }
}
