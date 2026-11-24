/**
 * @file test-isolation-hygiene.spec.ts
 * @description P2-3 测试隔离卫生守卫：
 * 1) 静态审计全仓 `tests/*.spec.ts`，确保每处 `WorkflowOrchestratorFacade` 与 `WorkbenchHttpServer`
 *    实例化均显式传入隔离的 `persistenceDir` 与 `sandboxRootDir`；
 * 2) 验证 `withTestWorkspace()` 在正常返回与异常抛出路径下均自动清理 `os.tmpdir()` 临时目录。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { createTestWorkspace, withTestWorkspace } from './helpers/testIsolation.ts';

/** 通过括号深度匹配提取 `new ClassName(...)` 调用的参数区间文本 */
function findConstructorCalls(
  source: string,
  className: string,
): Array<{ line: number; argsText: string }> {
  const token = `new ${className}(`;
  const results: Array<{ line: number; argsText: string }> = [];
  let cursor = 0;

  while (cursor < source.length) {
    const idx = source.indexOf(token, cursor);
    if (idx === -1) {
      break;
    }

    const line = source.slice(0, idx).split('\n').length;
    const openParenIdx = idx + token.length - 1;
    let depth = 0;
    let inString: "'" | '"' | '`' | null = null;
    let escaped = false;
    let endIdx = -1;

    for (let i = openParenIdx; i < source.length; i += 1) {
      const ch = source[i];
      if (inString !== null) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    const argsText = endIdx !== -1 ? source.slice(openParenIdx + 1, endIdx) : '';
    results.push({ line, argsText });
    cursor = endIdx !== -1 ? endIdx + 1 : openParenIdx + 1;
  }

  return results;
}

describe('P2-3 — 测试隔离卫生与零工作区污染守卫', () => {
  it('1. 静态审计全仓 tests/*.spec.ts：全部 Facade 与 Server 实例化均显式隔离 persistenceDir 与 sandboxRootDir', () => {
    const testsDir = path.resolve('tests');
    const specFiles = fs
      .readdirSync(testsDir)
      .filter((name) => name.endsWith('.spec.ts'))
      .sort();

    assert.ok(specFiles.length >= 30, '应扫描到完整测试套件文件列表');

    const violations: string[] = [];
    for (const fileName of specFiles) {
      const content = fs.readFileSync(path.join(testsDir, fileName), 'utf-8');
      for (const targetClass of ['WorkflowOrchestratorFacade', 'WorkbenchHttpServer']) {
        const calls = findConstructorCalls(content, targetClass);
        for (const call of calls) {
          const hasPersistence = call.argsText.includes('persistenceDir');
          const hasSandbox = call.argsText.includes('sandboxRootDir');
          if (!hasPersistence || !hasSandbox) {
            violations.push(
              `${fileName}:${call.line} new ${targetClass}(...) missing ${
                !hasPersistence ? 'persistenceDir' : ''
              }${!hasPersistence && !hasSandbox ? ' & ' : ''}${!hasSandbox ? 'sandboxRootDir' : ''}`,
            );
          }
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      `发现未隔离持久化的测试构造点（会污染工作区 .runtime-data/ 或 .sandbox-worktrees/）：\n${violations.join('\n')}`,
    );
  });

  it('2. withTestWorkspace() 与 createTestWorkspace() 将状态写入 os.tmpdir() 且无论成功/异常均彻底清理', async () => {
    let capturedRoot = '';
    await withTestWorkspace('hygiene-pass-', async (ws) => {
      capturedRoot = ws.rootDir;
      assert.ok(
        ws.rootDir.startsWith(os.tmpdir()),
        `隔离工作区应位于 os.tmpdir() 下，实际: ${ws.rootDir}`,
      );
      const orchestrator = new WorkflowOrchestratorFacade({
        maxNegotiationTurns: 3,
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'P23-HYGIENE-01',
          title: '临时目录隔离验证',
          summary: '运行结束后自动清理临时目录',
          requirements: { R1: '隔离持久化与沙箱' },
        }),
        initiatorActor: 'P2-3 测试员',
      });
      assert.equal(fs.existsSync(ws.persistenceDir), true);
      assert.equal(fs.existsSync(ws.sandboxRootDir), true);
    });

    assert.equal(fs.existsSync(capturedRoot), false, '退出 withTestWorkspace 后必须清理临时根目录');

    // 验证异常抛出场景同样执行 finally cleanup()
    const manualWs = createTestWorkspace('hygiene-err-');
    let failedRoot = '';
    await assert.rejects(
      withTestWorkspace('hygiene-throw-', async (ws) => {
        failedRoot = ws.rootDir;
        fs.mkdirSync(ws.persistenceDir, { recursive: true });
        throw new Error('simulated failure');
      }),
      /simulated failure/,
    );
    assert.equal(fs.existsSync(failedRoot), false, '异常分支退出时仍须彻底清理临时目录');
    manualWs.cleanup();
    assert.equal(fs.existsSync(manualWs.rootDir), false);
  });
});
