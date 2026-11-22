/**
 * @file WorkflowDslLoader.ts
 * @description 声明式可配置工作流 DSL 解析器与拓扑构建器 (`dsl_loader`)。
 *
 * 对应《工程落地架构草案》与《系统设计报告》7.1 节：
 * - 读取并校验 `configs/workflows/*.yaml` 声明式工作流定义；
 * - 将 YAML DSL 转换为强类型的 `WorkflowDslConfiguration` 领域配置对象；
 * - 动态驱动状态机阶段拓扑（如全栈 6 阶段 vs 纯后端跳过 PD 阶段）、风控门禁策略、最大协商轮次、Token 预算与 BYOM 模型路由配置。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { AgentRole, ModelRoutingTier, WorkflowStageId } from '../domain/enums.ts';
import { AgentRegistry } from '../agents/AgentRegistry.ts';

export type DslGatePolicyMode = 'RISK_BASED' | 'FORCE_HUMAN_GATE';

export interface DslStageGatePolicy {
  readonly mode: DslGatePolicyMode;
  readonly lowRiskAction: 'AUTO_PASS_WITH_AUDIT' | 'BLOCK_FOR_HUMAN';
  readonly highRiskAction: 'BLOCK_FOR_HUMAN';
  readonly ownerRole: string;
}

export interface DslStageDescriptor {
  readonly stageId: WorkflowStageId;
  readonly displayName: string;
  readonly agentRole: AgentRole;
  readonly modelTier: ModelRoutingTier;
  readonly negotiateWithStageId: WorkflowStageId | null;
  readonly escalationAgentRole: AgentRole | null;
  readonly gatePolicy: DslStageGatePolicy;
}

export interface DslGuardrailsConfig {
  readonly maxNegotiationTurns: number;
  readonly maxExecutionRetries: number;
  readonly tokenBudgetLimit: number;
  readonly enableSemanticCache: boolean;
  readonly enableFalseConsensusDiffGuard: boolean;
  readonly highRiskScoreThreshold: number;
}

export interface DslModelEndpointConfig {
  readonly tier: ModelRoutingTier;
  readonly provider: string;
  readonly modelName: string;
  readonly costPer1kTokensUsd: number;
}

export class WorkflowDslConfiguration {
  public readonly id: string;
  public readonly name: string;
  public readonly deploymentMode: string;
  public readonly sourceFilePath: string;
  public readonly rawYamlSnapshot: string;
  public readonly guardrails: DslGuardrailsConfig;
  public readonly modelRouting: ReadonlyMap<ModelRoutingTier, DslModelEndpointConfig>;
  public readonly stages: ReadonlyArray<DslStageDescriptor>;

  public constructor(params: {
    id: string;
    name: string;
    deploymentMode: string;
    sourceFilePath: string;
    rawYamlSnapshot: string;
    guardrails: DslGuardrailsConfig;
    modelRouting: ReadonlyMap<ModelRoutingTier, DslModelEndpointConfig>;
    stages: ReadonlyArray<DslStageDescriptor>;
  }) {
    this.id = params.id;
    this.name = params.name;
    this.deploymentMode = params.deploymentMode;
    this.sourceFilePath = params.sourceFilePath;
    this.rawYamlSnapshot = params.rawYamlSnapshot;
    this.guardrails = params.guardrails;
    this.modelRouting = params.modelRouting;
    this.stages = [...params.stages];
  }

  public getStageOrder(): ReadonlyArray<WorkflowStageId> {
    return this.stages.map((s) => s.stageId);
  }

  public findStageDescriptor(stageId: WorkflowStageId): DslStageDescriptor | undefined {
    return this.stages.find((s) => s.stageId === stageId);
  }

  public isForceHumanGate(stageId: WorkflowStageId): boolean {
    const desc = this.findStageDescriptor(stageId);
    if (!desc) {
      return stageId === WorkflowStageId.STAGE_4_QA;
    }
    return (
      desc.gatePolicy.mode === 'FORCE_HUMAN_GATE' ||
      desc.gatePolicy.lowRiskAction === 'BLOCK_FOR_HUMAN'
    );
  }

  /** B2：按 DSL 声明返回该阶段的协商目标（如 QA → 3b Engineer；PD → 1 PM） */
  public findNegotiationTarget(stageId: WorkflowStageId): WorkflowStageId | null {
    return this.findStageDescriptor(stageId)?.negotiateWithStageId ?? null;
  }
}

