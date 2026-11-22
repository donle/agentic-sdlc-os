/**
 * @file DagSupervisorView.tsx
 * @description 总管对话调度与版本演进历史：自然语言回退表单 + 分支演化 + 人为决策时间轴。
 */

import { useState } from 'react';
import type { DashboardStateDto } from '../types.ts';
import { BranchEvolution } from '../components/BranchEvolution.tsx';
import { DecisionTimeline } from '../components/DecisionTimeline.tsx';

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
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>总管 Agent (Supervisor) 自然语言调度与多分支版本演进历史</span>
        </div>
        <span className="pill pill-cyan">历史版本完整保留 · 零覆盖污染</span>
      </div>
      <div className="supervisor-form">
        <div className="form-row">
          <select
            className="select-control"
            value={stageId}
            onChange={(ev) => setStageId(ev.target.value)}
          >
            <option value="">自动从自然语言识别目标步骤与 Agent</option>
            <option value="STAGE_1_PM">回到步骤 1: PM Agent (产品需求与埋点)</option>
            <option value="STAGE_2_PD">回到步骤 2: PD Agent (UI 交互设计)</option>
            <option value="STAGE_3A_TECH_SPEC">回到步骤 3a: Tech Lead Agent (架构与表设计)</option>
            <option value="STAGE_3B_ENGINEER">回到步骤 3b: Engineer Agent (代码实现)</option>
            <option value="STAGE_4_QA">回到步骤 4: QA Agent (自动化测试)</option>
          </select>
          <input
            type="text"
            className="input-control"
            value={instruction}
            onChange={(ev) => setInstruction(ev.target.value)}
            placeholder="输入给总管 Agent 的回退重做指令..."
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => instruction.trim() && onSendRollback(stageId, instruction.trim())}
          >
            向总管发送回退指令
          </button>
        </div>
      </div>

      <div className="dag-history-layout" style={{ marginTop: 16 }}>
        <div>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              marginBottom: 10,
              color: 'var(--text-secondary)',
            }}
          >
            项目各分支步骤版本演进全记录（被回退替换的旧版快照默认折叠）：
          </div>
          <BranchEvolution
            snapshots={state.run?.snapshots ?? []}
            branches={state.run?.branches ?? []}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              marginBottom: 10,
              color: 'var(--text-secondary)',
            }}
          >
            项目的全部人为决策与回退操作记录：
          </div>
          <DecisionTimeline decisions={state.humanDecisions ?? []} />
        </div>
      </div>
    </section>
  );
}
