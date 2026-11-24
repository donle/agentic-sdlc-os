/**
 * @file RunSummaryBar.tsx
 * @description 首屏项目单行概览条：标题 + 状态 + 分支 + 待办计数 + 项目档案入口（详情进抽屉）。
 */

import type { DashboardStateDto } from '../types.ts';
import { moodFromState, personaFor } from '../lib/agentPersona.ts';
import { stageMeta } from '../lib/display.ts';
import { AgentAvatar } from './AgentAvatar.tsx';

export function RunSummaryBar({
  state,
  onOpenProfile,
}: {
  state: DashboardStateDto | null;
  onOpenProfile: () => void;
}) {
  const run = state?.run;
  if (!run) {
    return (
      <section className="run-summary-bar compact">
        <div className="run-line">
          <h2>正在加载研发项目...</h2>
        </div>
      </section>
    );
  }
  const unresolved = (state?.notifications ?? []).filter(
    (n) => n.requiresHumanAction && !n.resolved,
  );
  const mine = unresolved.filter((n) => n.accessEvaluation?.canApproveOrArbitrate).length;

  let statusPill: React.ReactNode;
  if (run.status === 'PAUSED_AT_HUMAN_GATE') {
    const meta = run.currentStageId ? stageMeta(run.currentStageId) : null;
    statusPill = (
      <span className="pill pill-amber">
        ⏳ {meta ? meta.shortName : (run.currentStageId ?? '')} 待确认
      </span>
    );
  } else if (run.status === 'COMPLETED') {
    statusPill = <span className="pill pill-green">🎉 已交付</span>;
  } else {
    statusPill = <span className="pill pill-blue">{run.status}</span>;
  }

  const stages = state?.stagePipelineOrder ?? [];
  const activeSnaps = (run.snapshots ?? []).filter(
    (s) => s.branchId === run.activeBranchId && s.state !== 'SUPERSEDED',
  );

  return (
    <section className="run-summary-bar compact" id="runSummaryBar">
      <div className="run-line">
        <div className="run-squad-avatars" aria-label="项目协同 Agent 团队">
          <AgentAvatar roleOrStage="SUPERVISOR_AGENT" size="xs" mood="idle" />
          {stages.map((sid) => {
            const snap = activeSnaps.find((s) => s.stageId === sid);
            const p = personaFor(sid);
            return (
              <AgentAvatar
                key={sid}
                roleOrStage={sid}
                size="xs"
                mood={snap ? moodFromState(snap.state) : 'idle'}
                title={`${p.personName} (${p.codename})`}
              />
            );
          })}
        </div>
        <h2>{run.title}</h2>
        {statusPill}
        <span className="pill pill-blue">⎇ {run.activeBranchId}</span>
        <span className={`pill ${unresolved.length > 0 ? 'pill-amber' : 'pill-green'}`}>
          {unresolved.length > 0 ? `⏳ 待办 ${unresolved.length} (由我 ${mine})` : '✓ 无待办'}
        </span>
        <button type="button" className="btn" onClick={onOpenProfile}>
          📋 项目详情
        </button>
      </div>
    </section>
  );
}
