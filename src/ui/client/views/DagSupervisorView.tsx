/**
 * @file DagSupervisorView.tsx
 * @description 总管对话调度与版本演进历史（Meridian UI Kit）：自然语言回退 + 分支演化 + 人为决策时间轴。
 */

import { useState } from 'react';
import {
  Button,
  Card,
  Inline,
  Input,
  Panel,
  SectionLabel,
  Select,
  Stack,
  StatusChip,
} from '../../kit/index.ts';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { BranchEvolution } from '../components/BranchEvolution.tsx';
import { DecisionTimeline } from '../components/DecisionTimeline.tsx';
import type { DashboardStateDto } from '../types.ts';

const STAGE_ROLLBACK_OPTIONS = [
  { value: '', label: '自动从自然语言识别目标步骤与 Agent' },
  { value: 'STAGE_1_PM', label: '回到步骤 1: PM Agent (产品需求与埋点)' },
  { value: 'STAGE_2_PD', label: '回到步骤 2: PD Agent (UI 交互设计)' },
  { value: 'STAGE_3A_TECH_SPEC', label: '回到步骤 3a: Tech Lead Agent (架构与表设计)' },
  { value: 'STAGE_3B_ENGINEER', label: '回到步骤 3b: Engineer Agent (代码实现)' },
  { value: 'STAGE_4_QA', label: '回到步骤 4: QA Agent (自动化测试)' },
] as const;

export function DagSupervisorView({
  state,
  onSendRollback,
}: {
  state: DashboardStateDto;
  onSendRollback: (targetStageId: string, instruction: string) => void;
}) {
  const [stageId, setStageId] = useState('');
  const [instruction, setInstruction] = useState(
    '回退到 PD Agent，把交互布局改为右侧双栏折叠抽屉并重新执行下游阶段',
  );

  return (
    <Panel
      title={
        <Inline>
          <AgentAvatar roleOrStage="SUPERVISOR_AGENT" size="sm" mood="working" showSpeakingWaves />
          <span>林总管 (Supervisor Agent) 自然语言调度与多分支版本演进历史</span>
        </Inline>
      }
      subtitle="任何回退都会基于父节点衍生独立 DAG 分支，旧分支快照永久不可变留档"
      actions={
        <StatusChip tone="cyan" dot>
          历史版本完整保留 · 零覆盖污染
        </StatusChip>
      }
    >
      <Stack gap="loose">
        <Card inset title="向总管下达自然语言回退与分叉重做指令">
          <div className="form-row">
            <Select
              ariaLabel="选择目标回退步骤"
              value={stageId}
              options={[...STAGE_ROLLBACK_OPTIONS]}
              onChange={setStageId}
            />
            <Input
              ariaLabel="总管回退指令内容"
              value={instruction}
              onChange={setInstruction}
              placeholder="输入给总管 Agent 的回退重做指令..."
            />
            <Button
              variant="primary"
              disabled={!instruction.trim()}
              onClick={() => instruction.trim() && onSendRollback(stageId, instruction.trim())}
            >
              向总管发送回退指令
            </Button>
          </div>
        </Card>

        <div className="dag-history-layout">
          <Stack gap="tight">
            <SectionLabel>项目各分支步骤版本演进全记录（旧版快照默认折叠）</SectionLabel>
            <BranchEvolution
              snapshots={state.run?.snapshots ?? []}
              branches={state.run?.branches ?? []}
            />
          </Stack>
          <Stack gap="tight">
            <SectionLabel>全部人为决策与回退操作时间轴</SectionLabel>
            <DecisionTimeline decisions={state.humanDecisions ?? []} />
          </Stack>
        </div>
      </Stack>
    </Panel>
  );
}
