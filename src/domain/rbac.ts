/**
 * @file rbac.ts
 * @description 企业级多层级用户体系与基于角色的访问控制 (RBAC) 领域模型。
 *
 * 设计层级：
 * 1. 最上层管理员 (`UserHierarchyTier.PROJECT_ADMIN`)：
 *    - 拥有项目与系统的最高管理权限；
 *    - 可配置工作流 YAML 模板、动态调整风控门禁阈值、管理角色权限矩阵；
 *    - 拥有全局最高裁决权（Admin Override）：可跨环节审批或驳回任意阶段的门禁，并可随时调度总管 Agent 执行全局回退。
 * 2. 各环节专业领域员工 (`UserHierarchyTier.STAGE_SPECIALIST`)：
 *    - 拥有各自的专长领域（如 PM 产品经理、PD 体验设计师、Tech Lead 架构师、Engineer 研发工程师、QA 测试工程师、DA 数据分析师）；
 *    - 全体员工共享完整的工作流全景状态、阶段交付物明细、DAG 分支历史与审计账本（信息透明共享）；
 *    - 仅对自己专长领域的阶段门禁拥有直接签核/拍板权限（其他环节门禁为只读共享视图）。
 */

import { AgentRole, WorkflowStageId } from './enums.ts';

/**
 * 用户层级枚举：顶层管理员 vs 环节专业员工
 */
export const UserHierarchyTier = {
  PROJECT_ADMIN: 'PROJECT_ADMIN',
  STAGE_SPECIALIST: 'STAGE_SPECIALIST',
} as const;
export type UserHierarchyTier = (typeof UserHierarchyTier)[keyof typeof UserHierarchyTier];

/**
 * 员工专长领域枚举
 */
export const SpecialistDomain = {
  GLOBAL_ADMINISTRATION: 'GLOBAL_ADMINISTRATION',
  PRODUCT_MANAGEMENT: 'PRODUCT_MANAGEMENT',
  PRODUCT_DESIGN_UX: 'PRODUCT_DESIGN_UX',
  SYSTEM_ARCHITECTURE: 'SYSTEM_ARCHITECTURE',
  SOFTWARE_ENGINEERING: 'SOFTWARE_ENGINEERING',
  QUALITY_ASSURANCE: 'QUALITY_ASSURANCE',
  DATA_ANALYTICS: 'DATA_ANALYTICS',
} as const;
export type SpecialistDomain = (typeof SpecialistDomain)[keyof typeof SpecialistDomain];

/**
 * 系统预置的细粒度权限码
 */
export const SystemPermissionCode = {
  VIEW_SHARED_WORKFLOW: 'VIEW_SHARED_WORKFLOW',
  CREATE_PROPOSAL: 'CREATE_PROPOSAL',
  APPROVE_ASSIGNED_STAGE_GATE: 'APPROVE_ASSIGNED_STAGE_GATE',
  ADMIN_OVERRIDE_ANY_GATE: 'ADMIN_OVERRIDE_ANY_GATE',
  INVOKE_SUPERVISOR_ROLLBACK: 'INVOKE_SUPERVISOR_ROLLBACK',
  EXECUTE_SANDBOX_VERIFICATION: 'EXECUTE_SANDBOX_VERIFICATION',
  MANAGE_WORKFLOW_DSL_AND_GUARDRAILS: 'MANAGE_WORKFLOW_DSL_AND_GUARDRAILS',
  MANAGE_RBAC_POLICY: 'MANAGE_RBAC_POLICY',
} as const;
export type SystemPermissionCode = (typeof SystemPermissionCode)[keyof typeof SystemPermissionCode];

/**
 * 企业用户账号实体
 */
export class EnterpriseUserAccount {
  public readonly userId: string;
  public readonly displayName: string;
  public readonly jobTitle: string;
  public readonly department: string;
  public readonly tier: UserHierarchyTier;
  public readonly specialistDomain: SpecialistDomain;
  public readonly counterpartAgentRole: AgentRole;
  public readonly ownedStageIds: ReadonlyArray<WorkflowStageId>;
  public readonly permissions: ReadonlyArray<SystemPermissionCode>;
  public readonly avatarBadge: string;

  public constructor(params: {
    userId: string;
    displayName: string;
    jobTitle: string;
    department: string;
    tier: UserHierarchyTier;
    specialistDomain: SpecialistDomain;
    counterpartAgentRole: AgentRole;
    ownedStageIds: ReadonlyArray<WorkflowStageId>;
    permissions: ReadonlyArray<SystemPermissionCode>;
    avatarBadge: string;
  }) {
    this.userId = params.userId;
    this.displayName = params.displayName;
    this.jobTitle = params.jobTitle;
    this.department = params.department;
    this.tier = params.tier;
    this.specialistDomain = params.specialistDomain;
    this.counterpartAgentRole = params.counterpartAgentRole;
    this.ownedStageIds = [...params.ownedStageIds];
    this.permissions = [...params.permissions];
    this.avatarBadge = params.avatarBadge;
  }

  public isProjectAdmin(): boolean {
    return this.tier === UserHierarchyTier.PROJECT_ADMIN;
  }

  public hasPermission(code: SystemPermissionCode): boolean {
    return this.permissions.includes(code);
  }

  public ownsStage(stageId: WorkflowStageId): boolean {
    return this.isProjectAdmin() || this.ownedStageIds.includes(stageId);
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      userId: this.userId,
      displayName: this.displayName,
      jobTitle: this.jobTitle,
      department: this.department,
      tier: this.tier,
      specialistDomain: this.specialistDomain,
      counterpartAgentRole: this.counterpartAgentRole,
      ownedStageIds: this.ownedStageIds,
      permissions: this.permissions,
      avatarBadge: this.avatarBadge,
      isProjectAdmin: this.isProjectAdmin(),
    };
  }
}

/**
 * 针对某一特定阶段门禁的权限评估结果
 */
export interface StageAccessEvaluation {
  readonly stageId: WorkflowStageId;
  readonly canViewSharedArtifact: boolean;
  readonly canApproveOrArbitrate: boolean;
  readonly isDirectDomainOwner: boolean;
  readonly isAdminOverride: boolean;
  readonly requiredSpecialistRoles: ReadonlyArray<string>;
  readonly denialReason: string | null;
}
