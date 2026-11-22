/**
 * @file warehouse-query.spec.ts
 * @description G11 测试：只读数仓查询接入——①SQL 模板白名单与会话只读前置；
 *              ②runId 参数净化（注入拦截）；③查询成功 → isReal:true 真实数据注入；
 *              ④查询失败 → stub 兜底显式降级；⑤Provider 工厂按 env 选择。
 */

import * as assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  buildWhitelistedSql,
  createAnalyticsProvider,
  sanitizeRunIdForSql,
  WarehouseQueryProvider,
} from '../src/agents/context/WarehouseQueryProvider.ts';
import { WarehouseStubProvider } from '../src/agents/context/StubProviders.ts';
import { McpContextProvider } from '../src/agents/context/McpContextProvider.ts';
import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import type { ContextNeed } from '../src/agents/context/types.ts';

const DA_NEED: ContextNeed = { type: 'analytics_metrics', required: true, maxTokens: 2000 };

function makeQuery(runId: string): {
  runId: string;
  stageId: WorkflowStageId;
  proposal: ProjectProposalContract;
  upstreamSummaries: ReadonlyArray<{ stageId: string; summary: string }>;
} {
  return {
    runId,
    stageId: WorkflowStageId.STAGE_5_DA,
    proposal: new ProjectProposalContract({
      proposalId: 'P-G11',
      title: 'G11 数仓闭环测试',
      summary: '只读查询测试提案',
      requirements: { R1: '需求一' },
    }),
    upstreamSummaries: [],
  };
}

describe('G11 — 只读数仓查询', () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function saveEnv(keys: string[]): void {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
    }
  }

  it('1. SQL 白名单模板：只读会话前置 + 仅两个预定义模板 + 参数仅 :run_id', () => {
    const sql = buildWhitelistedSql('metrics_by_requirement', 'RUN-G11-1');
    assert.ok(
      sql.startsWith('SET default_transaction_read_only = on;'),
      '每条查询必须前置只读会话声明',
    );
    assert.ok(sql.includes("WHERE run_id = 'RUN-G11-1'"), 'runId 经净化后内联');
    assert.ok(!sql.includes(';DROP') && !sql.includes('--'), '模板内不含额外语句');

    assert.throws(() => buildWhitelistedSql('drop_table_users' as never, 'RUN-1'), /未知 SQL 模板/);
  });

  it('2. runId 净化：注入载荷被字符白名单剥离（引号/分号归零）', () => {
    const sanitized = sanitizeRunIdForSql("x'; DROP TABLE users;--");
    assert.equal(sanitized, 'x___DROP_TABLE_users_--');
    // 关键安全属性：单引号与分号必然被剥离（注入向量死亡）
    assert.ok(!sanitized.includes("'") && !sanitized.includes(';'));
    assert.ok(sanitizeRunIdForSql(`${'A'.repeat(100)}`).length <= 64, '长度截断 64');
  });

  it('3. 查询成功 → isReal:true，注入真实指标与埋点核验 JSON', async () => {
    const provider = new WarehouseQueryProvider({
      connectionUrl: 'postgresql://warehouse.internal/metrics',
      queryRunner: (sql) => {
        assert.ok(sql.includes('default_transaction_read_only'));
        return sql.includes('pipeline_metric_baselines')
          ? [
              {
                requirement_id: 'R1',
                metric_name: 'req_1_adoption_rate',
                baseline_value: '0%',
                target_value: '25%',
              },
            ]
          : [{ event_name: 'evt_r1', is_verified: 'true', verified_at: '2026-11-23' }];
      },
    });
    const result = await provider.resolve(makeQuery('RUN-G11-OK'), DA_NEED);
    assert.equal(result.isReal, true);
    assert.equal(result.source, 'warehouse-query:analytics_metrics');
    const parsed = JSON.parse(result.content) as {
      warehouse: string;
      metrics: Array<{ metric_name: string }>;
      trackingEventCoverage: Array<{ event_name: string }>;
    };
    assert.equal(parsed.warehouse, 'readonly-query');
    assert.equal(parsed.metrics.length, 1);
    assert.equal(parsed.metrics[0].metric_name, 'req_1_adoption_rate');
    assert.equal(parsed.trackingEventCoverage[0].event_name, 'evt_r1');
  });

  it('4. 查询失败 → stub 兜底显式降级（isReal:false + source 标注 query-failed）', async () => {
    const provider = new WarehouseQueryProvider({
      queryRunner: () => {
        throw new Error('connection refused');
      },
    });
    const result = await provider.resolve(makeQuery('RUN-G11-FAIL'), DA_NEED);
    assert.equal(result.isReal, false, '兜底数据不得伪装为真实数仓结果');
    assert.ok(result.source.includes('query-failed'), '来源必须显式标注降级');
    const parsed = JSON.parse(result.content) as { warehouse: string };
    assert.equal(parsed.warehouse, 'demo-stub', '内容为确定性 stub');
  });

  it('5. 工厂按 env 选择：MCP 优先于直连，直连优先于 stub', () => {
    saveEnv(['WAREHOUSE_MCP_URL', 'WAREHOUSE_CONNECTION_STRING']);
    process.env.WAREHOUSE_MCP_URL = 'http://127.0.0.1:9/mcp';
    process.env.WAREHOUSE_CONNECTION_STRING = 'postgresql://wh/m';
    assert.ok(createAnalyticsProvider() instanceof McpContextProvider, 'MCP URL 优先');

    delete process.env.WAREHOUSE_MCP_URL;
    assert.ok(
      createAnalyticsProvider() instanceof WarehouseQueryProvider,
      '仅连接串时用只读查询 Provider',
    );

    delete process.env.WAREHOUSE_CONNECTION_STRING;
    assert.ok(createAnalyticsProvider() instanceof WarehouseStubProvider, '都未配置时回落 stub');
  });
});
