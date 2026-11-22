/**
 * @file App.tsx
 * @description 应用根组件：唯一状态源（DashboardState / 身份 / 路由 / 主题 / 抽屉 / 弹窗 / 提示条），
 * SSE 实时订阅（按登录身份重连），并向下分发统一动作封装。
 */

import { useCallback, useEffect, useState } from 'react';
import type { DashboardStateDto, NotificationDto } from './types.ts';
import { WorkbenchApiClient } from './WorkbenchApiClient.ts';
import { Sidebar, type RouteKey } from './components/Sidebar.tsx';
import { Topbar } from './components/Topbar.tsx';
import { RunSummaryBar } from './components/RunSummaryBar.tsx';
import { DetailDrawer, type DrawerContent } from './components/DetailDrawer.tsx';
import { NewProposalModal } from './components/NewProposalModal.tsx';
import { DecisionTimeline } from './components/DecisionTimeline.tsx';
import { WorkspaceView } from './views/WorkspaceView.tsx';
import { ProjectsHubView } from './views/ProjectsHubView.tsx';
import { GateCenterView } from './views/GateCenterView.tsx';
import { DagSupervisorView } from './views/DagSupervisorView.tsx';
import { SandboxExplorerView } from './views/SandboxExplorerView.tsx';
import { AuditRagView } from './views/AuditRagView.tsx';
import { AdminGovernanceView } from './views/AdminGovernanceView.tsx';
import { ComponentGalleryView } from './views/ComponentGalleryView.tsx';
import { stageMeta } from './lib/display.ts';

const apiClient = new WorkbenchApiClient();

const VALID_ROUTES: ReadonlyArray<RouteKey> = [
  'projects',
  'workspace',
  'gate-center',
  'dag-supervisor',
  'sandbox-explorer',
  'audit-rag',
  'admin-governance',
  'gallery',
];

function routeFromHash(): RouteKey {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  return VALID_ROUTES.includes(hash as RouteKey) ? (hash as RouteKey) : 'workspace';
}

