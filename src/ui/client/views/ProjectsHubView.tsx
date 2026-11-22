/**
 * @file ProjectsHubView.tsx
 * @description 项目总览大厅：全部运行实例的进度卡片。
 */

import type { DashboardStateDto } from '../types.ts';
import { stageMeta } from '../lib/display.ts';

export function ProjectsHubView({
  state,
  onEnterRun,
}: {
  state: DashboardStateDto;
  onEnterRun: (runId: string) => void;
}) {
  const currentRunId = state.run?.runId;
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>企业研发项目总览大厅</span>
        </div>
      </div>
      <div className="project-portfolio-grid">
        {(state.allRunsList ?? []).map((item) => {
          const isCurrent = item.runId === currentRunId;
          const completed = item.completedStagesCount ?? 1;
          const total = item.totalStagesCount ?? 6;
          const percent = Math.min(100, Math.round((completed / total) * 100));
          const stageInfo = item.currentStageId ? stageMeta(item.currentStageId) : null;
          return (
            <div
              className="project-portfolio-card"
              key={item.runId}
              style={isCurrent ? { borderColor: 'var(--accent-blue)' } : undefined}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{item.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    项目编号: {item.runId} · 发起人: {item.initiatorActor}
                  </div>
                </div>
                <span
                  className={`pill ${item.status === 'COMPLETED' ? 'pill-green' : 'pill-amber'}`}
                >
                  {item.status === 'COMPLETED' ? '✅ 已交付' : '⏳ 推进中·待确认'}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{item.summary}</div>
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    marginBottom: 5,
                  }}
                >
                  <span>
                    当前推进步骤: <strong>{stageInfo ? stageInfo.name : '已完成全部步骤'}</strong>
                  </span>
                  <span>
                    进度 {completed}/{total} 步 ({percent}%)
                  </span>
                </div>
                <div
                  style={{
                    height: 7,
                    background: 'var(--bg-canvas)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${percent}%`,
                      background: 'linear-gradient(90deg, var(--accent-blue), var(--status-green))',
                    }}
                  />
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingTop: 8,
                  borderTop: '1px dashed var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="pill pill-blue">分支: {item.activeBranchId}</span>
                  <span className="pill pill-cyan">💬 {item.commentsCount ?? 0} 条团队评论</span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onEnterRun(item.runId)}
                >
                  {isCurrent ? '正在查看 · 进入分步工作台 →' : '进入项目分步协同工作区 →'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