interface RawYamlRoot {
  workflow?: {
    id?: string;
    name?: string;
    deploymentMode?: string;
    guardrails?: {
      maxNegotiationTurns?: number;
      maxExecutionRetries?: number;
      tokenBudgetLimit?: number;
      enableSemanticCache?: boolean;
      enableFalseConsensusDiffGuard?: boolean;
      highRiskScoreThreshold?: number;
    };
    modelRouting?: Record<
      string,
      {
        provider?: string;
        modelName?: string;
        costPer1kTokensUsd?: number;
      }
    >;
    stages?: Array<{
      stageId?: string;
      displayName?: string;
      agentRole?: string;
      modelTier?: string;
      negotiateWithStageId?: string;
      escalationAgentRole?: string;
      enabled?: boolean;
      /** J2：自定义节点的 RBAC 门禁角色映射（缺省仅最高管理员） */
      requiredHumanRoles?: string[];
      gatePolicy?: {
        mode?: string;
        lowRiskAction?: string;
        highRiskAction?: string;
        ownerRole?: string;
      };
    }>;
  };
}

const CORE_AGENT_ROLES = new Set<string>(Object.values(AgentRole));

export class WorkflowDslLoader {
  public static getDefaultYamlPath(): string {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(currentDir, '../../configs/workflows/enterprise_sdlc.yaml');
  }

  public static listAvailableTemplates(): ReadonlyArray<{
    readonly fileName: string;
    readonly fullPath: string;
  }> {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const workflowsDir = path.resolve(currentDir, '../../configs/workflows');
    if (!fs.existsSync(workflowsDir)) {
      return [];
    }
    return fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort()
      .map((fileName) => ({
        fileName,
        fullPath: path.join(workflowsDir, fileName),
      }));
  }

