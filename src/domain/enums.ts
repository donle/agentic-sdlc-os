/**
 * @file enums.ts
 * @description 领域核心强类型枚举常量定义。采用 TypeScript 擦除安全 (Erasable-Safe) 的强类型枚举对象模式，
 * 既支持作为编译期类型约束，又支持作为运行时常量枚举访问，无任何魔法字符串。
 */

/**
 * 职能 Agent 角色枚举
 */
export const AgentRole = {
  SUPERVISOR: 'SUPERVISOR_AGENT',
  PRODUCT_MANAGER: 'PM_AGENT',
  PRODUCT_DESIGNER: 'PD_AGENT',
  TECH_LEAD: 'TECH_LEAD_AGENT',
  SOFTWARE_ENGINEER: 'ENGINEER_AGENT',
  QUALITY_ASSURANCE: 'QA_AGENT',
  DATA_ANALYST: 'DA_AGENT',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/**
 * 研发流水线标准阶段标识
 */
export const WorkflowStageId = {
  STAGE_0_INITIATION: 'STAGE_0_INITIATION',
  STAGE_1_PM: 'STAGE_1_PM',
  STAGE_2_PD: 'STAGE_2_PD',
  STAGE_3A_TECH_SPEC: 'STAGE_3A_TECH_SPEC',
  STAGE_3B_ENGINEER: 'STAGE_3B_ENGINEER',
  STAGE_4_QA: 'STAGE_4_QA',
  STAGE_5_DA: 'STAGE_5_DA',
} as const;
export type WorkflowStageId = (typeof WorkflowStageId)[keyof typeof WorkflowStageId];

/**
 * 不可变阶段快照 (StageSnapshotMemento) 的生命周期状态
 */
export const SnapshotLifecycleState = {
  IDLE: 'IDLE',
  RECOGNIZING_INTENT: 'RECOGNIZING_INTENT',
  CACHE_HIT: 'CACHE_HIT',
  EXECUTING: 'EXECUTING',
  NEGOTIATING: 'NEGOTIATING',
  RETRYING: 'RETRYING',
  PENDING_HUMAN_GATE: 'PENDING_HUMAN_GATE',
  APPROVED: 'APPROVED',
  AUTO_APPROVED_LOW_RISK: 'AUTO_APPROVED_LOW_RISK',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type SnapshotLifecycleState =
  (typeof SnapshotLifecycleState)[keyof typeof SnapshotLifecycleState];

/**
 * 业务风险等级枚举
 */
export const BusinessRiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type BusinessRiskLevel = (typeof BusinessRiskLevel)[keyof typeof BusinessRiskLevel];

/**
 * 门禁动作枚举
 */
export const GateActionType = {
  AUTO_PASS_WITH_AUDIT: 'AUTO_PASS_WITH_AUDIT',
  BLOCK_FOR_HUMAN_VERIFICATION: 'BLOCK_FOR_HUMAN_VERIFICATION',
  BLOCK_FOR_CONFLICT_ARBITRATION: 'BLOCK_FOR_CONFLICT_ARBITRATION',
} as const;
export type GateActionType = (typeof GateActionType)[keyof typeof GateActionType];

/**
 * 人类审核或策略裁决类型
 */
export const DecisionVerdict = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  ARBITRATE_OPTION_A: 'ARBITRATE_OPTION_A',
  ARBITRATE_OPTION_B: 'ARBITRATE_OPTION_B',
  AUTO_PASS_LOW_RISK: 'AUTO_PASS_LOW_RISK',
  SUPERVISOR_ROLLBACK: 'SUPERVISOR_ROLLBACK',
} as const;
export type DecisionVerdict = (typeof DecisionVerdict)[keyof typeof DecisionVerdict];

/**
 * Agent 实时推送给前端用户的提醒类型
 */
export const NotificationCategory = {
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  CONFLICT_ARBITRATION_REQUIRED: 'CONFLICT_ARBITRATION_REQUIRED',
  SCOPE_DIFF_WARNING: 'SCOPE_DIFF_WARNING',
  AUTO_PASSED_TRACE: 'AUTO_PASSED_TRACE',
  ROLLBACK_EXECUTED: 'ROLLBACK_EXECUTED',
  STAGE_PROGRESS: 'STAGE_PROGRESS',
  /** B3：Token 预算守卫熔断（人工提高预算后可继续） */
  TOKEN_BUDGET_EXCEEDED: 'TOKEN_BUDGET_EXCEEDED',
  /** A2：阶段契约在自愈重试耗尽后仍失败（人工可重试本阶段） */
  STAGE_CONTRACT_FAILED: 'STAGE_CONTRACT_FAILED',
} as const;
export type NotificationCategory = (typeof NotificationCategory)[keyof typeof NotificationCategory];

/**
 * 意图识别到最终执行结果的达成状态（用于复盘与成本控制）
 */
export const IntentFulfillmentStatus = {
  FULFILLED_ON_FIRST_TRY: 'FULFILLED_ON_FIRST_TRY',
  FULFILLED_AFTER_RETRY: 'FULFILLED_AFTER_RETRY',
  FULFILLED_VIA_CACHE: 'FULFILLED_VIA_CACHE',
  ESCALATED_TO_HUMAN: 'ESCALATED_TO_HUMAN',
  FAILED_CONTRACT: 'FAILED_CONTRACT',
} as const;
export type IntentFulfillmentStatus =
  (typeof IntentFulfillmentStatus)[keyof typeof IntentFulfillmentStatus];

/**
 * 混合模型路由层级 (BYOM)
 */
export const ModelRoutingTier = {
  PRIVACY_SENSITIVE_LOCAL: 'PRIVACY_SENSITIVE_LOCAL',
  HIGH_REASONING_HYBRID: 'HIGH_REASONING_HYBRID',
  EMBEDDING: 'EMBEDDING',
} as const;
export type ModelRoutingTier = (typeof ModelRoutingTier)[keyof typeof ModelRoutingTier];
