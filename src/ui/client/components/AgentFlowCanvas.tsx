/**
 * @file AgentFlowCanvas.tsx
 * @description 拟人化 Agent 协同流程图（v3 插图角色 + 动态数据包流动 + 对话气泡 + 总管雷达连线）：
 * 保留 L1/L2 视角密度分层与 stageOrder 自适应宽度，让每个岗位节点以真实角色形象与动画状态呈现在流程脊柱上。
 */

import { moodFromState, personaFor } from '../lib/agentPersona.ts';
import { SVG_STAGE_LABELS } from '../lib/display.ts';
import type { PerspectiveState } from '../lib/perspective.ts';
import type { FlowNegotiationHint, FlowNodeInput } from '../types.ts';

const ROW_Y = 172;
const VIEW_HEIGHT = 332;
const NODE_HEIGHT = 104;
const AVATAR_R = 20;

const STATE_BADGE_TEXT: Record<string, string> = {
  APPROVED: '✓ 已通过签核',
  AUTO_APPROVED_LOW_RISK: '🤖 自动放行 · 已留痕',
  PENDING_HUMAN_GATE: '⏳ 等待人工审核',
  REJECTED: '↩ 已打回重做',
  SUPERSEDED: '🕘 历史旧版',
};

function shortSpeechForNode(input: FlowNodeInput, stepFocus: boolean): string | null {
  const snap = input.activeBranchSnapshot;
  if (input.hasPendingGateNotification || snap?.state === 'PENDING_HUMAN_GATE') {
    return '🙋 请您拍板!';
  }
  if (snap?.state === 'REJECTED') {
    return '↩️ 待重做调整';
  }
  if (stepFocus && snap) {
    const mood = moodFromState(snap.state);
    if (mood === 'celebrating') {
      return snap.cacheHit ? '✨ 复用秒过!' : '🎉 交付就绪';
    }
    return '⚡ 当前聚焦';
  }
  return null;
}

