/**
 * @file ProjectsHubView.tsx
 * @description 项目总览大厅：Meridian UI Kit 卡片化展示全部运行实例进度、状态与分支。
 */

import {
  Button,
  Card,
  EmptyState,
  Inline,
  Meter,
  Panel,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { personaFor } from '../lib/agentPersona.ts';
import { stageMeta } from '../lib/display.ts';
import type { DashboardStateDto } from '../types.ts';

function statusMeta(status: string): {
  readonly label: string;
  readonly tone: 'success' | 'danger' | 'warn' | 'brand';
} {
  switch (status) {
    case 'COMPLETED':
      return { label: '✅ 已交付', tone: 'success' };
    case 'ABORTED':
      return { label: '❌ 契约熔断·待重试', tone: 'danger' };
    case 'ABORTED_TOKEN_BUDGET':
      return { label: '⚠️ 预算熔断·待扩容', tone: 'danger' };
    case 'PAUSED_AT_HUMAN_GATE':
      return { label: '⏳ 待人工确认', tone: 'warn' };
    default:
      return { label: '🔄 推进中', tone: 'brand' };
  }
}

export function ProjectsHubView({
  state,
  onEnterRun,
}: {
  state: DashboardStateDto;
  onEnterRun: (runId: string) => void;
}) {
  const currentRunId = state.run?.runId;
  const runs = state.allRunsList ?? [];

  return (
    <Panel
      title="企业研发项目总览大厅"
      subtitle={`共 ${runs.length} 个托管运行实例，点击任意卡片进入多智能体协同工作区`}
    >
      {runs.length === 0 ? (
        <EmptyState
          icon="folder"
          title="暂无运行中的研发项目"
          description="点击顶部【+ 发起新项目】按钮发起企业研发提案。"
        />
      ) : (
        <div className="project-portfolio-grid">
          {runs.map((item) => {
            const isCurrent = item.runId === currentRunId;
            const completed = item.completedStagesCount ?? 1;
            const total = item.totalStagesCount ?? 6;
            const percent = Math.min(100, Math.round((completed / total) * 100));
            const stageInfo = item.currentStageId ? stageMeta(item.currentStageId) : null;
            const stagePersona = personaFor(item.currentStageId ?? 'STAGE_5_DA');
            const badge = statusMeta(item.status);

            return (
              <Card
                key={item.runId}
                className={isCurrent ? 'project-card-current' : undefined}
                title={
                  <Inline className="m-between" wrap>
                    <Inline>
                      <AgentAvatar
                        roleOrStage={item.currentStageId ?? 'SUPERVISOR_AGENT'}
                        size="sm"
                        mood={
                          item.status === 'PAUSED_AT_HUMAN_GATE'
                            ? 'waiting'
                            : item.status === 'COMPLETED'
                              ? 'celebrating'
                              : 'working'
                        }
                        showMoodBadge
                      />
                      <Text variant="h3" clamp="1">
                        {item.title}
                      </Text>
                    </Inline>
                    <StatusChip tone={badge.tone} dot>
                      {badge.label}
                    </StatusChip>
                  </Inline>
                }
                subtitle={`当前值守：${stagePersona.personName} (${stagePersona.codename}) · 编号 ${item.runId} · 发起人 ${item.initiatorActor}`}
                footer={
                  <Inline className="m-between" wrap>
                    <Inline>
                      <StatusChip tone="brand">分支: {item.activeBranchId}</StatusChip>
                      <StatusChip tone="cyan">💬 {item.commentsCount ?? 0} 条评论</StatusChip>
                    </Inline>
                    <Button
                      size="sm"
                      variant={isCurrent ? 'success' : 'primary'}
                      onClick={() => onEnterRun(item.runId)}
                    >
                      {isCurrent ? '正在查看 · 进入工作区 →' : '进入项目分步协同工作区 →'}
                    </Button>
                  </Inline>
                }
              >
                <Stack gap="tight">
                  <Text variant="sm" tone="secondary" clamp="2">
                    {item.summary}
                  </Text>
                  <Stack gap="tight">
                    <Inline className="m-between">
                      <Text variant="xs" tone="secondary">
                        当前推进步骤：
                        <strong>{stageInfo ? stageInfo.name : '已完成全部步骤'}</strong>
                      </Text>
                      <Text variant="xs" mono>
                        {completed}/{total} 步 ({percent}%)
                      </Text>
                    </Inline>
                    <Meter
                      value={percent}
                      max={100}
                      tone={item.status === 'COMPLETED' ? 'success' : 'brand'}
                      label={`进度 ${percent}%`}
                    />
                  </Stack>
                </Stack>
              </Card>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
