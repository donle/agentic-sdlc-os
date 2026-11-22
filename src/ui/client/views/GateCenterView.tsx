/**
 * @file GateCenterView.tsx
 * @description 待办确认与方案拍板中心：全部/仅我负责筛选 + 签核意见 + 待办卡片操作。
 */

import { useState } from 'react';
import type { DashboardStateDto, NotificationDto } from '../types.ts';

const PAGE_SIZE = 6;

function NotifCard({
  notif,
  comment,
  onSubmit,
}: {
  notif: NotificationDto;
  comment: string;
  onSubmit: (notif: NotificationDto, verdict: string, label: string, reason: string) => void;
}) {
  const isUrgent = notif.requiresHumanAction && !notif.resolved;
  const access = notif.accessEvaluation;
  const canAct = Boolean(access?.canApproveOrArbitrate);

  let rbacStatus: React.ReactNode = null;
  if (access?.isDirectDomainOwner) {
    rbacStatus = <span className="pill pill-green">🎯 属于你负责的步骤 · 可直接签核</span>;
  } else if (access?.isAdminOverride) {
    rbacStatus = <span className="pill pill-purple">👑 管理员跨步骤签核</span>;
  } else if (access) {
    rbacStatus = (
      <span className="pill pill-muted">
        🔒 由 {access.requiredSpecialistRoles.join(' / ')} 负责确认
      </span>
    );
  }

  return (
    <div className={`notif-card ${isUrgent ? 'urgent-action' : 'resolved-item'}`}>
      <div className="notif-title">
        <span>{notif.title}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {rbacStatus}
          <span className={`pill ${isUrgent ? 'pill-amber' : 'pill-green'}`}>
            {isUrgent ? '待确认' : '已确认完成'}
          </span>
        </div>
      </div>
      <div className="notif-body">{notif.message}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        负责 Agent: {notif.senderRole} · 步骤: {notif.stageId} · 版本分支: {notif.branchId}
      </div>
      {isUrgent && notif.actionOptions.length > 0 ? (
        <div className="notif-actions">
          {notif.actionOptions.map((opt) => {
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
                onClick={() => onSubmit(notif, opt.verdict, opt.label, comment)}
              >
                {canAct ? opt.label : `🔒 ${opt.label}`}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function GateCenterView({
  state,
  onSubmitDecision,
}: {
  state: DashboardStateDto;
  onSubmitDecision: (
    notif: NotificationDto,
    verdict: string,
    label: string,
    reason: string,
  ) => void;
}) {
  const [filterMine, setFilterMine] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState(
    '经本领域负责人审阅，当前步骤 Agent 方案与讨论结论符合要求，确认通过。',
  );

  const all = state.notifications ?? [];
  const filtered = filterMine ? all.filter((n) => n.accessEvaluation?.canApproveOrArbitrate) : all;
  const visible = expanded ? filtered : filtered.slice(0, PAGE_SIZE);
  const unresolvedCount = all.filter((n) => n.requiresHumanAction && !n.resolved).length;

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>项目各步骤待确认事项与方案拍板汇总</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn ${filterMine ? '' : 'btn-primary'}`}
            onClick={() => setFilterMine(false)}
          >
            查看全部步骤确认记录
          </button>
          <button
            type="button"
            className={`btn ${filterMine ? 'btn-primary' : ''}`}
            onClick={() => setFilterMine(true)}
          >
            仅看由我负责确认的步骤
          </button>
          <span className={`pill ${unresolvedCount > 0 ? 'pill-amber' : 'pill-green'}`}>
            {unresolvedCount > 0 ? `${unresolvedCount} 项待确认/拍板` : '全部已确认'}
          </span>
        </div>
      </div>

      <div className="form-row" style={{ marginBottom: 14 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          签核意见说明 (将同步记入对应步骤的团队评论区)：
        </span>
        <input
          type="text"
          className="input-control"
          value={comment}
          onChange={(ev) => setComment(ev.target.value)}
          placeholder="输入审批或驳回理由..."
        />
      </div>

      <div className="notification-list">
        {visible.length === 0 ? (
          <div className="diagnosis-item">当前筛选条件下暂无待确认步骤记录。</div>
        ) : (
          visible.map((notif) => (
            <NotifCard
              key={notif.notificationId}
              notif={notif}
              comment={comment}
              onSubmit={onSubmitDecision}
            />
          ))
        )}
        {filtered.length > visible.length ? (
          <button type="button" className="link-toggle" onClick={() => setExpanded(true)}>
            展开其余 {filtered.length - visible.length} 条待办记录 ▾
          </button>
        ) : null}
      </div>
    </section>
  );
}
