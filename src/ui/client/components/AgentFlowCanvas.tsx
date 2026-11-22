/**
 * @file AgentFlowCanvas.tsx
 * @description Agent 协同流程图（SVG 声明式渲染）：阶段节点按快照状态着色，
 * 业务事件徽标（🕘回退更新 / ↩️被驳回 / ⚡缓存复用）、PM↔PD 协商弧线、
 * 总管分叉徽标与步骤查看器联动高亮。节点可点击就地打开阶段操作台。
 */

import type { FlowNegotiationHint, FlowNodeInput } from '../types.ts';
import { SVG_STAGE_LABELS } from '../lib/display.ts';

const VIEW_WIDTH = 1080;
const VIEW_HEIGHT = 284;
const NODE_WIDTH = 152;
const NODE_HEIGHT = 78;
const ROW_Y = 168;
const GAP = (VIEW_WIDTH - 40 - 6 * NODE_WIDTH) / 5;

const STATE_BADGE_TEXT: Record<string, string> = {
  APPROVED: '✓ 已通过签核',
  AUTO_APPROVED_LOW_RISK: '🤖 自动放行 · 已留痕',
  PENDING_HUMAN_GATE: '⏳ 等待人工审核',
  REJECTED: '↩ 已打回重做',
  SUPERSEDED: '🕘 历史旧版',
};

