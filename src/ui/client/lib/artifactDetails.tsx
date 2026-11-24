/**
 * @file artifactDetails.tsx
 * @description G5: 六类阶段交付物契约（含 DA 埋点归因报告与未识别类型 JSON 兜底）的结构化渲染组件。
 */

import { useState, type ReactNode } from 'react';
import {
  Callout,
  Card,
  DataTable,
  EmptyState,
  Inline,
  KeyValueList,
  SectionLabel,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import type { SnapshotRecordDto } from '../types.ts';
import { parseStageArtifact } from './artifactParsers.ts';

const LIST_LIMIT = 3;

function FoldedList({ items, foldLabel }: { items: ReactNode[]; foldLabel: string }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) {
    return null;
  }
  if (items.length <= LIST_LIMIT) {
    return (
      <Stack gap="tight">
        {items.map((node, idx) => (
          <div key={idx}>{node}</div>
        ))}
      </Stack>
    );
  }
  return (
    <Stack gap="tight">
      {items.slice(0, LIST_LIMIT).map((node, idx) => (
        <div key={idx}>{node}</div>
      ))}
      <button type="button" className="link-toggle" onClick={() => setOpen(!open)}>
        {open
          ? `收起${foldLabel} ▴`
          : `${foldLabel}（还有 ${items.length - LIST_LIMIT} 条，点击展开）▾`}
      </button>
      {open ? (
        <Stack gap="tight">
          {items.slice(LIST_LIMIT).map((node, idx) => (
            <div key={idx}>{node}</div>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function ArtifactDetails({ snap }: { snap: SnapshotRecordDto }) {
  const parsed = parseStageArtifact(snap.artifactType, snap.artifactDetails);

  const missingBanner =
    parsed.missingFields.length > 0 ? (
      <Callout tone="warn" title="部分结构化字段缺失（已启用前端容错展示）">
        缺失字段：{parsed.missingFields.join(', ')}
      </Callout>
    ) : null;

  const rationaleBlock =
    parsed.agentRationale || parsed.keyDecisions.length > 0 ? (
      <Stack gap="tight">
        {parsed.agentRationale ? (
          <Callout tone="info" title="Agent 自述与推理依据 (G1)">
            {parsed.agentRationale}
          </Callout>
        ) : null}
        {parsed.keyDecisions.length > 0 ? (
          <>
            <SectionLabel>关键权衡决策 ({parsed.keyDecisions.length})</SectionLabel>
            {parsed.keyDecisions.map((kd, idx) => (
              <Card key={idx} inset title={kd.decision} subtitle={kd.rationale}>
                {kd.tradeoffs.length > 0 ? (
                  <Inline wrap>
                    {kd.tradeoffs.map((t, i) => (
                      <StatusChip key={i} tone="neutral">
                        {t}
                      </StatusChip>
                    ))}
                  </Inline>
                ) : null}
              </Card>
            ))}
          </>
        ) : null}
      </Stack>
    ) : null;

  if (parsed.kind === 'PRD') {
    const storyCards = parsed.userStories.map((s) => (
      <Card key={s.reqId} inset title={`[${s.reqId}] ${s.story}`}>
        <ul className="m-bullet-list">
          {s.acceptanceCriteria.map((ac, i) => (
            <li key={i}>{ac}</li>
          ))}
        </ul>
      </Card>
    ));
    const eventCards = parsed.trackingPlanEvents.map((ev) => (
      <Card
        key={ev.eventName}
        inset
        title={<code>{ev.eventName}</code>}
        subtitle={ev.triggerCondition}
      >
        <Text variant="xs" tone="tertiary">
          属性字段：{ev.properties.join(', ')}
        </Text>
      </Card>
    ));

    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <div className="inspector-grid">
          <Stack gap="tight">
            <SectionLabel>User Stories &amp; 验收标准 ({parsed.userStories.length})</SectionLabel>
            {storyCards.length > 0 ? (
              <FoldedList items={storyCards} foldLabel="展开其余 User Stories" />
            ) : (
              <EmptyState compact title="暂无 User Stories 数据" />
            )}
          </Stack>
          <Stack gap="tight">
            <SectionLabel>
              前置数据埋点规划 Tracking Plan ({parsed.trackingPlanEvents.length})
            </SectionLabel>
            {eventCards.length > 0 ? (
              <FoldedList items={eventCards} foldLabel="展开其余埋点事件" />
            ) : (
              <EmptyState compact title="暂无埋点规划" />
            )}
            <SectionLabel>非功能与历史避坑约束</SectionLabel>
            <Stack gap="tight">
              {parsed.nonFunctionalConstraints.map((c, i) => (
                <Text key={i} variant="xs" tone="secondary">
                  • {c}
                </Text>
              ))}
            </Stack>
          </Stack>
        </div>
      </Stack>
    );
  }

  if (parsed.kind === 'UI_DESIGN') {
    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <div className="inspector-grid">
          <Stack gap="tight">
            <SectionLabel>
              企业 Design System 组件映射 ({parsed.componentMappings.length})
            </SectionLabel>
            <FoldedList
              foldLabel="展开其余组件映射"
              items={parsed.componentMappings.map((m) => (
                <Card
                  key={m.reqId}
                  inset
                  title={`[${m.reqId}] → ${m.designSystemComponent}`}
                  subtitle={`交互状态机: ${m.interactionStates.join(' · ')}`}
                >
                  <Inline wrap>
                    {m.interactionStates.map((st) => (
                      <StatusChip key={st} tone="brand">
                        {st}
                      </StatusChip>
                    ))}
                  </Inline>
                </Card>
              ))}
            />
          </Stack>
          <Stack gap="tight">
            <SectionLabel>无障碍与交互规范</SectionLabel>
            {parsed.accessibilityChecklist.map((item, i) => (
              <Card key={i} inset>
                <Text variant="sm">{item}</Text>
              </Card>
            ))}
          </Stack>
        </div>
      </Stack>
    );
  }

  if (parsed.kind === 'TECH_SPEC') {
    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <div className="inspector-grid">
          <Stack gap="tight">
            <SectionLabel>OpenAPI 接口契约 ({parsed.apiContracts.length})</SectionLabel>
            <FoldedList
              foldLabel="展开其余接口契约"
              items={parsed.apiContracts.map((api) => (
                <Card
                  key={`${api.method}-${api.endpoint}`}
                  inset
                  title={
                    <Inline>
                      <StatusChip tone="brand">{api.method}</StatusChip>
                      <code>{api.endpoint}</code>
                    </Inline>
                  }
                  subtitle={`Req: ${api.requestSchema} → Res: ${api.responseSchema}`}
                >
                  <KeyValueList
                    items={[
                      { key: '请求 Schema', value: <code>{api.requestSchema}</code> },
                      { key: '响应 Schema', value: <code>{api.responseSchema}</code> },
                    ]}
                  />
                </Card>
              ))}
            />
            <SectionLabel>采用的架构设计模式</SectionLabel>
            <Inline wrap>
              {parsed.architecturePatternsUsed.map((p) => (
                <StatusChip key={p} tone="violet">
                  {p}
                </StatusChip>
              ))}
            </Inline>
          </Stack>
          <Stack gap="tight">
            <SectionLabel>
              数据库 DDL 变更脚本 ({parsed.databaseDdlStatements.length} 条)
            </SectionLabel>
            <pre className="code-preview-block">
              {parsed.databaseDdlStatements.length > 0
                ? parsed.databaseDdlStatements.join('\n\n')
                : '-- 无数据库表结构 DDL 变更 (低风险)'}
            </pre>
          </Stack>
        </div>
      </Stack>
    );
  }

  if (parsed.kind === 'CODE_IMPL') {
    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <Inline>
          <StatusChip tone="cyan" dot>
            Worktree 分支：{parsed.gitWorktreeBranch || '未提供'}
          </StatusChip>
          {parsed.selfTestPassed !== null ? (
            <StatusChip tone={parsed.selfTestPassed ? 'success' : 'danger'} dot>
              {parsed.selfTestPassed ? '沙箱自测通过' : '沙箱自测存在失败'}
            </StatusChip>
          ) : null}
        </Inline>
        <DataTable
          columns={[
            {
              key: 'filePath',
              header: '修改文件',
              render: (row) => <code>{row.filePath}</code>,
            },
            {
              key: 'className',
              header: '类 / 模块',
              render: (row) => row.className,
            },
            {
              key: 'designPattern',
              header: '设计模式',
              render: (row) => <StatusChip tone="violet">{row.designPattern}</StatusChip>,
            },
            {
              key: 'linesChanged',
              header: '变更行数',
              numeric: true,
              render: (row) => `+${row.linesChanged}`,
            },
          ]}
          rows={parsed.modifiedFiles}
          rowKey={(row, idx) => `${row.filePath}-${idx}`}
          empty={<EmptyState compact title="暂无文件变更列表" />}
        />
      </Stack>
    );
  }

  if (parsed.kind === 'QA') {
    const secIssues = parsed.securityIssuesFound ?? 0;
    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <Inline wrap>
          <StatusChip tone={secIssues === 0 ? 'success' : 'danger'} dot>
            高危安全漏洞：{secIssues} 个
          </StatusChip>
          <StatusChip tone={parsed.allAcceptanceCriteriaMet ? 'success' : 'warn'} dot>
            全部验收标准达成：{parsed.allAcceptanceCriteriaMet ? 'YES' : 'NO'}
          </StatusChip>
        </Inline>
        <DataTable
          columns={[
            { key: 'suiteName', header: '测试套件', render: (s) => <strong>{s.suiteName}</strong> },
            {
              key: 'passed',
              header: '通过 / 总计',
              numeric: true,
              render: (s) => `${s.passedCases}/${s.totalCases}`,
            },
            {
              key: 'coverage',
              header: '行覆盖率',
              numeric: true,
              render: (s) => (
                <StatusChip tone={s.coveragePercent >= 80 ? 'success' : 'warn'}>
                  {s.coveragePercent}%
                </StatusChip>
              ),
            },
          ]}
          rows={parsed.testSuitesExecuted}
          rowKey={(s, i) => `${s.suiteName}-${i}`}
          empty={<EmptyState compact title="暂无测试套件执行数据" />}
        />
      </Stack>
    );
  }

  if (parsed.kind === 'DATA_ANALYSIS') {
    return (
      <Stack gap="normal">
        {missingBanner}
        {rationaleBlock}
        <SectionLabel>已核验前置埋点事件 ({parsed.verifiedTrackingEvents.length})</SectionLabel>
        <Inline wrap>
          {parsed.verifiedTrackingEvents.map((evt) => (
            <StatusChip key={evt} tone="success" dot>
              <code>{evt}</code>
            </StatusChip>
          ))}
        </Inline>
        <SectionLabel>上线指标与效果基线投影</SectionLabel>
        <DataTable
          columns={[
            {
              key: 'metricName',
              header: '核心指标',
              render: (m) => <strong>{m.metricName}</strong>,
            },
            { key: 'baselineValue', header: '当前基线', render: (m) => m.baselineValue },
            {
              key: 'targetValue',
              header: '目标基准',
              render: (m) => <StatusChip tone="success">{m.targetValue}</StatusChip>,
            },
          ]}
          rows={parsed.projectedMetrics}
          rowKey={(m, i) => `${m.metricName}-${i}`}
          empty={<EmptyState compact title="暂无指标投影" />}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="normal">
      <Callout tone="neutral" title={`通用契约产物 (${snap.artifactType})`}>
        {snap.artifactSummary}
      </Callout>
      <details className="raw-fold" open>
        <summary>原始结构化交付物 JSON</summary>
        <pre className="code-preview-block">{JSON.stringify(parsed.rawDetails, null, 2)}</pre>
      </details>
    </Stack>
  );
}
