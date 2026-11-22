/**
 * @file StepViewer.tsx
 * @description 执行历史步骤查看器：所有 Agent 动作按时间正序排列，
 * ‹ › 步进或点击任意步骤，联动流程图高亮对应节点；当前步骤渲染为
 * 强调 Agent 身份的大卡片。
 */

import type { WorkflowDomainEventDto } from '../types.ts';
import { formatRelativeTime, lifecycleCss, lifecycleIcon, stageMeta } from '../lib/display.ts';

function AgentActionCard({ event }: { event: WorkflowDomainEventDto }) {
  const meta = stageMeta(event.stageId);
  return (
    <div className={`agent-action-card ${lifecycleCss(event.lifecycleState)}`}>
      <div className="agent-action-head">
        <span className="agent-action-avatar">{lifecycleIcon(event.lifecycleState)}</span>
        <div className="agent-action-identity">
          <div className="agent-action-name">{meta.agentDisplayName}</div>
          <div className="agent-action-role">
            {meta.shortName} · 协同责任专家: {meta.specialistLabel}
          </div>
        </div>
        <span className="agent-action-time">{formatRelativeTime(event.timestampIso)}</span>
      </div>
      <div className="agent-action-body">{event.headline}</div>
    </div>
  );
}

export function StepViewer({
  events,
  cursor,
  onCursorChange,
  onOpenEventDetail,
  onOpenActionBreakdown,
  onOpenAllEvents,
}: {
  events: ReadonlyArray<WorkflowDomainEventDto>;
  cursor: number;
  onCursorChange: (index: number) => void;
  onOpenEventDetail: (event: WorkflowDomainEventDto) => void;
  onOpenActionBreakdown: () => void;
  onOpenAllEvents: () => void;
}) {
  if (events.length === 0) {
    return (
      <div className="feed-empty">
        暂无 Agent 执行历史。发起提案后，这里将逐步呈现每个 Agent 的动作。
      </div>
    );
  }
  const safeCursor = Math.max(0, Math.min(cursor, events.length - 1));
  const current = events[safeCursor];

  return (
    <>
      <div className="step-viewer-bar">
        <button
          type="button"
          className="step-viewer-nav"
          disabled={safeCursor === 0}
          onClick={() => onCursorChange(safeCursor - 1)}
        >
          ‹
        </button>
        <div className="step-viewer-chips">
          {events.map((event, index) => (
            <button
              type="button"
              key={event.eventId + String(index)}
              className={`step-chip ${index === safeCursor ? 'current' : ''}`}
              onClick={() => onCursorChange(index)}
            >
              <span>{lifecycleIcon(event.lifecycleState)}</span>
              <span className="step-chip-stage">
                {stageMeta(event.stageId).stepTag.replace('STEP ', 'S')}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="step-viewer-nav"
          disabled={safeCursor === events.length - 1}
          onClick={() => onCursorChange(safeCursor + 1)}
        >
          ›
        </button>
      </div>

      <AgentActionCard event={current} />

      <div className="node-panel-links" style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={onOpenActionBreakdown}>
          📋 执行动作分解
        </button>
        <button type="button" className="btn" onClick={onOpenAllEvents}>
          📜 全部事件列表
        </button>
        <button type="button" className="btn" onClick={() => onOpenEventDetail(current)}>
          🔍 当前步事件详情
        </button>
      </div>
    </>
  );
}
