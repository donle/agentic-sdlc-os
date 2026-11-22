/**
 * @file StageNodePanel.tsx
 * @description 阶段操作台：点击流程图节点就地展开 —— Agent 身份大卡 + 产出摘要 +
 * 操作区（有待办时裁决含原因输入框；无待办时团队评论输入）。
 */

import { useState } from 'react';
import type { DashboardStateDto, NotificationDto } from '../types.ts';
import { stageMeta, stateBadge } from '../lib/display.ts';
import { AgentDiscussion, AgentWorkActivity } from '../lib/stageContent.tsx';

export function StageNodePanel({
  state,
  stageId,
  onClose,
  onSubmitDecision,
  onPostComment,
  onOpenArtifact,
  onOpenDiscussion,
  onOpenComments,
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
  onOpenDiscussion: () => void;
  onOpenComments: () => void;
}) {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');

  const meta = stageMeta(stageId);
  const run = state.run;
  const snap =
    run?.snapshots?.find(
      (s) => s.branchId === run.activeBranchId && s.stageId === stageId && s.state !== 'SUPERSEDED',
    ) ?? null;
  const access = state.rbacContext?.stageAccessMatrix[stageId];
  const pendingNotif = (state.notifications ?? []).find(
    (n) => n.stageId === stageId && n.requiresHumanAction && !n.resolved,
  );
  const stageComments = (state.teamComments ?? []).filter((c) => c.stageId === stageId);
  const canAct = Boolean(access?.canApproveOrArbitrate);

  let accessBadge = <span className="pill pill-cyan">👁️ 全员共享视图</span>;
  if (access?.isDirectDomainOwner) {
    accessBadge = <span className="pill pill-green">🎯 你是本阶段负责人</span>;
  } else if (access?.isAdminOverride) {
    accessBadge = <span className="pill pill-purple">👑 管理员跨阶段权限</span>;
  }
  const stateBadgeEl = snap ? (
    (() => {
      const badge = stateBadge(snap.state, snap.cacheHit);
      return <span className={badge.pillClass}>{badge.label}</span>;
    })()
  ) : (
    <span className="pill pill-muted">◌ 待启动</span>
  );

  return (
    <section className="panel node-panel" id="stageNodePanel">
      <div className="panel-header">
        <div className="panel-title">
          <span>阶段操作台</span>
        </div>
        <button
          type="button"
          className="btn"
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={onClose}
        >
          ✕ 收起
        </button>
      </div>
      <div>
        <div className="node-panel-identity">
          <span className="agent-action-avatar">{meta.stepNumber}</span>
          <div className="agent-action-identity">
            <div className="agent-action-name">{meta.agentDisplayName}</div>
            <div className="agent-action-role">
              {meta.shortName} · 责任专家: {meta.specialistLabel}
            </div>
          </div>
          {accessBadge}
          {stateBadgeEl}
        </div>
        <div className="node-panel-summary">{meta.stepGoal}</div>

        {snap ? (
          <>
            <div className="node-panel-summary">
              <strong>📦 本阶段产出：</strong>
              {snap.artifactSummary}
            </div>
            <div className="node-panel-links">
              <button type="button" className="btn" onClick={onOpenArtifact}>
                📄 完整交付物
              </button>
              <button type="button" className="btn" onClick={onOpenDiscussion}>
                💬 讨论过程与结论
              </button>
              <button type="button" className="btn" onClick={onOpenComments}>
                🗣️ 全部团队评论 ({stageComments.length})
              </button>
            </div>
            <details className="raw-fold" style={{ marginTop: 10 }}>
              <summary>展开本阶段 Agent 执行动作分解详情</summary>
              <div style={{ padding: '10px 12px' }}>
                <AgentWorkActivity stageId={stageId} snap={snap} />
              </div>
            </details>
            <details className="raw-fold" style={{ marginTop: 8 }}>
              <summary>展开跨 Agent 讨论过程与结论</summary>
              <div style={{ padding: '10px 12px' }}>
                <AgentDiscussion
                  stageId={stageId}
                  snap={snap}
                  negotiationLogs={state.negotiationLogs ?? []}
                  allSnapshots={state.run?.snapshots ?? []}
                />
              </div>
            </details>
          </>
        ) : (
          <div className="node-panel-summary">本阶段尚未执行，完成前序阶段后将自动产出交付物。</div>
        )}

        {pendingNotif ? (
          <>
            <div className="node-panel-section-title">
              ⚖️ 本阶段待人工确认 / 拍板（裁决原因将写入不可变审计账本）
            </div>
            <div className="node-panel-summary">
              <strong>{pendingNotif.title}</strong>
              <br />
              {pendingNotif.message}
            </div>
            {!canAct && access?.denialReason ? (
              <div className="node-panel-summary" style={{ color: 'var(--status-amber)' }}>
                💡 {access.denialReason} 你可以在下方发表评论供负责人参考。
              </div>
            ) : null}
            <textarea
              className="textarea-control"
              rows={2}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder="填写通过 / 驳回 / 拍板的具体原因（选填，会同步记入团队评论区）"
            />
            <div className="node-panel-actions">
              {(pendingNotif.actionOptions ?? []).map((opt) => {
                const btnClass =
                  opt.verdict === 'REJECT'
                    ? 'btn-danger'
                    : opt.verdict === 'ARBITRATE_OPTION_A' || opt.verdict === 'APPROVE'
                      ? 'btn-success'
                      : 'btn-warning';
                return (
                  <button
                    type="button"
                    key={opt.actionKey}
                    className={`btn ${btnClass}`}
                    disabled={!canAct}
                    onClick={() => onSubmitDecision(pendingNotif, opt.verdict, opt.label, reason)}
                  >
                    {canAct ? opt.label : `🔒 ${opt.label}`}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="node-panel-section-title">💬 对本阶段发表团队评论</div>
            <textarea
              className="textarea-control"
              rows={2}
              value={comment}
              onChange={(ev) => setComment(ev.target.value)}
              placeholder="对本阶段 Agent 方案、讨论结论或产出的意见（全员可见）..."
            />
            <div className="node-panel-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (!comment.trim()) {
                    return;
                  }
                  onPostComment(stageId, comment.trim());
                  setComment('');
                }}
              >
                发表评论
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
