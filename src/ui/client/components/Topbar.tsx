/**
 * @file Topbar.tsx
 * @description 顶部工具栏：项目切换、发起新项目、成员视角一键切换、流程模板切换、主题与连接状态。
 */

import type { DashboardStateDto } from '../types.ts';

const ROLE_CHIPS: ReadonlyArray<{ userId: string; label: string; color: string }> = [
  { userId: 'user-admin-01', label: '王总管(管理员)', color: '#7c3aed' },
  { userId: 'user-pm-01', label: '陈工(PM)', color: '#2563eb' },
  { userId: 'user-pd-01', label: '林工(设计)', color: '#db2777' },
  { userId: 'user-tech-01', label: '赵工(架构)', color: '#0891b2' },
  { userId: 'user-eng-01', label: '刘工(研发)', color: '#059669' },
  { userId: 'user-qa-01', label: '孙工(QA)', color: '#d97706' },
];

export function Topbar({
  state,
  theme,
  sseConnected,
  onActorChange,
  onRunChange,
  onTemplateChange,
  onOpenNewProposal,
  onToggleTheme,
}: {
  state: DashboardStateDto | null;
  theme: 'light' | 'dark';
  sseConnected: boolean;
  onActorChange: (userId: string) => void;
  onRunChange: (runId: string) => void;
  onTemplateChange: (fileName: string) => void;
  onOpenNewProposal: () => void;
  onToggleTheme: () => void;
}) {
  const currentActor = state?.rbacContext?.currentUser.userId;
  const runs = state?.allRunsList ?? [];
  const currentRunId = state?.run?.runId;

  return (
    <header className="app-topbar">
      <div className="topbar-group">
        <span className="topbar-label">项目</span>
        <select
          className="select-control"
          aria-label="切换当前协作项目"
          value={currentRunId ?? ''}
          onChange={(ev) => onRunChange(ev.target.value)}
        >
          {runs.map((item) => (
            <option key={item.runId} value={item.runId}>
              {item.title} ({item.runId})
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={onOpenNewProposal}>
          + 发起新项目
        </button>
      </div>

      <div className="topbar-group">
        <span className="topbar-label">一键切换成员视角</span>
        <div className="role-avatar-bar">
          {ROLE_CHIPS.map((chip) => (
            <button
              type="button"
              key={chip.userId}
              className={`role-chip-btn ${currentActor === chip.userId ? 'active-role-chip' : ''}`}
              onClick={() => onActorChange(chip.userId)}
            >
              <span className="role-dot" style={{ background: chip.color }} />
              {chip.label}
            </button>
          ))}
        </div>

        <select
          className="select-control"
          aria-label="研发流程模板切换"
          value={state?.workflowDslSummary?.activeTemplateFile ?? 'enterprise_sdlc.yaml'}
          onChange={(ev) => onTemplateChange(ev.target.value)}
        >
          <option value="enterprise_sdlc.yaml">全栈 6 步研发流</option>
          <option value="backend_api_only.yaml">纯后端 4 步流 (免UI)</option>
        </select>

        <button type="button" className="btn" onClick={onToggleTheme}>
          {theme === 'dark' ? '☀️ 浅色' : '🌙 深色'}
        </button>
        <span className={`pill ${sseConnected ? 'pill-green' : 'pill-muted'}`}>
          {sseConnected ? '🟢 实时协同已连接' : '⚪ 同步就绪'}
        </span>
      </div>
    </header>
  );
}
