/**
 * @file Sidebar.tsx
 * @description 左侧导航：品牌区、当前成员身份卡、七个视图路由、透明协同说明。
 */

import type { DashboardStateDto } from '../types.ts';

export type RouteKey =
  | 'projects'
  | 'workspace'
  | 'gate-center'
  | 'dag-supervisor'
  | 'sandbox-explorer'
  | 'audit-rag'
  | 'admin-governance'
  | 'gallery';

const NAV_ITEMS: ReadonlyArray<{ route: RouteKey; label: string; icon: React.ReactNode }> = [
  {
    route: 'projects',
    label: '项目总览大厅',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    route: 'workspace',
    label: '项目分步协同工作区',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
      </svg>
    ),
  },
  {
    route: 'gate-center',
    label: '待办确认与方案拍板',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4l3 3" />
      </svg>
    ),
  },
  {
    route: 'dag-supervisor',
    label: '总管对话与版本历史',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="12" r="3" />
        <path d="M6 9v6M8.5 7.5L15.5 11" />
      </svg>
    ),
  },
  {
    route: 'sandbox-explorer',
    label: '交付源码与测试沙箱',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    route: 'audit-rag',
    label: '协同动态与团队经验库',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    route: 'admin-governance',
    label: '团队成员与流程设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 00-3-3.87" />
        <path d="M16 3.13a4 4 0 010 7.75" />
      </svg>
    ),
  },
  {
    route: 'gallery',
    label: 'Meridian UI 组件库',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 17.5h7M17.5 14v7" />
      </svg>
    ),
  },
];

export function Sidebar({
  state,
  route,
  onRouteChange,
}: {
  state: DashboardStateDto | null;
  route: RouteKey;
  onRouteChange: (route: RouteKey) => void;
}) {
  const user = state?.rbacContext?.currentUser;
  const unresolvedCount = (state?.notifications ?? []).filter(
    (n) => n.requiresHumanAction && !n.resolved,
  ).length;

  const ownedNames = (user?.ownedStageIds ?? []).filter((id) => id !== 'STAGE_0_INITIATION');

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <span className="brand-badge">A</span>
        <div>
          <div className="brand-title">Agentic SDLC</div>
          <div className="brand-subtitle">Multi-Agent Product Workspace</div>
        </div>
      </div>

      <div className={`user-identity-card ${user?.isProjectAdmin ? 'admin-tier' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className={`pill ${user?.isProjectAdmin ? 'pill-purple' : 'pill-blue'}`}>
            {user?.avatarBadge ?? 'USER'}
          </span>
          <span className={`pill ${user?.isProjectAdmin ? 'pill-purple' : 'pill-cyan'}`}>
            {user?.isProjectAdmin ? '项目最高管理员' : '环节专业负责人'}
          </span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{user?.displayName ?? ''}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {user ? `${user.jobTitle} · ${user.department}` : ''}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 6,
            marginTop: 2,
          }}
        >
          {user?.isProjectAdmin
            ? '负责范围: 全流程所有步骤均可拍板确认与管理'
            : `负责确认步骤: ${ownedNames.length > 0 ? ownedNames.join('、') : '暂无'}`}
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section-label">项目与分步协作</div>
        {NAV_ITEMS.map((item, idx) => (
          <div key={item.route}>
            {idx === 4 ? <div className="nav-section-label">工程资产与团队</div> : null}
            <button
              type="button"
              className={`nav-item ${route === item.route ? 'active-nav' : ''}`}
              onClick={() => onRouteChange(item.route)}
            >
              <span className="nav-item-left">
                <svg
                  className="nav-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  {item.icon}
                </svg>
                <span>{item.label}</span>
              </span>
              {item.route === 'gate-center' ? (
                <span className={`pill ${unresolvedCount > 0 ? 'pill-amber' : 'pill-green'}`}>
                  {unresolvedCount}
                </span>
              ) : null}
            </button>
          </div>
        ))}
      </nav>

      <div
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          padding: 10,
          background: 'var(--bg-subtle)',
          borderRadius: 8,
        }}
      >
        <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>
          透明协同模式
        </div>
        <div>全团队共享相同项目步骤与评论；步骤签核按成员专长领域授权。</div>
      </div>
    </aside>
  );
}
