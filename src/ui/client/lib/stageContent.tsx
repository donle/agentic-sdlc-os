/**
 * @file stageContent.tsx
 * @description 阶段业务内容组件：Agent 执行动作分解与跨 Agent 讨论过程/结论。
 * 原 StageDisplayFormatter 中的业务文案表在此以数据 + JSX 声明式呈现。
 */

import type { NegotiationTurnDto, SnapshotRecordDto } from '../types.ts';
import { stateBadge, stageMeta } from './display.ts';

interface StageAction {
  readonly title: string;
  readonly detail: string;
}

const ACTIONS_BY_STAGE: Record<string, ReadonlyArray<StageAction>> = {
  STAGE_1_PM: [
    {
      title: '1. 读取项目立项背景与核心诉求',
      detail: '解析立项提案中的核心需求条目、权限/数据库涉及范围与团队备注',
    },
    {
      title: '2. 结合团队历史评论与避坑经验校准边界',
      detail: '自动载入历史同类需求评审意见，规避需求遗漏或边界不清问题',
    },
    {
      title: '3. 拆解结构化 User Stories 与量化验收标准 (AC)',
      detail: '为每项核心业务诉求生成用户故事、响应耗时指标与异常处理要求',
    },
    {
      title: '4. 与 DA Agent 协同产出《前置数据埋点规划》',
      detail: '在需求阶段前置定义核心交互埋点事件与属性字段，确保上线后可量化评估',
    },
  ],
  STAGE_2_PD: [
    {
      title: '1. 解析上游已生效的 PRD 与用户故事',
      detail: '提取所有用户交互触点、角色操作路径与极端状态（空状态、加载态、异常提示）',
    },
    {
      title: '2. 映射企业 Design System 标准 UI 组件库',
      detail: '将业务功能映射为标准组件（如权限矩阵表格、画布/抽屉容器、无障碍键盘导航）',
    },
    {
      title: '3. 与 PM Agent 进行交互可行性与排期对齐讨论',
      detail: '针对高复杂度交互组件发起跨角色讨论，评估标准组件方案与定制开发方案的利弊',
    },
    {
      title: '4. 生成 UI/UX 交互规范与讨论结论供团队审阅',
      detail: '汇总组件映射清单与方案对比，交由体验设计师与产品经理确认',
    },
  ],
  STAGE_3A_TECH_SPEC: [
    {
      title: '1. 承接上游 PRD 与已确认的 UI 交互方案',
      detail: '对齐前后端数据交互字段、权限校验粒度与接口幂等性要求',
    },
    {
      title: '2. 制定 OpenAPI 接口契约与面向对象架构模式',
      detail: '定义 REST 接口入参/出参 Schema，选定 Template Method / Strategy 等解耦模式',
    },
    {
      title: '3. 设计数据库表结构变更 (DDL) 并评估变更风险',
      detail: '编写 SQL 迁移脚本；若包含表结构变更或涉及权限核心域，自动请求架构师把关',
    },
    {
      title: '4. 锁定技术方案契约并准备移交编码沙箱',
      detail: '确保在 Engineer Agent 写代码前先鎖定接口与表结构，避免下游返工',
    },
  ],
  STAGE_3B_ENGINEER: [
    {
      title: '1. 创建独立的 Git Worktree 隔离沙箱分支',
      detail: '切出独立沙箱工作分支，确保不污染主干代码',
    },
    {
      title: '2. 严格依据步骤 3a 的技术契约编写领域服务代码',
      detail: '生成面向对象业务类文件、数据库迁移脚本及前置定义的埋点触发逻辑',
    },
    {
      title: '3. 编写配套自动化单元测试并执行本地编译自检',
      detail: '为每个新增业务模块生成单元测试用例，确保编译与基础断言自测通过',
    },
    {
      title: '4. 提交沙箱代码分支至 QA Agent 进行质量验证',
      detail: '冻结本轮代码产物快照，触发下游自动化测试与安全扫描',
    },
  ],
  STAGE_4_QA: [
    {
      title: '1. 对照步骤 1 的 PRD 验收标准 (AC) 生成测试计划',
      detail: '覆盖正向业务路径、权限越权边界、异常输入与回归测试场景',
    },
    {
      title: '2. 在隔离沙箱中执行单元测试与接口集成测试套件',
      detail: '实测所有生成模块的方法调用、审计事件触发与行覆盖率指标',
    },
    {
      title: '3. 执行静态代码安全漏洞扫描',
      detail: '扫描沙箱代码是否存在动态代码执行 (eval) 或硬编码密钥泄露等安全隐患',
    },
    {
      title: '4. 出具质量验收报告并提交上线前终审',
      detail: '汇总测试通过率与覆盖率，交由测试负责人签字放行',
    },
  ],
  STAGE_5_DA: [
    {
      title: '1. 核验步骤 1 定义的前置埋点事件在代码中的覆盖率',
      detail: '逐项比对 Tracking Plan 事件名与沙箱实现代码中的埋点触发点',
    },
    {
      title: '2. 构建业务转化率与系统性能监控基线',
      detail: '设定上线后核心功能采纳率、审批耗时与 P95 响应延迟目标基线',
    },
    {
      title: '3. 产出项目全流程交付效能与效果复盘报告',
      detail: '完成从立项提案到上线归因的研发全闭环沉淀',
    },
  ],
};

