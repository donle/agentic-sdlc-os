/**
 * @file SseBridge.ts
 * @description C1 SSE 逐事件桥：实现 IWorkflowEventObserver，把 Agent 生命周期事件
 * 实时推送给所有已连接 SSE 客户端（不等全量帧）。支持 Last-Event-ID 重放（D3）。
 */

import type { IWorkflowEventObserver, WorkflowDomainEvent } from '../patterns/EventBus.ts';
import type { AgentUserNotification } from '../domain/models.ts';

export type SseFrameWriter = (frame: string, eventName: string, seqId: string) => void;

export class SseBridge implements IWorkflowEventObserver {
  private seq = 0;
  private readonly eventBuffer: Array<{ id: string; eventName: string; data: string }> = [];
  private readonly bufferLimit = 200;
  private readonly broadcast: SseFrameWriter;

  public constructor(broadcast: SseFrameWriter) {
    this.broadcast = broadcast;
  }

  public onWorkflowEvent(event: WorkflowDomainEvent): void {
    const data = JSON.stringify({ type: 'run_event', event: { ...event } });
    this.push(data, 'run_event');
  }

  public onUserNotification(notification: AgentUserNotification): void {
    const data = JSON.stringify({ type: 'user_notification', notification: { ...notification } });
    this.push(data, 'user_notification');
  }

  /** D3：重放 >lastEventId 的缓冲事件（全量帧兜底幂等） */
  public replay(
    clientLastId: number,
    write: (frame: string, eventName: string, id: string) => void,
  ): void {
    for (const item of this.eventBuffer) {
      const seqNum = Number(item.id);
      if (seqNum > clientLastId) {
        write(item.data, item.eventName, item.id);
      }
    }
  }

  private push(data: string, eventName: string): void {
    this.seq += 1;
    const id = String(this.seq);
    this.eventBuffer.push({ id, eventName, data });
    if (this.eventBuffer.length > this.bufferLimit) {
      this.eventBuffer.shift();
    }
    this.broadcast(data, eventName, id);
  }
}
