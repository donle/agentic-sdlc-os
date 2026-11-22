/**
 * @file WorkspaceView.tsx
 * @description 核心工作区（单列）：流程图（业务事件徽标）→ 执行历史步骤查看器 → 阶段操作台。
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  DashboardStateDto,
  FlowNegotiationHint,
  FlowNodeInput,
  NotificationDto,
} from '../types.ts';
import { AgentFlowCanvas } from '../components/AgentFlowCanvas.tsx';
import { StepViewer } from '../components/StepViewer.tsx';
import { StageNodePanel } from '../components/StageNodePanel.tsx';
import type { DrawerContent } from '../components/DetailDrawer.tsx';
import { ArtifactDetails } from '../lib/artifactDetails.tsx';
import { AgentDiscussion, AgentWorkActivity } from '../lib/stageContent.tsx';
import { stageMeta } from '../lib/display.ts';
import { CommentCard } from '../components/CommentCard.tsx';

export function WorkspaceView({
  state,
  submitDecision,
  postComment,
  openDrawer,
}: {
  state: DashboardStateDto;
  submitDecision: (notif: NotificationDto, verdict: string, label: string, reason: string) => void;
  postComment: (stageId: string, content: string) => void;
  openDrawer: (content: DrawerContent) => void;
}) {
  const run = state.run;
  const [panelStageId, setPanelStageId] = useState<string | null>(null);
  const [stepCursor, setStepCursor] = useState(Number.MAX_SAFE_INTEGER);

  // 运行实例 / 分支切换：重置查看器到最新一步并收起操作台
  useEffect(() => {
    setStepCursor(Number.MAX_SAFE_INTEGER);
    setPanelStageId(null);
  }, [run?.runId, run?.activeBranchId]);

  const chronological = useMemo(
    () => [...(state.liveInteractionStream ?? [])].reverse(),
    [state.liveInteractionStream],
  );

  const inputs = useMemo<FlowNodeInput[]>(() => {
    const allSnapshots = run?.snapshots ?? [];
    const activeSnapshots = allSnapshots.filter(
      (s) => s.branchId === run?.activeBranchId && s.state !== 'SUPERSEDED',
    );
    const pendingStageIds = new Set(
      (state.notifications ?? [])
        .filter((n) => n.requiresHumanAction && !n.resolved)
        .map((n) => n.stageId),
    );
    return (state.stagePipelineOrder ?? []).map((stageId) => ({
      stageId,
      activeBranchSnapshot: activeSnapshots.find((s) => s.stageId === stageId) ?? null,
      supersededVersionCount: allSnapshots.filter(
        (s) => s.stageId === stageId && s.state === 'SUPERSEDED',
      ).length,
      rejectedCount: allSnapshots.filter((s) => s.stageId === stageId && s.state === 'REJECTED')
        .length,
      hasPendingGateNotification: pendingStageIds.has(stageId),
    }));
  }, [state, run]);

  const negotiation = useMemo<FlowNegotiationHint | null>(() => {
    const turns = state.negotiationLogs ?? [];
    if (turns.length === 0) {
      return null;
    }
    const last = turns[turns.length - 1];
    const unresolvedConflict = (state.notifications ?? []).some(
      (n) => n.category === 'CONFLICT_ARBITRATION_REQUIRED' && n.requiresHumanAction && !n.resolved,
    );
    return last.escalatedToSupervisor && unresolvedConflict
      ? { turnIndex: last.turnIndex, maxTurnsAllowed: last.maxTurnsAllowed, escalated: true }
      : null;
  }, [state]);

  if (!run) {
    return null;
  }
  const hasRollbackFork = run.branches.length > 1;
  const safeCursor = Math.max(0, Math.min(stepCursor, chronological.length - 1));

  const openArtifactDrawer = (stageId: string) => {
    const snap = run.snapshots?.find(
      (s) => s.branchId === run.activeBranchId && s.stageId === stageId && s.state !== 'SUPERSEDED',
    );
    if (!snap) {
      return;
    }
    openDrawer({
      title: '完整交付物与方案文档',
      subtitle: stageMeta(stageId).name,
      body: <ArtifactDetails snap={snap} />,
    });
  };

  const openDiscussionDrawer = (stageId: string) => {
    const snap = run.snapshots?.find(
      (s) => s.branchId === run.activeBranchId && s.stageId === stageId && s.state !== 'SUPERSEDED',
    );
    openDrawer({
      title: 'Agent 跨岗位讨论过程与历史结论',
      subtitle: stageMeta(stageId).name,
      body: (
        <AgentDiscussion
          stageId={stageId}
          snap={snap ?? undefined}
          negotiationLogs={state.negotiationLogs ?? []}
          allSnapshots={run.snapshots ?? []}
        />
      ),
    });
  };

  const openCommentsDrawer = (stageId: string) => {
    const stageComments = (state.teamComments ?? []).filter((c) => c.stageId === stageId);
    openDrawer({
      title: '团队成员评论与评审意见',
      subtitle: `共 ${stageComments.length} 条`,
      body:
        stageComments.length === 0 ? (
          <div className="timeline-empty">本阶段暂无评论，在阶段操作台中发表第一条评论。</div>
        ) : (
          stageComments.map((cmt) => <CommentCard key={cmt.commentId} comment={cmt} />)
        ),
    });
  };

  return (
    <>
      <section className="panel flow-canvas-panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Agent 多智能体协同流程图</span>
            <span className="pill pill-purple">
              ⎇ {run.activeBranchId}
              {hasRollbackFork ? ` · 共 ${run.branches.length} 个分支` : ''}
            </span>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            点击任意阶段节点即可就地查看产出与执行裁决
          </span>
        </div>
        <AgentFlowCanvas
          stageOrder={state.stagePipelineOrder ?? []}
          inputs={inputs}
          negotiation={negotiation}
          hasRollbackFork={hasRollbackFork}
          stepFocusStageId={chronological[safeCursor]?.stageId ?? null}
          activeBranchId={run.activeBranchId}
          branchCount={run.branches.length}
          onNodeClick={(stageId) => setPanelStageId(stageId)}
        />
      </section>

      <section className="panel" id="stepViewerPanel">
        <div className="panel-header">
          <div className="panel-title">
            <span>执行历史步骤查看器</span>
          </div>
          <span className="pill pill-blue">
            共 {chronological.length} 步
            {chronological.length > 0 ? ` · 当前 ${safeCursor + 1}/${chronological.length}` : ''}
          </span>
        </div>
        <StepViewer
          events={chronological}
          cursor={stepCursor}
          onCursorChange={setStepCursor}
          onOpenEventDetail={(event) =>
            openDrawer({
              title: 'Agent 活动事件详情',
              subtitle: event.eventId,
              body: (
                <>
                  <div className="drawer-detail-hero">
                    <span className="feed-icon">{event.headline ? '📌' : '📣'}</span>
                    <div>
                      <div className="drawer-detail-headline">{event.headline}</div>
                      <div className="drawer-detail-meta">
                        {event.lifecycleState} · {event.timestampIso} · {event.branchId}
                      </div>
                    </div>
                  </div>
                  <h4 className="inspector-subtitle">结构化明细 (detailPayload)</h4>
                  <table className="detail-kv-table">
                    <tbody>
                      {Object.entries(event.detailPayload ?? {}).map(([key, value]) => (
                        <tr key={key}>
                          <th>{key}</th>
                          <td>
                            {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ),
            })
          }
          onOpenActionBreakdown={() => {
            const stageId = chronological[safeCursor]?.stageId ?? state.stagePipelineOrder[0];
            const snap =
              run.snapshots?.find(
                (s) =>
                  s.branchId === run.activeBranchId &&
                  s.stageId === stageId &&
                  s.state !== 'SUPERSEDED',
              ) ?? undefined;
            openDrawer({
              title: '执行动作分解',
              subtitle: stageMeta(stageId).name,
              body: <AgentWorkActivity stageId={stageId} snap={snap} />,
            });
          }}
          onOpenAllEvents={() =>
            openDrawer({
              title: '全部 Agent 活动',
              subtitle: `共 ${chronological.length} 条 · 时间正序`,
              body:
                chronological.length === 0 ? (
                  <div className="timeline-empty">暂无活动事件。</div>
                ) : (
                  <div className="feed-list">
                    {chronological.map((event) => (
                      <div
                        className={`feed-item ${event.lifecycleState.toLowerCase()}`}
                        key={event.eventId}
                      >
                        <span className="feed-icon">
                          {event.headline.startsWith('[协商') ? '💬' : '🤖'}
                        </span>
                        <div className="feed-body">
                          <div className="feed-headline">{event.headline}</div>
                          <div className="feed-meta">
                            {stageMeta(event.stageId).shortName} · {event.lifecycleState} ·{' '}
                            {event.timestampIso}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ),
            })
          }
        />
      </section>

      {panelStageId ? (
        <StageNodePanel
          state={state}
          stageId={panelStageId}
          onClose={() => setPanelStageId(null)}
          onSubmitDecision={submitDecision}
          onPostComment={postComment}
          onOpenArtifact={() => openArtifactDrawer(panelStageId)}
          onOpenDiscussion={() => openDiscussionDrawer(panelStageId)}
          onOpenComments={() => openCommentsDrawer(panelStageId)}
        />
      ) : null}
    </>
  );
}
