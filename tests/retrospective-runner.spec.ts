/**
 * @file retrospective-runner.spec.ts
 * @description P0-6 自动化复盘与基准评测入口测试：验证 6 处异步 await 修复、临时隔离目录不污染默认工作区、
 * 只读评估真实持久化历史运行以及 CLI 执行兼容性。
 */

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict } from '../src/domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { RetrospectiveBenchmarkSuite } from '../src/retrospective/runRetrospective.ts';

describe('P0-6 — runRetrospective 异步时序与真实历史复盘评估测试', () => {
  it('1. runFullSuite() 全 await 顺序执行达标且不向默认 .runtime-data/ 写入 PROP-BENCH 数据', async () => {
    const defaultStorePath = path.resolve('.runtime-data/ledger-store.json');

    const suite = new RetrospectiveBenchmarkSuite();
    const report = await suite.runFullSuite();

    assert.equal(report.overallHealthy, true);
    assert.equal(report.fulfillmentMetrics.fulfillmentRatePercent, 100);
    assert.equal(report.fulfillmentMetrics.retryDistribution.oneRetry, 1);
    assert.ok(report.cacheMetrics.cacheHitRatePercent >= 30);

    if (fs.existsSync(defaultStorePath)) {
      const content = fs.readFileSync(defaultStorePath, 'utf-8');
      assert.equal(
        content.includes('PROP-BENCH-001') || content.includes('PROP-BENCH-002'),
        false,
        '运行基准套件绝不应将合成 PROP-BENCH-001/002 写入工作区默认 .runtime-data/ledger-store.json',
      );
    }
  });

  it('2. evaluatePersistedHistory() 能只读加载真实历史运行并汇总快照/成本指标而不篡改文件', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-history-'));
    const persistDir = path.join(tmpBase, 'persist');
    const sandboxDir = path.join(tmpBase, 'sandbox');

    try {
      const facade = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: persistDir,
        sandboxRootDir: sandboxDir,
      });

      const run = await facade.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'PROP-REAL-HIST-01',
          title: '真实历史持久化复盘测试',
          summary: '验证 evaluatePersistedHistory 读取真实历史快照与裁决',
          requirements: { REQ_1: '支持真实历史快照复盘聚合' },
        }),
        initiatorActor: '产品经理-陈工',
        scenarioHints: { forceTransientRetry: true },
      });

      const qaSnap = run.getLatestSnapshotOnActiveBranch();
      assert.ok(qaSnap);
      await facade.submitHumanGateDecision({
        runId: run.runId,
        snapshotId: qaSnap.snapshotId,
        reviewerActor: 'QA负责人-赵工',
        verdict: DecisionVerdict.APPROVE,
        comment: '真实历史运行 QA 通过',
      });

      const snapshotBefore = fs.readFileSync(path.join(persistDir, 'ledger-store.json'), 'utf-8');

      const suite = new RetrospectiveBenchmarkSuite();
      const summary = suite.evaluatePersistedHistory(persistDir);

      assert.equal(summary.source, 'persisted_history');
      assert.equal(summary.restoredRunCount, 1);
      assert.ok(summary.snapshotCount >= 5, '应完整还原全部已执行阶段快照');
      assert.ok(summary.decisionCount >= 1);
      assert.ok(summary.report !== null);
      assert.equal(summary.report.fulfillmentMetrics.totalInvocations, summary.snapshotCount);
      assert.equal(summary.report.fulfillmentMetrics.retryDistribution.oneRetry, 1);
      assert.equal(
        fs.readFileSync(path.join(persistDir, 'ledger-store.json'), 'utf-8'),
        snapshotBefore,
        '只读评估不得改写已有持久化文件',
      );
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('3. 空持久化目录调用 evaluatePersistedHistory() 应安全返回 empty', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-empty-'));
    try {
      const suite = new RetrospectiveBenchmarkSuite();
      const summary = suite.evaluatePersistedHistory(emptyDir);
      assert.equal(summary.source, 'empty');
      assert.equal(summary.restoredRunCount, 0);
      assert.equal(summary.report, null);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('4. CLI 入口以 --benchmark 模式直启应正常退出 0 并输出完整报告', () => {
    const stdout = execFileSync(
      process.execPath,
      ['src/retrospective/runRetrospective.ts', '--benchmark'],
      {
        encoding: 'utf-8',
        timeout: 20000,
      },
    );
    assert.ok(stdout.includes('自动化复盘与成本控制检测报告') || stdout.includes('隔离基准复盘'));
    assert.ok(stdout.includes('全部达标 (HEALTHY)'));
  });
});
