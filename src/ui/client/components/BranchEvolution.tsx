/**
 * @file BranchEvolution.tsx
 * @description DAG 分支演化视图：按分支分组展示快照历史，SUPERSEDED 默认折叠。
 */

import type { SnapshotRecordDto } from '../types.ts';
import { formatRelativeTime, stageMeta, stateBadge } from '../lib/display.ts';

function SnapRow({ snap }: { snap: SnapshotRecordDto }) {
  const badge = stateBadge(snap.state, snap.cacheHit);
  return (
    <div className={`branch-snap-row ${snap.state === 'SUPERSEDED' ? 'snap-superseded' : ''}`}>
      <span className="branch-snap-state">
        <span className={badge.pillClass}>{badge.label}</span>
      </span>
      <div className="branch-snap-body">
        <div className="branch-snap-title">
          {stageMeta(snap.stageId).shortName}
          <span className="branch-snap-id"> {snap.snapshotId}</span>
        </div>
        <div className="branch-snap-summary">
          {snap.artifactSummary} · {formatRelativeTime(snap.createdAtIso)}
        </div>
      </div>
    </div>
  );
}

export function BranchEvolution({
  snapshots,
  branches,
}: {
  snapshots: ReadonlyArray<SnapshotRecordDto>;
  branches: ReadonlyArray<string>;
}) {
  if (snapshots.length === 0) {
    return <div className="timeline-empty">当前运行实例尚未产生阶段快照。</div>;
  }

  const ordered = [
    ...branches.filter((b) => snapshots.some((s) => s.branchId === b)),
    ...[...new Set(snapshots.map((s) => s.branchId))].filter((b) => !branches.includes(b)),
  ];

  return (
    <div className="branch-evolution">
      {ordered.map((branchId, index) => {
        const branchSnaps = snapshots
          .filter((s) => s.branchId === branchId)
          .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
        const live = branchSnaps.filter((s) => s.state !== 'SUPERSEDED');
        const superseded = branchSnaps.filter((s) => s.state === 'SUPERSEDED');
        const isCurrent = index === ordered.length - 1;
        return (
          <div className={`branch-group ${isCurrent ? 'branch-current' : ''}`} key={branchId}>
            <div className="branch-header">
              <span className="branch-name">⎇ {branchId}</span>
              {isCurrent ? (
                <span className="pill pill-green">当前活跃分支</span>
              ) : (
                <span className="pill pill-muted">历史分支</span>
              )}
              <span className="branch-count">
                {live.length} 个有效快照 · {superseded.length} 个已废弃
              </span>
            </div>
            {live.map((snap) => (
              <SnapRow key={snap.snapshotId} snap={snap} />
            ))}
            {superseded.length > 0 ? (
              <details className="branch-superseded-fold">
                <summary>🕘 本分支历史上被替换的 {superseded.length} 个旧版快照</summary>
                {superseded.map((snap) => (
                  <SnapRow key={snap.snapshotId} snap={snap} />
                ))}
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