function StageNode({
  input,
  x,
  y,
  nodeWidth,
  stepFocus,
  isL1Summary,
  clipId,
  onNodeClick,
}: {
  input: FlowNodeInput;
  x: number;
  y: number;
  nodeWidth: number;
  stepFocus: boolean;
  isL1Summary: boolean;
  clipId: string;
  onNodeClick: (stageId: string) => void;
}) {
  const label = SVG_STAGE_LABELS[input.stageId] ?? {
    stepTag: input.stageId.replace('STAGE_', ''),
    shortLabel: input.stageId,
    emoji: '🤖',
  };
  const persona = personaFor(input.stageId);
  const snap = input.activeBranchSnapshot;
  const stateClass = snap ? `state-${snap.state.toLowerCase()}` : 'state-idle';
  const rawBadgeText = snap ? (STATE_BADGE_TEXT[snap.state] ?? snap.state) : '◌ 待启动';
  const badgeText = isL1Summary && snap ? `L1 · ${rawBadgeText}` : rawBadgeText;
  const centerX = x + nodeWidth / 2;
  const avatarCy = y + 28;
  const speech = shortSpeechForNode(input, stepFocus);

  return (
    <g
      className={`flow-node ${stateClass} ${isL1Summary ? 'node-l1-summary' : ''} ${input.hasPendingGateNotification ? 'gate-hovering' : ''} ${stepFocus ? 'node-step-focus' : ''}`}
      data-stage-id={input.stageId}
      data-density={isL1Summary ? 'L1' : 'L2'}
      onClick={() => onNodeClick(input.stageId)}
    >
      {/* 节点上方拟人对话小气泡 */}
      {speech ? (
        <g className="flow-speech-bubble">
          <rect
            className="flow-speech-bubble-box"
            x={centerX - 48}
            y={y - 31}
            rx={10}
            width={96}
            height={22}
            style={{ stroke: persona.accentColor }}
          />
          <polygon
            className="flow-speech-bubble-tail"
            points={`${centerX - 5},${y - 10} ${centerX + 5},${y - 10} ${centerX},${y - 4}`}
          />
          <text className="flow-speech-bubble-text" x={centerX} y={y - 16} textAnchor="middle">
            {speech}
          </text>
        </g>
      ) : null}

      <rect className="flow-node-box" x={x} y={y} rx={15} width={nodeWidth} height={NODE_HEIGHT} />

      {/* 左上角步骤徽标 */}
      <rect className="flow-step-pill" x={x + 8} y={y + 8} rx={6} width={48} height={16} />
      <text className="flow-step-pill-text" x={x + 32} y={y + 19} textAnchor="middle">
        {label.stepTag}
      </text>

      {/* 右上角角色人物专长缩写 */}
      {!isL1Summary ? (
        <text
          className="flow-node-person-tag"
          x={x + nodeWidth - 10}
          y={y + 19}
          textAnchor="end"
          style={{ fill: persona.accentColor }}
        >
          {persona.personName}
        </text>
      ) : null}

      {/* 拟人插图圆形头像 */}
      <g
        className={`flow-node-avatar-group ${stepFocus || input.hasPendingGateNotification ? 'avatar-bobbing' : ''}`}
      >
        <circle
          cx={centerX}
          cy={avatarCy}
          r={AVATAR_R + 3}
          fill={persona.softBg}
          stroke={persona.accentColor}
          strokeWidth={snap ? 2 : 1.2}
          strokeDasharray={snap ? undefined : '3 2'}
        />
        <image
          href={persona.avatarSrc}
          x={centerX - AVATAR_R}
          y={avatarCy - AVATAR_R}
          width={AVATAR_R * 2}
          height={AVATAR_R * 2}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="xMidYMid slice"
          opacity={snap?.state === 'SUPERSEDED' ? 0.55 : 1}
        />
      </g>

      <text className="flow-node-title" x={centerX} y={y + 68} textAnchor="middle">
        {label.shortLabel}
      </text>
      <text className="flow-node-status" x={centerX} y={y + 87} textAnchor="middle">
        {badgeText}
      </text>

      {snap?.cacheHit && !isL1Summary ? (
        <text
          className="flow-cache-badge"
          x={x + nodeWidth - 14}
          y={y + NODE_HEIGHT + 15}
          textAnchor="middle"
        >
          ⚡缓存复用
        </text>
      ) : null}
      {input.supersededVersionCount > 0 ? (
        <text
          className="flow-superseded-badge"
          x={x + 22}
          y={y + NODE_HEIGHT + 15}
          textAnchor="middle"
        >
          🕘 回退 x{input.supersededVersionCount}
        </text>
      ) : null}
      {input.rejectedCount > 0 ? (
        <text
          className="flow-rejected-badge"
          x={centerX}
          y={y + NODE_HEIGHT + 28}
          textAnchor="middle"
        >
          ↩️ 被驳回 x{input.rejectedCount}
        </text>
      ) : null}
    </g>
  );
}

