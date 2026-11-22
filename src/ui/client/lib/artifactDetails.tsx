/**
 * @file artifactDetails.tsx
 * @description 五类阶段交付物契约的结构化详情渲染（PRD / UI 设计 / 技术契约 / 代码实现 / QA 报告），
 * 未识别类型折叠为原始 JSON。长列表默认显示前 3 条，其余折叠展开。
 */

import type { SnapshotRecordDto } from '../types.ts';
import { stateBadge } from './display.ts';
import { useState } from 'react';

const LIST_LIMIT = 3;

function FoldedList({ items, foldLabel }: { items: React.ReactNode[]; foldLabel: string }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) {
    return null;
  }
  if (items.length <= LIST_LIMIT) {
    return (
      <>
        {items.map((node, idx) => (
          <div key={idx}>{node}</div>
        ))}
      </>
    );
  }
  return (
    <>
      {items.slice(0, LIST_LIMIT).map((node, idx) => (
        <div key={idx}>{node}</div>
      ))}
      <button type="button" className="link-toggle" onClick={() => setOpen(!open)}>
        {open
          ? `收起${foldLabel} ▴`
          : `${foldLabel}（还有 ${items.length - LIST_LIMIT} 条，点击展开）▾`}
      </button>
      {open ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 0' }}>
          {items.slice(LIST_LIMIT).map((node, idx) => (
            <div key={idx}>{node}</div>
          ))}
        </div>
      ) : null}
    </>
  );
}

interface StoryDto {
  readonly reqId: string;
  readonly story: string;
  readonly acceptanceCriteria: string[];
}
interface TrackingEventDto {
  readonly eventName: string;
  readonly triggerCondition: string;
  readonly properties: string[];
}
interface ComponentMappingDto {
  readonly reqId: string;
  readonly designSystemComponent: string;
  readonly interactionStates: string[];
}
interface ApiContractDto {
  readonly method: string;
  readonly endpoint: string;
  readonly requestSchema: string;
  readonly responseSchema: string;
}
interface ModifiedFileDto {
  readonly filePath: string;
  readonly className: string;
  readonly designPattern: string;
  readonly linesChanged: number;
}
interface TestSuiteDto {
  readonly suiteName: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly coveragePercent: number;
}

