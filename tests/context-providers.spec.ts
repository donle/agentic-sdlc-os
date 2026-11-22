/**
 * @file context-providers.spec.ts
 * @description 步骤 3（MCP 三服务器）单测：McpContextProvider JSON-RPC 协议与失败边界 +
 *              Figma/数仓 stub 连接器的确定性派生 + ToolRegistry 集成解析。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { McpContextProvider } from '../src/agents/context/McpContextProvider.ts';
import { FigmaStubProvider, WarehouseStubProvider } from '../src/agents/context/StubProviders.ts';
import { ToolRegistry } from '../src/agents/context/ToolRegistry.ts';
import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';

function makeProposal(): ProjectProposalContract {
  return new ProjectProposalContract({
    proposalId: 'P-MCP-1',
    title: 'MCP 连接器测试项目',
    summary: '验证外部知识提供者',
    requirements: { R1: '采购审批流程数字化', R2: '合同归档与检索' },
  });
}

function makeQuery(stageId: WorkflowStageId): {
  runId: string;
  stageId: WorkflowStageId;
  proposal: ProjectProposalContract;
  upstreamSummaries: ReadonlyArray<{ stageId: string; summary: string }>;
} {
  return { runId: 'RUN-MCP-1', stageId, proposal: makeProposal(), upstreamSummaries: [] };
}

describe('步骤 3 — McpContextProvider（通用 MCP JSON-RPC 客户端）', () => {
  it('1. tools/call 请求载荷与文本内容解析', async () => {
    let capturedPayload: Record<string, unknown> | null = null;
    const provider = new McpContextProvider({
      name: 'figma-mcp',
      serverUrl: 'http://127.0.0.1:9/mcp',
      resolvableTypes: ['figma_components'],
      toolName: 'get_figma_components',
      postJson: async (url, payload, headers) => {
        capturedPayload = payload;
        assert.equal(url, 'http://127.0.0.1:9/mcp');
        assert.equal(headers['Content-Type'], 'application/json');
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              { type: 'text', text: '{"designSystem":"Enterprise-DS","mappings":["DataTable"]}' },
            ],
          },
        };
      },
    });

    const result = await provider.resolve(makeQuery(WorkflowStageId.STAGE_2_PD), {
      type: 'figma_components',
      required: true,
      maxTokens: 2000,
    });
    assert.equal(result.isReal, true);
    assert.equal(result.source, 'mcp:figma-mcp:get_figma_components');
    assert.ok(result.content.includes('Enterprise-DS'));
    assert.ok(result.tokenEstimate > 0);

    // JSON-RPC 载荷形状
    const captured = capturedPayload as unknown as {
      jsonrpc: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    assert.equal(captured.jsonrpc, '2.0');
    const params = captured.params;
    assert.equal(params.name, 'get_figma_components');
    assert.equal(params.arguments.needType, 'figma_components');
    assert.equal(params.arguments.stageId, 'STAGE_2_PD');
  });

  it('2. MCP 返回 error → 抛错（由 ToolRegistry 按 required/optional 处理）', async () => {
    const provider = new McpContextProvider({
      name: 'broken-mcp',
      serverUrl: 'http://127.0.0.1:9/mcp',
      resolvableTypes: ['db_schema'],
      toolName: 'query',
      postJson: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: '内部错误' },
      }),
    });
    await assert.rejects(
      provider.resolve(makeQuery(WorkflowStageId.STAGE_3A_TECH_SPEC), {
        type: 'db_schema',
        required: true,
        maxTokens: 1500,
      }),
      /MCP tools\/call 失败/,
    );
  });

  it('3. MCP 返回空内容 → 抛错（不让空字符串伪装成有效上下文）', async () => {
    const provider = new McpContextProvider({
      name: 'empty-mcp',
      serverUrl: 'http://127.0.0.1:9/mcp',
      resolvableTypes: ['api_inventory'],
      toolName: 'query',
      postJson: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
    });
    await assert.rejects(
      provider.resolve(makeQuery(WorkflowStageId.STAGE_3A_TECH_SPEC), {
        type: 'api_inventory',
        required: false,
        maxTokens: 1000,
      }),
      /内容为空/,
    );
  });

  it('4. canResolve 按声明类型匹配', () => {
    const provider = new McpContextProvider({
      name: 'x',
      serverUrl: 'http://127.0.0.1:9/mcp',
      resolvableTypes: ['figma_components', 'db_schema'],
      toolName: 'q',
      postJson: async () => ({}),
    });
    assert.equal(
      provider.canResolve({ type: 'figma_components', required: true, maxTokens: 1 }),
      true,
    );
    assert.equal(
      provider.canResolve({ type: 'jira_related', required: false, maxTokens: 1 }),
      false,
    );
  });
});

describe('步骤 3 — Figma/数仓 stub 连接器（D-2 显式降级补位）', () => {
  it('5. FigmaStubProvider：每条需求确定性建议组件，isReal=false 诚实标记', async () => {
    const provider = new FigmaStubProvider();
    const result1 = await provider.resolve(makeQuery(WorkflowStageId.STAGE_2_PD), {
      type: 'figma_components',
      required: true,
      maxTokens: 2000,
    });
    const result2 = await provider.resolve(makeQuery(WorkflowStageId.STAGE_2_PD), {
      type: 'figma_components',
      required: true,
      maxTokens: 2000,
    });
    assert.equal(result1.isReal, false, 'stub 上下文不得伪装为真实数据');
    assert.equal(result1.content, result2.content, '同输入必须产出确定性相同内容');
    const parsed = JSON.parse(result1.content) as {
      componentMappings: Array<{ reqId: string; suggestedComponents: string[] }>;
    };
    assert.deepEqual(
      parsed.componentMappings.map((m) => m.reqId),
      ['R1', 'R2'],
    );
    assert.ok(parsed.componentMappings.every((m) => m.suggestedComponents.length >= 2));
  });

  it('6. WarehouseStubProvider：按需求派生指标基线，isReal=false', async () => {
    const provider = new WarehouseStubProvider();
    const result = await provider.resolve(makeQuery(WorkflowStageId.STAGE_5_DA), {
      type: 'analytics_metrics',
      required: true,
      maxTokens: 2000,
    });
    assert.equal(result.isReal, false);
    const parsed = JSON.parse(result.content) as {
      metrics: Array<{ relatedRequirement: string; baselineValue: string; targetValue: string }>;
    };
    assert.equal(parsed.metrics.length, 2);
    assert.ok(parsed.metrics.every((m) => m.baselineValue === '0%' && m.targetValue.endsWith('%')));
  });

  it('7. ToolRegistry 集成：stub 补位后 STAGE_2_PD 的 required figma_components 不再 blocked', async () => {
    const registry = new ToolRegistry(4000);
    registry.register(new FigmaStubProvider());
    const result = await registry.resolve(
      [
        { type: 'figma_components', required: true, maxTokens: 2000 },
        { type: 'neg_rejection_lessons', required: false, maxTokens: 500 },
      ],
      makeQuery(WorkflowStageId.STAGE_2_PD),
    );
    assert.equal(result.included.length, 1);
    assert.equal(result.included[0].result?.isReal, false);
    assert.equal(
      result.truncated.some((t) => t.type === 'figma_components'),
      false,
      'required 上下文由 stub 补位后不应再产生 blocked 记录',
    );
  });
});