  public static loadFromFile(filePath?: string): WorkflowDslConfiguration {
    const resolvedPath = filePath ?? WorkflowDslLoader.getDefaultYamlPath();
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`未找到工作流 DSL 配置文件: ${resolvedPath}`);
    }
    const rawYaml = fs.readFileSync(resolvedPath, 'utf-8');
    return WorkflowDslLoader.parseFromString(rawYaml, path.basename(resolvedPath));
  }

  public static parseFromString(
    rawYaml: string,
    sourceLabel = 'inline.yaml',
    registryForParsing?: AgentRegistry,
  ): WorkflowDslConfiguration {
    const parsed = parseYaml(rawYaml) as RawYamlRoot | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.workflow) {
      throw new Error(`工作流 DSL [${sourceLabel}] 缺少顶层 "workflow" 节点`);
    }

    const wf = parsed.workflow;
    const id = String(wf.id ?? '').trim();
    const name = String(wf.name ?? '').trim();
    if (!id || !name) {
      throw new Error(`工作流 DSL [${sourceLabel}] 必须定义 workflow.id 和 workflow.name`);
    }

    const rawGuardrails = wf.guardrails ?? {};
    const guardrails: DslGuardrailsConfig = {
      maxNegotiationTurns: Number(rawGuardrails.maxNegotiationTurns ?? 3),
      maxExecutionRetries: Number(rawGuardrails.maxExecutionRetries ?? 2),
      tokenBudgetLimit: Number(rawGuardrails.tokenBudgetLimit ?? 120000),
      enableSemanticCache: Boolean(rawGuardrails.enableSemanticCache ?? true),
      enableFalseConsensusDiffGuard: Boolean(rawGuardrails.enableFalseConsensusDiffGuard ?? true),
      highRiskScoreThreshold: Number(rawGuardrails.highRiskScoreThreshold ?? 60),
    };

    if (guardrails.maxNegotiationTurns < 1) {
      throw new Error(`工作流 DSL [${sourceLabel}] maxNegotiationTurns 必须 >= 1`);
    }
    if (!Number.isFinite(guardrails.tokenBudgetLimit) || guardrails.tokenBudgetLimit < 1000) {
      throw new Error(
        `工作流 DSL [${sourceLabel}] tokenBudgetLimit 必须 >= 1000（预算守卫 B3 的硬下限）`,
      );
    }

    const modelRouting = new Map<ModelRoutingTier, DslModelEndpointConfig>();
    const rawRouting = wf.modelRouting ?? {};
    const privacyCfg = rawRouting.PRIVACY_SENSITIVE;
    if (privacyCfg) {
      modelRouting.set(ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL, {
        tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
        provider: String(privacyCfg.provider ?? 'local-vllm'),
        modelName: String(privacyCfg.modelName ?? 'qwen2.5-coder-32b-instruct-int4'),
        costPer1kTokensUsd: Number(privacyCfg.costPer1kTokensUsd ?? 0.0002),
      });
    }
    const reasoningCfg = rawRouting.HIGH_REASONING;
    if (reasoningCfg) {
      modelRouting.set(ModelRoutingTier.HIGH_REASONING_HYBRID, {
        tier: ModelRoutingTier.HIGH_REASONING_HYBRID,
        provider: String(reasoningCfg.provider ?? 'private-gateway'),
        modelName: String(reasoningCfg.modelName ?? 'claude-3-7-sonnet-enterprise'),
        costPer1kTokensUsd: Number(reasoningCfg.costPer1kTokensUsd ?? 0.003),
      });
    }

    if (!Array.isArray(wf.stages) || wf.stages.length === 0) {
      throw new Error(`工作流 DSL [${sourceLabel}] 必须包含非空的 stages 阶段列表`);
    }

    // J2：注册表口径——DSL 声明的**新节点**（阶段键/角色键不在核心枚举）动态注册，
    // 不再以裸枚举白名单拦截（两遍解析：先注册全部自定义节点，再构建描述符，
    // 使 negotiateWithStageId 可指向后文声明的自定义阶段）。
    const registry = registryForParsing ?? AgentRegistry.default();
    for (const rawStage of wf.stages) {
      if (rawStage.enabled === false) {
        continue;
      }
      const stageIdStr = String(rawStage.stageId ?? '').trim();
      if (!registry.isValidStageId(stageIdStr)) {
        registry.registerCustomStage({
          stageId: stageIdStr,
          agentRole: String(rawStage.agentRole ?? '').trim(),
          displayName: String(rawStage.displayName ?? '').trim() || stageIdStr,
          requiredHumanRoles: ((rawStage.requiredHumanRoles as string[] | undefined) ?? []).map(
            String,
          ),
        });
      }
    }

    const stages: DslStageDescriptor[] = [];
    for (const rawStage of wf.stages) {
      if (rawStage.enabled === false) {
        continue;
      }
      const stageIdStr = String(rawStage.stageId ?? '').trim();
      if (!registry.isValidStageId(stageIdStr)) {
        throw new Error(`工作流 DSL [${sourceLabel}] 包含未知阶段标识: ${stageIdStr}`);
      }
      const agentRoleStr = String(rawStage.agentRole ?? '').trim();
      const isCustomStage = registry.isCustomStage(stageIdStr);
      if (!isCustomStage && !CORE_AGENT_ROLES.has(agentRoleStr)) {
        throw new Error(
          `工作流 DSL [${sourceLabel}] 阶段 [${stageIdStr}] 包含未知角色: ${agentRoleStr}`,
        );
      }

      const rawTier = String(rawStage.modelTier ?? 'HIGH_REASONING').trim();
      const modelTier: ModelRoutingTier =
        rawTier === 'PRIVACY_SENSITIVE' || rawTier === ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL
          ? ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL
          : ModelRoutingTier.HIGH_REASONING_HYBRID;

      let negotiateWithStageId: WorkflowStageId | null = null;
      if (rawStage.negotiateWithStageId) {
        const negStageStr = String(rawStage.negotiateWithStageId).trim();
        if (!registry.isValidStageId(negStageStr)) {
          throw new Error(`工作流 DSL [${sourceLabel}] 协商目标阶段非法: ${negStageStr}`);
        }
        negotiateWithStageId = negStageStr as WorkflowStageId;
      }

      let escalationAgentRole: AgentRole | null = null;
      if (rawStage.escalationAgentRole) {
        const escRoleStr = String(rawStage.escalationAgentRole).trim();
        if (registry.isValidAgentRole(escRoleStr)) {
          escalationAgentRole = escRoleStr as AgentRole;
        }
      }

      const rawGate = rawStage.gatePolicy ?? {};
      const gateMode: DslGatePolicyMode =
        rawGate.mode === 'FORCE_HUMAN_GATE' ? 'FORCE_HUMAN_GATE' : 'RISK_BASED';
      const lowRiskAction =
        rawGate.lowRiskAction === 'BLOCK_FOR_HUMAN' || gateMode === 'FORCE_HUMAN_GATE'
          ? 'BLOCK_FOR_HUMAN'
          : 'AUTO_PASS_WITH_AUDIT';

      stages.push({
        stageId: stageIdStr as WorkflowStageId,
        displayName: String(rawStage.displayName ?? stageIdStr),
        agentRole: agentRoleStr as AgentRole,
        modelTier,
        negotiateWithStageId,
        escalationAgentRole,
        gatePolicy: {
          mode: gateMode,
          lowRiskAction,
          highRiskAction: 'BLOCK_FOR_HUMAN',
          ownerRole: String(rawGate.ownerRole ?? '领域审核负责人'),
        },
      });
    }

    if (stages.length === 0) {
      throw new Error(`工作流 DSL [${sourceLabel}] 启用后的有效阶段数不能为 0`);
    }

    return new WorkflowDslConfiguration({
      id,
      name,
      deploymentMode: String(wf.deploymentMode ?? 'SINGLE_NODE_ON_PREMISE'),
      sourceFilePath: sourceLabel,
      rawYamlSnapshot: rawYaml,
      guardrails,
      modelRouting,
      stages,
    });
  }
}
