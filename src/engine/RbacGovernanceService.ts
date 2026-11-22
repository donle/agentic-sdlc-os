/**
 * @file RbacGovernanceService.ts
 * @description 企业级多角色权限治理服务 (`RbacGovernanceService`)。
 *
 * 核心职责：
 * 1. 管理两级用户体系（顶层管理员 `PROJECT_ADMIN` + 六大环节专长领域员工 `STAGE_SPECIALIST`）；
 * 2. 维护“阶段门禁 -> 允许审批的专长角色”映射矩阵：
 *    - 所有用户共享工作流完整视图（`canViewSharedArtifact = true`）；
 *    - 各环节专长员工对本领域阶段门禁拥有直接签核/裁决权；
 *    - 最上层管理员拥有最高权限（可管理项目全局配置、并可通过 Admin Override 跨阶段裁决任意门禁）。
 * 3. 在后端 API 层强制执行权限校验，防止越权审批或非管理员篡改系统治理参数。
 */

import { AgentRole, WorkflowStageId } from '../domain/enums.ts';
import { AgentRegistry } from '../agents/AgentRegistry.ts';
import {
  EnterpriseUserAccount,
  SpecialistDomain,
  type StageAccessEvaluation,
  SystemPermissionCode,
  UserHierarchyTier,
} from '../domain/rbac.ts';

export class RbacGovernanceService {
  private readonly users: Map<string, EnterpriseUserAccount>;
  private readonly disabledUserIds: Set<string>;
  private allowSpecialistCrossStageRollback: boolean;
  /** J2：可插拔节点注册表（自定义节点的 RBAC 角色映射来源） */
  private readonly agentRegistry: AgentRegistry;

  public constructor(agentRegistry?: AgentRegistry) {
    this.agentRegistry = agentRegistry ?? AgentRegistry.default();
    this.users = new Map<string, EnterpriseUserAccount>();
    this.disabledUserIds = new Set<string>();
    this.allowSpecialistCrossStageRollback = true;
    this.seedEnterpriseRoster();
  }

  /**
   * 按用户层级与专长领域派生标准细粒度权限码集合（供 SessionService 新增/同步用户共用）
   */
  public static derivePermissionsForRole(
    tier: UserHierarchyTier | string,
    specialistDomain: SpecialistDomain | string,
  ): ReadonlyArray<SystemPermissionCode> {
    if (tier === UserHierarchyTier.PROJECT_ADMIN) {
      return Object.values(SystemPermissionCode);
    }
    switch (specialistDomain) {
      case SpecialistDomain.PRODUCT_MANAGEMENT:
        return [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.CREATE_PROPOSAL,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ];
      case SpecialistDomain.PRODUCT_DESIGN_UX:
        return [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ];
      case SpecialistDomain.SYSTEM_ARCHITECTURE:
        return [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.CREATE_PROPOSAL,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
        ];
      case SpecialistDomain.SOFTWARE_ENGINEERING:
      case SpecialistDomain.QUALITY_ASSURANCE:
        return [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ];
      case SpecialistDomain.DATA_ANALYTICS:
      default:
        return [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
        ];
    }
  }

  private seedEnterpriseRoster(): void {
    const allStages: ReadonlyArray<WorkflowStageId> = [
      WorkflowStageId.STAGE_0_INITIATION,
      WorkflowStageId.STAGE_1_PM,
      WorkflowStageId.STAGE_2_PD,
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      WorkflowStageId.STAGE_3B_ENGINEER,
      WorkflowStageId.STAGE_4_QA,
      WorkflowStageId.STAGE_5_DA,
    ];

    const roster: ReadonlyArray<EnterpriseUserAccount> = [
      // 1. 最上层管理员 (Tier 1: Top-Level Project Administrator)
      new EnterpriseUserAccount({
        userId: 'user-admin-01',
        displayName: '王总管',
        jobTitle: '研发体系最高管理员 / PMO 总监',
        department: '企业研发效能与架构治理委员会',
        tier: UserHierarchyTier.PROJECT_ADMIN,
        specialistDomain: SpecialistDomain.GLOBAL_ADMINISTRATION,
        counterpartAgentRole: AgentRole.SUPERVISOR,
        ownedStageIds: allStages,
        permissions: Object.values(SystemPermissionCode),
        avatarBadge: '👑 ADMIN',
      }),

      // 2. 各环节专业领域员工 (Tier 2: Stage Specialists)
      new EnterpriseUserAccount({
        userId: 'user-pm-01',
        displayName: '陈工 (PM)',
        jobTitle: '资深产品经理',
        department: 'B端核心业务产品部',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.PRODUCT_MANAGEMENT,
        counterpartAgentRole: AgentRole.PRODUCT_MANAGER,
        // PM 负责提案发起、Stage 1 PRD 门禁，并共同参与 Stage 2 PM-PD 协商冲突拍板
        ownedStageIds: [
          WorkflowStageId.STAGE_0_INITIATION,
          WorkflowStageId.STAGE_1_PM,
          WorkflowStageId.STAGE_2_PD,
        ],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.CREATE_PROPOSAL,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ],
        avatarBadge: '📋 PM',
      }),

      new EnterpriseUserAccount({
        userId: 'user-pd-01',
        displayName: '林工 (PD/UX)',
        jobTitle: '主任体验与交互设计师',
        department: '企业级设计系统中心 (UED)',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.PRODUCT_DESIGN_UX,
        counterpartAgentRole: AgentRole.PRODUCT_DESIGNER,
        ownedStageIds: [WorkflowStageId.STAGE_2_PD],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ],
        avatarBadge: '🎨 PD/UX',
      }),