function StageNode({
  input,
  x,
  y,
  stepFocus,
  onNodeClick,
}: {
  input: FlowNodeInput;
  x: number;
  y: number;
  stepFocus: boolean;
  onNodeClick: (stageId: string) => void;
}) {
  const label = SVG_STAGE_LABELS[input.stageId] ?? {
    stepTag: input.stageId,
    shortLabel: input.stageId,
    emoji: '🤖',
  };
  const snap = input.activeBranchSnapshot;
  const stateClass = snap ? `state-${snap.state.toLowerCase()}` : 'state-idle';
  const badgeText = snap ? (STATE_BADGE_TEXT[snap.state] ?? snap.state) : '◌ 待启动';
  const centerX = x + NODE_WIDTH / 2;

  return (
    <g
      className={`flow-node ${stateClass} ${input.hasPendingGateNotification ? 'gate-hovering' : ''} ${stepFocus ? 'node-step-focus' : ''}`}
      data-stage-id={input.stageId}
      onClick={() => onNodeClick(input.stageId)}
    >
      <rect className="flow-node-box" x={x} y={y} rx={13} width={NODE_WIDTH} height={NODE_HEIGHT} />
      <rect className="flow-step-pill" x={x + 10} y={y + 9} rx={7} width={52} height={17} />
      <text className="flow-step-pill-text" x={x + 36} y={y + 21} textAnchor="middle">
        {label.stepTag}
      </text>
      <text className="flow-node-emoji" x={x + NODE_WIDTH - 18} y={y + 22} textAnchor="middle">
        {label.emoji}
      </text>
      <text className="flow-node-title" x={centerX} y={y + 45} textAnchor="middle">
        {label.shortLabel}
      </text>
      <text className="flow-node-status" x={centerX} y={y + 63} textAnchor="middle">
        {badgeText}
      </text>
      {snap?.cacheHit ? (
        <text
          className="flow-cache-badge"
          x={x + NODE_WIDTH - 14}
          y={y + NODE_HEIGHT + 12}
          textAnchor="middle"
        >
          ⚡缓存复用
        </text>
      ) : null}
      {input.supersededVersionCount > 0 ? (
        <text
          className="flow-superseded-badge"
          x={x + 14}
          y={y + NODE_HEIGHT + 12}
          textAnchor="middle"
        >
          🕘 回退更新 x{input.supersededVersionCount}
        </text>
      ) : null}
      {input.rejectedCount > 0 ? (
        <text
          className="flow-rejected-badge"
          x={centerX}
          y={y + NODE_HEIGHT + 24}
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
  onNodeClick,
}: {
  stageOrder: ReadonlyArray<string>;
  inputs: ReadonlyArray<FlowNodeInput>;
  negotiation: FlowNegotiationHint | null;
  hasRollbackFork: boolean;
  stepFocusStageId: string | null;
  activeBranchId: string;
  branchCount: number;
  onNodeClick: (stageId: string) => void;
}) {
  const pmX = 20 + NODE_WIDTH / 2;
  const pdX = 20 + (NODE_WIDTH + GAP) + NODE_WIDTH / 2;
  const arcY = ROW_Y - 26;
  const negotiationVisible =
    negotiation !== null &&
    inputs.some((i) => i.stageId === 'STAGE_1_PM' && i.activeBranchSnapshot);

  return (
    <div className="agent-flow-canvas-wrap">
      <svg
        className="agent-flow-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Agent 协同流程画布"
      >
        <defs>
          <marker id="flowArrow" markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>

        <g className={`flow-supervisor ${hasRollbackFork ? 'supervisor-engaged' : ''}`}>
          <rect
            className="flow-supervisor-box"
            x={(VIEW_WIDTH - 260) / 2}
            y={18}
            rx={14}
            width={260}
            height={58}
          />
          <text className="flow-supervisor-title" x={VIEW_WIDTH / 2} y={43} textAnchor="middle">
            🧭 总管 Agent · PMO 调度官
          </text>
          <text className="flow-supervisor-subtitle" x={VIEW_WIDTH / 2} y={62} textAnchor="middle">
            监听全链路 · 冲突接管 · 对话式 DAG 回退
          </text>
          <line
            className="flow-supervisor-tether"
            x1={VIEW_WIDTH / 2}
            y1={76}
            x2={VIEW_WIDTH / 2}
            y2={ROW_Y - 6}
          />
          <g className="flow-fork-badge" style={{ display: hasRollbackFork ? '' : 'none' }}>
            <rect
              className="flow-fork-badge-box"
              x={VIEW_WIDTH / 2 + 140}
              y={28}
              rx={9}
              width={118}
              height={26}
            />
            <text
              className="flow-fork-badge-text"
              x={VIEW_WIDTH / 2 + 199}
              y={45}
              textAnchor="middle"
            >
              ⎇ 已分叉回退
            </text>
          </g>
        </g>

        {stageOrder.map((stageId, index) => {
          const x = 20 + index * (NODE_WIDTH + GAP);
          const input = inputs.find((i) => i.stageId === stageId);
          const reached = Boolean(inputs[index + 1]?.activeBranchSnapshot);
          return (
            <g key={stageId}>
              {index > 0 ? (
                <line
                  className={`flow-edge ${reached ? 'flow-edge-active' : ''}`}
                  x1={x - GAP}
                  y1={ROW_Y + NODE_HEIGHT / 2}
                  x2={x}
                  y2={ROW_Y + NODE_HEIGHT / 2}
                  markerEnd="url(#flowArrow)"
                />
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
                stepFocus={stageId === stepFocusStageId}
                onNodeClick={onNodeClick}
              />
            </g>
          );
        })}

        {negotiationVisible && negotiation ? (
          <g className={`flow-negotiation ${negotiation.escalated ? 'negotiation-escalated' : ''}`}>
            <path
              className="flow-negotiation-path"
              d={`M ${pmX} ${ROW_Y - 4} C ${pmX} ${arcY}, ${pdX} ${arcY}, ${pdX} ${ROW_Y - 4}`}
              markerEnd="url(#flowArrow)"
            />
            <rect
              className="flow-negotiation-label-box"
              x={(pmX + pdX) / 2 - 100}
              y={arcY - 15}
              rx={8}
              width={200}
              height={24}
            />
            <text
              className="flow-negotiation-label"
              x={(pmX + pdX) / 2}
              y={arcY + 2}
              textAnchor="middle"
            >
              {negotiation.escalated
                ? `⛔ 协商超限熔断 (${negotiation.turnIndex}/${negotiation.maxTurnsAllowed} 轮) → 总管接管`
                : `⇄ PM ↔ PD 受限协商 第 ${negotiation.turnIndex}/${negotiation.maxTurnsAllowed} 轮`}
            </text>
          </g>
        ) : null}
      </svg>
      <div className="flow-canvas-hint">
        💬 协商讨论 · ↩️ 被驳回 · 🕘 回退更新 · ⎇ 分支分叉 · ⚡ 缓存复用 ——
        全部真实记录在流程图对应位置（当前分支 {activeBranchId}
        {hasRollbackFork ? ` · 共 ${branchCount} 个分支` : ''}）
      </div>
    </div>
  );
}
