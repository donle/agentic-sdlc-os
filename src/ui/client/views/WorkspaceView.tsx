/**
 * @file WorkspaceView.tsx
 * @description §13/§14 核心协同工作区（Meridian UI Kit）
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  Inline,
  KeyValueList,
  Panel,
  SectionLabel,
  Select,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { AgentCollaborationTheater } from '../components/AgentCollaborationTheater.tsx';
import { AgentDeliverableReview } from '../components/AgentDeliverableReview.tsx';
import { AgentFlowCanvas } from '../components/AgentFlowCanvas.tsx';
import type { DrawerContent } from '../components/DetailDrawer.tsx';
import { StepViewer } from '../components/StepViewer.tsx';
import { moodFromState } from '../lib/agentPersona.ts';
import { ArtifactDetails } from '../lib/artifactDetails.tsx';
import { stageMeta } from '../lib/display.ts';
import type { PerspectiveState } from '../lib/perspective.ts';
import { AgentWorkActivity } from '../lib/stageContent.tsx';
import type {
  DashboardStateDto,
  FlowNegotiationHint,
  FlowNodeInput,
  NotificationDto,
  WorkflowDomainEventDto,
} from '../types.ts';

export function WorkspaceView({
  state,
  apiClient,
  perspective,
  submitDecision,
  postComment,
  openDrawer,
}: {
  state: DashboardStateDto;
  apiClient: WorkbenchApiClient;
  perspective: PerspectiveState;
  submitDecision: (notif: NotificationDto, verdict: string, label: string, reason: string) => void;
  postComment: (stageId: string, content: string) => void;
  openDrawer: (content: DrawerContent) => void;
}) {
  const run = state.run;
  const [panelStageId, setPanelStageId] = useState<string | null>(null);
  const [stepCursor, setStepCursor] = useState(Number.MAX_SAFE_INTEGER);
  const [stageFilter, setStageFilter] = useState<string>('ALL');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [extraEvents, setExtraEvents] = useState<ReadonlyArray<WorkflowDomainEventDto>>([]);
  const [historyTotal, setHistoryTotal] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    setStepCursor(Number.MAX_SAFE_INTEGER);
    setPanelStageId(run?.currentStageId ?? state.stagePipelineOrder?.[0] ?? null);
    setExtraEvents([]);
    setHistoryTotal(state.liveInteractionStreamTotal ?? null);
    setExpandedEventId(null);
  }, [
    run?.runId,
    run?.activeBranchId,
    run?.currentStageId,
    state.liveInteractionStreamTotal,
    state.stagePipelineOrder,
  ]);

  const mergedEventsDesc = useMemo(() => {
    const map = new Map<string, WorkflowDomainEventDto>();
    for (const ev of state.liveInteractionStream ?? []) {
      map.set(ev.eventId, ev);
    }
    for (const ev of extraEvents) {
      map.set(ev.eventId, ev);
    }
    const items = [...map.values()].sort((a, b) => b.timestampIso.localeCompare(a.timestampIso));
    return stageFilter === 'ALL' ? items : items.filter((e) => e.stageId === stageFilter);
  }, [state.liveInteractionStream, extraEvents, stageFilter]);

  const chronological = useMemo(() => [...mergedEventsDesc].reverse(), [mergedEventsDesc]);

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
  const totalAvailable =
    historyTotal ?? state.liveInteractionStreamTotal ?? mergedEventsDesc.length;
  const hasMoreHistory = mergedEventsDesc.length < totalAvailable;

  const loadMoreHistory = async () => {
    setLoadingHistory(true);
    try {
      const page = await apiClient.fetchEventHistory({
        runId: run.runId,
        stageId: stageFilter === 'ALL' ? undefined : stageFilter,
        offset: mergedEventsDesc.length,
        limit: 40,
      });
      setExtraEvents((prev) => [...prev, ...page.events]);
      setHistoryTotal(page.total);
    } finally {
      setLoadingHistory(false);
    }
  };

  const openArtifactDrawer = (stageId: string, snapshotId?: string) => {
    const snap =
      (snapshotId ? run.snapshots?.find((s) => s.snapshotId === snapshotId) : undefined) ??
      run.snapshots?.find(
        (s) =>
          s.branchId === run.activeBranchId && s.stageId === stageId && s.state !== 'SUPERSEDED',
      );
    if (!snap) {
      return;
    }
    openDrawer({
      title: '完整交付物与方案文档',
      subtitle: `${stageMeta(stageId).name} · ${snap.snapshotId}`,
      size: 'lg',
      body: <ArtifactDetails snap={snap} />,
    });
  };

  return (
    <Stack gap="loose">
      <Panel
        title={
          <Inline>
            <span>Agent 多智能体协同流程脊柱</span>
            <StatusChip tone="violet" dot>
              {run.activeBranchId}
              {hasRollbackFork ? ` · 共 ${run.branches.length} 分支` : ''}
            </StatusChip>
            <StatusChip tone={perspective.level === 'L3' ? 'brand' : 'neutral'}>
              {perspective.level === 'L3' ? 'L3 全阶段详览' : 'L2 负责节点 / L1 其他摘要'}
            </StatusChip>
          </Inline>
        }
        subtitle="点击任意阶段节点，在下方直接打开【Agent 交付审阅面板】与门禁裁决区"
      >
        <AgentFlowCanvas
          stageOrder={state.stagePipelineOrder ?? []}
          inputs={inputs}
          negotiation={negotiation}
          hasRollbackFork={hasRollbackFork}
          stepFocusStageId={chronological[safeCursor]?.stageId ?? null}
          activeBranchId={run.activeBranchId}
          branchCount={run.branches.length}
          perspective={perspective}
          onNodeClick={(stageId) => setPanelStageId(stageId)}
        />
      </Panel>

      <AgentCollaborationTheater
        state={state}
        events={chronological}
        cursor={safeCursor}
        onCursorChange={setStepCursor}
        onFocusStage={(stageId) => setPanelStageId(stageId)}
      />

      {panelStageId ? (
        <AgentDeliverableReview
          key={`${run.runId}-${panelStageId}`}
          state={state}
          stageId={panelStageId}
          perspective={perspective}
          extraStageEvents={extraEvents}
          hasMoreHistory={hasMoreHistory}
          onLoadMoreHistory={() => void loadMoreHistory()}
          onSubmitDecision={submitDecision}
          onPostComment={postComment}
          onOpenFullArtifactDrawer={() => openArtifactDrawer(panelStageId)}
          onClose={() => setPanelStageId(null)}
        />
      ) : (
        <Callout tone="info" title="请选择上方流程节点以打开交付审阅台">
          点击流程脊柱中任意 Agent 节点，即可审阅结构化交付物、事件推演链路与执行签核。
        </Callout>
      )}

      <Panel
        id="stepViewerPanel"
        title={
          <Inline>
            <span>执行历史与事件链路下钻</span>
            <StatusChip tone="brand">
              已加载 {mergedEventsDesc.length}/{totalAvailable} 条事件
            </StatusChip>
          </Inline>
        }
        actions={
          <Inline>
            <Select
              ariaLabel="按阶段筛选事件"
              value={stageFilter}
              onChange={(val) => setStageFilter(val)}
              options={[
                { value: 'ALL', label: '全部阶段事件' },
                ...(state.stagePipelineOrder ?? []).map((sid) => ({
                  value: sid,
                  label: stageMeta(sid).shortName,
                })),
              ]}
            />
            {hasMoreHistory ? (
              <Button
                size="sm"
                variant="outline"
                loading={loadingHistory}
                onClick={() => void loadMoreHistory()}
              >
                加载更早历史
              </Button>
            ) : null}
          </Inline>
        }
      >
        <Stack gap="normal">
          <StepViewer
            events={chronological}
            cursor={stepCursor}
            onCursorChange={setStepCursor}
            onOpenEventDetail={(event) =>
              openDrawer({
                title: 'Agent 活动事件详情',
                subtitle: `${event.eventId} · ${stageMeta(event.stageId).name}`,
                size: 'md',
                body: (
                  <Stack gap="normal">
                    <Card
                      inset
                      title={event.headline}
                      subtitle={`${event.lifecycleState} · ${event.timestampIso} · ${event.branchId}`}
                    >
                      <SectionLabel>结构化明细 (detailPayload)</SectionLabel>
                      <KeyValueList
                        items={Object.entries(event.detailPayload ?? {}).map(([k, v]) => ({
                          key: k,
                          value: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
                        }))}
                      />
                    </Card>
                  </Stack>
                ),
              })
            }
            onOpenActionBreakdown={() => {
              const sid = chronological[safeCursor]?.stageId ?? state.stagePipelineOrder[0];
              const snap = run.snapshots?.find(
                (s) =>
                  s.branchId === run.activeBranchId &&
                  s.stageId === sid &&
                  s.state !== 'SUPERSEDED',
              );
              openDrawer({
                title: '真实执行轨迹与决策分解',
                subtitle: stageMeta(sid).name,
                size: 'md',
                body: (
                  <AgentWorkActivity
                    stageId={sid}
                    snap={snap ?? undefined}
                    stageEvents={mergedEventsDesc.filter((e) => e.stageId === sid)}
                  />
                ),
              });
            }}
            onOpenAllEvents={() =>
              openDrawer({
                title: '完整事件时间轴',
                subtitle: `共 ${chronological.length} 条 · 时间正序`,
                size: 'lg',
                body:
                  chronological.length === 0 ? (
                    <EmptyState compact title="暂无活动事件" />
                  ) : (
                    <Stack gap="tight">
                      {chronological.map((event) => (
                        <Card
                          key={event.eventId}
                          inset
                          title={event.headline}
                          subtitle={`${stageMeta(event.stageId).shortName} · ${event.lifecycleState} · ${event.timestampIso}`}
                        >
                          {Object.keys(event.detailPayload ?? {}).length > 0 ? (
                            <KeyValueList
                              items={Object.entries(event.detailPayload).map(([k, v]) => ({
                                key: k,
                                value: typeof v === 'string' ? v : JSON.stringify(v),
                              }))}
                            />
                          ) : null}
                        </Card>
                      ))}
                    </Stack>
                  ),
              })
            }
          />

          <SectionLabel>事件链快速下钻（点击任意事件展开 detailPayload）</SectionLabel>
          {mergedEventsDesc.length === 0 ? (
            <EmptyState compact title="当前筛选条件无事件记录" />
          ) : (
            <Stack gap="tight">
              {mergedEventsDesc.slice(0, 12).map((ev) => {
                const isExpanded = expandedEventId === ev.eventId;
                const payloadSnapshotId =
                  typeof ev.detailPayload?.snapshotId === 'string'
                    ? ev.detailPayload.snapshotId
                    : undefined;
                return (
                  <Card
                    key={ev.eventId}
                    inset
                    interactive
                    onClick={() => setExpandedEventId(isExpanded ? null : ev.eventId)}
                    title={
                      <Inline className="m-between" wrap>
                        <Inline>
                          <AgentAvatar
                            roleOrStage={ev.agentRole || ev.stageId}
                            size="xs"
                            mood={moodFromState(ev.lifecycleState)}
                          />
                          <Text variant="sm" as="strong">
                            {ev.headline}
                          </Text>
                        </Inline>
                        <Inline>
                          <StatusChip tone="brand">{stageMeta(ev.stageId).shortName}</StatusChip>
                          <StatusChip
                            tone={ev.lifecycleState === 'PENDING_HUMAN_GATE' ? 'warn' : 'neutral'}
                          >
                            {ev.lifecycleState}
                          </StatusChip>
                        </Inline>
                      </Inline>
                    }
                    subtitle={`${ev.timestampIso} · 分支 ${ev.branchId}`}
                    footer={
                      ev.lifecycleState === 'PENDING_HUMAN_GATE' || payloadSnapshotId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPanelStageId(ev.stageId);
                            openArtifactDrawer(ev.stageId, payloadSnapshotId);
                          }}
                        >
                          查看该步骤交付物 →
                        </Button>
                      ) : undefined
                    }
                  >
                    {isExpanded && Object.keys(ev.detailPayload ?? {}).length > 0 ? (
                      <KeyValueList
                        items={Object.entries(ev.detailPayload).map(([k, v]) => ({
                          key: k,
                          value: typeof v === 'string' ? v : JSON.stringify(v),
                        }))}
                      />
                    ) : null}
                  </Card>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Panel>
    </Stack>
  );
}
