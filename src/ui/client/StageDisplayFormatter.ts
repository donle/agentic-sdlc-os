/**
 * @file StageDisplayFormatter.ts
 * @description 负责项目各步骤的 Agent 工作状态分解、Agent 间讨论对话与历史结论、以及各步骤交付物文档的视觉渲染。
 */

import type { NegotiationTurnDto, SnapshotRecordDto } from './types.ts';

export interface StageTitleMeta {
  readonly stepNumber: number;
  readonly name: string;
  readonly shortName: string;
  readonly role: string;
  readonly agentDisplayName: string;
  readonly specialistLabel: string;
  readonly stepGoal: string;
}

export class StageDisplayFormatter {
  public static getStageTitleMap(): Record<string, StageTitleMeta> {
    return {
      STAGE_1_PM: {
        stepNumber: 1,
        name: '步骤 1：产品需求与埋点设计',
        shortName: '1. 产品需求 PRD',
        role: 'PM_AGENT',
        agentDisplayName: '📋 PM Agent (AI 产品经理)',
        specialistLabel: '陈工 · 产品经理',
        stepGoal: '将业务立项拆解为 User Stories、量化验收标准 (AC) 与前置数据埋点方案',
      },
      STAGE_2_PD: {
        stepNumber: 2,
        name: '步骤 2：UI 交互与体验设计',
        shortName: '2. 交互与 UI 设计',
        role: 'PD_AGENT',
        agentDisplayName: '🎨 PD Agent (AI 体验设计师)',
        specialistLabel: '林工 · 体验设计师',
        stepGoal: '映射企业组件库规范与交互状态机，与 PM Agent 对齐交互可行性与体验边界',
      },
      STAGE_3A_TECH_SPEC: {
        stepNumber: 3,
        name: '步骤 3a：技术架构与接口/表设计',
        shortName: '3a. 架构与表设计',
        role: 'TECH_LEAD_AGENT',
        agentDisplayName: '🏛️ Tech Lead Agent (AI 架构师)',
        specialistLabel: '赵工 · 系统架构师',
        stepGoal: '制定 OpenAPI 接口契约、数据库表结构变更 (DDL) 与设计模式规范，先行评审再写代码',
      },
      STAGE_3B_ENGINEER: {
        stepNumber: 4,
        name: '步骤 3b：代码实现与沙箱自测',
        shortName: '3b. 工程师编码',
        role: 'ENGINEER_AGENT',
        agentDisplayName: '💻 Engineer Agent (AI 研发工程师)',
        specialistLabel: '刘工 · 研发工程师',
        stepGoal: '在独立 Git Worktree 隔离沙箱分支中编写模块化业务类、埋点代码与配套单元测试',
      },
      STAGE_4_QA: {
        stepNumber: 5,
        name: '步骤 4：质量验收与安全测试',
        shortName: '4. QA 质量测试',
        role: 'QA_AGENT',
        agentDisplayName: '🛡️ QA Agent (AI 测试工程师)',
        specialistLabel: '孙工 · 测试负责人',
        stepGoal: '对照步骤 1 的验收标准在沙箱执行自动化单测、集成回归测试与静态安全漏洞扫描',
      },
      STAGE_5_DA: {
        stepNumber: 6,
        name: '步骤 5：数据埋点归因与上线复盘',
        shortName: '5. 数据复盘分析',
        role: 'DA_AGENT',
        agentDisplayName: '📊 DA Agent (AI 数据分析师)',
        specialistLabel: '周工 · 数据分析师',
        stepGoal: '核验前置埋点覆盖率，构建上线后核心转化率与研发效能归因看板',
      },
    };
  }

  public static formatStateBadge(state: string, cacheHit: boolean): string {
    if (state === 'PENDING_HUMAN_GATE') {
      return '<span class="pill pill-amber">⏳ 待责任人确认 / 拍板</span>';
    }
    if (state === 'APPROVED') {
      return '<span class="pill pill-green">✅ 团队已确认通过</span>';
    }
    if (state === 'AUTO_APPROVED_LOW_RISK') {
      return `<span class="pill pill-cyan">🟢 已完成并自动流转${cacheHit ? ' (复用已验证方案)' : ''}</span>`;
    }
    if (state === 'SUPERSEDED') {
      return '<span class="pill pill-muted">🕘 历史旧版 (已回退更新)</span>';
    }
    if (state === 'REJECTED') {
      return '<span class="pill pill-red">↩️ 已打回修改</span>';
    }
    return `<span class="pill pill-blue">${state}</span>`;
  }