      new EnterpriseUserAccount({
        userId: 'user-tech-01',
        displayName: '赵工 (Tech Lead)',
        jobTitle: '首席系统架构师',
        department: '平台架构与数据安全委员会',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.SYSTEM_ARCHITECTURE,
        counterpartAgentRole: AgentRole.TECH_LEAD,
        ownedStageIds: [WorkflowStageId.STAGE_3A_TECH_SPEC, WorkflowStageId.STAGE_3B_ENGINEER],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.CREATE_PROPOSAL,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
        ],
        avatarBadge: '🏛️ ARCH',
      }),

      new EnterpriseUserAccount({
        userId: 'user-eng-01',
        displayName: '刘工 (Engineer)',
        jobTitle: '高级核心研发工程师',
        department: '核心业务研发工程部',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.SOFTWARE_ENGINEERING,
        counterpartAgentRole: AgentRole.SOFTWARE_ENGINEER,
        ownedStageIds: [WorkflowStageId.STAGE_3B_ENGINEER],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ],
        avatarBadge: '💻 ENG',
      }),

      new EnterpriseUserAccount({
        userId: 'user-qa-01',
        displayName: '孙工 (QA)',
        jobTitle: '质量保证与自动化测试负责人',
        department: '质量工程与发布保障部',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.QUALITY_ASSURANCE,
        counterpartAgentRole: AgentRole.QUALITY_ASSURANCE,
        ownedStageIds: [WorkflowStageId.STAGE_4_QA],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        ],
        avatarBadge: '🛡️ QA',
      }),

      new EnterpriseUserAccount({
        userId: 'user-da-01',
        displayName: '周工 (DA)',
        jobTitle: '资深数据分析师',
        department: '商业智能与数据科学部 (BI)',
        tier: UserHierarchyTier.STAGE_SPECIALIST,
        specialistDomain: SpecialistDomain.DATA_ANALYTICS,
        counterpartAgentRole: AgentRole.DATA_ANALYST,
        ownedStageIds: [WorkflowStageId.STAGE_5_DA],
        permissions: [
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
        ],
        avatarBadge: '📊 DA',
      }),
    ];

    for (const user of roster) {
      this.users.set(user.userId, user);
    }
  }

  public getAllUsers(): ReadonlyArray<EnterpriseUserAccount> {
    return Array.from(this.users.values()).filter((u) => !this.disabledUserIds.has(u.userId));
  }

  /**
   * F1/F2：与 SessionService 同步用户账号与启停状态（打破两套用户源割裂）
   */
  public upsertUserAccount(
    account: EnterpriseUserAccount,
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ): void {
    this.users.set(account.userId, account);
    if (status === 'DISABLED') {
      this.disabledUserIds.add(account.userId);
    } else {
      this.disabledUserIds.delete(account.userId);
    }
  }

  public setUserStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): void {
    if (status === 'DISABLED') {
      this.disabledUserIds.add(userId);
    } else {
      this.disabledUserIds.delete(userId);
    }
  }

  public isUserActive(userId: string): boolean {
    return this.users.has(userId) && !this.disabledUserIds.has(userId);
  }

  /**
   * 仅用于只读视图或未传 userId 时的默认投影展示；
   * 严禁在写操作/权限断言中使用本方法将未知/未认证用户静默提权为 user-admin-01！
   */
  public getUserOrDefault(userId?: string): EnterpriseUserAccount {
    if (userId && this.users.has(userId)) {
      return this.users.get(userId)!;
    }
    return this.users.get('user-admin-01')!;
  }

  public getUserOrThrow(userId: string): EnterpriseUserAccount {
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`未找到企业用户账号: ${userId}`);
    }
    return user;
  }

  /**
   * F1：严格获取当前已认证且处于 ACTIVE 状态的账号（未知、未认证或已停用均抛出 403 RBAC 拦截异常）
   */
  public getUserStrict(userId: string): EnterpriseUserAccount {
    if (!userId || userId === 'UNAUTHENTICATED') {
      throw new Error('[RBAC 权限拦截] 未登录或会话无效，拒绝访问受控业务操作');
    }
    const user = this.users.get(userId);
    if (!user) {
      throw new Error(`[RBAC 权限拦截] 未知的企业用户账号: ${userId}`);
    }
    if (this.disabledUserIds.has(userId)) {
      throw new Error(`[RBAC 权限拦截] 企业用户账号 [${user.displayName}] 已停用，权限已即时吊销`);
    }
    return user;
  }

  /**
   * F1：校验用户是否具备指定的细粒度系统权限码 (`SystemPermissionCode`)
   */
  public assertHasPermission(
    userId: string,
    permission: SystemPermissionCode,
  ): EnterpriseUserAccount {
    const user = this.getUserStrict(userId);
    if (!user.isProjectAdmin() && !user.hasPermission(permission)) {
      throw new Error(
        `[RBAC 权限拦截] 当前用户 [${user.displayName} · ${user.jobTitle}] 缺少所需系统权限码 [${permission}]`,
      );
    }
    return user;
  }

  public isCrossStageRollbackAllowedForSpecialists(): boolean {
    return this.allowSpecialistCrossStageRollback;
  }

  public setAllowSpecialistCrossStageRollback(allowed: boolean): void {
    this.allowSpecialistCrossStageRollback = allowed;
  }

  public getRequiredRolesForStage(stageId: WorkflowStageId): ReadonlyArray<string> {
    // J2：自定义节点（注册表声明）的角色映射配置化；核心阶段走下方硬编码矩阵
    const customRoles = this.agentRegistry.getRequiredHumanRoles(String(stageId));
    if (customRoles !== null) {
      return customRoles;
    }
    switch (stageId) {
      case WorkflowStageId.STAGE_0_INITIATION:
      case WorkflowStageId.STAGE_1_PM:
        return ['产品经理 (PM_SPECIALIST)', '最高管理员 (PROJECT_ADMIN)'];
      case WorkflowStageId.STAGE_2_PD:
        return [
          '体验设计师 (PD_UX_SPECIALIST)',
          '产品经理 (PM_SPECIALIST)',
          '最高管理员 (PROJECT_ADMIN)',
        ];
      case WorkflowStageId.STAGE_3A_TECH_SPEC:
        return ['系统架构师 (TECH_LEAD_SPECIALIST)', '最高管理员 (PROJECT_ADMIN)'];
      case WorkflowStageId.STAGE_3B_ENGINEER:
        return [
          '研发工程师 (ENGINEER_SPECIALIST)',
          '系统架构师 (TECH_LEAD_SPECIALIST)',
          '最高管理员 (PROJECT_ADMIN)',
        ];
      case WorkflowStageId.STAGE_4_QA:
        return ['质量负责人 (QA_SPECIALIST)', '最高管理员 (PROJECT_ADMIN)'];
      case WorkflowStageId.STAGE_5_DA:
        return ['数据分析师 (DA_SPECIALIST)', '最高管理员 (PROJECT_ADMIN)'];
    }
  }

  /**
   * 评估指定用户对某个阶段门禁的共享查看权与审批裁决权
   */
  public evaluateStageAccess(userId: string, stageId: WorkflowStageId): StageAccessEvaluation {
    const requiredRoles = this.getRequiredRolesForStage(stageId);
    if (!userId || userId === 'UNAUTHENTICATED' || !this.users.has(userId)) {
      return {
        stageId,
        canViewSharedArtifact: false,
        canApproveOrArbitrate: false,
        isDirectDomainOwner: false,
        isAdminOverride: false,
        requiredSpecialistRoles: requiredRoles,
        denialReason: `未知或未认证用户 [${userId || 'ANONYMOUS'}] 无权签核阶段 [${stageId}]`,
      };
    }
    const user = this.users.get(userId)!;
    if (this.disabledUserIds.has(userId)) {
      return {
        stageId,
        canViewSharedArtifact: false,
        canApproveOrArbitrate: false,
        isDirectDomainOwner: false,
        isAdminOverride: false,
        requiredSpecialistRoles: requiredRoles,
        denialReason: `当前用户 [${user.displayName}] 账号已停用，无权签核阶段 [${stageId}]`,
      };
    }
    const isDirectOwner =
      user.tier === UserHierarchyTier.STAGE_SPECIALIST && user.ownedStageIds.includes(stageId);
    const isAdmin = user.isProjectAdmin();
    const canApprove =
      (isDirectOwner && user.hasPermission(SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE)) ||
      isAdmin;

    return {
      stageId,
      canViewSharedArtifact: true,
      canApproveOrArbitrate: canApprove,
      isDirectDomainOwner: isDirectOwner,
      isAdminOverride: isAdmin && !isDirectOwner,
      requiredSpecialistRoles: requiredRoles,
      denialReason: canApprove
        ? null
        : `当前用户 [${user.displayName} · ${user.jobTitle}] 非该阶段专长责任人。阶段 [${stageId}] 需由 ${requiredRoles.join(' 或 ')} 签核（你当前拥有完整的共享只读查看权）。`,
    };
  }

  /**
   * 评估当前用户对所有标准阶段的权限矩阵
   */
  public evaluateAllStagesForUser(userId: string): Readonly<Record<string, StageAccessEvaluation>> {
    const stages: ReadonlyArray<WorkflowStageId> = [
      WorkflowStageId.STAGE_1_PM,
      WorkflowStageId.STAGE_2_PD,
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      WorkflowStageId.STAGE_3B_ENGINEER,
      WorkflowStageId.STAGE_4_QA,
      WorkflowStageId.STAGE_5_DA,
    ];
    const matrix: Record<string, StageAccessEvaluation> = {};
    for (const st of stages) {
      matrix[st] = this.evaluateStageAccess(userId, st);
    }
    return matrix;
  }

  /**
   * 强制校验用户是否有权审批或裁决某个阶段的门禁，无权限则抛出 403 业务异常
   */
  public assertCanApproveStageGate(
    userId: string,
    stageId: WorkflowStageId,
  ): {
    readonly user: EnterpriseUserAccount;
    readonly evaluation: StageAccessEvaluation;
    readonly formattedActorLabel: string;
  } {
    const user = this.getUserStrict(userId);
    const evaluation = this.evaluateStageAccess(user.userId, stageId);
    if (!evaluation.canApproveOrArbitrate) {
      throw new Error(`[RBAC 权限拦截] ${evaluation.denialReason ?? '当前角色无权签核该阶段门禁'}`);
    }
    const modeTag = user.isProjectAdmin()
      ? '最高管理员签核/Override'
      : `专长领域签核:${user.specialistDomain}`;
    return {
      user,
      evaluation,
      formattedActorLabel: `${user.displayName} (${user.jobTitle} · ${modeTag})`,
    };
  }

  /**
   * 强制校验用户是否为最上层项目管理员 (`PROJECT_ADMIN`)
   */
  public assertIsProjectAdmin(userId: string): EnterpriseUserAccount {
    const user = this.getUserStrict(userId);
    if (!user.isProjectAdmin()) {
      throw new Error(
        `[RBAC 最高权限拦截] 仅顶层管理员 (PROJECT_ADMIN) 可修改项目全局工作流治理配置，当前用户为 [${user.displayName} · ${user.jobTitle}]`,
      );
    }
    return user;
  }

  /**
   * 强制校验用户是否有权触发总管 Agent 回退
   */
  public assertCanInvokeRollback(
    userId: string,
    targetStageId: WorkflowStageId,
  ): EnterpriseUserAccount {
    const user = this.getUserStrict(userId);
    if (user.isProjectAdmin()) {
      return user;
    }
    if (!user.hasPermission(SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK)) {
      throw new Error(
        `[RBAC 权限拦截] 当前用户 [${user.displayName}] 无权调度总管 Agent 执行 DAG 分叉回退`,
      );
    }
    if (!this.allowSpecialistCrossStageRollback && !user.ownsStage(targetStageId)) {
      throw new Error(
        `[RBAC 权限拦截] 管理员已开启严格阶段回退限制：当前用户 [${user.displayName}] 仅可回退至本专长领域阶段 (${user.ownedStageIds.join(', ')})，不可跨领域回退至 [${targetStageId}]`,
      );
    }
    return user;
  }
}
