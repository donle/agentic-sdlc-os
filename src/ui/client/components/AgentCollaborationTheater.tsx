/**
 * @file AgentCollaborationTheater.tsx
 * @description 拟人化 Agent 协同剧场与对话动画舞台：
 * 将真实后端事件流 (liveInteractionStream) 与跨岗位协商日志 (negotiationLogs)
 * 转化为可自动演播、可交互步进的拟人角色动画与对话气泡剧场。
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Inline, StatusChip, Text } from '../../kit/index.ts';
import { moodActionCue, moodFromState, personaFor, type AgentMood } from '../lib/agentPersona.ts';
import { formatRelativeTime, stageMeta, truncate } from '../lib/display.ts';
import type { DashboardStateDto, NegotiationTurnDto, WorkflowDomainEventDto } from '../types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';

function lifecycleBadgeLabel(lifecycleState: string): string {
  switch (lifecycleState) {
    case 'RECOGNIZING_INTENT':
      return '💭 意图识别';
    case 'EXECUTING':
      return '⚡ 执行生成';
    case 'CACHE_HIT':
      return '✨ 缓存复用';
    case 'NEGOTIATING':
      return '💬 跨岗协商';
    case 'RETRYING':
      return '🔄 自愈重试';
    case 'PENDING_HUMAN_GATE':
      return '🙋 等待人类拍板';
    case 'APPROVED':
      return '🎉 人工签核通过';
    case 'AUTO_APPROVED_LOW_RISK':
      return '🤖 低风险自动放行';
    case 'REJECTED':
      return '↩️ 驳回重做';
    case 'SUPERSEDED':
      return '🕘 历史归档';
    default:
      return lifecycleState;
  }
}

function renderPayloadHighlights(payload: Readonly<Record<string, unknown>>): ReadonlyArray<{
  key: string;
  label: string;
  tone: 'brand' | 'success' | 'warn' | 'danger' | 'neutral' | 'violet' | 'cyan';
}> {
  const chips: Array<{
    key: string;
    label: string;
    tone: 'brand' | 'success' | 'warn' | 'danger' | 'neutral' | 'violet' | 'cyan';
  }> = [];

  if (typeof payload.riskScore === 'number') {
    const score = payload.riskScore;
    chips.push({
      key: 'risk',
      label: `风险分 ${score}/100 (${String(payload.riskLevel ?? '')})`,
      tone: score >= 60 ? 'warn' : 'success',
    });
  }
  if (typeof payload.modelUsed === 'string' && payload.modelUsed) {
    chips.push({ key: 'model', label: `模型 ${payload.modelUsed}`, tone: 'cyan' });
  }
  if (payload.cacheHit === true) {
    chips.push({ key: 'cache', label: '⚡ 命中语义缓存', tone: 'cyan' });
  }
  if (typeof payload.verdict === 'string') {
    chips.push({
      key: 'verdict',
      label: `裁决：${payload.verdict}`,
      tone: payload.verdict === 'REJECT' ? 'danger' : 'success',
    });
  }
  if (typeof payload.tokensConsumed === 'number' && payload.tokensConsumed > 0) {
    chips.push({
      key: 'tokens',
      label: `消耗 ${payload.tokensConsumed.toLocaleString()} tokens`,
      tone: 'neutral',
    });
  }
  if (typeof payload.turnIndex === 'number' && typeof payload.maxTurnsAllowed === 'number') {
    chips.push({
      key: 'turn',
      label: `协商第 ${payload.turnIndex}/${payload.maxTurnsAllowed} 轮`,
      tone: 'violet',
    });
  }
  return chips;
}

function RoleDeskAnimation({ mood, propEmoji }: { mood: AgentMood; propEmoji: string }) {
  return (
    <div className={`theater-desk-prop theater-desk--${mood}`} aria-hidden="true">
      <span className="theater-prop-icon">{propEmoji}</span>
      {mood === 'working' || mood === 'retrying' ? (
        <span className="theater-typing-dots">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      {mood === 'thinking' ? <span className="theater-thought-cloud">💡</span> : null}
      {mood === 'waiting' ? <span className="theater-hand-wave">✋</span> : null}
      {mood === 'celebrating' ? <span className="theater-sparkle-burst">✨</span> : null}
      {mood === 'cache' ? <span className="theater-sparkle-burst">⚡</span> : null}
    </div>
  );
}

function NegotiationDramaStage({
  turns,
  activeTurnIdx,
  onSelectTurn,
  onFocusStage,
}: {
  turns: ReadonlyArray<NegotiationTurnDto>;
  activeTurnIdx: number;
  onSelectTurn: (idx: number) => void;
  onFocusStage: (stageId: string) => void;
}) {
  const safeIdx = Math.max(0, Math.min(activeTurnIdx, turns.length - 1));
  const turn = turns[safeIdx];
  if (!turn) {
    return null;
  }

  const leftPersona = personaFor(turn.challengerRole);
  const rightPersona = personaFor(turn.responderRole);
  const supervisor = personaFor('SUPERVISOR_AGENT');
  const stageToFocus =
    turn.topic === 'QA_REPAIR'
      ? 'STAGE_4_QA'
      : turn.topic === 'PRD_TRACKING_ALIGNMENT'
        ? 'STAGE_1_PM'
        : turn.topic === 'TECH_SPEC_REVIEW'
          ? 'STAGE_3A_TECH_SPEC'
          : 'STAGE_2_PD';

  return (
    <div className="theater-dialogue-stage" key={`${turn.negotiationId}-${safeIdx}`}>
      <div className="theater-dialogue-topbar">
        <Inline wrap>
          <StatusChip tone={turn.escalatedToSupervisor ? 'warn' : 'violet'} dot>
            {turn.escalatedToSupervisor
              ? `⛔ 第 ${turn.turnIndex}/${turn.maxTurnsAllowed} 轮协商未决 · 总管已介入`
              : `💬 跨角色对话实况 · 第 ${turn.turnIndex}/${turn.maxTurnsAllowed} 轮`}
          </StatusChip>
          {turns.map((item, idx) => (
            <button
              key={item.negotiationId + String(idx)}
              type="button"
              className={`theater-turn-pill ${idx === safeIdx ? 'active' : ''}`}
              onClick={() => onSelectTurn(idx)}
            >
              第 {item.turnIndex} 轮
            </button>
          ))}
        </Inline>
        <Button size="sm" variant="outline" onClick={() => onFocusStage(stageToFocus)}>
          查看完整协商与拍板 →
        </Button>
      </div>

      <div className="theater-versus-arena">
        {/* 左侧质询方角色 */}
        <div className="theater-character-col theater-character-left">
          <div className="theater-character-float">
            <AgentAvatar
              roleOrStage={turn.challengerRole}
              size="xl"
              mood="talking"
              showMoodBadge
              showSpeakingWaves
            />
          </div>
          <div className="theater-character-tag" style={{ borderColor: leftPersona.accentColor }}>
            <strong>{leftPersona.personName}</strong>
            <span>{leftPersona.codename} · 提出质询</span>
          </div>
          <div
            className="theater-speech-bubble theater-bubble-left"
            style={{ borderColor: leftPersona.accentColor }}
          >
            <div className="theater-bubble-label">🔍 质询焦点</div>
            <div className="theater-bubble-text">{turn.challengePoint}</div>
          </div>
        </div>

        {/* 中间交流脉冲桥 / 总管仲裁 */}
        <div className="theater-bridge-col">
          {turn.escalatedToSupervisor ? (
            <div className="theater-supervisor-swoop">
              <AgentAvatar roleOrStage="SUPERVISOR_AGENT" size="lg" mood="waiting" showMoodBadge />
              <div className="theater-supervisor-callout">
                <strong>{supervisor.personName} 接管</strong>
                <span>交由人工拍板 A/B</span>
              </div>
            </div>
          ) : (
            <div className="theater-spark-bridge" aria-hidden="true">
              <span className="theater-spark-line" />
              <span className="theater-spark-pill">
                {turn.consensusReached ? '🤝 达成共识' : '⇄ 观点碰撞'}
              </span>
              <span className="theater-spark-line" />
            </div>
          )}
        </div>

        {/* 右侧响应方角色 */}
        <div className="theater-character-col theater-character-right">
          <div className="theater-character-float theater-float-delayed">
            <AgentAvatar
              roleOrStage={turn.responderRole}
              size="xl"
              mood={turn.consensusReached ? 'celebrating' : 'working'}
              showMoodBadge
              showSpeakingWaves
            />
          </div>
          <div className="theater-character-tag" style={{ borderColor: rightPersona.accentColor }}>
            <strong>{rightPersona.personName}</strong>
            <span>{rightPersona.codename} · 响应方案</span>
          </div>
          <div
            className="theater-speech-bubble theater-bubble-right"
            style={{ borderColor: rightPersona.accentColor }}
          >
            <div className="theater-bubble-label">💡 响应对策</div>
            <div className="theater-bubble-text">{turn.responseResolution}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentCollaborationTheater({
  state,
  events,
  cursor,
  onCursorChange,
  onFocusStage,
}: {
  state: DashboardStateDto;
  events: ReadonlyArray<WorkflowDomainEventDto>;
  cursor: number;
  onCursorChange: (index: number) => void;
  onFocusStage: (stageId: string) => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState<2800 | 1700>(2800);
  const [viewMode, setViewMode] = useState<'story' | 'negotiation'>('story');
  const [negotiationIdx, setNegotiationIdx] = useState(0);

  const negotiationLogs = state.negotiationLogs ?? [];
  const hasNegotiations = negotiationLogs.length > 0;
  const safeCursor = events.length > 0 ? Math.max(0, Math.min(cursor, events.length - 1)) : 0;
  const currentEvent = events[safeCursor];
  const prevEvent = safeCursor > 0 ? events[safeCursor - 1] : undefined;

  useEffect(() => {
    setIsPlaying(false);
  }, [state.run?.runId, state.run?.activeBranchId]);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }
    const timer = window.setInterval(() => {
      if (viewMode === 'negotiation' && hasNegotiations) {
        setNegotiationIdx((prev) => {
          if (prev + 1 >= negotiationLogs.length) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
        return;
      }
      if (events.length === 0) {
        setIsPlaying(false);
        return;
      }
      if (safeCursor + 1 >= events.length) {
        setIsPlaying(false);
        return;
      }
      onCursorChange(safeCursor + 1);
    }, speedMs);

    return () => window.clearInterval(timer);
  }, [
    isPlaying,
    speedMs,
    viewMode,
    hasNegotiations,
    negotiationLogs.length,
    events.length,
    safeCursor,
    onCursorChange,
  ]);

  const stageOrder = state.stagePipelineOrder ?? [];
  const activeSnapshots = useMemo(() => {
    const branchId = state.run?.activeBranchId;
    return (state.run?.snapshots ?? []).filter(
      (s) => s.branchId === branchId && s.state !== 'SUPERSEDED',
    );
  }, [state.run]);

  if (events.length === 0 && !hasNegotiations) {
    return null;
  }

  const currentPersona = currentEvent
    ? personaFor(currentEvent.agentRole || currentEvent.stageId)
    : personaFor('SUPERVISOR_AGENT');
  const currentMood = currentEvent ? moodFromState(currentEvent.lifecycleState) : 'idle';
  const currentMeta = currentEvent ? stageMeta(currentEvent.stageId) : null;
  const isHandoffTransition = Boolean(
    prevEvent && currentEvent && prevEvent.stageId !== currentEvent.stageId,
  );
  const prevPersona = prevEvent ? personaFor(prevEvent.agentRole || prevEvent.stageId) : null;
  const payloadChips = currentEvent
    ? renderPayloadHighlights(currentEvent.detailPayload ?? {})
    : [];

  const handleReplay = () => {
    if (viewMode === 'negotiation' && hasNegotiations) {
      setNegotiationIdx(0);
      setIsPlaying(true);
      return;
    }
    onCursorChange(0);
    setIsPlaying(true);
  };

  return (
    <section className="collaboration-theater" aria-label="Agent 拟人协同动画剧场">
      {/* 剧场顶部控制栏 */}
      <div className="theater-header-bar">
        <div className="theater-title-group">
          <span className="theater-live-dot" aria-hidden="true" />
          <div>
            <div className="theater-title">多 Agent 拟人协同动画剧场</div>
            <div className="theater-subtitle">
              实时演绎岗位角色思考、产物交接与跨岗位协商对话全过程
            </div>
          </div>
        </div>

        <div className="theater-controls">
          {hasNegotiations ? (
            <div className="theater-mode-switch" role="tablist" aria-label="剧场模式">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'story'}
                className={`theater-mode-btn ${viewMode === 'story' ? 'active' : ''}`}
                onClick={() => setViewMode('story')}
              >
                🎬 全链路演播 ({events.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'negotiation'}
                className={`theater-mode-btn ${viewMode === 'negotiation' ? 'active' : ''}`}
                onClick={() => setViewMode('negotiation')}
              >
                💬 协商对话秀 ({negotiationLogs.length} 轮)
              </button>
            </div>
          ) : null}

          <div className="theater-playback-group">
            <Button
              size="sm"
              variant={isPlaying ? 'violet' : 'primary'}
              onClick={() => {
                if (!isPlaying && viewMode === 'story' && safeCursor >= events.length - 1) {
                  onCursorChange(0);
                }
                if (
                  !isPlaying &&
                  viewMode === 'negotiation' &&
                  negotiationIdx >= negotiationLogs.length - 1
                ) {
                  setNegotiationIdx(0);
                }
                setIsPlaying((p) => !p);
              }}
            >
              {isPlaying ? '⏸ 暂停演播' : '▶ 自动演播'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleReplay}>
              🔄 从头重播
            </Button>
            <button
              type="button"
              className="theater-speed-btn"
              onClick={() => setSpeedMs((s) => (s === 2800 ? 1700 : 2800))}
              title="切换演播速度"
            >
              {speedMs === 2800 ? '1.0x' : '1.6x'}
            </button>
          </div>
        </div>
      </div>

      {/* 岗位角色接力队列（显示全团队形象与当前高亮角色） */}
      <div className="theater-squad-strip">
        {stageOrder.map((sid, idx) => {
          const persona = personaFor(sid);
          const snap = activeSnapshots.find((s) => s.stageId === sid);
          const isCurrent =
            viewMode === 'story' && currentEvent ? currentEvent.stageId === sid : false;
          const mood: AgentMood = isCurrent
            ? currentMood
            : snap
              ? moodFromState(snap.state)
              : 'idle';
          const reached = Boolean(snap);
          return (
            <div key={sid} className="theater-squad-slot">
              {idx > 0 ? (
                <div className={`theater-squad-connector ${reached ? 'reached' : ''}`}>
                  <span className="theater-packet-dot" />
                </div>
              ) : null}
              <button
                type="button"
                className={`theater-squad-member ${isCurrent ? 'is-active' : ''} ${reached ? 'is-reached' : ''}`}
                onClick={() => onFocusStage(sid)}
                title={`点击审阅 ${persona.personName} (${persona.codename}) 的工作区`}
              >
                <AgentAvatar
                  roleOrStage={sid}
                  size="sm"
                  mood={mood}
                  showMoodBadge={isCurrent || mood === 'waiting'}
                  showSpeakingWaves={isCurrent && (mood === 'talking' || mood === 'working')}
                />
                <span className="theater-squad-name">{persona.personName}</span>
                <span className="theater-squad-role">{persona.codename}</span>
              </button>
            </div>
          );
        })}
      </div>

      {/* 核心舞台：剧情演播 OR 跨岗位协商对谈 */}
      {viewMode === 'negotiation' && hasNegotiations ? (
        <NegotiationDramaStage
          turns={negotiationLogs}
          activeTurnIdx={negotiationIdx}
          onSelectTurn={(idx) => {
            setIsPlaying(false);
            setNegotiationIdx(idx);
          }}
          onFocusStage={onFocusStage}
        />
      ) : currentEvent ? (
        <div
          className={`theater-story-stage theater-stage-mood--${currentMood}`}
          key={currentEvent.eventId + String(safeCursor)}
        >
          {/* 交接过渡动画横幅 */}
          {isHandoffTransition && prevPersona ? (
            <div className="theater-handoff-banner">
              <span className="theater-handoff-actor">
                <AgentAvatar roleOrStage={prevPersona.role} size="xs" mood="celebrating" />
                <span>{prevPersona.personName}</span>
              </span>
              <span className="theater-handoff-track" aria-hidden="true">
                <span className="theater-handoff-capsule">
                  {prevPersona.propEmoji} 交接 {prevPersona.handoffLabel}
                </span>
              </span>
              <span className="theater-handoff-actor">
                <AgentAvatar roleOrStage={currentPersona.role} size="xs" mood={currentMood} />
                <span>{currentPersona.personName} 接棒</span>
              </span>
            </div>
          ) : null}

          <div className="theater-actor-spotlight">
            <div className="theater-actor-stage-left">
              <div className="theater-character-float">
                <AgentAvatar
                  roleOrStage={currentEvent.agentRole || currentEvent.stageId}
                  size="xl"
                  mood={currentMood}
                  showMoodBadge
                  showSpeakingWaves={
                    currentMood === 'talking' ||
                    currentMood === 'working' ||
                    currentMood === 'waiting'
                  }
                />
                <RoleDeskAnimation mood={currentMood} propEmoji={currentPersona.propEmoji} />
              </div>
              <div
                className="theater-character-tag"
                style={{ borderColor: currentPersona.accentColor }}
              >
                <strong>{currentPersona.personName}</strong>
                <span>{currentPersona.roleTitle}</span>
              </div>
            </div>

            <div className="theater-actor-stage-right">
              <div
                className="theater-speech-bubble theater-speech-main"
                style={{ borderColor: currentPersona.accentColor }}
              >
                <div className="theater-bubble-header">
                  <Inline wrap>
                    <StatusChip tone="brand">
                      {currentMeta ? currentMeta.shortName : currentEvent.stageId}
                    </StatusChip>
                    <StatusChip
                      tone={
                        currentMood === 'waiting'
                          ? 'warn'
                          : currentMood === 'alert'
                            ? 'danger'
                            : currentMood === 'celebrating'
                              ? 'success'
                              : 'violet'
                      }
                      dot
                    >
                      {lifecycleBadgeLabel(currentEvent.lifecycleState)}
                    </StatusChip>
                    <Text variant="xs" tone="tertiary">
                      {moodActionCue(currentMood)}
                    </Text>
                  </Inline>
                  <Text variant="xs" tone="tertiary">
                    {formatRelativeTime(currentEvent.timestampIso)}
                  </Text>
                </div>

                <div className="theater-bubble-headline">{currentEvent.headline}</div>

                {payloadChips.length > 0 ? (
                  <div className="theater-payload-chips">
                    {payloadChips.map((chip) => (
                      <StatusChip key={chip.key} tone={chip.tone}>
                        {chip.label}
                      </StatusChip>
                    ))}
                  </div>
                ) : null}

                <div className="theater-bubble-footer">
                  <Text variant="xs" tone="secondary">
                    分支 <code>{currentEvent.branchId}</code> · 进度 {safeCursor + 1}/
                    {events.length}
                  </Text>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onFocusStage(currentEvent.stageId)}
                  >
                    打开 {currentPersona.personName} 的工作台 →
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* 底部快速时间轴导航 */}
          <div className="theater-scrubber">
            <button
              type="button"
              className="step-viewer-nav"
              disabled={safeCursor === 0}
              onClick={() => {
                setIsPlaying(false);
                onCursorChange(safeCursor - 1);
              }}
              aria-label="上一步动作"
            >
              ‹ 上一步
            </button>
            <div className="theater-scrubber-dots">
              {events.map((ev, idx) => {
                const p = personaFor(ev.agentRole || ev.stageId);
                return (
                  <button
                    key={ev.eventId + String(idx)}
                    type="button"
                    className={`theater-scrubber-dot ${idx === safeCursor ? 'current' : ''} ${idx < safeCursor ? 'passed' : ''}`}
                    style={{ '--dot-accent': p.accentColor } as React.CSSProperties}
                    title={`${p.personName} · ${truncate(ev.headline, 48)}`}
                    onClick={() => {
                      setIsPlaying(false);
                      onCursorChange(idx);
                    }}
                  />
                );
              })}
            </div>
            <button
              type="button"
              className="step-viewer-nav"
              disabled={safeCursor >= events.length - 1}
              onClick={() => {
                setIsPlaying(false);
                onCursorChange(safeCursor + 1);
              }}
              aria-label="下一步动作"
            >
              下一步 ›
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
