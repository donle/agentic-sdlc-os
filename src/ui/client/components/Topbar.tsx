/**
 * @file Topbar.tsx
 * @description 顶部工具栏：项目切换、发起新项目、成员视角一键切换、流程模板切换、主题与连接状态。
 */

import type { AuthUserDto, DashboardStateDto, WorkflowTemplateItemDto } from '../types.ts';
import type { PerspectiveState } from '../lib/perspective.ts';
import { StatusChip } from '../../kit/index.ts';
import { AgentAvatar } from './AgentAvatar.tsx';

const TEMPLATE_LABELS: Record<string, string> = {
  'enterprise_sdlc.yaml': '全栈 6 步研发流 (enterprise_sdlc.yaml)',
  'backend_api_only.yaml': '纯后端 4 步流 (免UI · backend_api_only.yaml)',
};

export function Topbar({
  state,
  theme,
  sseConnected,
  authMode,
  authUser,
  impersonatingAdmin,
  templates,
  perspective,
  onActorChange,
  onRunChange,
  onTemplateChange,
  onOpenNewProposal,
  onToggleTheme,
  onOpenLogin,
  onOpenChangePassword,
  onLogout,
  onExitActAs,
}: {
  state: DashboardStateDto | null;
  theme: 'light' | 'dark';
  sseConnected: boolean;
  authMode: 'loading' | 'authenticated' | 'unauthenticated' | 'demo_mode';
  authUser: AuthUserDto | null;
  impersonatingAdmin: AuthUserDto | null;
  templates: ReadonlyArray<WorkflowTemplateItemDto>;
  perspective: PerspectiveState;
  onActorChange: (userId: string) => void;
  onRunChange: (runId: string) => void;
  onTemplateChange: (fileName: string) => void;
  onOpenNewProposal: () => void;
  onToggleTheme: () => void;
  onOpenLogin: () => void;
  onOpenChangePassword: () => void;
  onLogout: () => void;
  onExitActAs: () => void;
}) {
  const currentActor = state?.rbacContext?.currentUser.userId;
  const roster = state?.rbacContext?.roster ?? [];
  const runs = state?.allRunsList ?? [];
  const currentRunId = state?.run?.runId;
  const rawActiveTemplate = state?.workflowDslSummary?.activeTemplateFile ?? 'enterprise_sdlc.yaml';
  const activeTemplateName = rawActiveTemplate.split(/[\\/]/).pop() ?? 'enterprise_sdlc.yaml';
  const templateOptions: ReadonlyArray<WorkflowTemplateItemDto> =
    templates.length > 0 ? templates : [{ fileName: activeTemplateName }];
  const canSwitchActor =
    authMode === 'demo_mode' ||
    authUser?.tier === 'PROJECT_ADMIN' ||
    impersonatingAdmin?.tier === 'PROJECT_ADMIN';

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
        {canSwitchActor && roster.length > 0 ? (
          <>
            <span className="topbar-label">
              {authMode === 'authenticated' ? '管理员视角切换' : '一键切换成员视角'}
            </span>
            <div className="role-avatar-bar">
              {roster.map((member) => {
                return (
                  <button
                    type="button"
                    key={member.userId}
                    className={`role-chip-btn ${currentActor === member.userId ? 'active-role-chip' : ''}`}
                    onClick={() => onActorChange(member.userId)}
                    title={`${member.displayName} · ${member.jobTitle}`}
                  >
                    <AgentAvatar
                      roleOrStage={member.counterpartAgentRole}
                      size="xs"
                      mood={currentActor === member.userId ? 'working' : 'idle'}
                    />
                    <span>{member.displayName}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        <select
          className="select-control"
          aria-label="研发流程模板切换"
          value={activeTemplateName}
          onChange={(ev) => onTemplateChange(ev.target.value)}
        >
          {templateOptions.map((tpl) => (
            <option key={tpl.fileName} value={tpl.fileName}>
              {TEMPLATE_LABELS[tpl.fileName] ?? tpl.fileName}
            </option>
          ))}
        </select>

        <button type="button" className="btn" onClick={onToggleTheme}>
          {theme === 'dark' ? '☀️ 浅色' : '🌙 深色'}
        </button>
        <StatusChip
          tone={perspective.level === 'L3' ? 'violet' : 'brand'}
          title={perspective.summaryText}
        >
          {perspective.badgeText}
        </StatusChip>
        <StatusChip tone={sseConnected ? 'success' : 'neutral'} dot>
          {sseConnected ? '实时协同已连接' : '同步就绪'}
        </StatusChip>

        {authMode === 'authenticated' && authUser ? (
          <div className="topbar-group" style={{ gap: 6 }}>
            {impersonatingAdmin ? (
              <button type="button" className="btn btn-warning" onClick={onExitActAs}>
                退出代班 ({impersonatingAdmin.displayName})
              </button>
            ) : null}
            <button type="button" className="btn" onClick={onOpenChangePassword}>
              改密
            </button>
            <button type="button" className="btn" onClick={onLogout}>
              退出 ({authUser.username})
            </button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={onOpenLogin}>
            账号登录
          </button>
        )}
      </div>
    </header>
  );
}
