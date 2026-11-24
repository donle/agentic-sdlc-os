/**
 * @file stageContent.tsx
 * @description 阶段业务内容展示组件：全部基于后端真实事件流、交付摘要、关键决策与协商记录渲染（零前端编造）。
 */

import {
  Callout,
  Card,
  EmptyState,
  Inline,
  KeyValueList,
  SectionLabel,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import type { NegotiationTurnDto, SnapshotRecordDto, WorkflowDomainEventDto } from '../types.ts';
import { moodFromState, personaFor } from './agentPersona.ts';
import { parseStageArtifact } from './artifactParsers.ts';
import { stateBadge, stageMeta } from './display.ts';

function statusToneForSnapshot(state: string): 'success' | 'warn' | 'danger' | 'neutral' | 'brand' {
  switch (state) {
    case 'APPROVED':
    case 'AUTO_APPROVED_LOW_RISK':
      return 'success';
    case 'PENDING_HUMAN_GATE':
      return 'warn';
    case 'REJECTED':
      return 'danger';
    case 'SUPERSEDED':
      return 'neutral';
    default:
      return 'brand';
  }
}

function SupersededHistoryBox({
  stageId,
  snap,
  all,
}: {
  stageId: string;
  snap: SnapshotRecordDto;
  all: ReadonlyArray<SnapshotRecordDto>;
}) {
  const superseded = all.filter((s) => s.stageId === stageId && s.state === 'SUPERSEDED');
  if (superseded.length === 0) {
    return null;
  }
  return (
    <Callout
      tone="info"
      icon="git-branch"
      title={`版本演进与历史回退记录（共 ${superseded.length + 1} 个版本）`}
    >
      <Stack gap="tight">
        {superseded.map((old) => (
          <div key={old.snapshotId}>
            <Text variant="xs" as="strong">
              旧分支 [{old.branchId}] · {old.snapshotId}：
            </Text>
            <Text variant="xs" tone="secondary">
              {old.structuredSummary?.headline ?? old.artifactSummary}
            </Text>
          </div>
        ))}
        <div>
          <Text variant="xs" as="strong" tone="brand">
            当前活跃分支 [{snap.branchId}] · {snap.snapshotId}：
          </Text>
          <Text variant="xs">{snap.structuredSummary?.headline ?? snap.artifactSummary}</Text>
        </div>
      </Stack>
    </Callout>
  );
}

/** Agent 在做什么：直接由后端快照、关键决策与真实事件流驱动（无硬编码文案） */
export function AgentWorkActivity({
  stageId,
  snap,
  stageEvents = [],
}: {
  stageId: string;
  snap?: SnapshotRecordDto;
  stageEvents?: ReadonlyArray<WorkflowDomainEventDto>;
}) {
  const meta = stageMeta(stageId);
  if (!snap) {
    return (
      <EmptyState
        icon="clock"
        compact
        title={`${meta.agentDisplayName} — 等待上游确认`}
        description={`目标职责：${meta.stepGoal}。前序步骤确认通过后将自动接收上游契约开始执行。`}
      />
    );
  }

  const badge = stateBadge(snap.state, snap.cacheHit);
  const parsed = parseStageArtifact(snap.artifactType, snap.artifactDetails);
  const orderedEvents = [...stageEvents].reverse();
  const persona = personaFor(stageId);

  return (
    <Stack gap="normal">
      <Card
        title={
          <Inline>
            <AgentAvatar
              roleOrStage={stageId}
              size="md"
              mood={moodFromState(snap.state)}
              showMoodBadge
            />
            <div>
              <div>
                {persona.personName} · {meta.agentDisplayName}
              </div>
            </div>
            <StatusChip tone={statusToneForSnapshot(snap.state)} dot>
              {badge.label}
            </StatusChip>
          </Inline>
        }
        subtitle={`协同责任人: ${meta.specialistLabel} · 模型: ${snap.modelUsed}`}
      >
        <Stack gap="tight">
          <KeyValueList
            items={[
              { key: '快照标识', value: <code>{snap.snapshotId}</code> },
              { key: '所属分支', value: snap.branchId },
              { key: '核心结论', value: snap.structuredSummary?.headline ?? snap.artifactSummary },
              ...(parsed.agentRationale
                ? [{ key: 'Agent 自述', value: parsed.agentRationale }]
                : []),
            ]}
          />
        </Stack>
      </Card>

      {parsed.keyDecisions.length > 0 ? (
        <Stack gap="tight">
          <SectionLabel>关键权衡决策 (Key Decisions)</SectionLabel>
          {parsed.keyDecisions.map((kd, idx) => (
            <Card key={idx} inset title={kd.decision} subtitle={kd.rationale}>
              {kd.tradeoffs.length > 0 ? (
                <Inline wrap>
                  {kd.tradeoffs.map((t, i) => (
                    <StatusChip key={i} tone="neutral">
                      权衡: {t}
                    </StatusChip>
                  ))}
                </Inline>
              ) : null}
            </Card>
          ))}
        </Stack>
      ) : null}

      <Stack gap="tight">
        <SectionLabel>真实执行轨迹 ({orderedEvents.length} 条事件)</SectionLabel>
        {orderedEvents.length === 0 ? (
          <EmptyState
            icon="activity"
            compact
            title="暂无本步骤独立事件切片"
            description="该快照可能为语义缓存直接命中或持久化恢复历史快照，完整交付物详见交付审阅区。"
          />
        ) : (
          orderedEvents.map((ev) => (
            <Card
              key={ev.eventId}
              inset
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
                  <StatusChip tone="brand">{ev.lifecycleState}</StatusChip>
                </Inline>
              }
              subtitle={`${ev.agentRole} · ${ev.timestampIso} · 分支 ${ev.branchId}`}
            >
              {Object.keys(ev.detailPayload ?? {}).length > 0 ? (
                <KeyValueList
                  items={Object.entries(ev.detailPayload).map(([k, v]) => ({
                    key: k,
                    value: typeof v === 'string' ? v : JSON.stringify(v),
                  }))}
                />
              ) : null}
            </Card>
          ))
        )}
      </Stack>
    </Stack>
  );
}

