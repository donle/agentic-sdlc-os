/**
 * @file types.ts
 * @description Agent 上下文获取系统类型定义（BACKEND_TODO_DESIGN "Agent 外部知识介入" 章节）。
 *
 * 核心概念：
 * - ContextNeed：Agent 声明"我需要什么类型的外部知识"
 * - ContextProvider：外部知识源（MCP 服务器 / Git / 数仓 / 内部引擎）
 * - ContextResult：解析后的上下文片段（带 token 预算）
 * - ToolRegistry：注册 + 按需解析 + Token 裁剪
 */

import type { WorkflowStageId } from '../../domain/enums.ts';
import type { ProjectProposalContract } from '../../domain/contracts.ts';

/** Agent 声明的外部知识需求 */
export interface ContextNeed {
  /** 知识类型标识：'jira_related' / 'figma_components' / 'code_structure' / 'db_schema' / ... */
  readonly type: string;
  /** 必须有否则 Agent 无法工作（vs 可选增强） */
  readonly required: boolean;
  /** 该项上下文的 token 预算上限 */
  readonly maxTokens: number;
}

/** 传给 ContextProvider 的查询参数 */
export interface ContextQuery {
  readonly runId: string;
  readonly stageId: WorkflowStageId;
  readonly proposal: ProjectProposalContract;
  /** 上游产物摘要（供 ContextProvider 判断相关性） */
  readonly upstreamSummaries: ReadonlyArray<{ stageId: string; summary: string }>;
}

/** ContextProvider 返回的上下文片段 */
export interface ContextResult {
  /** 对应的 ContextNeed.type */
  readonly type: string;
  /** 实际内容（文本 / JSON 字符串） */
  readonly content: string;
  /** 估算 token 数 */
  readonly tokenEstimate: number;
  /** 来源标记（审计用） */
  readonly source: string;
  /** true = 真实数据；false = 降级 stub */
  readonly isReal: boolean;
  /** 是否因超长被 ToolCallLoopGuard 截断 */
  readonly truncated?: boolean;
}

export interface ContextProvider {
  readonly name: string;
  /** MCP 服务器地址（如果有） */
  readonly mcpServerUrl?: string;
  canResolve(need: ContextNeed): boolean;
  resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult>;
}

export interface ResolvedContext {
  readonly need: ContextNeed;
  readonly result: ContextResult | null;
  /** true = 声明了 required 但 Provider 未能提供 */
  readonly blocked: boolean;
}

/** 每个阶段的 ContextNeeds 声明表 */
export const STAGE_CONTEXT_NEEDS: Partial<Record<WorkflowStageId, ReadonlyArray<ContextNeed>>> = {
  STAGE_1_PM: [
    { type: 'jira_related', required: false, maxTokens: 1500 },
    { type: 'metrics_baseline', required: false, maxTokens: 800 },
    { type: 'neg_rejection_lessons', required: false, maxTokens: 500 },
  ],
  STAGE_2_PD: [
    { type: 'figma_components', required: true, maxTokens: 2000 },
    { type: 'neg_rejection_lessons', required: false, maxTokens: 500 },
  ],
  STAGE_3A_TECH_SPEC: [
    { type: 'code_structure', required: true, maxTokens: 2000 },
    { type: 'db_schema', required: true, maxTokens: 1500 },
    { type: 'api_inventory', required: false, maxTokens: 1000 },
  ],
  STAGE_3B_ENGINEER: [
    { type: 'code_structure', required: false, maxTokens: 1500 },
    { type: 'dependency_versions', required: true, maxTokens: 500 },
  ],
  STAGE_4_QA: [
    { type: 'ci_cd_status', required: false, maxTokens: 500 },
    { type: 'test_baseline', required: false, maxTokens: 800 },
  ],
  STAGE_5_DA: [{ type: 'analytics_metrics', required: true, maxTokens: 2000 }],
};

/** 全部已声明的上下文知识类型目录（步骤 4 动态需求的注入白名单——目录外类型一律丢弃） */
export const ALL_CONTEXT_NEED_TYPES: ReadonlySet<string> = new Set(
  Object.values(STAGE_CONTEXT_NEEDS)
    .flat()
    .map((need) => need.type),
);

/** 粗估字符串 token 数（中文 ≈ 1 token/字，英文 ≈ 1 token/4 chars） */
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1 + otherCount / 4);
}
