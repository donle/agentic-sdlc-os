/**
 * @file TestResultParser.ts
 * @description node:test 真实测试结果解析（BACKEND_TODO E2）。
 * 解析 `node --test --test-reporter=spec [--experimental-test-coverage]` 的输出：
 * 计数行（ℹ tests / pass / fail）与覆盖率表（all files 行）。
 * 解析失败/超时转译为失败套件（如实上报 0/失败），绝不编造通过数。
 */

import { execFileSync } from 'node:child_process';

export interface ParsedSuite {
  readonly suiteName: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly coveragePercent: number | null;
  readonly timedOut: boolean;
  readonly rawOutput: string;
}

function parseCount(text: string, label: 'tests' | 'pass' | 'fail'): number {
  const m = text.match(new RegExp(`ℹ\\s+${label}\\s+(\\d+)`));
  return m ? Number(m[1]) : 0;
}

function parseCoveragePercent(text: string): number | null {
  // 兼容 "all files | 91.43 | 80.00 | ..."（--experimental-test-coverage 汇总行）
  const m = text.match(/all files\s*\|\s*([\d.]+)/);
  if (!m) {
    return null;
  }
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

export class TestResultParser {
  /**
   * 运行单个 spec 文件（node --test）并解析真实结果；任何异常转译为失败套件而非抛出。
   */
  public static runSuite(testFileAbsPath: string, cwd: string, timeoutMs = 15000): ParsedSuite {
    const suiteName = testFileAbsPath.replace(/\\/g, '/').split('/').slice(-2).join('/');
    // 关键边界（E2）：从主测试运行器派生时会继承 NODE_TEST_CONTEXT，
    // 使子进程 node --test 判定"递归运行"而跳过全部文件 → 计数为 0。必须从 env 中删除该键。
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    let output: string;
    let timedOut = false;
    try {
      output = execFileSync(
        process.execPath,
        ['--test', '--test-reporter=spec', '--experimental-test-coverage', testFileAbsPath],
        { cwd, encoding: 'utf-8', timeout: timeoutMs, env },
      );
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        code?: string;
        signal?: string;
        message?: string;
      };
      output = [e.stdout, e.stderr].filter(Boolean).join('\n');
      timedOut =
        e.killed === true ||
        e.code === 'ETIMEDOUT' ||
        e.signal === 'SIGTERM' ||
        /ETIMEDOUT/i.test(String(e.message ?? ''));
    }
    return TestResultParser.parseSuiteOutput(output, suiteName, timedOut);
  }

  /**
   * E3：从原始 spec 输出解析套件结果（宿主机与 docker 运行时共用同一解析口径）。
   * 解析失败/超时转译为失败套件（如实上报 0/失败），绝不编造通过数。
   */
  public static parseSuiteOutput(output: string, suiteName: string, timedOut = false): ParsedSuite {
    const total = parseCount(output, 'tests');
    const passed = parseCount(output, 'pass');
    const failed = parseCount(output, 'fail');
    if (total === 0 && !timedOut) {
      // 空测试文件（无 test() 调用）：如实返回 0 条用例
      return {
        suiteName,
        totalCases: 0,
        passedCases: 0,
        failedCases: 0,
        coveragePercent: parseCoveragePercent(output),
        timedOut,
        rawOutput: output.slice(0, 4000),
      };
    }
    if (total === 0 && timedOut) {
      // 超时且无输出 → 如实记为 1 条失败
      return {
        suiteName,
        totalCases: 1,
        passedCases: 0,
        failedCases: 1,
        coveragePercent: null,
        timedOut,
        rawOutput: (output || `测试进程超时`).slice(0, 4000),
      };
    }
    return {
      suiteName,
      totalCases: total,
      passedCases: passed,
      failedCases: Math.max(failed, total - passed),
      coveragePercent: parseCoveragePercent(output),
      timedOut,
      rawOutput: output.slice(0, 4000),
    };
  }
}