interface StageDiscussionInfo {
  readonly partnerAgents: string;
  readonly dialogueA: string;
  readonly dialogueB: string;
  readonly conclusion: (snap: SnapshotRecordDto) => string;
}

const STAGE_DISCUSSIONS: Record<string, StageDiscussionInfo> = {
  STAGE_1_PM: {
    partnerAgents: 'PM Agent ↔ DA Agent (数据分析师)',
    dialogueA:
      '📋 PM Agent：已将业务立项拆解为结构化 User Stories，请 DA Agent 同步确认每个核心交互节点的埋点事件定义。',
    dialogueB:
      '📊 DA Agent：已核对所有 User Stories，同步绑定了 `run_id`、`branch_id`、`actor_role`、`latency_ms` 四个标准归因属性，上线后可直接对接转化漏斗看板。',
    conclusion: (snap) => {
      const reqIds = (snap.artifactDetails.coreRequirementIds as string[] | undefined) ?? [];
      return `【已达成共识结论】完成 ${reqIds.length || 3} 项核心需求的 PRD 验收标准与前置埋点方案对齐，无需求范围缺失。`;
    },
  },
  STAGE_2_PD: {
    partnerAgents: 'PD Agent ↔ PM Agent (产品经理)',
    dialogueA:
      '🎨 PD Agent：已将 PRD 中的用户故事映射为企业标准组件库组件，并补充了空状态、加载骨架屏与键盘无障碍规范。',
    dialogueB: '📋 PM Agent：确认 UI 组件映射完整覆盖了所有验收标准 (AC)，未发生核心业务需求删减。',
    conclusion: () =>
      '【已达成共识结论】UI 交互状态机与企业 Design System 组件映射已全量对齐，可直接移交架构师进行接口契约设计。',
  },
  STAGE_3A_TECH_SPEC: {
    partnerAgents: 'Tech Lead Agent ↔ PD Agent & Engineer Agent',
    dialogueA:
      '🏛️ Tech Lead Agent：基于上游 PRD 与 UI 组件状态机，已定义 RESTful OpenAPI 接口契约与数据库 Schema 变更脚本。',
    dialogueB:
      '💻 Engineer Agent：已确认接口入参/出参契约及面向对象设计模式约束，可在独立 Git Worktree 沙箱中无歧义实现领域服务类。',
    conclusion: (snap) =>
      snap.riskScore >= 60
        ? `【高风险技术方案结论】本步骤包含数据库 DDL 表结构变更与权限安全域设计（风险评分 ${snap.riskScore}/100），已输出完整 SQL 脚本并由架构师把关确认。`
        : '【常规技术方案结论】接口契约清晰且不涉及破坏性数据库表结构变更，技术方案已锁定生效。',
  },
  STAGE_3B_ENGINEER: {
    partnerAgents: 'Engineer Agent ↔ Tech Lead Agent',
    dialogueA: `💻 Engineer Agent：已在隔离沙箱分支完成领域服务类与单元测试编写，本地编译自测通过。`,
    dialogueB:
      '🏛️ Tech Lead Agent：代码结构校验通过，严格遵循了步骤 3a 约定的面向对象设计模式与埋点事件命名规范。',
    conclusion: () =>
      '【代码实现结论】所有核心需求模块已在隔离沙箱落盘并通过自测，代码分支已移交 QA Agent 进行自动化验收。',
  },
  STAGE_4_QA: {
    partnerAgents: 'QA Agent ↔ Engineer Agent',
    dialogueA:
      '🛡️ QA Agent：已在沙箱对步骤 3b 提交的代码执行了契约单元测试、集成回归测试与静态安全漏洞扫描。',
    dialogueB:
      '💻 Engineer Agent：所有边界条件断言均一次性通过（行覆盖率 95.6%，高危漏洞 0 个），无需打回返工修复。',
    conclusion: () =>
      '【质量验收结论】沙箱自动化测试 100% 通过且无安全隐患，已满足步骤 1 定义的全部验收标准 (AC)，具备上线发布条件。',
  },
  STAGE_5_DA: {
    partnerAgents: 'DA Agent ↔ PM Agent',
    dialogueA:
      '📊 DA Agent：已完成线上埋点事件覆盖率核验（覆盖率 100%），并构建了功能采纳率与响应延迟基线模型。',
    dialogueB:
      '📋 PM Agent：数据监控闭环已确认，后续如发现转化指标波动可一键基于本报告发起下一轮迭代。',
    conclusion: () => '【数据复盘结论】前置埋点全量校验通过，项目从提案到上线归因闭环已全部完成。',
  },
};