export function AgentFlowCanvas({
  stageOrder,
  inputs,
  negotiation,
  hasRollbackFork,
  stepFocusStageId,
  activeBranchId,
  branchCount,
  perspective,
  onNodeClick,
}: {
  stageOrder: ReadonlyArray<string>;
  inputs: ReadonlyArray<FlowNodeInput>;
  negotiation: FlowNegotiationHint | null;
  hasRollbackFork: boolean;
  stepFocusStageId: string | null;
  activeBranchId: string;
  branchCount: number;
  perspective?: PerspectiveState;
  onNodeClick: (stageId: string) => void;
}) {
  const count = Math.max(1, stageOrder.length);
  const nodeWidth = count <= 4 ? 204 : count <= 6 ? 156 : 138;
  const gap = count > 1 ? 30 : 0;
  const sidePad = 24;
  const viewWidth = Math.max(960, sidePad * 2 + count * nodeWidth + (count - 1) * gap);

  const supervisorPersona = personaFor('SUPERVISOR_AGENT');

  const pmIndex = stageOrder.indexOf('STAGE_1_PM');
  const pdIndex = stageOrder.indexOf('STAGE_2_PD');
  const pmX =
    pmIndex >= 0 ? sidePad + pmIndex * (nodeWidth + gap) + nodeWidth / 2 : sidePad + nodeWidth / 2;
  const pdX =
    pdIndex >= 0
      ? sidePad + pdIndex * (nodeWidth + gap) + nodeWidth / 2
      : sidePad + nodeWidth + gap + nodeWidth / 2;
  const arcY = ROW_Y - 52;
  const negotiationVisible =
    negotiation !== null &&
    pmIndex >= 0 &&
    pdIndex >= 0 &&
    inputs.some((i) => i.stageId === 'STAGE_1_PM' && i.activeBranchSnapshot);

  // 总管雷达连接目标：优先连向待人工确认节点或当前聚焦节点
  const targetStageIndex = (() => {
    const pendingIdx = stageOrder.findIndex((sid) =>
      inputs.some((i) => i.stageId === sid && i.hasPendingGateNotification),
    );
    if (pendingIdx >= 0) {
      return pendingIdx;
    }
    const focusIdx = stepFocusStageId ? stageOrder.indexOf(stepFocusStageId) : -1;
    return focusIdx;
  })();

  const targetNodeX =
    targetStageIndex >= 0
      ? sidePad + targetStageIndex * (nodeWidth + gap) + nodeWidth / 2
      : viewWidth / 2;

  return (
    <div className="agent-flow-canvas-wrap">
      <svg
        className="agent-flow-svg"
        viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Agent 协同流程画布"
      >
        <defs>
          <marker id="flowArrow" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" />
          </marker>
          <clipPath id="clip-supervisor">
            <circle cx={viewWidth / 2 - 110} cy={47} r={20} />
          </clipPath>
          {stageOrder.map((stageId, index) => {
            const x = sidePad + index * (nodeWidth + gap);
            const cx = x + nodeWidth / 2;
            const cy = ROW_Y + 28;
            return (
              <clipPath key={stageId} id={`clip-stage-${index}`}>
                <circle cx={cx} cy={cy} r={AVATAR_R} />
              </clipPath>
            );
          })}
        </defs>

        {/* 总管 Agent · 调度塔台 */}
        <g className={`flow-supervisor ${hasRollbackFork ? 'supervisor-engaged' : ''}`}>
          <path
            className="flow-supervisor-tether"
            d={`M ${viewWidth / 2} 78 Q ${viewWidth / 2} 118, ${targetNodeX} ${ROW_Y - 12}`}
            fill="none"
          />
          {targetStageIndex >= 0 ? (
            <circle className="flow-supervisor-pulse-orb" r={4}>
              <animateMotion
                dur="2.2s"
                repeatCount="indefinite"
                path={`M ${viewWidth / 2} 78 Q ${viewWidth / 2} 118, ${targetNodeX} ${ROW_Y - 12}`}
              />
            </circle>
          ) : null}

          <rect
            className="flow-supervisor-box"
            x={(viewWidth - 300) / 2}
            y={14}
            rx={16}
            width={300}
            height={64}
          />
          <circle
            cx={viewWidth / 2 - 110}
            cy={47}
            r={23}
            fill={supervisorPersona.softBg}
            stroke={supervisorPersona.accentColor}
            strokeWidth={2}
          />
          <image
            href={supervisorPersona.avatarSrc}
            x={viewWidth / 2 - 130}
            y={27}
            width={40}
            height={40}
            clipPath="url(#clip-supervisor)"
            preserveAspectRatio="xMidYMid slice"
          />
          <text className="flow-supervisor-title" x={viewWidth / 2 + 16} y={40} textAnchor="middle">
            {supervisorPersona.personName} · 总管调度官
          </text>
          <text
            className="flow-supervisor-subtitle"
            x={viewWidth / 2 + 16}
            y={59}
            textAnchor="middle"
          >
            监听全链路 · 冲突仲裁 · DAG 分叉回退
          </text>
          <g className="flow-fork-badge" style={{ display: hasRollbackFork ? '' : 'none' }}>
            <rect
              className="flow-fork-badge-box"
              x={viewWidth / 2 + 162}
              y={31}
              rx={9}
              width={118}
              height={26}
            />
            <text
              className="flow-fork-badge-text"
              x={viewWidth / 2 + 221}
              y={48}
              textAnchor="middle"
            >
              ⎇ 已分叉回退
            </text>
          </g>
        </g>

        {/* 各岗位 Agent 工作站节点 + 动态交接传送粒子 */}
        {stageOrder.map((stageId, index) => {
          const x = sidePad + index * (nodeWidth + gap);
          const input = inputs.find((i) => i.stageId === stageId);
          const prevInput = index > 0 ? inputs[index - 1] : undefined;
          const reached = Boolean(input?.activeBranchSnapshot);
          const prevDone = Boolean(prevInput?.activeBranchSnapshot);
          const isL1Summary = perspective ? perspective.getStageDensity(stageId) === 'L1' : false;
          const edgeStartX = x - gap;
          const edgeEndX = x;
          const edgeY = ROW_Y + NODE_HEIGHT / 2;
          const edgePersona = index > 0 ? personaFor(stageOrder[index - 1]) : null;

          return (
            <g key={stageId}>
              {index > 0 ? (
                <g>
                  <line
                    className={`flow-edge ${reached || prevDone ? 'flow-edge-active' : ''}`}
                    x1={edgeStartX}
                    y1={edgeY}
                    x2={edgeEndX}
                    y2={edgeY}
                    markerEnd="url(#flowArrow)"
                  />
                  {reached || prevDone ? (
                    <circle
                      className="flow-packet-orb"
                      r={4.2}
                      fill={edgePersona?.accentColor ?? '#2f54eb'}
                    >
                      <animateMotion
                        dur="1.7s"
                        repeatCount="indefinite"
                        path={`M ${edgeStartX + 2} ${edgeY} L ${edgeEndX - 4} ${edgeY}`}
                      />
                    </circle>
                  ) : null}
                </g>
              ) : null}
              <StageNode
                input={
                  input ?? {
                    stageId,
                    activeBranchSnapshot: null,
                    supersededVersionCount: 0,
                    rejectedCount: 0,
                    hasPendingGateNotification: false,
                  }
                }
                x={x}
                y={ROW_Y}
                nodeWidth={nodeWidth}
                stepFocus={stageId === stepFocusStageId}
                isL1Summary={isL1Summary}
                clipId={`clip-stage-${index}`}
                onNodeClick={onNodeClick}
              />
            </g>
          );
        })}

        {/* PM ↔ PD 跨岗位协商弧线与动态信使光点 */}
        {negotiationVisible && negotiation ? (
          <g className={`flow-negotiation ${negotiation.escalated ? 'negotiation-escalated' : ''}`}>
            <path
              className="flow-negotiation-path"
              d={`M ${pmX} ${ROW_Y - 6} C ${pmX} ${arcY}, ${pdX} ${arcY}, ${pdX} ${ROW_Y - 6}`}
              markerEnd="url(#flowArrow)"
            />
            <circle r={4} className="flow-negotiation-orb">
              <animateMotion
                dur="1.4s"
                repeatCount="indefinite"
                path={`M ${pmX} ${ROW_Y - 6} C ${pmX} ${arcY}, ${pdX} ${arcY}, ${pdX} ${ROW_Y - 6}`}
              />
            </circle>
            <rect
              className="flow-negotiation-label-box"
              x={(pmX + pdX) / 2 - 110}
              y={arcY - 14}
              rx={9}
              width={220}
              height={24}
            />
            <text
              className="flow-negotiation-label"
              x={(pmX + pdX) / 2}
              y={arcY + 2}
              textAnchor="middle"
            >
              {negotiation.escalated
                ? `⛔ 协商熔断 (${negotiation.turnIndex}/${negotiation.maxTurnsAllowed} 轮) → 总管接管`
                : `💬 陈工 ↔ 林工 协商第 ${negotiation.turnIndex}/${negotiation.maxTurnsAllowed} 轮`}
            </text>
          </g>
        ) : null}
      </svg>
      <div className="flow-canvas-hint">
        🎭 岗位角色在岗协同中 · 流动光点表示契约交接 ·
        {hasRollbackFork
          ? ` 项目已产生 ${branchCount} 条版本分支，当前正在查看【${activeBranchId}】`
          : ' 点击任意岗位角色卡片打开交付审阅台'}
      </div>
    </div>
  );
}
