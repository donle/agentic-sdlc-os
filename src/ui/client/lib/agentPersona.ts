/**
 * @file agentPersona.ts
 * @description 拟人化 Agent 岗位角色目录：为每个职能 Agent 提供专属插图、人物设定、主题色、交接道具与情绪状态映射。
 */

export type AgentMood =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'cache'
  | 'talking'
  | 'retrying'
  | 'waiting'
  | 'celebrating'
  | 'alert'
  | 'archived';

export interface AgentPersona {
  readonly role: string;
  readonly stageId?: string;
  readonly codename: string;
  readonly personName: string;
  readonly roleTitle: string;
  readonly avatarSrc: string;
  readonly accentColor: string;
  readonly softBg: string;
  readonly propEmoji: string;
  readonly handoffLabel: string;
  readonly catchphrase: string;
}

export const AGENT_PERSONAS: Record<string, AgentPersona> = {
  SUPERVISOR_AGENT: {
    role: 'SUPERVISOR_AGENT',
    codename: '总管调度官',
    personName: '林总管',
    roleTitle: 'PMO 全局协调 & 仲裁官',
    avatarSrc: '/assets/agents/supervisor.jpg',
    accentColor: '#7c3aed',
    softBg: 'rgba(124, 58, 237, 0.12)',
    propEmoji: '🧭',
    handoffLabel: 'DAG 分叉指令',
    catchphrase: '全局链路监听中，随时响应冲突仲裁与回退调度',
  },
  PM_AGENT: {
    role: 'PM_AGENT',
    stageId: 'STAGE_1_PM',
    codename: '产品经理',
    personName: '陈工',
    roleTitle: 'AI 需求分析与埋点规划师',
    avatarSrc: '/assets/agents/pm.svg',
    accentColor: '#2563eb',
    softBg: 'rgba(37, 99, 235, 0.12)',
    propEmoji: '📋',
    handoffLabel: 'PRD 与埋点契约',
    catchphrase: '先把业务价值、验收边界和埋点口径对齐清楚！',
  },
  PD_AGENT: {
    role: 'PD_AGENT',
    stageId: 'STAGE_2_PD',
    codename: '体验设计师',
    personName: '林工',
    roleTitle: 'AI 交互与界面体验设计师',
    avatarSrc: '/assets/agents/pd.svg',
    accentColor: '#db2777',
    softBg: 'rgba(219, 39, 119, 0.12)',
    propEmoji: '🎨',
    handoffLabel: '高保真 UI 规范',
    catchphrase: '每个按钮状态和空态体验都要经得起用户推敲~',
  },
  TECH_LEAD_AGENT: {
    role: 'TECH_LEAD_AGENT',
    stageId: 'STAGE_3A_TECH_SPEC',
    codename: '系统架构师',
    personName: '赵工',
    roleTitle: 'AI 架构契约与数据建模师',
    avatarSrc: '/assets/agents/tech_lead.svg',
    accentColor: '#0891b2',
    softBg: 'rgba(8, 145, 178, 0.12)',
    propEmoji: '🏛️',
    handoffLabel: 'OpenAPI & DDL 契约',
    catchphrase: '先定接口契约与库表边界，再进沙箱写代码',
  },
  ENGINEER_AGENT: {
    role: 'ENGINEER_AGENT',
    stageId: 'STAGE_3B_ENGINEER',
    codename: '研发工程师',
    personName: '刘工',
    roleTitle: 'AI 全栈编码与沙箱实现师',
    avatarSrc: '/assets/agents/engineer.jpg',
    accentColor: '#059669',
    softBg: 'rgba(5, 150, 105, 0.12)',
    propEmoji: '💻',
    handoffLabel: '沙箱源码 & 单元测试',
    catchphrase: '独立 Worktree 沙箱已拉起，代码和单测一并搞定！',
  },
  QA_AGENT: {
    role: 'QA_AGENT',
    stageId: 'STAGE_4_QA',
    codename: '质量测试官',
    personName: '孙工',
    roleTitle: 'AI 质量验收与安全审计官',
    avatarSrc: '/assets/agents/qa.svg',
    accentColor: '#d97706',
    softBg: 'rgba(217, 119, 6, 0.12)',
    propEmoji: '🛡️',
    handoffLabel: '回归测试 & 安全报告',
    catchphrase: '边界用例与安全红线逐项核验，绝不放过隐患！',
  },
  DA_AGENT: {
    role: 'DA_AGENT',
    stageId: 'STAGE_5_DA',
    codename: '数据分析师',
    personName: '周工',
    roleTitle: 'AI 埋点归因与效能分析师',
    avatarSrc: '/assets/agents/da.jpg',
    accentColor: '#0d9488',
    softBg: 'rgba(13, 148, 136, 0.12)',
    propEmoji: '📊',
    handoffLabel: '上线复盘归因看板',
    catchphrase: '核验埋点覆盖率，用真实数据闭环复盘交付效果',
  },
};