/** 真实跨角色协商与版本演进展示（仅展示后端真实协商记录与快照自述） */
export function AgentDiscussion({
  stageId,
  snap,
  negotiationLogs,
  allSnapshots,
}: {
  stageId: string;
  snap?: SnapshotRecordDto;
  negotiationLogs: ReadonlyArray<NegotiationTurnDto>;
  allSnapshots: ReadonlyArray<SnapshotRecordDto>;
}) {
  if (!snap) {
    return (
      <EmptyState
        icon="message"
        compact
        title="本阶段尚未启动"
        description="待 Agent 执行后将在此展示后端记录的真实跨角色协商过程与决策依据。"
      />
    );
  }

  const parsed = parseStageArtifact(snap.artifactType, snap.artifactDetails);
  const relevantLogs = negotiationLogs.filter((turn) => {
    if (stageId === 'STAGE_2_PD') {
      return !turn.topic || turn.topic === 'DESIGN_REVIEW';
    }
    if (stageId === 'STAGE_4_QA') {
      return turn.topic === 'QA_REPAIR';
    }
    if (stageId === 'STAGE_1_PM') {
      return turn.topic === 'PRD_TRACKING_ALIGNMENT';
    }
    if (stageId === 'STAGE_3A_TECH_SPEC') {
      return turn.topic === 'TECH_SPEC_REVIEW';
    }
    return false;
  });

  const latestTurn = relevantLogs.length > 0 ? relevantLogs[relevantLogs.length - 1] : undefined;

  return (
    <Stack gap="normal">
      <SupersededHistoryBox stageId={stageId} snap={snap} all={allSnapshots} />

      {relevantLogs.length > 0 ? (
        <Stack gap="tight">
          {relevantLogs.map((turn) => {
            const challenger = personaFor(turn.challengerRole);
            const responder = personaFor(turn.responderRole);
            return (
              <Card
                key={turn.negotiationId}
                inset
                title={
                  <Inline className="m-between" wrap>
                    <Text variant="sm" as="strong">
                      第 {turn.turnIndex}/{turn.maxTurnsAllowed} 轮协商 · {challenger.personName} (
                      {challenger.codename}) ↔ {responder.personName} ({responder.codename})
                    </Text>
                    <StatusChip tone={turn.escalatedToSupervisor ? 'warn' : 'success'} dot>
                      {turn.escalatedToSupervisor
                        ? '达到上限 · 总管接管'
                        : turn.consensusReached
                          ? '已达成结构化共识'
                          : '继续对齐'}
                    </StatusChip>
                  </Inline>
                }
              >
                <div className="dialogue-thread">
                  <div className="dialogue-msg dialogue-msg-left">
                    <AgentAvatar
                      roleOrStage={turn.challengerRole}
                      size="sm"
                      mood="talking"
                      showSpeakingWaves
                    />
                    <div
                      className="dialogue-bubble dialogue-bubble-left"
                      style={{ borderColor: challenger.accentColor }}
                    >
                      <div className="dialogue-speaker">
                        <strong>{challenger.personName}</strong>
                        <span>质询 ({turn.challengerRole})</span>
                      </div>
                      <div className="dialogue-text">{turn.challengePoint}</div>
                    </div>
                  </div>

                  <div className="dialogue-msg dialogue-msg-right">
                    <div
                      className="dialogue-bubble dialogue-bubble-right"
                      style={{ borderColor: responder.accentColor }}
                    >
                      <div className="dialogue-speaker">
                        <strong>{responder.personName}</strong>
                        <span>响应 ({turn.responderRole})</span>
                      </div>
                      <div className="dialogue-text">{turn.responseResolution}</div>
                    </div>
                    <AgentAvatar
                      roleOrStage={turn.responderRole}
                      size="sm"
                      mood={turn.consensusReached ? 'celebrating' : 'working'}
                      showSpeakingWaves
                    />
                  </div>
                </div>
              </Card>
            );
          })}

          {latestTurn ? (
            <Callout
              tone={latestTurn.escalatedToSupervisor ? 'warn' : 'success'}
              title={
                <Inline>
                  <AgentAvatar roleOrStage="SUPERVISOR_AGENT" size="xs" mood="waiting" />
                  <span>
                    {latestTurn.escalatedToSupervisor
                      ? '协商超限熔断 · 林总管呈现 A/B 备选拍板方案'
                      : '协商结论归档'}
                  </span>
                </Inline>
              }
            >
              <div className="ab-compare-grid">
                <Card inset title="方案 A">
                  <Text variant="sm">{latestTurn.optionAProposal}</Text>
                </Card>
                <Card inset title="方案 B">
                  <Text variant="sm">{latestTurn.optionBProposal}</Text>
                </Card>
              </div>
            </Callout>
          ) : null}
        </Stack>
      ) : (
        <Callout tone="neutral" icon="info" title="本步骤无跨角色争议冲突 · 直接产出交付契约">
          <Stack gap="tight">
            <Text variant="sm">
              {snap.structuredSummary?.rationale ?? parsed.agentRationale ?? snap.artifactSummary}
            </Text>
            {parsed.keyDecisions.length > 0 ? (
              <KeyValueList
                items={parsed.keyDecisions.map((d) => ({
                  key: d.decision,
                  value: d.rationale,
                }))}
              />
            ) : null}
          </Stack>
        </Callout>
      )}
    </Stack>
  );
}
