/**
 * @file AgentRegistry.ts
 * @description J2 可插拔节点注册表：核心 7 阶段仍由枚举与强类型 Agent 承载，
 * DSL 可声明的**新节点**（阶段键/角色键）经本注册表动态注册——
 * `VALID_STAGE_IDS` 从注册表口径取值（枚举 ∪ 自定义，替代裸枚举白名单），
 * RBAC 门禁角色映射随节点声明配置化（替代硬编码 switch）。
 *
 * 边界：自定义节点当前为**编排检查点**语义（无自动执行体，Facade 跳过推进并广播通知）；
 * 强类型产物契约仅覆盖核心 7 阶段（扩展产物契约需另立条目，见 docs/J2_PLUGGABLE_NODES.md）。
 */

import { AgentRole, WorkflowStageId } from '../domain/enums.ts';

export interface CustomStageDescriptor {
  /** 新阶段键（大写下划线，非核心枚举成员） */
  readonly stageId: string;
  /** 新角色键（DSL 声明） */
  readonly agentRole: string;
  readonly displayName: string;
  /** RBAC 门禁所需人类角色映射（缺省 = 仅最高管理员） */
  readonly requiredHumanRoles?: ReadonlyArray<string>;
}

const CUSTOM_STAGE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const DEFAULT_CUSTOM_STAGE_HUMAN_ROLES: ReadonlyArray<string> = ['最高管理员 (PROJECT_ADMIN)'];

export class AgentRegistry {
  private readonly enumStageIds: ReadonlySet<string>;
  private readonly enumRoles: ReadonlySet<string>;
  private readonly customStages = new Map<string, CustomStageDescriptor>();
  private readonly customRoles = new Set<string>();

  public constructor() {
    this.enumStageIds = new Set<string>(Object.values(WorkflowStageId));
    this.enumRoles = new Set<string>(Object.values(AgentRole));
  }

  private static readonly defaultInstance = new AgentRegistry();

  /** 进程级共享注册表（DSL 校验与 RBAC 查询共用同一口径） */
  public static default(): AgentRegistry {
    return this.defaultInstance;
  }

  /**
   * 注册（或覆盖）自定义节点；核心枚举阶段禁止覆盖。
   * 同键重复注册 = 覆盖更新（同一 DSL 模板重复解析保持幂等）。
   */
  public registerCustomStage(descriptor: CustomStageDescriptor): CustomStageDescriptor {
    const stageId = String(descriptor.stageId ?? '').trim();
    if (!CUSTOM_STAGE_KEY_PATTERN.test(stageId)) {
      throw new Error(
        `自定义阶段标识 [${stageId}] 非法：需为大写下划线格式（字母开头，3-64 位 [A-Z0-9_]）`,
      );
    }
    if (this.enumStageIds.has(stageId)) {
      throw new Error(`阶段 [${stageId}] 为核心枚举阶段，不允许以自定义节点覆盖`);
    }
    const agentRole = String(descriptor.agentRole ?? '').trim();
    if (!agentRole) {
      throw new Error(`自定义阶段 [${stageId}] 必须声明 agentRole`);
    }
    const normalized: CustomStageDescriptor = {
      stageId,
      agentRole,
      displayName: String(descriptor.displayName ?? '').trim() || stageId,
      requiredHumanRoles: descriptor.requiredHumanRoles?.length
        ? [...descriptor.requiredHumanRoles]
        : undefined,
    };
    this.customStages.set(stageId, normalized);
    this.customRoles.add(agentRole);
    return normalized;
  }

  public getCustomStage(stageId: string): CustomStageDescriptor | undefined {
    return this.customStages.get(String(stageId));
  }

  public isCustomStage(stageId: string): boolean {
    return this.customStages.has(String(stageId));
  }

  public listCustomStages(): ReadonlyArray<CustomStageDescriptor> {
    return [...this.customStages.values()];
  }

  /** J2：阶段键合法性 = 核心枚举 ∪ 注册表自定义（DSL 校验唯一口径） */
  public isValidStageId(stageId: string): boolean {
    const key = String(stageId);
    return this.enumStageIds.has(key) || this.customStages.has(key);
  }

  /** J2：角色键合法性 = 核心枚举 ∪ 注册表自定义 */
  public isValidAgentRole(role: string): boolean {
    const key = String(role);
    return this.enumRoles.has(key) || this.customRoles.has(key);
  }

  /**
   * RBAC 门禁角色查询：自定义节点返回声明映射（缺省仅管理员）；核心阶段返回 null（由 RBAC 硬表负责）。
   */
  public getRequiredHumanRoles(stageId: string): ReadonlyArray<string> | null {
    const custom = this.getCustomStage(stageId);
    if (!custom) {
      return null;
    }
    return custom.requiredHumanRoles ?? DEFAULT_CUSTOM_STAGE_HUMAN_ROLES;
  }
}