/** 阶段交付物详情（完整内容进抽屉时渲染） */
export function ArtifactDetails({ snap }: { snap: SnapshotRecordDto }) {
  const details = snap.artifactDetails ?? {};
  const type = snap.artifactType;

  if (type === 'PRD_ARTIFACT_CONTRACT') {
    const stories = (details.userStories as StoryDto[] | undefined) ?? [];
    const events = (details.trackingPlanEvents as TrackingEventDto[] | undefined) ?? [];
    const constraints = (details.nonFunctionalConstraints as string[] | undefined) ?? [];
    const storyCards = stories.map((s) => (
      <div className="artifact-subcard" key={s.reqId}>
        <div style={{ fontWeight: 700, color: '#60a5fa' }}>
          [{s.reqId}] {s.story}
        </div>
        <ul style={{ marginTop: 6, paddingLeft: 18, color: 'var(--text-secondary)', fontSize: 12 }}>
          {(s.acceptanceCriteria ?? []).map((ac, i) => (
            <li key={i}>{ac}</li>
          ))}
        </ul>
      </div>
    ));
    const eventCards = events.map((ev) => (
      <div className="artifact-subcard" key={ev.eventName}>
        <div>
          <code style={{ color: '#34d399' }}>{ev.eventName}</code> — {ev.triggerCondition}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          属性字段: {(ev.properties ?? []).join(', ')}
        </div>
      </div>
    ));
    return (
      <div className="inspector-grid">
        <div>
          <h4 className="inspector-subtitle">
            📋 结构化 User Stories &amp; 验收标准 ({stories.length})
          </h4>
          <div className="col-stack" style={{ gap: 8 }}>
            <FoldedList items={storyCards} foldLabel="展开其余 User Stories" />
          </div>
        </div>
        <div>
          <h4 className="inspector-subtitle">
            📊 前置数据埋点规划 Tracking Plan ({events.length})
          </h4>
          <div className="col-stack" style={{ gap: 8 }}>
            <FoldedList items={eventCards} foldLabel="展开其余埋点事件" />
          </div>
          <h4 className="inspector-subtitle" style={{ marginTop: 14 }}>
            🛡️ 非功能性与历史避坑约束
          </h4>
          <ul style={{ paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
            {constraints.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (type === 'UI_DESIGN_ARTIFACT_CONTRACT') {
    const mappings = (details.componentMappings as ComponentMappingDto[] | undefined) ?? [];
    const a11y = (details.accessibilityChecklist as string[] | undefined) ?? [];
    return (
      <div className="inspector-grid">
        <div>
          <h4 className="inspector-subtitle">
            🎨 企业 Design System 组件映射清单 ({mappings.length})
          </h4>
          <div className="col-stack" style={{ gap: 8 }}>
            <FoldedList
              foldLabel="展开其余组件映射"
              items={mappings.map((m) => (
                <div className="artifact-subcard" key={m.reqId}>
                  <div>
                    <strong>[{m.reqId}]</strong> → 组件{' '}
                    <code style={{ color: '#c084fc' }}>{m.designSystemComponent}</code>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                    交互状态机: {(m.interactionStates ?? []).join(' · ')}
                  </div>
                </div>
              ))}
            />
          </div>
        </div>
        <div>
          <h4 className="inspector-subtitle">♿ 无障碍与交互体验规范</h4>
          <ul style={{ paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
            {a11y.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (type === 'TECH_SPEC_ARTIFACT_CONTRACT') {
    const apis = (details.apiContracts as ApiContractDto[] | undefined) ?? [];
    const ddls = (details.databaseDdlStatements as string[] | undefined) ?? [];
    const patterns = (details.architecturePatternsUsed as string[] | undefined) ?? [];
    return (
      <div className="inspector-grid">
        <div>
          <h4 className="inspector-subtitle">🔌 OpenAPI 接口契约规范 ({apis.length})</h4>
          <div className="col-stack" style={{ gap: 8 }}>
            <FoldedList
              foldLabel="展开其余接口契约"
              items={apis.map((api) => (
                <div className="artifact-subcard" key={`${api.method}-${api.endpoint}`}>
                  <div>
                    <span className="pill pill-blue">{api.method}</span> <code>{api.endpoint}</code>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                    Req: <code>{api.requestSchema}</code> → Res: <code>{api.responseSchema}</code>
                  </div>
                </div>
              ))}
            />
          </div>
          <h4 className="inspector-subtitle" style={{ marginTop: 12 }}>
            🏛️ 采用的架构设计模式
          </h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {patterns.map((p) => (
              <span className="pill pill-purple" key={p}>
                {p}
              </span>
            ))}
          </div>
        </div>
        <div>
          <h4 className="inspector-subtitle">🗄️ 数据库 DDL 变更脚本 ({ddls.length} 条)</h4>
          <pre className="code-preview-block">
            {ddls.length > 0 ? ddls.join('\n\n') : '-- 无数据库表结构 DDL 变更 (低风险)'}
          </pre>
        </div>
      </div>
    );
  }

  if (type === 'CODE_IMPLEMENTATION_ARTIFACT_CONTRACT') {
    const files = (details.modifiedFiles as ModifiedFileDto[] | undefined) ?? [];
    const branch = String(details.gitWorktreeBranch ?? '');
    return (
      <div>
        <div style={{ marginBottom: 10 }}>
          <span className="pill pill-cyan">Git Worktree 隔离分支: {branch}</span>
        </div>
        <div className="col-stack" style={{ gap: 8 }}>
          {files.map((f) => (
            <div
              className="artifact-subcard"
              key={f.filePath}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <div>
                  <code>{f.filePath}</code>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  类名: <strong>{f.className}</strong> · 设计模式: {f.designPattern}
                </div>
              </div>
              <span className="pill pill-green">+{f.linesChanged} lines</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'QA_VERIFICATION_ARTIFACT_CONTRACT') {
    const suites = (details.testSuitesExecuted as TestSuiteDto[] | undefined) ?? [];
    const secIssues = Number(details.securityIssuesFound ?? 0);
    return (
      <div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
          <span className={`pill ${secIssues === 0 ? 'pill-green' : 'pill-red'}`}>
            高危安全漏洞: {secIssues} 个
          </span>
          <span className="pill pill-blue">
            全部验收标准达成: {details.allAcceptanceCriteriaMet ? 'YES' : 'NO'}
          </span>
        </div>
        <div className="col-stack" style={{ gap: 8 }}>
          {suites.map((s) => (
            <div
              className="artifact-subcard"
              key={s.suiteName}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <strong>{s.suiteName}</strong>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  通过用例: {s.passedCases}/{s.totalCases}
                </div>
              </div>
              <span className="pill pill-green">覆盖率 {s.coveragePercent}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const badge = stateBadge(snap.state, snap.cacheHit);
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span className={badge.pillClass}>{badge.label}</span>
        <span className="pill pill-muted" style={{ marginLeft: 8 }}>
          {snap.artifactType}
        </span>
      </div>
      <div className="node-panel-summary">{snap.artifactSummary}</div>
      <details className="raw-fold">
        <summary>查看本交付物的原始结构化数据 (JSON)</summary>
        <pre className="code-preview-block">{JSON.stringify(details, null, 2)}</pre>
      </details>
    </div>
  );
}
