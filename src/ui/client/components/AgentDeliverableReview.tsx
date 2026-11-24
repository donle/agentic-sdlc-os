/**
 * @file AgentDeliverableReview.tsx
 * @description §13 「Agent 交付审阅面板」核心组件（Meridian UI Kit 构建）
 */

import { useState } from 'react';
import {
  Banner,
  Button,
  Callout,
  Card,
  Divider,
  EmptyState,
  Field,
  Gauge,
  Inline,
  KeyValueList,
  Panel,
  SectionLabel,
  Stack,
  StatusChip,
  Tabs,
  Text,
  Textarea,
} from '../../kit/index.ts';
import type {
  DashboardStateDto,
  NotificationDto,
  SnapshotRecordDto,
  WorkflowDomainEventDto,
} from '../types.ts';
import { moodActionCue, moodFromState, personaFor } from '../lib/agentPersona.ts';
import { ArtifactDetails } from '../lib/artifactDetails.tsx';
import { stageMeta, stateBadge } from '../lib/display.ts';
import type { PerspectiveState } from '../lib/perspective.ts';
import { AgentDiscussion, AgentWorkActivity } from '../lib/stageContent.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { CommentCard } from './CommentCard.tsx';

export interface AgentDeliverableReviewProps {
  readonly state: DashboardStateDto;
  readonly stageId: string;
  readonly perspective: PerspectiveState;
  readonly notification?: NotificationDto | null;
  readonly snapshot?: SnapshotRecordDto | null;
  readonly extraStageEvents?: ReadonlyArray<WorkflowDomainEventDto>;
  readonly hasMoreHistory?: boolean;
  readonly onLoadMoreHistory?: () => void;
  readonly onSubmitDecision: (
    notif: NotificationDto,
    verdict: string,
    label: string,
    reason: string,
  ) => void;
  readonly onPostComment: (stageId: string, content: string) => void;
  readonly onOpenFullArtifactDrawer?: () => void;
  readonly onClose?: () => void;
}

function gaugeTone(score: number): 'success' | 'warn' | 'danger' {
  if (score >= 70) {
    return 'danger';
  }
  if (score >= 45) {
    return 'warn';
  }
  return 'success';
}

