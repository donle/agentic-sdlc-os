/**
 * @file test-result-parser.spec.ts
 * @description E2 边界单测：TestResultParser 解析 node:test spec 输出的真实计数与覆盖率。
 * 边界：正常输出 / 全失败 / 超时 / 输出无法解析（崩溃）→ 如实上报不编造。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { TestResultParser } from '../src/sandbox/TestResultParser.ts';

describe('E2 — TestResultParser 边界测试', () => {
  let tmpDir: string;

  function writeTest(fileName: string, content: string): string {
    const absPath = path.join(tmpDir, fileName);
    fs.writeFileSync(absPath, content, 'utf-8');
    return absPath;
  }

  describe('正常解析', () => {
    it('1. 全通过的 node:test spec 文件 → 正确计数', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-parser-'));
      try {
        const testFile = writeTest(
          'pass.spec.ts',
          `import test from 'node:test';
import assert from 'node:assert/strict';
test('test1', () => { assert.equal(1, 1); });
test('test2', () => { assert.equal(2, 2); });
`,
        );
        const result = TestResultParser.runSuite(testFile, tmpDir, 15000);
        assert.equal(result.totalCases, 2);
        assert.equal(result.passedCases, 2);
        assert.equal(result.failedCases, 0);
        assert.equal(result.timedOut, false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('2. 部分失败 → failedCases 如实上报', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-parser-'));
      try {
        const testFile = writeTest(
          'fail.spec.ts',
          `import test from 'node:test';
import assert from 'node:assert/strict';
test('pass1', () => { assert.equal(1, 1); });
test('fail1', () => { assert.equal(1, 2); });
test('pass2', () => { assert.equal(3, 3); });
`,
        );
        const result = TestResultParser.runSuite(testFile, tmpDir, 15000);
        assert.equal(result.totalCases, 3);
        assert.equal(result.passedCases, 2);
        assert.equal(result.failedCases, 1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('异常场景', () => {
    it('3. P1-3 激活：超时 → timedOut=true 且 failedCases >= 1', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-parser-'));
      try {
        const testFile = writeTest(
          'timeout.spec.ts',
          `import test from 'node:test';
test('hang', async () => { await new Promise(() => {}); });
`,
        );
        const result = TestResultParser.runSuite(testFile, tmpDir, 1200);
        assert.equal(result.timedOut, true, '超时应标记');
        assert.equal(result.passedCases, 0, '超时不应有通过数');
        assert.equal(result.failedCases >= 1, true, '超时至少计 1 条失败');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('4. 测试文件语法错误 → parseFailed → 如实记 1 条失败', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-parser-'));
      try {
        const testFile = writeTest(
          'crash.spec.ts',
          'this is not valid TypeScript or JavaScript !!!',
        );
        const result = TestResultParser.runSuite(testFile, tmpDir, 10000);
        assert.equal(result.totalCases >= 1, true, '崩溃时至少记 1 条');
        assert.equal(result.passedCases, 0, '崩溃时通过数应为 0');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('5. P1-3 激活：空测试文件 → 零失败且不编造额外通过数（parseSuiteOutput 空输出为 0）', () => {
      const parsedEmpty = TestResultParser.parseSuiteOutput('', 'empty.spec.ts', false);
      assert.equal(parsedEmpty.totalCases, 0);
      assert.equal(parsedEmpty.passedCases, 0);
      assert.equal(parsedEmpty.failedCases, 0);
      assert.equal(parsedEmpty.timedOut, false);

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-parser-'));
      try {
        const testFile = writeTest(
          'empty.spec.ts',
          `import test from 'node:test';\n// 无任何 test() 调用\n`,
        );
        const result = TestResultParser.runSuite(testFile, tmpDir, 10000);
        // Node 22/24 对无 test() 文件或报告 0 条或报告文件本身为 1 条，均应为非超时且零失败
        assert.equal(result.totalCases <= 1, true, '空文件不应编造多条用例');
        assert.equal(result.failedCases, 0, '空文件不应有失败');
        assert.equal(result.timedOut, false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
