/**
 * @file StubProviders.ts
 * @description D-2 显式降级 stub 连接器：私有化单机环境没有 Figma/数仓真实系统时，
 * 为 STAGE_2_PD（figma_components, required）与 STAGE_5_DA（analytics_metrics, required）
 * 提供**确定性派生**的演示上下文，避免 required 上下文长期缺失导致阶段 blocked。
 *
 * 诚实口径：`isReal: false`（与 SandboxProvisionResult.simulated 同哲学）——
 * 产物来源标记进审计，不会伪装成真实外部数据。
 * 部署真实 MCP 服务器后（env `FIGMA_MCP_URL` / `WAREHOUSE_MCP_URL`）由 Facade 换用
 * `McpContextProvider`，本文件仅作为无外部系统时的兜底。
 */

import type { ContextNeed, ContextProvider, ContextQuery, ContextResult } from './types.ts';
import { estimateTokens } from './types.ts';

/** 确定性伪随机（同输入同输出，保证演示可复现） */
function stableHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 2147483647;
  }
  return hash;
}

const DS_COMPONENT_POOL = [
  'DataTable',
  'FormPanel',
  'StatusBadge',
  'DrawerDetail',
  'StepIndicator',
  'ApprovalTimeline',
  'MetricCard',
  'FilterToolbar',
] as const;

const INTERACTION_STATE_POOL = ['default', 'hover', 'disabled', 'loading'] as const;

/**
 * STAGE_2_PD `figma_components` stub：为每条核心需求确定性建议 Design System 组件与交互状态。
 */
export class FigmaStubProvider implements ContextProvider {
  public readonly name = 'figma-stub';

  public canResolve(need: ContextNeed): boolean {
    return need.type === 'figma_components';
  }

  public async resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    const componentMappings = query.proposal.coreRequirementIds.map((reqId) => {
      const seed = stableHash(reqId);
      const primary = DS_COMPONENT_POOL[seed % DS_COMPONENT_POOL.length];
      const secondary = DS_COMPONENT_POOL[(seed >> 3) % DS_COMPONENT_POOL.length];
      return {
        reqId,
        suggestedComponents: [primary, secondary !== primary ? secondary : 'CardContainer'],
        interactionStates: INTERACTION_STATE_POOL.slice(0, 2 + (seed % 2)),
        note: 'stub 派生：未连接真实 Figma（FIGMA_MCP_URL 未配置）',
      };
    });

    const content = JSON.stringify({
      designSystem: 'Enterprise-DS(stub)',
      componentMappings,
    });
    return {
      type: need.type,
      content,
      tokenEstimate: estimateTokens(content),
      source: `${this.name}:figma_components`,
      isReal: false,
    };
  }
}

/**
 * STAGE_5_DA `analytics_metrics` stub：按提案需求派生确定性指标基线与目标投影。
 */
export class WarehouseStubProvider implements ContextProvider {
  public readonly name = 'warehouse-stub';

  public canResolve(need: ContextNeed): boolean {
    return need.type === 'analytics_metrics';
  }

  public async resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    const reqIds = query.proposal.coreRequirementIds;
    const metrics = reqIds.map((reqId, index) => {
      const seed = stableHash(`${reqId}:${query.runId}`);
      return {
        metricName: `req_${index + 1}_adoption_rate`,
        relatedRequirement: reqId,
        baselineValue: '0%',
        targetValue: `${10 + (seed % 20)}%`,
        note: 'stub 派生：未连接真实数仓（WAREHOUSE_MCP_URL 未配置）',
      };
    });

    const content = JSON.stringify({ warehouse: 'demo-stub', metrics });
    return {
      type: need.type,
      content,
      tokenEstimate: estimateTokens(content),
      source: `${this.name}:analytics_metrics`,
      isReal: false,
    };
  }
}
