/**
 * @file DecisionTimeline.tsx
 * @description 审批与人为干预时间轴：谁在何时批准/驳回/裁决/回退了哪一版方案。
 */

import type { HumanDecisionDto } from '../types.ts';
import { formatRelativeTime, stageMeta, verdictVisual } from '../lib/display.ts';

export function DecisionTimeline({ decisions }: { decisions: ReadonlyArray<HumanDecisionDto> }) {
  if (decisions.length === 0) {
    return (
      <div className="timeline-empty">
        暂无人为操作记录。当有签核、驳回、冲突拍板或总管回退时，将在此按时间轴呈现。
      </div>
    );
  }

  const chronological = [...decisions].reverse();
  const groups = new Map<string, HumanDecisionDto[]>();
  for (const decision of chronological) {
    const dayKey = decision.createdAtIso.slice(0, 10);
    const bucket = groups.get(dayKey) ?? [];
    bucket.push(decision);
    groups.set(dayKey, bucket);
  }

  return (
    <div className="decision-timeline">
      {[...groups.entries()].map(([dayKey, items]) => (
        <div className="decision-day-group" key={dayKey}>
          <div className="decision-day-label">{dayKey}</div>
          {items.map((decision) => {
            const visual = verdictVisual(decision.verdict);
            return (
              <div className={`decision-row ${visual.className}`} key={decision.decisionId}>
                <div className="decision-icon">{visual.icon}</div>
                <div className="decision-body">
                  <div className="decision-head">
                    <strong>{visual.label}</strong>
                    <span className="decision-actor">{decision.reviewerActor}</span>
                    <span className="decision-time">
                      {formatRelativeTime(decision.createdAtIso)}
                    </span>
                  </div>
                  <div className="decision-meta">
                    {stageMeta(decision.stageId).shortName} · {decision.branchId}
                  </div>
                  <div className="decision-comment">{decision.comment}</div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
