/**
 * @file WarehouseQueryProvider.ts
 * @description G11：Stage 5（DA Agent）真实数仓查询提供者——**只读 SQL 白名单模板** + 结果 JSON
 * 注入 `analytics_metrics` 上下文；无数仓配置时回落确定性 stub（保持投影报告并显式标注，D-2）。
 *
 * 安全边界（只读承诺的三层防线）：
 * 1. **会话只读**：每条查询前置 `SET default_transaction_read_only = on`；
 * 2. **模板白名单**：SQL 仅允许本文件 `SQL_TEMPLATES` 中预定义的模板，业务输入不做字符串拼接；
 * 3. **参数净化**：唯一参数 runId 经字符白名单 + 单引号转义后内联（与 psql CLI 先例一致，零驱动依赖）。
 *
 * 默认查询 runner：`psql` CLI（`WAREHOUSE_CONNECTION_STRING`），测试经 `queryRunner` 注入 mock。
 * 注册优先级（Facade）：`WAREHOUSE_MCP_URL`（MCP 路线）> `WAREHOUSE_CONNECTION_STRING`（直连只读查询）> stub。
 */

import { execFileSync } from 'node:child_process';

import type { ContextNeed, ContextProvider, ContextQuery, ContextResult } from './types.ts';
import { estimateTokens } from './types.ts';
import { WarehouseStubProvider } from './StubProviders.ts';
import { McpContextProvider } from './McpContextProvider.ts';

/** 只读 SQL 模板白名单（唯一可执行的两个查询；参数仅 :run_id，经净化后内联） */
const SQL_TEMPLATES = {
  metrics_by_requirement: `SELECT requirement_id, metric_name, baseline_value, target_value FROM pipeline_metric_baselines WHERE run_id = ':run_id' ORDER BY requirement_id`,
  tracking_events_coverage: `SELECT event_name, is_verified, verified_at FROM tracking_event_verification WHERE run_id = ':run_id' ORDER BY event_name`,
} as const;

export type SqlTemplateName = keyof typeof SQL_TEMPLATES;

/** runId 字符白名单净化（注入防线：引号/分号等一律替换为下划线，字面量无法逃逸） */
export function sanitizeRunIdForSql(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export function buildWhitelistedSql(templateName: SqlTemplateName, runId: string): string {
  const template = SQL_TEMPLATES[templateName];
  if (!template) {
    throw new Error(`未知 SQL 模板: ${String(templateName)}`);
  }
  return `SET default_transaction_read_only = on;\n${template.replace(':run_id', sanitizeRunIdForSql(runId))}`;
}

export interface WarehouseQueryOutcome {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly sourceLabel: string;
}

export class WarehouseQueryProvider implements ContextProvider {
  public readonly name = 'warehouse-query';
  private readonly connectionUrl: string;
  private readonly maxRows: number;
  private readonly queryRunner: (
    sql: string,
    connectionUrl: string,
  ) => ReadonlyArray<Record<string, unknown>>;
  private readonly stubFallback = new WarehouseStubProvider();

  public constructor(params?: {
    connectionUrl?: string;
    maxRows?: number;
    queryRunner?: (sql: string, connectionUrl: string) => ReadonlyArray<Record<string, unknown>>;
  }) {
    this.connectionUrl = params?.connectionUrl ?? process.env.WAREHOUSE_CONNECTION_STRING ?? '';
    this.maxRows = params?.maxRows ?? 50;
    this.queryRunner =
      params?.queryRunner ??
      ((sql, url) => {
        // psql CLI（与 PgPersistenceDriver 的零依赖先例一致）：SQL 经 stdin 传入，CSV 输出
        const output = execFileSync('psql', [url, '--csv', '--no-psqlrc', '-f', '-'], {
          input: sql,
          encoding: 'utf-8',
          timeout: 15000,
        });
        return parseCsvRows(output);
      });
  }

  public canResolve(need: ContextNeed): boolean {
    return need.type === 'analytics_metrics';
  }

  public async resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    try {
      const metricsRows = this.queryRunner(
        buildWhitelistedSql('metrics_by_requirement', query.runId),
        this.connectionUrl,
      ).slice(0, this.maxRows);
      const eventsRows = this.queryRunner(
        buildWhitelistedSql('tracking_events_coverage', query.runId),
        this.connectionUrl,
      ).slice(0, this.maxRows);
      if (metricsRows.length === 0 && eventsRows.length === 0) {
        throw new Error('数仓查询无结果');
      }
      const content = JSON.stringify({
        warehouse: 'readonly-query',
        metrics: metricsRows,
        trackingEventCoverage: eventsRows,
      });
      return {
        type: need.type,
        content,
        tokenEstimate: estimateTokens(content),
        source: `${this.name}:analytics_metrics`,
        isReal: true,
      };
    } catch (err) {
      // 数仓已配置但查询失败 → 回落 stub（显式 isReal:false，不让 DA 空手而归）
      console.warn(
        `[WarehouseQueryProvider] 只读查询失败 → stub 兜底: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
      );
      const fallback = await this.stubFallback.resolve(query, need);
      return {
        ...fallback,
        source: `${this.name}:query-failed→stub`,
      };
    }
  }
}

/** 极简 CSV 解析（psql --csv：首行表头，值内不含引号换行的简单行；SET 输出行被剔除） */
function parseCsvRows(csv: string): ReadonlyArray<Record<string, unknown>> {
  const lines = csv
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^SET$/i.test(l));
  if (lines.length < 2) {
    return [];
  }
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    const row: Record<string, unknown> = {};
    headers.forEach((header, i) => {
      row[header] = values[i] ?? '';
    });
    return row;
  });
}

/**
 * G11 工厂：按环境选择 analytics_metrics 的 Provider（供 Facade 注册；导出便于测试）
 * 优先级：WAREHOUSE_MCP_URL > WAREHOUSE_CONNECTION_STRING > 确定性 stub
 */
export function createAnalyticsProvider(): ContextProvider {
  const mcpUrl = process.env.WAREHOUSE_MCP_URL ?? '';
  if (mcpUrl) {
    return new McpContextProvider({
      name: 'warehouse-mcp',
      serverUrl: mcpUrl,
      resolvableTypes: ['analytics_metrics'],
      toolName: 'query_warehouse_metrics',
    });
  }
  if (process.env.WAREHOUSE_CONNECTION_STRING) {
    return new WarehouseQueryProvider();
  }
  return new WarehouseStubProvider();
}
