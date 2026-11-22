/**
 * @file McpContextProvider.ts
 * @description 通用 MCP（Model Context Protocol）上下文提供者：经 HTTP JSON-RPC 调用外部
 * MCP 服务器的 `tools/call` 获取外部知识。Figma/数仓/Git 等真实系统在私有化部署时各自
 * 起一个 MCP server，本类用配置（可解析的 need 类型 + 工具名）适配它们。
 *
 * D-2 边界：HTTP 失败/超时/协议错误 → 抛错，由 `ToolRegistry` 统一按
 * required（blocked，显式可见）/ optional（静默降级 + WARN）处理。
 * 凭证：`token` 参数或 env `MCP_AUTH_TOKEN`，以 Bearer 头发送。
 */

import type { ContextNeed, ContextProvider, ContextQuery, ContextResult } from './types.ts';
import { estimateTokens } from './types.ts';

export interface McpContextProviderParams {
  readonly name: string;
  /** MCP server 的 streamable HTTP 端点（JSON-RPC 2.0） */
  readonly serverUrl: string;
  /** 该 MCP server 能提供的 need 类型（与 STAGE_CONTEXT_NEEDS 声明对应） */
  readonly resolvableTypes: ReadonlyArray<string>;
  /** 调用的 MCP 工具名 */
  readonly toolName: string;
  readonly timeoutMs?: number;
  readonly token?: string;
  /** 测试注入口（默认全局 fetch） */
  readonly postJson?: (
    url: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ) => Promise<unknown>;
}

interface McpToolCallResult {
  readonly result?: {
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly isError?: boolean;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

export class McpContextProvider implements ContextProvider {
  public readonly name: string;
  public readonly mcpServerUrl: string;
  private readonly resolvableTypes: ReadonlyArray<string>;
  private readonly toolName: string;
  private readonly timeoutMs: number;
  private readonly token: string | null;
  private readonly postJson: NonNullable<McpContextProviderParams['postJson']>;

  public constructor(params: McpContextProviderParams) {
    this.name = params.name;
    this.mcpServerUrl = params.serverUrl;
    this.resolvableTypes = [...params.resolvableTypes];
    this.toolName = params.toolName;
    this.timeoutMs = params.timeoutMs ?? 10000;
    this.token = params.token ?? process.env.MCP_AUTH_TOKEN ?? null;
    this.postJson =
      params.postJson ??
      (async (url, payload, headers) => {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`MCP HTTP ${response.status}`);
        }
        return (await response.json()) as unknown;
      });
  }

  public canResolve(need: ContextNeed): boolean {
    return this.resolvableTypes.includes(need.type);
  }

  public async resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: this.toolName,
        arguments: {
          needType: need.type,
          runId: query.runId,
          stageId: query.stageId,
          proposalTitle: query.proposal.title,
          requirements: query.proposal.requirementDescriptions,
          upstreamSummaries: [...query.upstreamSummaries],
          maxTokens: need.maxTokens,
        },
      },
    };

    const raw = await this.postJson(this.mcpServerUrl, payload, headers);
    const parsed = raw as McpToolCallResult;
    if (parsed.error) {
      throw new Error(`MCP tools/call 失败: ${parsed.error.message.slice(0, 120)}`);
    }
    const text = (parsed.result?.content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
    if (!text) {
      throw new Error('MCP 返回内容为空');
    }

    return {
      type: need.type,
      content: text,
      tokenEstimate: estimateTokens(text),
      source: `mcp:${this.name}:${this.toolName}`,
      isReal: true,
    };
  }
}
