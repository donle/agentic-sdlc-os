/**
 * @file docker-runtime.spec.ts
 * @description E3 测试：①DockerTestRuntime 命令构造（网络隔离 / 只读 worktree / 读写结果目录 /
 *              超时 kill + 容器清理）与解析口径复用；②沙箱验证的运行时切换与降级链（host / docker /
 *              host-fallback）。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, afterEach } from 'node:test';

import { DockerTestRuntime } from '../src/sandbox/DockerTestRuntime.ts';
import { TestResultParser } from '../src/sandbox/TestResultParser.ts';
import { GitWorktreeSandboxManager } from '../src/sandbox/GitWorktreeSandboxManager.ts';

const FAKE_SPEC_OUTPUT = [
  '▶ 套件',
  '    ✔ 主路径 (1.2ms)',
  '    ✔ 空输入防护 (0.5ms)',
  'ℹ tests 2',
  'ℹ suites 1',
  'ℹ pass 2',
  'ℹ fail 0',
  'ℹ duration_ms 12',
].join('\n');

describe('E3 — DockerTestRuntime（一次性容器执行）', () => {
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

  it('1. 命令构造：--network none + worktree 只读挂载 + 结果目录读写挂载 + tee 留档', () => {
    const workspace = path.join(os.tmpdir(), 'e3-workspace');
    const resultsDir = path.join(os.tmpdir(), 'e3-results');
    const testFile = path.join(workspace, 'tests', 'r1.sandbox.spec.ts');
    let capturedArgs: string[] = [];
    const runtime = new DockerTestRuntime({
      image: 'node:22-alpine',
      probeCommand: () => true,
      runCommand: (args) => {
        capturedArgs = [...args];
        return { output: FAKE_SPEC_OUTPUT, timedOut: false, exitCode: 0 };
      },
    });

    const result = runtime.runSuite(testFile, workspace, resultsDir, 15000);
    assert.equal(result.image, 'node:22-alpine');
    assert.ok(result.containerCommand.startsWith('docker run --rm --name sdlc-verify-'));

    const indexOf = (arg: string): number => capturedArgs.indexOf(arg);
    assert.ok(indexOf('--network') >= 0, '必须带 --network');
    assert.equal(capturedArgs[indexOf('--network') + 1], 'none', '网络必须完全隔离');
    const mountRo = capturedArgs.find((a) => a.endsWith(':/workspace:ro'));
    const mountRw = capturedArgs.find((a) => a.endsWith(':/results:rw'));
    assert.ok(mountRo, 'worktree 必须只读挂载');
    assert.ok(mountRw, '结果目录必须读写挂载');
    assert.equal(capturedArgs[indexOf('-w') + 1], '/workspace');
    assert.ok(capturedArgs.includes('node:22-alpine'));
    const shCommand = capturedArgs[capturedArgs.indexOf('-c') + 1];
    assert.ok(shCommand.includes('--test-reporter=spec'), '容器内使用 spec reporter');
    assert.ok(shCommand.includes('| tee /results/'), '输出 tee 到结果目录留档');
    assert.ok(shCommand.includes('/workspace/tests/r1.sandbox.spec.ts'), '容器内测试路径正确');

    // 宿主侧复用同一解析口径
    const suite = TestResultParser.parseSuiteOutput(result.output, 'tests/r1.sandbox.spec.ts');
    assert.equal(suite.totalCases, 2);
    assert.equal(suite.passedCases, 2);
    assert.equal(suite.failedCases, 0);
  });

  it('2. 超时 → timedOut + best-effort 强制移除容器', () => {
    const removedNames: string[] = [];
    const runtime = new DockerTestRuntime({
      probeCommand: () => true,
      runCommand: (args, timeoutMs) => {
        if (args[0] === 'rm') {
          removedNames.push(args[2]);
          return { output: '', timedOut: false, exitCode: 0 };
        }
        void timeoutMs;
        return { output: '', timedOut: true, exitCode: null };
      },
    });
    const result = runtime.runSuite(
      path.join(os.tmpdir(), 'e3-slow', 'r1.sandbox.spec.ts'),
      path.join(os.tmpdir(), 'e3-slow'),
      path.join(os.tmpdir(), 'e3-slow-results'),
      100,
    );
    assert.equal(result.timedOut, true);
    assert.equal(removedNames.length, 1, '超时后必须 best-effort 执行 docker rm -f');
    assert.ok(removedNames[0].startsWith('sdlc-verify-'));

    // 超时无输出 → 解析如实记 1 条失败（不编造通过数）
    const suite = TestResultParser.parseSuiteOutput(result.output, 'slow-suite', result.timedOut);
    assert.equal(suite.totalCases, 1);
    assert.equal(suite.failedCases, 1);
  });
});

describe('E3 — 沙箱验证运行时切换与降级链', () => {
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

  function provisionSmallSandbox(manager: GitWorktreeSandboxManager): {
    runId: string;
    branchId: string;
    requirementIds: string[];
  } {
    manager.provisionWorktreeAndWriteCode({
      runId: 'RUN-E3-01',
      branchId: 'branch-v1-main',
      proposalTitle: 'E3 运行时测试模块',
      requirementIds: ['REQ_E3_DEMO'],
      requirementDescriptions: { REQ_E3_DEMO: '验证 docker 运行时的演示模块' },
      ddlStatements: [],
    });
    return { runId: 'RUN-E3-01', branchId: 'branch-v1-main', requirementIds: ['REQ_E3_DEMO'] };
  }

  it('3. SANDBOX_RUNTIME=docker + docker 可用（注入假运行时）→ runtime=docker，计数来自容器输出', () => {
    saveEnv(['SANDBOX_RUNTIME']);
    process.env.SANDBOX_RUNTIME = 'docker';
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-e3-docker-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot, {
        dockerRuntime: new DockerTestRuntime({
          probeCommand: () => true,
          runCommand: () => ({ output: FAKE_SPEC_OUTPUT, timedOut: false, exitCode: 0 }),
        }),
      });
      const p = provisionSmallSandbox(manager);
      const result = manager.executeSandboxVerification({
        runId: p.runId,
        branchId: p.branchId,
        requirementIds: p.requirementIds,
        runSubprocessNodeTest: true,
      });
      assert.equal(result.runtime, 'docker');
      assert.equal(result.totalTestCases, 2);
      assert.equal(result.passedTestCases, 2);
      assert.ok(result.executionLog.includes('[Sandbox Runtime] docker'));
      // 结果留档目录已创建
      assert.ok(
        fs.existsSync(path.join(tempSandboxRoot, 'docker-results', p.runId, p.branchId)),
        'docker 结果目录应已建立',
      );
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });

  it('4. SANDBOX_RUNTIME=docker 但 docker 不可用 → 显式降级 host-fallback，宿主机真实执行', () => {
    saveEnv(['SANDBOX_RUNTIME']);
    process.env.SANDBOX_RUNTIME = 'docker';
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-e3-fallback-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot, {
        dockerRuntime: new DockerTestRuntime({ probeCommand: () => false }),
      });
      const p = provisionSmallSandbox(manager);
      const result = manager.executeSandboxVerification({
        runId: p.runId,
        branchId: p.branchId,
        requirementIds: p.requirementIds,
        runSubprocessNodeTest: true,
      });
      assert.equal(result.runtime, 'host-fallback');
      assert.ok(result.subprocessExecuted, '降级后宿主机真实执行');
      assert.ok(
        result.suites.every((s) => s.timedOut === false),
        '宿主机 node:test 正常完成（模板套件为 2 条用例）',
      );
      assert.ok(result.executionLog.includes('[Sandbox Runtime] host-fallback'));
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });

  it('5. 未请求 docker（默认）→ runtime=host，行为与 E2 完全一致', () => {
    saveEnv(['SANDBOX_RUNTIME']);
    delete process.env.SANDBOX_RUNTIME;
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-e3-host-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot);
      const p = provisionSmallSandbox(manager);
      const result = manager.executeSandboxVerification({
        runId: p.runId,
        branchId: p.branchId,
        requirementIds: p.requirementIds,
        runSubprocessNodeTest: true,
      });
      assert.equal(result.runtime, 'host');
      assert.equal(result.subprocessExecuted, true);
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });
});
