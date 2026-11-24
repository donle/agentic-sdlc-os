/**
 * @file AuditRagView.tsx
 * @description 协同动态（审计账本）与团队避坑经验知识库（Meridian UI Kit 视图）。
 */

import { useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  Inline,
  Input,
  ListRow,
  Panel,
  Select,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import { auditActorIcon, formatRelativeTime } from '../lib/display.ts';
import type { DashboardStateDto, RagQueryMatchDto } from '../types.ts';

const AUDIT_LIMIT = 8;

const RAG_STAGE_OPTIONS = [
  { value: 'STAGE_1_PM', label: '步骤 1: PM 需求与埋点' },
  { value: 'STAGE_2_PD', label: '步骤 2: PD 交互设计' },
  { value: 'STAGE_3A_TECH_SPEC', label: '步骤 3a: Tech Lead 架构与表设计' },
  { value: 'STAGE_3B_ENGINEER', label: '步骤 3b: Engineer 代码实现' },
  { value: 'STAGE_4_QA', label: '步骤 4: QA 自动化测试' },
] as const;

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
      <Panel
        title="项目全链路协同动态与签核记录"
        actions={
          <StatusChip tone="brand" dot>
            全员透明可追溯 · 共 {auditEntries.length} 条
          </StatusChip>
        }
      >
        <Stack gap="tight">
          {visible.length === 0 ? (
            <EmptyState compact title="暂无审计动态记录" />
          ) : (
            visible.map((entry) => (
              <ListRow
                key={entry.entryId}
                leading={<span>{auditActorIcon(entry.actionType)}</span>}
                title={entry.summary}
                meta={`${entry.actor} · ${entry.actionType} · ${formatRelativeTime(entry.timestampIso)}`}
              />
            ))
          )}
          {auditEntries.length > AUDIT_LIMIT ? (
            <button
              type="button"
              className="link-toggle"
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded
                ? '收起审计记录 ▴'
                : `展开更早的 ${auditEntries.length - visible.length} 条审计记录 ▾`}
            </button>
          ) : null}
        </Stack>
      </Panel>

      <Panel
        title="团队历史评审避坑经验知识库"
        actions={
          <StatusChip tone="violet" dot>
            自动注入对应步骤 Agent
          </StatusChip>
        }
      >
        <Stack gap="normal">
          <Card inset title="检索或沉淀团队避坑规范">
            <Stack gap="tight">
              <div className="form-row">
                <Select
                  ariaLabel="选择避坑经验适用步骤"
                  value={ragStage}
                  options={[...RAG_STAGE_OPTIONS]}
                  onChange={setRagStage}
                />
                <Input
                  ariaLabel="历史经验关键词或新规内容"
                  value={ragText}
                  onChange={setRagText}
                  placeholder="输入关键词检索历史经验，或录入新的团队设计/架构红线..."
                />
              </div>
              <Inline wrap>
                <Button
                  size="sm"
                  variant="primary"
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
                </Button>
                <Button
                  size="sm"
                  variant="outline"
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
                </Button>
              </Inline>
            </Stack>
          </Card>

          {ragRecords.length === 0 ? (
            <EmptyState
              compact
              title="暂无匹配的团队历史经验"
              description="可点击【沉淀为团队共享避坑经验】补充团队级评审红线。"
            />
          ) : (
            <Stack gap="tight">
              {ragRecords.map((rec) => (
                <Card
                  key={rec.recordId}
                  inset
                  title={
                    <Inline className="m-between" wrap>
                      <Inline>
                        <StatusChip tone="violet">{rec.stageId}</StatusChip>
                        <Text variant="sm" as="strong">
                          {rec.recordId}
                        </Text>
                      </Inline>
                      {'similarityScore' in rec ? (
                        <StatusChip tone="success">相关度: {rec.similarityScore}</StatusChip>
                      ) : (
                        <StatusChip tone="cyan">已共享给对应 Agent</StatusChip>
                      )}
                    </Inline>
                  }
                >
                  <Text variant="sm" tone="secondary">
                    {rec.desensitizedLesson}
                  </Text>
                </Card>
              ))}
            </Stack>
          )}
        </Stack>
      </Panel>
    </div>
  );
}