export function App() {
  const [state, setState] = useState<DashboardStateDto | null>(null);
  const [route, setRoute] = useState<RouteKey>(routeFromHash);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [sseConnected, setSseConnected] = useState(false);
  const [banner, setBanner] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
  const [drawer, setDrawer] = useState<DrawerContent | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [auditExpanded, setAuditExpanded] = useState(false);

  const showBanner = useCallback((message: string, type: 'error' | 'success') => {
    setBanner({ message, type });
  }, []);

  const applyState = useCallback((next: DashboardStateDto) => {
    setState(next);
  }, []);

  const refreshState = useCallback(async () => {
    applyState(await apiClient.fetchDashboardState());
  }, [applyState]);

  /** 统一动作封装：调用 API → 应用返回的最新状态 → 失败弹错误条 */
  const act = useCallback(
    async (fn: () => Promise<DashboardStateDto>, successMessage?: string) => {
      try {
        const next = await fn();
        applyState(next);
        if (successMessage) {
          showBanner(successMessage, 'success');
        }
        return next;
      } catch (err) {
        showBanner(err instanceof Error ? err.message : '操作失败', 'error');
        return null;
      }
    },
    [applyState, showBanner],
  );

  // 初始化 + SSE 订阅（身份变化时重连）
  const actorId = state?.rbacContext?.currentUser.userId;
  useEffect(() => {
    let cancelled = false;
    void refreshState().then(() => {
      if (cancelled) {
        return;
      }
      apiClient.subscribeRealtimeEventStream(
        (nextState) => {
          setState(nextState);
        },
        (connected) => setSseConnected(connected),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [refreshState, actorId]);

  useEffect(() => {
    const handler = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const switchRoute = useCallback((next: RouteKey) => {
    setRoute(next);
    window.location.hash = `#/${next}`;
  }, []);

  const switchActor = useCallback(
    async (userId: string) => {
      apiClient.setActiveActorUserId(userId);
      try {
        applyState(await apiClient.fetchDashboardState());
        const user = apiClient.getActiveActorUserId();
        showBanner(`已切换当前登录成员视角为 ${user}`, 'success');
      } catch (err) {
        showBanner(err instanceof Error ? err.message : '切换成员失败', 'error');
      }
    },
    [applyState, showBanner],
  );

  const submitDecision = useCallback(
    (notif: NotificationDto, verdict: string, label: string, reason: string) => {
      void act(
        () =>
          apiClient.submitGateDecision(
            notif.relatedSnapshotId,
            verdict,
            reason.trim() || `人工确认：[${label}]`,
          ),
        `已完成步骤裁决：${label}${reason.trim() ? '（原因已记入审计账本）' : ''}`,
      );
    },
    [act],
  );

  const postComment = useCallback(
    (stageId: string, content: string) => {
      void act(() => apiClient.postTeamComment(stageId, content), '评论已发布！全团队成员均可见');
    },
    [act],
  );

  const hasActiveRun = Boolean(state?.hasActiveRun && state.run);

  // 组件库总览页使用独立全宽外壳（不受旧版 .app-shell 栅格与 1024px 折叠影响）
  if (route === 'gallery') {
    return (
      <>
        <ComponentGalleryView onExit={() => switchRoute('workspace')} />
        <DetailDrawer content={drawer} onClose={() => setDrawer(null)} />
      </>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar state={state} route={route} onRouteChange={switchRoute} />

      <div className="app-main-area">
        <Topbar
          state={state}
          theme={theme}
          sseConnected={sseConnected}
          onActorChange={(userId) => void switchActor(userId)}
          onRunChange={(runId) => void act(() => apiClient.selectRun(runId))}
          onTemplateChange={(fileName) =>
            void act(
              () => apiClient.switchWorkflowTemplate(fileName),
              `已切换流程模板 [${fileName}]`,
            )
          }
          onOpenNewProposal={() => setModalOpen(true)}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />

        {banner ? (
          <div
            className={`alert-banner visible ${banner.type === 'error' ? 'alert-error' : 'alert-success'}`}
          >
            <span id="globalAlertText">{banner.message}</span>
            <button
              type="button"
              className="btn"
              style={{ padding: '3px 8px', fontSize: 11 }}
              onClick={() => setBanner(null)}
            >
              关闭
            </button>
          </div>
        ) : null}

        <main className="workbench-container">
          <RunSummaryBar
            state={state}
            onOpenProfile={() => openProjectProfileDrawer(state, setDrawer)}
          />

          {hasActiveRun ? (
            <>
              <div
                className={`view-section ${route === 'projects' ? 'active-view' : ''}`}
                style={route === 'projects' ? undefined : { display: 'none' }}
              >
                {state ? (
                  <ProjectsHubView
                    state={state}
                    onEnterRun={(runId) => {
                      void act(() => apiClient.selectRun(runId));
                      switchRoute('workspace');
                    }}
                  />
                ) : null}
              </div>

              <div
                className={`view-section active-view`}
                style={route === 'workspace' ? undefined : { display: 'none' }}
              >
                {state ? (
                  <WorkspaceView
                    state={state}
                    submitDecision={submitDecision}
                    postComment={postComment}
                    openDrawer={setDrawer}
                  />
                ) : null}
              </div>

              <div
                className={`view-section ${route === 'gate-center' ? 'active-view' : ''}`}
                style={route === 'gate-center' ? undefined : { display: 'none' }}
              >
                {state ? <GateCenterView state={state} onSubmitDecision={submitDecision} /> : null}
              </div>

              <div
                className={`view-section ${route === 'dag-supervisor' ? 'active-view' : ''}`}
                style={route === 'dag-supervisor' ? undefined : { display: 'none' }}
              >
                {state ? (
                  <DagSupervisorView
                    state={state}
                    onSendRollback={(targetStageId, instruction) =>
                      void act(
                        () => apiClient.sendSupervisorRollback(targetStageId, instruction),
                        `总管 Agent 已执行版本回退，新分支 [${state.run?.activeBranchId ?? ''}] 已生效`,
                      )
                    }
                  />
                ) : null}
              </div>

              <div
                className={`view-section ${route === 'sandbox-explorer' ? 'active-view' : ''}`}
                style={route === 'sandbox-explorer' ? undefined : { display: 'none' }}
              >
                {state ? <SandboxExplorerView state={state} apiClient={apiClient} /> : null}
              </div>

              <div
                className={`view-section ${route === 'audit-rag' ? 'active-view' : ''}`}
                style={route === 'audit-rag' ? undefined : { display: 'none' }}
              >
                {state ? (
                  <AuditRagView
                    state={state}
                    apiClient={apiClient}
                    expanded={auditExpanded}
                    onExpandedChange={setAuditExpanded}
                    onRefreshState={refreshState}
                    onBanner={showBanner}
                  />
                ) : null}
              </div>

              <div
                className={`view-section ${route === 'admin-governance' ? 'active-view' : ''}`}
                style={route === 'admin-governance' ? undefined : { display: 'none' }}
              >
                {state ? (
                  <AdminGovernanceView
                    state={state}
                    apiClient={apiClient}
                    onActorChange={(userId) => void switchActor(userId)}
                    onRefreshState={refreshState}
                    onBanner={showBanner}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <section className="panel">
              <div className="diagnosis-item">
                尚未加载到活跃项目，请点击右上角【+ 发起新项目】创建。
              </div>
            </section>
          )}
        </main>
      </div>

      <NewProposalModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmitCustom={(input) => {
          void act(
            () => apiClient.createCustomProposal(input),
            `新研发项目《${input.title}》已创建并拆解为多 Agent 协同步骤！`,
          ).then(() => {
            setModalOpen(false);
            switchRoute('workspace');
          });
        }}
        onLaunchPreset={(preset, label) => {
          void act(() => apiClient.launchPresetProposal(preset), `已切换至项目场景：${label}`).then(
            () => {
              setModalOpen(false);
              switchRoute('workspace');
            },
          );
        }}
      />

      <DetailDrawer content={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}

/** 项目档案抽屉（项目目标 / 流程配置 / 沙箱 / 人为决策时间轴入口） */
function openProjectProfileDrawer(
  state: DashboardStateDto | null,
  setDrawer: (content: DrawerContent | null) => void,
): void {
  const run = state?.run;
  if (!run || !state) {
    return;
  }
  const user = state.rbacContext?.currentUser;
  const dsl = state.workflowDslSummary;
  const sandbox = state.sandboxWorkspaceSummary;
  const metaMap = (id: string) => stageMeta(id).shortName;
  const mySteps = (user?.ownedStageIds ?? [])
    .filter((id) => id !== 'STAGE_0_INITIATION')
    .map(metaMap);
  const perspective = user
    ? user.isProjectAdmin
      ? `👑 当前登录：${user.displayName}（项目最高管理员）— 拥有所有步骤的跨岗位拍板权与流程规则设置权。`
      : `👤 当前登录：${user.displayName}（${user.jobTitle}）— 可查看所有步骤并发表团队评论；你负责确认的步骤为【${mySteps.join('、') || '无'}】。`
    : '';
  const sandboxFiles = sandbox?.generatedFiles ?? [];
  const decisions = state.humanDecisions ?? [];

  const kvRows: ReadonlyArray<[string, string]> = [
    ['项目目标', run.summary],
    ['立项发起人', run.initiatorActor],
    ['运行实例', `${run.title} (${run.runId})`],
    [
      '版本分支',
      `${run.activeBranchId}${run.branches.length > 1 ? `（共 ${run.branches.length} 个分支，历史完整保留）` : ''}`,
    ],
    ...(dsl
      ? ([
          ['流程模板', `${dsl.workflowName} (${dsl.activeTemplateFile}) · ${dsl.stageCount} 步`],
          ['协商轮次上限', `${dsl.maxNegotiationTurns} 轮`],
          ['人工确认风险线', `${dsl.highRiskScoreThreshold} / 100`],
        ] as ReadonlyArray<[string, string]>)
      : []),
    [
      '代码沙箱',
      sandbox
        ? `${sandbox.activeWorktreeBranch} · 已生成 ${sandboxFiles.length} 个文件`
        : '尚未进入编码阶段',
    ],
    ['团队评论', `${(state.teamComments ?? []).length} 条`],
  ];

  const openTimeline = (set: (c: DrawerContent | null) => void) => {
    set({
      title: '审批与人为干预时间轴',
      subtitle: `签核 · 拍板 · 回退全留痕 · 共 ${decisions.length} 条`,
      body: <DecisionTimeline decisions={decisions} />,
    });
  };

  setDrawer({
    title: '项目档案',
    subtitle: run.title,
    body: (
      <>
        {perspective ? (
          <div className="drawer-detail-hero">
            <div>{perspective}</div>
          </div>
        ) : null}
        <table className="detail-kv-table">
          <tbody>
            {kvRows.map(([key, value]) => (
              <tr key={key}>
                <th>{key}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sandboxFiles.length > 0 ? (
          <>
            <h4 className="inspector-subtitle" style={{ marginTop: 14 }}>
              沙箱已生成文件
            </h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {sandboxFiles.map((f) => (
                <code key={f.relativePath}>{f.relativePath}</code>
              ))}
            </div>
          </>
        ) : null}
      </>
    ),
    actions:
      decisions.length > 0 ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setDrawer(null);
            setTimeout(() => openTimeline(setDrawer), 60);
          }}
        >
          🧑‍⚖️ 查看人为决策时间轴
        </button>
      ) : undefined,
  });
}
