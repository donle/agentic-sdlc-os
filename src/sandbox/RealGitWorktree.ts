/**
 * @file RealGitWorktree.ts
 * @description 真实 git worktree 封装（BACKEND_TODO E1）。
 * GIT_REPO_PATH 存在且 git 可用时启用；否则沙箱回落到模拟模式（D-2 全局决策）。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorktreeAddResult {
  readonly workspacePath: string;
  readonly branchName: string;
  readonly simulated: boolean;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class RealGitWorktree {
  private readonly repoPath: string;
  private readonly worktreeRoot: string;

  public constructor(repoPath: string, worktreeRoot: string) {
    this.repoPath = repoPath;
    this.worktreeRoot = worktreeRoot;
  }

  public static isGitAvailable(): boolean {
    try {
      execFileSync('git', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  public static isGitRepository(repoPath: string): boolean {
    try {
      execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 为 (runId, branchId) 创建真实 worktree 与独立分支。
   * 分支重名 → 自动 -v{n} 后缀；路径脏 → prune 后重试一次。
   */
  public add(runId: string, branchId: string): WorktreeAddResult {
    const safeRun = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBranch = branchId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const target = path.join(this.worktreeRoot, safeRun, safeBranch);
    const baseBranch = `worktree/${safeRun}/${safeBranch}`;
    const branchName = this.resolveAvailableBranchName(baseBranch);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      execFileSync('git', ['-C', this.repoPath, 'worktree', 'add', target, '-b', branchName], {
        timeout: 15000,
      });
    } catch {
      // 路径脏/元数据过期：prune 后重试一次
      try {
        execFileSync('git', ['-C', this.repoPath, 'worktree', 'prune'], { timeout: 10000 });
        execFileSync('git', ['-C', this.repoPath, 'worktree', 'add', target, '-b', branchName], {
          timeout: 15000,
        });
      } catch (err) {
        throw new WorktreeError(
          `git worktree add 失败: ${err instanceof Error ? err.message.slice(0, 200) : '未知错误'}`,
        );
      }
    }
    return { workspacePath: target, branchName, simulated: false };
  }

  /** 回退/终止后清理 worktree 与本地分支 */
  public remove(branchName: string): void {
    try {
      const list = execFileSync('git', ['-C', this.repoPath, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      const worktreePath = list
        .split('\n')
        .find((line) => line.startsWith('worktree ') && line.includes('/worktree/'));
      if (worktreePath) {
        execFileSync(
          'git',
          [
            '-C',
            this.repoPath,
            'worktree',
            'remove',
            '--force',
            worktreePath.slice('worktree '.length),
          ],
          {
            timeout: 15000,
          },
        );
      }
      execFileSync('git', ['-C', this.repoPath, 'branch', '-D', branchName], { timeout: 10000 });
    } catch {
      // 清理失败不阻塞主流程（I3 定期 prune 兜底）
    }
  }

  private resolveAvailableBranchName(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (this.branchExists(candidate)) {
      candidate = `${base}-v${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private branchExists(branch: string): boolean {
    try {
      execFileSync('git', ['-C', this.repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