export function AgentDeliverableReview({
  state,
  stageId,
  perspective,
  notification,
  snapshot: explicitSnapshot,
  extraStageEvents = [],
  hasMoreHistory = false,
  onLoadMoreHistory,
  onSubmitDecision,
  onPostComment,
  onOpenFullArtifactDrawer,
  onClose,
}: AgentDeliverableReviewProps) {
  const [activeTab, setActiveTab] = useState<'deliverable' | 'reasoning' | 'comments'>(
    'deliverable',
  );
  const [decisionNote, setDecisionNote] = useState('');
  const [commentText, setCommentText] = useState('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const meta = stageMeta(stageId);
  const run = state.run;
  const activeBranch = run?.activeBranchId ?? 'branch-main';
  const resolvedSnap =
    explicitSnapshot ??
    run?.snapshots?.find(
      (s) => s.branchId === activeBranch && s.stageId === stageId && s.state !== 'SUPERSEDED',
    ) ??
    run?.snapshots?.filter((s) => s.stageId === stageId).pop() ??
    null;

  const activeNotif =
    notification ??
    (state.notifications ?? []).find(
      (n) => n.stageId === stageId && n.requiresHumanAction && !n.resolved,
    ) ??
    null;

  const density = perspective.getStageDensity(stageId);
  const stageComments = (state.teamComments ?? []).filter((c) => c.stageId === stageId);
  const combinedEventsMap = new Map<string, WorkflowDomainEventDto>();
  for (const ev of [...(state.liveInteractionStream ?? []), ...extraStageEvents]) {
    if (ev.stageId === stageId) {
      combinedEventsMap.set(ev.eventId, ev);
    }
  }
  const stageEvents = [...combinedEventsMap.values()];

  const access = activeNotif?.accessEvaluation ?? state.rbacContext?.stageAccessMatrix?.[stageId];
  const canAct = Boolean(access?.canApproveOrArbitrate);
  const isConflictArbitration =
    activeNotif?.category === 'CONFLICT_ARBITRATION_REQUIRED' ||
    resolvedSnap?.gateAction === 'BLOCK_FOR_CONFLICT_ARBITRATION';

  const latestNegotiation =
    (state.negotiationLogs ?? [])
      .filter(
        (t) =>
          (stageId === 'STAGE_2_PD' && (!t.topic || t.topic === 'DESIGN_REVIEW')) ||
          (stageId === 'STAGE_4_QA' && t.topic === 'QA_REPAIR'),
      )
      .pop() ?? state.negotiationLogs?.[state.negotiationLogs.length - 1];

  const badge = resolvedSnap
    ? stateBadge(resolvedSnap.state, resolvedSnap.cacheHit)
    : { label: '等待执行', pillClass: 'pill pill-muted' };
  const persona = personaFor(stageId);
  const agentMood = moodFromState(resolvedSnap?.state);

  const headerActions = (
    <Inline>
      <StatusChip tone={density === 'L2' ? 'brand' : 'neutral'} dot>
        {density === 'L2' ? 'L2 完整审阅' : 'L1 结论摘要'}
      </StatusChip>
      {onOpenFullArtifactDrawer && resolvedSnap && density === 'L2' ? (
        <Button size="sm" variant="outline" icon="file" onClick={onOpenFullArtifactDrawer}>
          完整审阅抽屉
        </Button>
      ) : null}
      {onClose ? (
        <Button size="sm" variant="ghost" icon="close" onClick={onClose}>
          收起
        </Button>
      ) : null}
    </Inline>
  );

  if (density === 'L1') {
    return (
      <Panel
        title={
          <Inline>
            <AgentAvatar roleOrStage={stageId} size="sm" mood={agentMood} />
            <span>{meta.name}</span>
          </Inline>
        }
        subtitle={`责任专员：${meta.specialistLabel} · 协同 Agent：${meta.agentDisplayName}`}
        actions={headerActions}
      >
        <Stack gap="normal">
          <div className="agent-persona-greeting" style={{ borderColor: persona.accentColor }}>
            <AgentAvatar roleOrStage={stageId} size="lg" mood={agentMood} showMoodBadge />
            <div className="agent-greeting-bubble">
              <div className="agent-greeting-name">
                <strong>{persona.personName}</strong>
                <span>{persona.roleTitle}</span>
              </div>
              <div className="agent-greeting-quote">
                {resolvedSnap
                  ? (resolvedSnap.structuredSummary?.headline ?? resolvedSnap.artifactSummary)
                  : persona.catchphrase}
              </div>
            </div>
          </div>
          {resolvedSnap ? (
            <KeyValueList
              items={[
                {
                  key: '当前结论',
                  value: resolvedSnap.structuredSummary?.headline ?? resolvedSnap.artifactSummary,
                },
                { key: '快照状态', value: badge.label },
                { key: '分支版本', value: resolvedSnap.branchId },
              ]}
            />
          ) : (
            <EmptyState compact title="该步骤尚未执行" description={meta.stepGoal} />
          )}
          <Callout tone="neutral" icon="lock" title="L1 视角受限（只读结论摘要）">
            {perspective.getDenialReason(stageId) ??
              '完整交付物细节、事件证据链与门禁拍板操作仅对本步骤责任人与项目管理员开放。'}
          </Callout>
        </Stack>
      </Panel>
    );
  }

  const structuredSummary = resolvedSnap?.structuredSummary;

  return (
    <Panel
      title={
        <Inline>
          <AgentAvatar
            roleOrStage={stageId}
            size="sm"
            mood={agentMood}
            showSpeakingWaves={agentMood === 'waiting'}
          />
          <span>{meta.name}</span>
          {resolvedSnap ? (
            <StatusChip
              tone={
                resolvedSnap.state === 'PENDING_HUMAN_GATE'
                  ? 'warn'
                  : resolvedSnap.state === 'REJECTED'
                    ? 'danger'
                    : 'success'
              }
              dot
            >
              {badge.label}
            </StatusChip>
          ) : null}
        </Inline>
      }
      subtitle={
        resolvedSnap
          ? `${resolvedSnap.artifactType} · ${resolvedSnap.snapshotId} · 模型 ${resolvedSnap.modelUsed} · 责任人 ${meta.specialistLabel}`
          : `协同 Agent：${meta.agentDisplayName} · 责任人 ${meta.specialistLabel}`
      }
      actions={headerActions}
    >
      <div className="agent-persona-greeting" style={{ borderColor: persona.accentColor }}>
        <AgentAvatar
          roleOrStage={stageId}
          size="lg"
          mood={agentMood}
          showMoodBadge
          showSpeakingWaves={agentMood === 'waiting' || agentMood === 'working'}
        />
        <div className="agent-greeting-bubble">
          <div className="agent-greeting-name">
            <strong>{persona.personName}</strong>
            <span>{persona.roleTitle}</span>
            <StatusChip tone={agentMood === 'waiting' ? 'warn' : 'brand'}>
              {moodActionCue(agentMood)}
            </StatusChip>
          </div>
          <div className="agent-greeting-quote">
            “
            {resolvedSnap
              ? (structuredSummary?.headline ?? resolvedSnap.artifactSummary)
              : persona.catchphrase}
            ”
          </div>
        </div>
      </div>

      <div className="review-panel-grid">
        <Stack gap="normal">
          <Tabs
            activeId={activeTab}
            onChange={(id) => setActiveTab(id as 'deliverable' | 'reasoning' | 'comments')}
            items={[
              { id: 'deliverable', label: '① Agent 交付了什么', icon: 'file' },
              {
                id: 'reasoning',
                label: '② 它怎么推演出来的',
                count: stageEvents.length,
                icon: 'activity',
              },
              {
                id: 'comments',
                label: '③ 团队意见',
                count: stageComments.length,
                icon: 'message',
              },
            ]}
          />

          {activeTab === 'deliverable' ? (
            resolvedSnap ? (
              <Stack gap="normal">
                <Card
                  inset
                  title="交付核心摘要 (Structured Summary)"
                  subtitle={structuredSummary?.rationale ?? resolvedSnap.artifactSummary}
                >
                  <Stack gap="tight">
                    <Text variant="sm" as="strong">
                      {structuredSummary?.headline ?? resolvedSnap.artifactSummary}
                    </Text>
                    {structuredSummary && structuredSummary.caveats.length > 0 ? (
                      <Inline wrap>
                        {structuredSummary.caveats.map((cav, idx) => (
                          <StatusChip key={idx} tone="warn">
                            {cav}
                          </StatusChip>
                        ))}
                      </Inline>
                    ) : null}
                  </Stack>
                </Card>
                <ArtifactDetails snap={resolvedSnap} />
              </Stack>
            ) : (
              <EmptyState
                compact
                icon="clock"
                title={`${meta.agentDisplayName} 尚未生成快照`}
                description="请等待前序步骤放行，Agent 将自动生成结构化交付物。"
              />
            )
          ) : null}

          {activeTab === 'reasoning' ? (
            <Stack gap="normal">
              <AgentWorkActivity
                stageId={stageId}
                snap={resolvedSnap ?? undefined}
                stageEvents={stageEvents}
              />
              {stageEvents.length > 0 ? (
                <Stack gap="tight">
                  <SectionLabel>点击事件可展开原始 detailPayload</SectionLabel>
                  {stageEvents.map((ev) => {
                    const isExpanded = expandedEventId === ev.eventId;
                    const payloadEntries = Object.entries(ev.detailPayload ?? {});
                    return (
                      <Card
                        key={ev.eventId}
                        inset
                        interactive
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.eventId)}
                        title={
                          <Inline className="m-between" wrap>
                            <Text variant="sm" as="strong">
                              {ev.headline}
                            </Text>
                            <StatusChip tone="brand">{ev.lifecycleState}</StatusChip>
                          </Inline>
                        }
                        subtitle={`${ev.timestampIso} · ${ev.branchId} · ${payloadEntries.length} 项结构化明细`}
                      >
                        {isExpanded && payloadEntries.length > 0 ? (
                          <KeyValueList
                            items={payloadEntries.map(([k, v]) => ({
                              key: k,
                              value: typeof v === 'string' ? v : JSON.stringify(v),
                            }))}
                          />
                        ) : null}
                      </Card>
                    );
                  })}
                  {hasMoreHistory && onLoadMoreHistory ? (
                    <Button size="sm" variant="outline" onClick={onLoadMoreHistory}>
                      加载更早历史事件…
                    </Button>
                  ) : null}
                </Stack>
              ) : null}
              <Divider />
              <SectionLabel>跨角色协商与版本演进实录</SectionLabel>
              <AgentDiscussion
                stageId={stageId}
                snap={resolvedSnap ?? undefined}
                negotiationLogs={state.negotiationLogs ?? []}
                allSnapshots={run?.snapshots ?? []}
              />
            </Stack>
          ) : null}

          {activeTab === 'comments' ? (
            <Stack gap="normal">
              <Stack gap="tight">
                {stageComments.length === 0 ? (
                  <EmptyState
                    compact
                    icon="message"
                    title="本步骤暂无团队评论"
                    description="在此发表审核建议、补充边界或协作意见，将永久归档并注入下游参考。"
                  />
                ) : (
                  stageComments.map((cmt) => <CommentCard key={cmt.commentId} comment={cmt} />)
                )}
              </Stack>
              <Field label={`针对【${meta.shortName}】发表评论`}>
                <Textarea
                  rows={2}
                  value={commentText}
                  onChange={setCommentText}
                  placeholder="输入评审建议或追问细节..."
                />
                <div style={{ marginTop: 8 }}>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!commentText.trim()}
                    onClick={() => {
                      if (commentText.trim()) {
                        onPostComment(stageId, commentText.trim());
                        setCommentText('');
                      }
                    }}
                  >
                    发布评论
                  </Button>
                </div>
              </Field>
            </Stack>
          ) : null}
        </Stack>

        <aside className="review-decision-rail">
          <Stack gap="normal">
            <Card inset title="门禁风险评估与决策裁决">
              <Stack gap="tight">
                {resolvedSnap ? (
                  <>
                    <Gauge
                      value={resolvedSnap.riskScore}
                      max={100}
                      tone={gaugeTone(resolvedSnap.riskScore)}
                      suffix="/100"
                      caption={`风险等级：${resolvedSnap.riskLevel}`}
                    />
                    {resolvedSnap.riskReasons.length > 0 ? (
                      <Stack gap="tight">
                        {resolvedSnap.riskReasons.map((r, i) => (
                          <Text key={i} variant="xs" tone="secondary">
                            • {r}
                          </Text>
                        ))}
                      </Stack>
                    ) : null}
                  </>
                ) : (
                  <Text variant="xs" tone="tertiary">
                    等待快照生成后评估风险分数。
                  </Text>
                )}

                {resolvedSnap?.scopeDiff?.hasUnauthorizedScopeReduction ? (
                  <Banner tone="error">
                    Scope Diff 红线：检测到需求被擅自删减（
                    {resolvedSnap.scopeDiff.droppedRequirementIds.join(', ')}）
                  </Banner>
                ) : null}

                {activeNotif && activeNotif.requiresHumanAction && !activeNotif.resolved ? (
                  <>
                    <Callout
                      tone={isConflictArbitration ? 'warn' : 'info'}
                      title={activeNotif.title}
                    >
                      {activeNotif.message}
                    </Callout>

                    {isConflictArbitration && latestNegotiation ? (
                      <Stack gap="tight">
                        <SectionLabel>待拍板 A / B 备选方案全文对照</SectionLabel>
                        <div className="ab-compare-grid">
                          <Card inset title="方案 A">
                            <Text variant="xs">{latestNegotiation.optionAProposal}</Text>
                          </Card>
                          <Card inset title="方案 B">
                            <Text variant="xs">{latestNegotiation.optionBProposal}</Text>
                          </Card>
                        </div>
                      </Stack>
                    ) : null}

                    <Field
                      label="本条裁决独立理由（不会串联其他待办卡片）"
                      hint={
                        canAct
                          ? '将同步记入决策账本与当前步骤团队评论区'
                          : (access?.denialReason ?? '当前角色仅只读浏览，无本步骤签核权限')
                      }
                    >
                      <Textarea
                        rows={2}
                        value={decisionNote}
                        disabled={!canAct}
                        onChange={setDecisionNote}
                        placeholder="请输入通过、驳回或拍板理由..."
                      />
                    </Field>

                    <Stack gap="tight">
                      {activeNotif.actionOptions.map((opt) => {
                        const variant =
                          opt.verdict === 'REJECT'
                            ? 'danger'
                            : opt.verdict === 'APPROVE' || opt.verdict === 'ARBITRATE_OPTION_A'
                              ? 'success'
                              : 'primary';
                        const fallbackReason =
                          decisionNote.trim() ||
                          `[${opt.label}] 经领域负责人审阅当前交付物与推演依据后确认执行。`;
                        return (
                          <Button
                            key={opt.actionKey}
                            variant={variant}
                            block
                            disabled={!canAct}
                            onClick={() =>
                              onSubmitDecision(activeNotif, opt.verdict, opt.label, fallbackReason)
                            }
                          >
                            {canAct ? opt.label : `🔒 ${opt.label}`}
                          </Button>
                        );
                      })}
                    </Stack>
                  </>
                ) : (
                  <Callout
                    tone={resolvedSnap?.state === 'REJECTED' ? 'danger' : 'success'}
                    title="当前步骤门禁状态"
                  >
                    {resolvedSnap
                      ? resolvedSnap.state === 'AUTO_APPROVED_LOW_RISK'
                        ? '低风险策略自动放行，已写入不可变审计账本。'
                        : resolvedSnap.state === 'APPROVED'
                          ? '已获团队负责人人工签核放行。'
                          : resolvedSnap.state === 'REJECTED'
                            ? '已被驳回并由总管分叉重做，请查看新分支快照。'
                            : `当前处于 ${resolvedSnap.state} 状态。`
                      : '暂无待操作人工门禁任务。'}
                  </Callout>
                )}
              </Stack>
            </Card>
          </Stack>
        </aside>
      </div>
    </Panel>
  );
}
