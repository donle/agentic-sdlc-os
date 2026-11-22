/**
 * @file data-retention.spec.ts
 * @description I3 数据保留测试：①审计 WAL 按月归档（跨月分片 + 合并读取 + 旧单文件兼容）；
 *              ②worktree 保留策略（N=10 默认 / protectRunIds 保护 / Facade 终态钩子触发）。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { AuditTrailEntry } from '../src/engine/ImmutableAuditLedger.ts';
import { PersistenceRepository } from '../src/engine/PersistenceRepository.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { GitWorktreeSandboxManager } from '../src/sandbox/GitWorktreeSandboxManager.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';
import { ProjectProposalContract } from '../src/domain/contracts.ts';
import type { OpenAiCompatibleChatResponse } from '../src/patterns/ModelRouterGateway.ts';

function makeEntry(params: { entryId: string; timestampIso: string }): AuditTrailEntry {
  return new AuditTrailEntry({
    entryId: params.entryId,
    runId: 'RUN-WAL-1',
    branchId: 'branch-v1-main',
    stageId: WorkflowStageId.STAGE_1_PM,
    actor: '测试员',
    actionType: 'TEST_ACTION',
    summary: 'WAL 月度归档测试条目',
    timestampIso: params.timestampIso,
  });
}

describe('I3 — 审计 WAL 按月归档', () => {
  it('1. 跨月条目分片落盘，读取按时间序合并', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-wal-'));
    try {
      const repo = new PersistenceRepository(tempDir);
      repo.appendAuditEntryToWal(
        makeEntry({ entryId: 'E-1', timestampIso: '2026-10-15T08:00:00.000Z' }),
      );
      repo.appendAuditEntryToWal(
        makeEntry({ entryId: 'E-2', timestampIso: '2026-10-20T09:00:00.000Z' }),
      );
      repo.appendAuditEntryToWal(
        makeEntry({ entryId: 'E-3', timestampIso: '2026-11-01T10:00:00.000Z' }),
      );

      const files = repo.getWalFileNames();
      assert.deepEqual(files, ['audit-trail-2026-10.jsonl', 'audit-trail-2026-11.jsonl']);

      const entries = repo.readAuditWalEntries();
      assert.equal(entries.length, 3);
      assert.deepEqual(
        entries.map((e) => e.entryId),
        ['E-1', 'E-2', 'E-3'],
        '合并读取必须保持月度时间序',
      );
      assert.equal(
        (entries[0] as { timestampIso: string }).timestampIso.startsWith('2026-10'),
        true,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. 非法时间戳回落当前月份（不产生畸形文件名）', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-wal2-'));
    try {
      const repo = new PersistenceRepository(tempDir);
      repo.appendAuditEntryToWal(makeEntry({ entryId: 'E-BAD', timestampIso: 'not-a-date' }));
      const files = repo.getWalFileNames();
      assert.equal(files.length, 1);
      assert.match(files[0], /^audit-trail-\d{4}-\d{2}\.jsonl$/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('3. 旧单文件 audit-trail.jsonl 兼容合并（历史数据不丢）', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-wal3-'));
    try {
      const repo = new PersistenceRepository(tempDir);
      // 模拟 I3 之前遗留的旧单文件
      fs.writeFileSync(
        path.join(tempDir, 'audit-trail.jsonl'),
        `${JSON.stringify({ entryId: 'E-LEGACY', summary: '历史条目' })}\n`,
        'utf-8',
      );
      repo.appendAuditEntryToWal(
        makeEntry({ entryId: 'E-NEW', timestampIso: '2026-11-23T00:00:00.000Z' }),
      );

      const entries = repo.readAuditWalEntries();
      assert.deepEqual(
        entries.map((e) => e.entryId),
        ['E-NEW', 'E-LEGACY'],
        '月度分片按字典序在前，旧单文件兜底在后（不丢失）',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('I3 — worktree 保留策略', () => {
  it('4. 保留最近 N 个 run，更旧的被清理；protectRunIds 无视新旧', () => {
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-rt-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot);
      // 造 5 个 run 目录（模拟模式 = 纯目录），mtime 手工错开
      for (let i = 1; i <= 5; i += 1) {
        const runDir = path.join(tempSandboxRoot, `RUN-RET-${String(i).padStart(2, '0')}`);
        fs.mkdirSync(path.join(runDir, 'branch-v1-main'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'branch-v1-main', 'marker.txt'), String(i));
        const oldDate = new Date(Date.UTC(2026, 10, i, 12, 0, 0));
        fs.utimesSync(runDir, oldDate, oldDate);
      }

      const result = manager.enforceWorktreeRetention({ keepLastN: 2 });
      // 5 个目录保留最新 2 个 → 清理 3 个最旧的（迭代序 = 最新在前）
      assert.deepEqual(result.removedRunIds, ['RUN-RET-03', 'RUN-RET-02', 'RUN-RET-01']);
      assert.ok(fs.existsSync(path.join(tempSandboxRoot, 'RUN-RET-05')), '最新的保留');
      assert.ok(fs.existsSync(path.join(tempSandboxRoot, 'RUN-RET-04')), '次新的保留');
      assert.ok(!fs.existsSync(path.join(tempSandboxRoot, 'RUN-RET-01')), '最旧的已删除');

      // protectRunIds：再清一轮（N=1），RUN-RET-05 即使不在最新 N 内也受保护存活
      manager.enforceWorktreeRetention({ keepLastN: 1, protectRunIds: ['RUN-RET-05'] });
      assert.ok(fs.existsSync(path.join(tempSandboxRoot, 'RUN-RET-05')), '受保护的 run 不被清理');
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });

  it('5. Facade 终态钩子：run ABORTED 后自动触发保留策略', async () => {
    const savedEnv: Record<string, string | undefined> = {
      SANDBOX_WORKTREE_RETENTION: process.env.SANDBOX_WORKTREE_RETENTION,
      LITELLM_ENABLE_LIVE_HTTP: process.env.LITELLM_ENABLE_LIVE_HTTP,
    };
    try {
      process.env.SANDBOX_WORKTREE_RETENTION = '1';
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-hook-'));
      // persistenceDir 一并隔离：node --test 并行进程共用默认 .runtime-data 会产生写竞争
      const tempPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-i3-persist-'));
      const orchestrator = new WorkflowOrchestratorFacade({
        sandboxRootDir: tempSandboxRoot,
        persistenceDir: tempPersistDir,
        maxNegotiationTurns: 3,
      });

      // 预置两个"历史 run"的沙箱目录（mtime：A 更旧）
      for (const name of ['RUN-OLD-A', 'RUN-OLD-B']) {
        const runDir = path.join(tempSandboxRoot, name);
        fs.mkdirSync(path.join(runDir, 'branch-v1-main'), { recursive: true });
        fs.writeFileSync(path.join(runDir, 'branch-v1-main', 'marker.txt'), name);
      }
      fs.utimesSync(
        path.join(tempSandboxRoot, 'RUN-OLD-A'),
        new Date(Date.UTC(2026, 0, 1)),
        new Date(Date.UTC(2026, 0, 1)),
      );

      // 触发终态：mock transport 返回纯散文 → PM 自愈重试耗尽 → ABORTED → 钩子执行保留策略
      orchestrator.modelRouter.setHttpTransport(async () => {
        const res: OpenAiCompatibleChatResponse = {
          id: 'chatcmpl-i3',
          model: 'mock',
          choices: [{ message: { role: 'assistant', content: '抱歉，我无法输出 JSON。' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
        return res;
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-I3-HOOK',
          title: 'I3 终态钩子测试项目',
          summary: '散文输出耗尽重试后 ABORTED',
          requirements: { R1: '需求一' },
        }),
        initiatorActor: '测试员',
      });
      assert.equal(runState.getStatus(), 'ABORTED', '散文输出应导致 ABORTED 终态');

      // N=1：最旧的 RUN-OLD-A 被清理，RUN-OLD-B 保留；终态 run 自身受保护
      assert.ok(
        !fs.existsSync(path.join(tempSandboxRoot, 'RUN-OLD-A')),
        '终态钩子应触发保留策略并清理最旧 run',
      );
      assert.ok(fs.existsSync(path.join(tempSandboxRoot, 'RUN-OLD-B')), '最新 run 保留');
      orchestrator.modelRouter.setHttpTransport(null);
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
      fs.rmSync(tempPersistDir, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