function supersededList(
  stageId: string,
  snap: SnapshotRecordDto,
  all: ReadonlyArray<SnapshotRecordDto>,
) {
  const superseded = all.filter((s) => s.stageId === stageId && s.state === 'SUPERSEDED');
  if (superseded.length === 0) {
    return null;
  }
  return (
    <div className="conclusion-history-box" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, color: '#38bdf8', fontSize: 12.5 }}>
        🔄 版本演进与历史回退结论记录 (共经历 {superseded.length + 1} 个迭代版本)：
      </div>
      <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
        {superseded.map((old) => (
          <li key={old.snapshotId}>
            <strong>旧分支 [{old.branchId}] 历史结论：</strong>
            {old.artifactSummary}{' '}
            <span className="pill pill-muted" style={{ fontSize: 10 }}>
              已根据团队评论演进至新分支
            </span>
          </li>
        ))}
        <li>
          <strong>当前活跃分支 [{snap.branchId}] 最新结论：</strong>
          {snap.artifactSummary}
        </li>
      </ul>
    </div>
  );
}

/** Agent 在做什么：执行动作分解（动作分解进抽屉时使用） */
export function AgentWorkActivity({
  stageId,
  snap,
}: {
  stageId: string;
  snap?: SnapshotRecordDto;
}) {
  const meta = stageMeta(stageId);
  if (!snap) {
    return (
      <div className="agent-activity-card waiting-card">
        <div className="agent-activity-header">
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {meta.agentDisplayName} — 处于待命状态
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              目标职责：{meta.stepGoal}
            </div>
          </div>
          <span className="pill pill-muted">⚪ 等待前序步骤确认后启动</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10 }}>
          当前项目正在等待前序步骤完成团队确认。前序步骤一旦放行，
          <strong>{meta.agentDisplayName}</strong> 将自动接收上游交付物并开始执行本步骤工作。
        </div>
      </div>
    );
  }

  const steps = ACTIONS_BY_STAGE[stageId] ?? [];
  const isWaitingHuman = snap.state === 'PENDING_HUMAN_GATE';
  const badge = stateBadge(snap.state, snap.cacheHit);

  return (
    <div className="agent-activity-card">
      <div className="agent-activity-header">
        <div>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{meta.agentDisplayName}</span>
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-secondary)' }}>
              · 协同责任人: {meta.specialistLabel}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: '#93c5fd', marginTop: 4 }}>
            <strong>当前工作状态：</strong>
            {snap.artifactSummary}
          </div>
        </div>
        <span className={badge.pillClass}>{badge.label}</span>
      </div>
      <div className="agent-action-timeline">
        {steps.map((act, idx) => {
          const isLastAndWaiting = isWaitingHuman && idx === steps.length - 1;
          return (
            <div className="action-step-row" key={act.title}>
              <span className={`action-step-icon ${isLastAndWaiting ? 'waiting' : 'done'}`}>
                {isLastAndWaiting ? '⏳' : '✓'}
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{act.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{act.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Agent 间讨论过程与历史结论 */
export function AgentDiscussion({
  stageId,
  snap,
  negotiationLogs,
  allSnapshots,
}: {
  stageId: string;
  snap?: SnapshotRecordDto;
  negotiationLogs: ReadonlyArray<NegotiationTurnDto>;
  allSnapshots: ReadonlyArray<SnapshotRecordDto>;
}) {
  if (!snap) {
    return (
      <div className="diagnosis-item">
        本阶段尚未启动，待 Agent 执行后将在此展示跨角色讨论过程与结论。
      </div>
    );
  }

  const historyEvolution = supersededList(stageId, snap, allSnapshots);

  // Stage 2 存在真实 PM-PD 多轮协商记录时展示完整博弈过程
  if (stageId === 'STAGE_2_PD' && negotiationLogs.length > 0) {
    const latestTurn = negotiationLogs[negotiationLogs.length - 1];
    const concluded = snap.state === 'APPROVED';
    return (
      <>
        {historyEvolution}
        <div className="col-stack" style={{ gap: 10 }}>
          {negotiationLogs.map((turn) => (
            <div className="discussion-turn-card" key={turn.negotiationId}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <span className="pill pill-blue">
                  第 {turn.turnIndex}/{turn.maxTurnsAllowed} 轮跨岗位讨论 · {turn.challengerRole} ↔{' '}
                  {turn.responderRole}
                </span>
                <span
                  className={`pill ${turn.escalatedToSupervisor ? 'pill-amber' : 'pill-green'}`}
                >
                  {turn.escalatedToSupervisor ? '分歧上报团队裁决' : '自动对齐'}
                </span>
              </div>
              <div className="dialogue-bubble challenger-bubble">
                <strong>🎨 PD Agent (体验设计师) 发起交互质询：</strong>
                <div style={{ marginTop: 3 }}>{turn.challengePoint}</div>
              </div>
              <div className="dialogue-bubble responder-bubble" style={{ marginTop: 6 }}>
                <strong>📋 PM Agent (产品经理) 响应与评估：</strong>
                <div style={{ marginTop: 3 }}>{turn.responseResolution}</div>
              </div>
            </div>
          ))}
          <div
            className={`historical-conclusion-banner ${latestTurn.escalatedToSupervisor ? 'pending-arbitration' : 'consensus-ok'}`}
          >
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>
              📌 本步骤 Agent 讨论历史结论摘要：
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginBottom: 8 }}>
              {latestTurn.escalatedToSupervisor
                ? concluded
                  ? '✅ 经 PD Agent 与 PM Agent 3 轮讨论并由团队责任人最终拍板，已选定交互实现方案并冻结设计规范。'
                  : '⚠️ PD Agent 与 PM Agent 围绕“高复杂度三维拓扑画布 vs 企业标准双栏折叠抽屉”进行了 3 轮讨论，总管 Agent 已提炼出以下两套备选结论供团队拍板：'
                : '✅ PD Agent 与 PM Agent 已在讨论中达成一致，交互规范符合现有组件库约束且未删减核心业务需求。'}
            </div>
            <div className="inspector-grid">
              <div
                className="artifact-subcard"
                style={{ borderLeft: '3px solid var(--status-green)' }}
              >
                <strong>{latestTurn.optionAProposal}</strong>
              </div>
              <div
                className="artifact-subcard"
                style={{ borderLeft: '3px solid var(--status-amber)' }}
              >
                <strong>{latestTurn.optionBProposal}</strong>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  const info = STAGE_DISCUSSIONS[stageId] ?? STAGE_DISCUSSIONS.STAGE_1_PM;
  return (
    <>
      {historyEvolution}
      <div className="discussion-turn-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <span className="pill pill-blue">跨角色工作流协同交互 · {info.partnerAgents}</span>
          <span className="pill pill-green">已达成结构化共识</span>
        </div>
        <div className="dialogue-bubble challenger-bubble">{info.dialogueA}</div>
        <div className="dialogue-bubble responder-bubble" style={{ marginTop: 6 }}>
          {info.dialogueB}
        </div>
        <div className="historical-conclusion-banner consensus-ok" style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>
            📌 本步骤 Agent 讨论历史结论：
          </div>
          <div style={{ fontSize: 12.5 }}>{info.conclusion(snap)}</div>
        </div>
      </div>
    </>
  );
}
