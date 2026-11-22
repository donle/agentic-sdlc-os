/**
 * @file display.ts
 * @description 纯数据展示助手：阶段元信息、生命周期/裁决图标、相对时间等，
 * 供所有 React 组件共用（无 DOM/字符串 HTML 依赖）。
 */

export interface StageMeta {
  readonly stepNumber: number;
  readonly name: string;
  readonly shortName: string;
  readonly stepTag: string;
  readonly agentDisplayName: string;
  readonly specialistLabel: string;
  readonly stepGoal: string;
}

export const STAGE_META: Record<string, StageMeta> = {
  STAGE_1_PM: {
    stepNumber: 1,
    name: '步骤 1：产品需求与埋点设计',
    shortName: '1. 产品需求 PRD',
    stepTag: 'S1',
    agentDisplayName: '📋 PM Agent (AI 产品经理)',
    specialistLabel: '陈工 · 产品经理',
    stepGoal: '将业务立项拆解为 User Stories、量化验收标准 (AC) 与前置数据埋点方案',
  },
  STAGE_2_PD: {
    stepNumber: 2,
    name: '步骤 2：UI 交互与体验设计',
    shortName: '2. 交互与 UI 设计',
    stepTag: 'S2',
    agentDisplayName: '🎨 PD Agent (AI 体验设计师)',
    specialistLabel: '林工 · 体验设计师',
    stepGoal: '映射企业组件库规范与交互状态机，与 PM Agent 对齐交互可行性与体验边界',
  },
  STAGE_3A_TECH_SPEC: {
    stepNumber: 3,
    name: '步骤 3a：技术架构与接口/表设计',
    shortName: '3a. 架构与表设计',
    stepTag: 'S3a',
    agentDisplayName: '🏛️ Tech Lead Agent (AI 架构师)',
    specialistLabel: '赵工 · 系统架构师',
    stepGoal: '制定 OpenAPI 接口契约、数据库表结构变更 (DDL) 与设计模式规范，先行评审再写代码',
  },
  STAGE_3B_ENGINEER: {
    stepNumber: 4,
    name: '步骤 3b：代码实现与沙箱自测',
    shortName: '3b. 工程师编码',
    stepTag: 'S3b',
    agentDisplayName: '💻 Engineer Agent (AI 研发工程师)',
    specialistLabel: '刘工 · 研发工程师',
    stepGoal: '在独立 Git Worktree 隔离沙箱分支中编写模块化业务类、埋点代码与配套单元测试',
  },
  STAGE_4_QA: {
    stepNumber: 5,
    name: '步骤 4：质量验收与安全测试',
    shortName: '4. QA 质量测试',
    stepTag: 'S4',
    agentDisplayName: '🛡️ QA Agent (AI 测试工程师)',
    specialistLabel: '孙工 · 测试负责人',
    stepGoal: '对照步骤 1 的验收标准在沙箱执行自动化单测、集成回归测试与静态安全漏洞扫描',
  },
  STAGE_5_DA: {
    stepNumber: 6,
    name: '步骤 5：数据埋点归因与上线复盘',
    shortName: '5. 数据复盘分析',
    stepTag: 'S5',
    agentDisplayName: '📊 DA Agent (AI 数据分析师)',
    specialistLabel: '周工 · 数据分析师',
    stepGoal: '核验前置埋点覆盖率，构建上线后核心转化率与研发效能归因看板',
  },
};

export function stageMeta(stageId: string): StageMeta {
  return (
    STAGE_META[stageId] ?? {
      stepNumber: 1,
      name: stageId,
      shortName: stageId,
      stepTag: stageId,
      agentDisplayName: 'AI Agent',
      specialistLabel: '领域负责人',
      stepGoal: '',
    }
  );
}

const LIFECYCLE_ICONS: Record<string, string> = {
  RECOGNIZING_INTENT: '🧠',
  EXECUTING: '⚙️',
  CACHE_HIT: '⚡',
  NEGOTIATING: '💬',
  RETRYING: '🔁',
  PENDING_HUMAN_GATE: '⏳',
  APPROVED: '✅',
  AUTO_APPROVED_LOW_RISK: '🤖',
  REJECTED: '❌',
  SUPERSEDED: '🕘',
  IDLE: '⚪',
};