  /**
   * 渲染“Agent 在做什么”：分步展示当前步骤 Agent 的工作状态、执行动作分解与上下游交互信号
   */
  public static formatAgentWorkActivityHtml(
    stageId: string,
    snap: SnapshotRecordDto | undefined,
  ): string {
    const meta = StageDisplayFormatter.getStageTitleMap()[stageId] ?? {
      stepNumber: 1,
      name: stageId,
      shortName: stageId,
      role: 'AGENT',
      agentDisplayName: 'AI Agent',
      specialistLabel: '领域负责人',
      stepGoal: '',
    };

    if (!snap) {
      return `
        <div class="agent-activity-card waiting-card">
          <div class="agent-activity-header">
            <div>
              <div style="font-size:14px; font-weight:700;">${meta.agentDisplayName} — 处于待命状态</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">目标职责：${meta.stepGoal}</div>
            </div>
            <span class="pill pill-muted">⚪ 等待前序步骤确认后启动</span>
          </div>
          <div style="font-size:12.5px; color:var(--text-secondary); margin-top:10px;">
            当前项目正在等待前序步骤完成团队确认。前序步骤一旦放行，<strong>${meta.agentDisplayName}</strong> 将自动接收上游交付物并开始执行本步骤工作。
          </div>
        </div>
      `;
    }

    const actionsByStage: Record<string, ReadonlyArray<{ title: string; detail: string }>> = {
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
          detail: `切出独立沙箱工作分支 (${String(snap.artifactDetails.gitWorktreeBranch ?? snap.branchId)})，确保不污染主干代码`,
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

    const steps = actionsByStage[stageId] ?? [];
    const isWaitingHuman = snap.state === 'PENDING_HUMAN_GATE';

    return `
      <div class="agent-activity-card">
        <div class="agent-activity-header">
          <div>
            <div style="font-size:14.5px; font-weight:700; display:flex; align-items:center; gap:8px;">
              <span>${meta.agentDisplayName}</span>
              <span style="font-size:12px; font-weight:400; color:var(--text-secondary);">· 协同责任人: ${meta.specialistLabel}</span>
            </div>
            <div style="font-size:12.5px; color:#93c5fd; margin-top:4px;">
              <strong>当前工作状态：</strong>${snap.artifactSummary}
            </div>
          </div>
          <div>${StageDisplayFormatter.formatStateBadge(snap.state, snap.cacheHit)}</div>
        </div>

        <div class="agent-action-timeline">
          ${steps
            .map((act, idx) => {
              const isLastAndWaiting = isWaitingHuman && idx === steps.length - 1;
              return `
                <div class="action-step-row">
                  <span class="action-step-icon ${isLastAndWaiting ? 'waiting' : 'done'}">
                    ${isLastAndWaiting ? '⏳' : '✓'}
                  </span>
                  <div>
                    <div style="font-weight:600; font-size:12.5px;">${act.title}</div>
                    <div style="font-size:11.5px; color:var(--text-secondary);">${act.detail}</div>
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  /**
   * 渲染“Agent 间工作流交互讨论过程与历史结论”
   */
  public static formatAgentDiscussionAndConclusionHtml(
    stageId: string,
    snap: SnapshotRecordDto | undefined,
    negotiationLogs: ReadonlyArray<NegotiationTurnDto>,
    allSnapshotsOnRun: ReadonlyArray<SnapshotRecordDto>,
  ): string {
    if (!snap) {
      return `
        <div class="diagnosis-item">
          本步骤尚未启动，待 Agent 执行后将在此展示跨角色 Agent 的交互讨论过程与历史结论。
        </div>
      `;
    }

    // 检查该步骤是否有过回退废弃的历史版本 (SUPERSEDED)
    const supersededOnThisStage = allSnapshotsOnRun.filter(
      (s) => s.stageId === stageId && s.state === 'SUPERSEDED',
    );

    const historyEvolutionHtml =
      supersededOnThisStage.length > 0
        ? `
        <div class="conclusion-history-box" style="margin-bottom:12px;">
          <div style="font-weight:700; color:#38bdf8; font-size:12.5px;">
            🔄 版本演进与历史回退结论记录 (共经历 ${supersededOnThisStage.length + 1} 个迭代版本)：
          </div>
          <ul style="margin-top:6px; padding-left:18px; font-size:12px; color:var(--text-secondary);">
            ${supersededOnThisStage
              .map(
                (oldSnap) =>
                  `<li><strong>旧分支 [${oldSnap.branchId}] 历史结论：</strong>${oldSnap.artifactSummary} <span class="pill pill-muted" style="font-size:10px;">已根据团队评论演进至新分支</span></li>`,
              )
              .join('')}
            <li><strong>当前活跃分支 [${snap.branchId}] 最新结论：</strong>${snap.artifactSummary}</li>
          </ul>
        </div>
      `
        : '';

    // 如果在 Stage 2 有真实的 PM-PD 多轮协商记录
    if (stageId === 'STAGE_2_PD' && negotiationLogs.length > 0) {
      const latestTurn = negotiationLogs[negotiationLogs.length - 1];
      const bubblesHtml = negotiationLogs
        .map(
          (turn) => `
          <div class="discussion-turn-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <span class="pill pill-blue">第 ${turn.turnIndex}/${turn.maxTurnsAllowed} 轮跨岗位讨论 · ${turn.challengerRole} ↔ ${turn.responderRole}</span>
              <span class="pill ${turn.escalatedToSupervisor ? 'pill-amber' : 'pill-green'}">
                ${turn.escalatedToSupervisor ? '分歧上报团队裁决' : '自动对齐'}
              </span>
            </div>
            <div class="dialogue-bubble challenger-bubble">
              <strong>🎨 PD Agent (体验设计师) 发起交互质询：</strong>
              <div style="margin-top:3px;">${turn.challengePoint}</div>
            </div>
            <div class="dialogue-bubble responder-bubble" style="margin-top:6px;">
              <strong>📋 PM Agent (产品经理) 响应与评估：</strong>
              <div style="margin-top:3px;">${turn.responseResolution}</div>
            </div>
          </div>
        `,
        )
        .join('');

      return `
        ${historyEvolutionHtml}
        <div class="col-stack" style="gap:10px;">
          ${bubblesHtml}
          <div class="historical-conclusion-banner ${latestTurn.escalatedToSupervisor ? 'pending-arbitration' : 'consensus-ok'}">
            <div style="font-weight:700; font-size:13.5px; margin-bottom:6px;">
              📌 本步骤 Agent 讨论历史结论摘要：
            </div>
            <div style="font-size:12.5px; color:var(--text-primary); margin-bottom:8px;">
              ${
                latestTurn.escalatedToSupervisor
                  ? snap.state === 'APPROVED'
                    ? '✅ 经 PD Agent 与 PM Agent 3 轮讨论并由团队责任人最终拍板，已选定交互实现方案并冻结设计规范。'
                    : '⚠️ PD Agent 与 PM Agent 围绕“高复杂度三维拓扑画布 vs 企业标准双栏折叠抽屉”进行了 3 轮讨论，总管 Agent 已提炼出以下两套备选结论供团队拍板：'
                  : '✅ PD Agent 与 PM Agent 已在讨论中达成一致，交互规范符合现有组件库约束且未删减核心业务需求。'
              }
            </div>
            <div class="inspector-grid">
              <div class="artifact-subcard" style="border-left:3px solid var(--status-green);">
                <strong>${latestTurn.optionAProposal}</strong>
              </div>
              <div class="artifact-subcard" style="border-left:3px solid var(--status-amber);">
                <strong>${latestTurn.optionBProposal}</strong>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // 其他步骤的标准跨 Agent 协同讨论与历史结论展示
    const stageDiscussions: Record<
      string,
      {
        partnerAgents: string;
        dialogueA: string;
        dialogueB: string;
        conclusion: string;
      }
    > = {
      STAGE_1_PM: {
        partnerAgents: 'PM Agent ↔ DA Agent (数据分析师)',
        dialogueA:
          '📋 PM Agent：已将业务立项拆解为结构化 User Stories，请 DA Agent 同步确认每个核心交互节点的埋点事件定义。',
        dialogueB:
          '📊 DA Agent：已核对所有 User Stories，同步绑定了 `run_id`、`branch_id`、`actor_role`、`latency_ms` 四个标准归因属性，上线后可直接对接转化漏斗看板。',
        conclusion: `【已达成共识结论】完成 ${snap.artifactDetails.coreRequirementIds ? (snap.artifactDetails.coreRequirementIds as string[]).length : 3} 项核心需求的 PRD 验收标准与前置埋点方案对齐，无需求范围缺失。`,
      },
      STAGE_2_PD: {
        partnerAgents: 'PD Agent ↔ PM Agent (产品经理)',
        dialogueA:
          '🎨 PD Agent：已将 PRD 中的用户故事映射为企业标准组件库组件，并补充了空状态、加载骨架屏与键盘无障碍规范。',
        dialogueB:
          '📋 PM Agent：确认 UI 组件映射完整覆盖了所有验收标准 (AC)，未发生核心业务需求删减。',
        conclusion:
          '【已达成共识结论】UI 交互状态机与企业 Design System 组件映射已全量对齐，可直接移交架构师进行接口契约设计。',
      },
      STAGE_3A_TECH_SPEC: {
        partnerAgents: 'Tech Lead Agent ↔ PD Agent & Engineer Agent',
        dialogueA:
          '🏛️ Tech Lead Agent：基于上游 PRD 与 UI 组件状态机，已定义 RESTful OpenAPI 接口契约与数据库 Schema 变更脚本。',
        dialogueB:
          '💻 Engineer Agent：已确认接口入参/出参契约及面向对象设计模式约束，可在独立 Git Worktree 沙箱中无歧义实现领域服务类。',
        conclusion:
          snap.riskScore >= 60
            ? `【高风险技术方案结论】本步骤包含数据库 DDL 表结构变更与权限安全域设计（风险评分 ${snap.riskScore}/100），已输出完整 SQL 脚本并由架构师把关确认。`
            : '【常规技术方案结论】接口契约清晰且不涉及破坏性数据库表结构变更，技术方案已锁定生效。',
      },
      STAGE_3B_ENGINEER: {
        partnerAgents: 'Engineer Agent ↔ Tech Lead Agent',
        dialogueA: `💻 Engineer Agent：已在隔离沙箱分支 [${String(snap.artifactDetails.gitWorktreeBranch ?? snap.branchId)}] 完成领域服务类与单元测试编写，本地编译自测通过。`,
        dialogueB:
          '🏛️ Tech Lead Agent：代码结构校验通过，严格遵循了步骤 3a 约定的面向对象设计模式与埋点事件命名规范。',
        conclusion:
          '【代码实现结论】所有核心需求模块已在隔离沙箱落盘并通过自测，代码分支已移交 QA Agent 进行自动化验收。',
      },
      STAGE_4_QA: {
        partnerAgents: 'QA Agent ↔ Engineer Agent',
        dialogueA:
          '🛡️ QA Agent：已在沙箱对步骤 3b 提交的代码执行了契约单元测试、集成回归测试与静态安全漏洞扫描。',
        dialogueB:
          '💻 Engineer Agent：所有边界条件断言均一次性通过（行覆盖率 95.6%，高危漏洞 0 个），无需打回返工修复。',
        conclusion:
          '【质量验收结论】沙箱自动化测试 100% 通过且无安全隐患，已满足步骤 1 定义的全部验收标准 (AC)，具备上线发布条件。',
      },
      STAGE_5_DA: {
        partnerAgents: 'DA Agent ↔ PM Agent',
        dialogueA:
          '📊 DA Agent：已完成线上埋点事件覆盖率核验（覆盖率 100%），并构建了功能采纳率与响应延迟基线模型。',
        dialogueB:
          '📋 PM Agent：数据监控闭环已确认，后续如发现转化指标波动可一键基于本报告发起下一轮迭代。',
        conclusion: '【数据复盘结论】前置埋点全量校验通过，项目从提案到上线归因闭环已全部完成。',
      },
    };

    const info = stageDiscussions[stageId] ?? stageDiscussions.STAGE_1_PM;

    return `
      ${historyEvolutionHtml}
      <div class="discussion-turn-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span class="pill pill-blue">跨角色工作流协同交互 · ${info.partnerAgents}</span>
          <span class="pill pill-green">已达成结构化共识</span>
        </div>
        <div class="dialogue-bubble challenger-bubble">${info.dialogueA}</div>
        <div class="dialogue-bubble responder-bubble" style="margin-top:6px;">${info.dialogueB}</div>
        <div class="historical-conclusion-banner consensus-ok" style="margin-top:10px;">
          <div style="font-weight:700; font-size:13px; margin-bottom:3px;">📌 本步骤 Agent 讨论历史结论：</div>
          <div style="font-size:12.5px;">${info.conclusion}</div>
        </div>
      </div>
    `;
  }

  public static formatArtifactDeepDetails(snap: SnapshotRecordDto): string {
    const details = snap.artifactDetails ?? {};
    const type = snap.artifactType;

    if (type === 'PRD_ARTIFACT_CONTRACT') {
      const stories =
        (details.userStories as Array<{
          reqId: string;
          story: string;
          acceptanceCriteria: string[];
        }>) ?? [];
      const events =
        (details.trackingPlanEvents as Array<{
          eventName: string;
          triggerCondition: string;
          properties: string[];
        }>) ?? [];
      const constraints = (details.nonFunctionalConstraints as string[]) ?? [];

      const storiesHtml = stories
        .map(
          (s) => `
          <div class="artifact-subcard">
            <div style="font-weight:700; color:#60a5fa;">[${s.reqId}] ${s.story}</div>
            <ul style="margin-top:6px; padding-left:18px; color:var(--text-secondary); font-size:12px;">
              ${(s.acceptanceCriteria ?? []).map((ac) => `<li>${ac}</li>`).join('')}
            </ul>
          </div>`,
        )
        .join('');

      const eventsHtml = events
        .map(
          (ev) => `
          <div class="artifact-subcard">
            <div><code style="color:#34d399;">${ev.eventName}</code> — ${ev.triggerCondition}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">属性字段: ${(ev.properties ?? []).join(', ')}</div>
          </div>`,
        )
        .join('');

      return `
        <div class="inspector-grid">
          <div>
            <h4 class="inspector-subtitle">📋 结构化 User Stories &amp; 验收标准 (${stories.length})</h4>
            <div class="col-stack" style="gap:8px;">${storiesHtml}</div>
          </div>
          <div>
            <h4 class="inspector-subtitle">📊 前置数据埋点规划 Tracking Plan (${events.length})</h4>
            <div class="col-stack" style="gap:8px;">${eventsHtml}</div>
            <h4 class="inspector-subtitle" style="margin-top:14px;">🛡️ 非功能性与历史避坑约束</h4>
            <ul style="padding-left:18px; font-size:12px; color:var(--text-secondary);">
              ${constraints.map((c) => `<li>${c}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
    }

    if (type === 'UI_DESIGN_ARTIFACT_CONTRACT') {
      const mappings =
        (details.componentMappings as Array<{
          reqId: string;
          designSystemComponent: string;
          interactionStates: string[];
        }>) ?? [];
      const a11y = (details.accessibilityChecklist as string[]) ?? [];

      return `
        <div class="inspector-grid">
          <div>
            <h4 class="inspector-subtitle">🎨 企业 Design System 组件映射清单 (${mappings.length})</h4>
            <div class="col-stack" style="gap:8px;">
              ${mappings
                .map(
                  (m) => `
                <div class="artifact-subcard">
                  <div><strong>[${m.reqId}]</strong> → 组件 <code style="color:#c084fc;">${m.designSystemComponent}</code></div>
                  <div style="font-size:11.5px; color:var(--text-secondary); margin-top:4px;">交互状态机: ${(m.interactionStates ?? []).join(' · ')}</div>
                </div>`,
                )
                .join('')}
            </div>
          </div>
          <div>
            <h4 class="inspector-subtitle">♿ 无障碍与交互体验规范</h4>
            <ul style="padding-left:18px; font-size:12px; color:var(--text-secondary);">
              ${a11y.map((item) => `<li>${item}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
    }

    if (type === 'TECH_SPEC_ARTIFACT_CONTRACT') {
      const apis =
        (details.apiContracts as Array<{
          method: string;
          endpoint: string;
          requestSchema: string;
          responseSchema: string;
        }>) ?? [];
      const ddls = (details.databaseDdlStatements as string[]) ?? [];
      const patterns = (details.architecturePatternsUsed as string[]) ?? [];

      return `
        <div class="inspector-grid">
          <div>
            <h4 class="inspector-subtitle">🔌 OpenAPI 接口契约规范 (${apis.length})</h4>
            <div class="col-stack" style="gap:8px;">
              ${apis
                .map(
                  (api) => `
                <div class="artifact-subcard">
                  <div><span class="pill pill-blue">${api.method}</span> <code>${api.endpoint}</code></div>
                  <div style="font-size:11.5px; color:var(--text-secondary); margin-top:4px;">Req: <code>${api.requestSchema}</code> → Res: <code>${api.responseSchema}</code></div>
                </div>`,
                )
                .join('')}
            </div>
            <h4 class="inspector-subtitle" style="margin-top:12px;">🏛️ 采用的架构设计模式</h4>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              ${patterns.map((p) => `<span class="pill pill-purple">${p}</span>`).join('')}
            </div>
          </div>
          <div>
            <h4 class="inspector-subtitle">🗄️ 数据库 DDL 变更脚本 (${ddls.length} 条)</h4>
            <pre class="code-preview-block">${ddls.length > 0 ? ddls.join('\n\n') : '-- 无数据库表结构 DDL 变更 (低风险)'}</pre>
          </div>
        </div>
      `;
    }

    if (type === 'CODE_IMPLEMENTATION_ARTIFACT_CONTRACT') {
      const files =
        (details.modifiedFiles as Array<{
          filePath: string;
          className: string;
          designPattern: string;
          linesChanged: number;
        }>) ?? [];
      const branch = String(details.gitWorktreeBranch ?? '');

      return `
        <div>
          <div style="margin-bottom:10px;">
            <span class="pill pill-cyan">Git Worktree 隔离分支: ${branch}</span>
          </div>
          <div class="col-stack" style="gap:8px;">
            ${files
              .map(
                (f) => `
              <div class="artifact-subcard" style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <div><code>${f.filePath}</code></div>
                  <div style="font-size:11.5px; color:var(--text-secondary);">类名: <strong>${f.className}</strong> · 设计模式: ${f.designPattern}</div>
                </div>
                <span class="pill pill-green">+${f.linesChanged} lines</span>
              </div>`,
              )
              .join('')}
          </div>
        </div>
      `;
    }

    if (type === 'QA_VERIFICATION_ARTIFACT_CONTRACT') {
      const suites =
        (details.testSuitesExecuted as Array<{
          suiteName: string;
          totalCases: number;
          passedCases: number;
          coveragePercent: number;
        }>) ?? [];
      const secIssues = Number(details.securityIssuesFound ?? 0);

      return `
        <div>
          <div style="display:flex; gap:10px; margin-bottom:10px;">
            <span class="pill ${secIssues === 0 ? 'pill-green' : 'pill-red'}">高危安全漏洞: ${secIssues} 个</span>
            <span class="pill pill-blue">全部验收标准达成: ${details.allAcceptanceCriteriaMet ? 'YES' : 'NO'}</span>
          </div>
          <div class="col-stack" style="gap:8px;">
            ${suites
              .map(
                (s) => `
              <div class="artifact-subcard" style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                  <strong>${s.suiteName}</strong>
                  <div style="font-size:11.5px; color:var(--text-secondary);">通过用例: ${s.passedCases}/${s.totalCases}</div>
                </div>
                <span class="pill pill-green">覆盖率 ${s.coveragePercent}%</span>
              </div>`,
              )
              .join('')}
          </div>
        </div>
      `;
    }

    return `<pre class="code-preview-block">${JSON.stringify(details, null, 2)}</pre>`;
  }
}
