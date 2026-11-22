/**
 * @file AuditRagView.tsx
 * @description 协同动态（审计账本）与团队避坑经验知识库（RAG 检索/录入）。
 */

import { useState } from 'react';
import type { DashboardStateDto, RagQueryMatchDto } from '../types.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import { auditActorIcon, formatRelativeTime } from '../lib/display.ts';

const AUDIT_LIMIT = 8;

export function AuditRagView({
  state,
  apiClient,
  expanded,
  onExpandedChange,
  onRefreshState,
  onBanner,
}: {
  state: DashboardStateDto;
  apiClient: WorkbenchApiClient;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onRefreshState: () => Promise<void>;
  onBanner: (message: string, type: 'error' | 'success') => void;
}) {
  const [ragResults, setRagResults] = useState<ReadonlyArray<RagQueryMatchDto> | null>(null);
  const [ragStage, setRagStage] = useState('STAGE_3A_TECH_SPEC');
  const [ragText, setRagText] = useState('数据库分布式乐观锁与幂等键设计');

  const auditEntries = state.auditTimeline ?? [];
  const visible = expanded ? auditEntries : auditEntries.slice(0, AUDIT_LIMIT);
  const ragRecords = ragResults ?? [...(state.negativeExperienceRecords ?? [])].reverse();

  return (
    <div className="main-grid">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>项目全链路协同动态与签核记录</span>
          </div>
          <span className="pill pill-blue">全员透明可追溯 · 共 {auditEntries.length} 条</span>
        </div>
        <div className="audit-timeline">
          {visible.map((entry) => (
            <div className="audit-row" key={entry.entryId}>
              <span className="audit-icon">{auditActorIcon(entry.actionType)}</span>
              <div className="audit-body">
                <div className="audit-summary">{entry.summary}</div>
                <div className="audit-meta">
                  {entry.actor} · {entry.actionType} · {formatRelativeTime(entry.timestampIso)}
                </div>
              </div>
            </div>
          ))}
        </div>
        {auditEntries.length > visible.length ? (
          <button type="button" className="link-toggle" onClick={() => onExpandedChange(!expanded)}>
            {expanded
              ? '收起审计记录 ▴'
              : `展开更早的 ${auditEntries.length - visible.length} 条审计记录 ▾`}
          </button>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>团队历史评审避坑经验知识库</span>
          </div>
          <span className="pill pill-purple">自动注入对应步骤 Agent</span>
        </div>

        <div className="supervisor-form" style={{ marginBottom: 14 }}>
          <div className="form-row">
            <select
              className="select-control"
              value={ragStage}
              onChange={(ev) => setRagStage(ev.target.value)}
            >
              <option value="STAGE_1_PM">步骤 1: PM 需求与埋点</option>
              <option value="STAGE_2_PD">步骤 2: PD 交互设计</option>
              <option value="STAGE_3A_TECH_SPEC">步骤 3a: Tech Lead 架构与表设计</option>
              <option value="STAGE_3B_ENGINEER">步骤 3b: Engineer 代码实现</option>
              <option value="STAGE_4_QA">步骤 4: QA 自动化测试</option>
            </select>
            <input
              type="text"
              className="input-control"
              value={ragText}
              onChange={(ev) => setRagText(ev.target.value)}
              placeholder="输入关键词检索历史经验，或录入新的团队设计/架构红线..."
            />
          </div>
          <div className="form-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                try {
                  setRagResults(
                    await apiClient.queryNegativeExperienceRag(ragStage, ragText.trim()),
                  );
                } catch (err) {
                  onBanner(err instanceof Error ? err.message : '检索失败', 'error');
                }
              }}
            >
              检索相关历史经验
            </button>
            <button
              type="button"
              className="btn btn-warning"
              onClick={async () => {
                if (!ragText.trim()) {
                  return;
                }
                try {
                  setRagResults(null);
                  await apiClient.ingestNegativeExperienceLesson(ragStage, ragText.trim());
                  await onRefreshState();
                  onBanner(
                    '已沉淀至团队共享避坑经验库，后续对应步骤 Agent 将自动引用！',
                    'success',
                  );
                } catch (err) {
                  onBanner(err instanceof Error ? err.message : '录入失败', 'error');
                }
              }}
            >
              沉淀为团队共享避坑经验
            </button>
          </div>
        </div>

        <div className="stream-list">
          {ragRecords.length === 0 ? (
            <div className="diagnosis-item">
              该步骤暂无匹配的团队历史经验，可点击【沉淀为团队共享避坑经验】添加。
            </div>
          ) : (
            ragRecords.map((rec) => (
              <div className="stream-item" key={rec.recordId}>
                <div>
                  <div>
                    <span className="pill pill-purple">{rec.stageId}</span>{' '}
                    <strong>{rec.recordId}</strong>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>
                    {rec.desensitizedLesson}
                  </div>
                </div>
                {'similarityScore' in rec ? (
                  <span className="pill pill-green">相关度: {rec.similarityScore}</span>
                ) : (
                  <span className="pill pill-cyan">已共享给对应 Agent</span>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