const LIFECYCLE_CSS: Record<string, string> = {
  RECOGNIZING_INTENT: 'feed-recognizing',
  EXECUTING: 'feed-executing',
  CACHE_HIT: 'feed-cache',
  NEGOTIATING: 'feed-negotiating',
  RETRYING: 'feed-retrying',
};

export function lifecycleIcon(lifecycleState: string): string {
  return LIFECYCLE_ICONS[lifecycleState] ?? '📣';
}

export function lifecycleCss(lifecycleState: string): string {
  return LIFECYCLE_CSS[lifecycleState] ?? 'feed-generic';
}

interface VerdictVisual {
  readonly icon: string;
  readonly className: string;
  readonly label: string;
}

const VERDICT_VISUALS: Record<string, VerdictVisual> = {
  APPROVE: { icon: '✅', className: 'decision-approved', label: '核验通过' },
  REJECT: { icon: '❌', className: 'decision-rejected', label: '驳回重做' },
  ARBITRATE_OPTION_A: { icon: '⚖️', className: 'decision-arbitrated', label: '拍板方案 A' },
  ARBITRATE_OPTION_B: { icon: '⚖️', className: 'decision-arbitrated', label: '拍板方案 B' },
  AUTO_PASS_LOW_RISK: { icon: '🤖', className: 'decision-auto-pass', label: '低风险自动放行' },
  SUPERVISOR_ROLLBACK: { icon: '↩️', className: 'decision-rollback', label: '总管对话回退' },
};

export function verdictVisual(verdict: string): VerdictVisual {
  return VERDICT_VISUALS[verdict] ?? { icon: '📌', className: 'decision-other', label: verdict };
}

const AUDIT_ACTOR_ICONS: Record<string, string> = {
  AGENT_: '🤖',
  NOTIFICATION_: '🔔',
  VERDICT_: '🧑‍⚖️',
};

export function auditActorIcon(actionType: string): string {
  const hit = Object.entries(AUDIT_ACTOR_ICONS).find(([prefix]) => actionType.startsWith(prefix));
  return hit?.[1] ?? '📄';
}

export function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return '';
  }
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} 天前`;
  }
  return iso.slice(0, 10);
}

export function truncate(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export function stateBadge(state: string, cacheHit: boolean): { label: string; pillClass: string } {
  if (state === 'PENDING_HUMAN_GATE') {
    return { label: '⏳ 待责任人确认 / 拍板', pillClass: 'pill pill-amber' };
  }
  if (state === 'APPROVED') {
    return { label: '✅ 团队已确认通过', pillClass: 'pill pill-green' };
  }
  if (state === 'AUTO_APPROVED_LOW_RISK') {
    return {
      label: cacheHit ? '🟢 已完成并自动流转 (复用已验证方案)' : '🟢 已完成并自动流转',
      pillClass: 'pill pill-cyan',
    };
  }
  if (state === 'SUPERSEDED') {
    return { label: '🕘 历史旧版 (已回退更新)', pillClass: 'pill pill-muted' };
  }
  if (state === 'REJECTED') {
    return { label: '↩️ 已打回修改', pillClass: 'pill pill-red' };
  }
  return { label: state, pillClass: 'pill pill-blue' };
}

export const SVG_STAGE_LABELS: Record<
  string,
  { stepTag: string; shortLabel: string; emoji: string }
> = {
  STAGE_1_PM: { stepTag: 'STEP 1', shortLabel: '产品需求 PRD', emoji: '📋' },
  STAGE_2_PD: { stepTag: 'STEP 2', shortLabel: '交互与 UI 设计', emoji: '🎨' },
  STAGE_3A_TECH_SPEC: { stepTag: 'STEP 3a', shortLabel: '架构与表设计', emoji: '🏛️' },
  STAGE_3B_ENGINEER: { stepTag: 'STEP 3b', shortLabel: '工程师编码', emoji: '💻' },
  STAGE_4_QA: { stepTag: 'STEP 4', shortLabel: 'QA 质量测试', emoji: '🛡️' },
  STAGE_5_DA: { stepTag: 'STEP 5', shortLabel: '数据复盘分析', emoji: '📊' },
};
