/**
 * @file StageNodePanel.tsx
 * @description 阶段操作台：统一委托给 Meridian UI Kit 构建的 `AgentDeliverableReview` 审阅面板。
 */

import type { DashboardStateDto, NotificationDto } from '../types.ts';
import { derivePerspective } from '../lib/perspective.ts';
import { AgentDeliverableReview } from './AgentDeliverableReview.tsx';

export function StageNodePanel({
  state,
  stageId,
  onClose,
  onSubmitDecision,
  onPostComment,
  onOpenArtifact,
}: {
  state: DashboardStateDto;
  stageId: string;
  onClose: () => void;
  onSubmitDecision: (
    notif: NotificationDto,
    verdict: string,
    label: string,
    reason: string,
  ) => void;
  onPostComment: (stageId: string, content: string) => void;
  onOpenArtifact: () => void;
  onOpenDiscussion?: () => void;
  onOpenComments?: () => void;
}) {
  const perspective = derivePerspective(state.rbacContext);

  return (
    <div id="stageNodePanel">
      <AgentDeliverableReview
        key={`${state.run?.runId ?? 'none'}-${stageId}`}
        state={state}
        stageId={stageId}
        perspective={perspective}
        onSubmitDecision={onSubmitDecision}
        onPostComment={onPostComment}
        onOpenFullArtifactDrawer={onOpenArtifact}
        onClose={onClose}
      />
    </div>
  );
}
