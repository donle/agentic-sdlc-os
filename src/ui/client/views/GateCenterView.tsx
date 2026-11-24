/**
 * @file GateCenterView.tsx
 * @description §14 待办确认与方案拍板中心（Meridian UI Kit 双栏架构）
 */

import { useEffect, useState } from 'react';
import {
  EmptyState,
  Inline,
  ListRow,
  Panel,
  SegmentedControl,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { AgentDeliverableReview } from '../components/AgentDeliverableReview.tsx';
import type { DrawerContent } from '../components/DetailDrawer.tsx';
import { ArtifactDetails } from '../lib/artifactDetails.tsx';
import { stageMeta } from '../lib/display.ts';
import type { PerspectiveState } from '../lib/perspective.ts';
import type { DashboardStateDto, NotificationDto } from '../types.ts';

const PAGE_SIZE = 12;

export function GateCenterView({
  state,
  perspective,
  onSubmitDecision,
  onPostComment,
  onOpenDrawer,
}: {
  state: DashboardStateDto;
  perspective: PerspectiveState;
  onSubmitDecision: (
    notif: NotificationDto,
    verdict: string,
    label: string,
    reason: string,
  ) => void;
  onPostComment: (stageId: string, content: string) => void;
  onOpenDrawer: (content: DrawerContent) => void;
}) {
  const [filterMode, setFilterMode] = useState<'all' | 'mine'>('all');
  const [expanded, setExpanded] = useState(false);
  const [selectedNotifId, setSelectedNotifId] = useState<string | null>(null);

  const all = state.notifications ?? [];
  const filtered =
    filterMode === 'mine' ? all.filter((n) => n.accessEvaluation?.canApproveOrArbitrate) : all;
  const visible = expanded ? filtered : filtered.slice(0, PAGE_SIZE);
  const unresolvedCount = all.filter((n) => n.requiresHumanAction && !n.resolved).length;

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedNotifId(null);
      return;
    }
    const stillVisible = visible.some((n) => n.notificationId === selectedNotifId);
    if (!stillVisible) {
      const preferred = visible.find((n) => n.requiresHumanAction && !n.resolved) ?? visible[0];
      setSelectedNotifId(preferred.notificationId);
    }
  }, [state.run?.runId, filterMode, all.length, selectedNotifId, visible]);

  const selectedNotif =
    visible.find((n) => n.notificationId === selectedNotifId) ??
    filtered.find((n) => n.notificationId === selectedNotifId) ??
    null;

  const selectedSnap = selectedNotif
    ? (state.run?.snapshots?.find((s) => s.snapshotId === selectedNotif.relatedSnapshotId) ?? null)
    : null;

  return (
    <div className="gate-center-split">
      <Panel
        title="待确认事项与方案拍板队列"
        actions={
          <StatusChip tone={unresolvedCount > 0 ? 'warn' : 'success'} dot>
            {unresolvedCount > 0 ? `${unresolvedCount} 项待确认/拍板` : '全部已确认'}
          </StatusChip>
        }
      >
        <Stack gap="normal">
          <SegmentedControl
            value={filterMode}
            onChange={(val) => setFilterMode(val)}
            options={[
              { value: 'all', label: '全部确认记录', badge: all.length },
              {
                value: 'mine',
                label: '仅我负责确认',
                badge: all.filter((n) => n.accessEvaluation?.canApproveOrArbitrate).length,
              },
            ]}
          />

          {visible.length === 0 ? (
            <EmptyState
              icon="inbox"
              compact
              title="暂无待确认步骤记录"
              description="当前筛选条件下没有需要人工确认或裁决的事件。"
            />
          ) : (
            <Stack gap="tight">
              {visible.map((notif) => {
                const isUrgent = notif.requiresHumanAction && !notif.resolved;
                const access = notif.accessEvaluation;
                const isSelected = selectedNotif?.notificationId === notif.notificationId;
                return (
                  <ListRow
                    key={notif.notificationId}
                    className={isSelected ? 'gate-queue-item-active' : undefined}
                    onClick={() => setSelectedNotifId(notif.notificationId)}
                    leading={
                      <AgentAvatar
                        roleOrStage={notif.senderRole || notif.stageId}
                        size="sm"
                        mood={isUrgent ? 'waiting' : 'celebrating'}
                        showMoodBadge={isUrgent}
                      />
                    }
                    title={notif.title}
                    description={notif.message}
                    meta={
                      <Inline wrap>
                        <Text variant="xs" tone="tertiary" as="span">
                          {stageMeta(notif.stageId).shortName} · {notif.senderRole} ·{' '}
                          {notif.branchId}
                        </Text>
                        {access?.isDirectDomainOwner ? (
                          <StatusChip tone="success">我负责</StatusChip>
                        ) : access?.isAdminOverride ? (
                          <StatusChip tone="violet">管理员可拍板</StatusChip>
                        ) : null}
                      </Inline>
                    }
                    trailing={
                      <StatusChip tone={isUrgent ? 'warn' : 'success'} dot>
                        {isUrgent ? '待确认' : '已确认'}
                      </StatusChip>
                    }
                  />
                );
              })}

              {filtered.length > visible.length ? (
                <button type="button" className="link-toggle" onClick={() => setExpanded(true)}>
                  展开其余 {filtered.length - visible.length} 条记录 ▾
                </button>
              ) : null}
            </Stack>
          )}
        </Stack>
      </Panel>

      <div>
        {selectedNotif ? (
          <AgentDeliverableReview
            key={selectedNotif.notificationId}
            state={state}
            stageId={selectedNotif.stageId}
            perspective={perspective}
            notification={selectedNotif}
            snapshot={selectedSnap}
            onSubmitDecision={onSubmitDecision}
            onPostComment={onPostComment}
            onOpenFullArtifactDrawer={
              selectedSnap
                ? () =>
                    onOpenDrawer({
                      title: '完整交付物与方案文档',
                      subtitle: stageMeta(selectedNotif.stageId).name,
                      size: 'lg',
                      body: <ArtifactDetails snap={selectedSnap} />,
                    })
                : undefined
            }
          />
        ) : (
          <Panel title="审阅与决策详情">
            <EmptyState
              icon="shield"
              title="选择左侧队列条目进行审阅"
              description="每条待办均绑定独立交付物、推演事件链、协商对比方案与独立裁决理由框。"
            />
          </Panel>
        )}
      </div>
    </div>
  );
}