const STAGE_TO_ROLE: Record<string, string> = {
  STAGE_0_INITIATION: 'SUPERVISOR_AGENT',
  STAGE_1_PM: 'PM_AGENT',
  STAGE_2_PD: 'PD_AGENT',
  STAGE_3A_TECH_SPEC: 'TECH_LEAD_AGENT',
  STAGE_3B_ENGINEER: 'ENGINEER_AGENT',
  STAGE_4_QA: 'QA_AGENT',
  STAGE_5_DA: 'DA_AGENT',
};

export function personaFor(roleOrStage?: string | null): AgentPersona {
  if (!roleOrStage) {
    return AGENT_PERSONAS.SUPERVISOR_AGENT;
  }
  const normalized = roleOrStage.trim();
  if (AGENT_PERSONAS[normalized]) {
    return AGENT_PERSONAS[normalized];
  }
  const mappedRole = STAGE_TO_ROLE[normalized];
  if (mappedRole && AGENT_PERSONAS[mappedRole]) {
    return AGENT_PERSONAS[mappedRole];
  }
  const upper = normalized.toUpperCase();
  if (upper.includes('SUPERVISOR')) {
    return AGENT_PERSONAS.SUPERVISOR_AGENT;
  }
  if (upper.includes('PM')) {
    return AGENT_PERSONAS.PM_AGENT;
  }
  if (upper.includes('PD')) {
    return AGENT_PERSONAS.PD_AGENT;
  }
  if (upper.includes('TECH') || upper.includes('3A')) {
    return AGENT_PERSONAS.TECH_LEAD_AGENT;
  }
  if (upper.includes('ENG') || upper.includes('3B')) {
    return AGENT_PERSONAS.ENGINEER_AGENT;
  }
  if (upper.includes('QA')) {
    return AGENT_PERSONAS.QA_AGENT;
  }
  if (upper.includes('DA')) {
    return AGENT_PERSONAS.DA_AGENT;
  }
  return AGENT_PERSONAS.SUPERVISOR_AGENT;
}

export function moodFromState(state?: string | null): AgentMood {
  switch (state) {
    case 'RECOGNIZING_INTENT':
      return 'thinking';
    case 'EXECUTING':
      return 'working';
    case 'CACHE_HIT':
      return 'cache';
    case 'NEGOTIATING':
      return 'talking';
    case 'RETRYING':
      return 'retrying';
    case 'PENDING_HUMAN_GATE':
      return 'waiting';
    case 'APPROVED':
    case 'AUTO_APPROVED_LOW_RISK':
      return 'celebrating';
    case 'REJECTED':
      return 'alert';
    case 'SUPERSEDED':
      return 'archived';
    default:
      return 'idle';
  }
}

export function moodActionCue(mood: AgentMood, customHeadline?: string): string {
  if (customHeadline) {
    return customHeadline;
  }
  switch (mood) {
    case 'thinking':
      return '正在解析意图与上下文…';
    case 'working':
      return '全力生成交付契约中…';
    case 'cache':
      return '秒级命中历史语义缓存！';
    case 'talking':
      return '正在跨岗位深度对齐中…';
    case 'retrying':
      return '发现契约偏差，自愈重试中…';
    case 'waiting':
      return '交付物已备好，请您拍板确认！';
    case 'celebrating':
      return '本环节已顺利验收放行~';
    case 'alert':
      return '方案已被打回，等待总管重调度';
    case 'archived':
      return '已作为历史版本归档留痕';
    default:
      return '在岗待命中，等待上游交接';
  }
}
