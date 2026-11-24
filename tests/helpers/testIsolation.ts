/**
 * @file testIsolation.ts
 * @description P2-3 测试隔离助手：统一在 `os.tmpdir()` 下为测试创建独立且互不干扰的
 * `persistenceDir` 与 `sandboxRootDir`，并在退出时自动清理临时目录，防止向仓库根目录
 * `.runtime-data/` 与 `.sandbox-worktrees/` 写入测试产物。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestIsolatedWorkspace {
  readonly rootDir: string;
  readonly persistenceDir: string;
  readonly sandboxRootDir: string;
  cleanup(): void;
}

/** 创建带独立持久化与沙箱工作树目录的临时测试工作区 */
export function createTestWorkspace(prefix = 'sdlc-test-'): TestIsolatedWorkspace {
  const normalizedPrefix = prefix.endsWith('-') ? prefix : `${prefix}-`;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), normalizedPrefix));
  const persistenceDir = path.join(rootDir, 'persist');
  const sandboxRootDir = path.join(rootDir, 'sandbox');

  return {
    rootDir,
    persistenceDir,
    sandboxRootDir,
    cleanup(): void {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/** 在受控临时工作区内执行测试逻辑，无论成功或抛错均自动清理 */
export async function withTestWorkspace<T>(
  prefix: string,
  fn: (ws: TestIsolatedWorkspace) => Promise<T> | T,
): Promise<T> {
  const ws = createTestWorkspace(prefix);
  try {
    return await fn(ws);
  } finally {
    ws.cleanup();
  }
}
