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

export interface PorcelainWorktreeEntry {
  readonly worktreePath: string;
  readonly branchRef: string | null;
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

  /**
   * AUDIT-11：按空行分段解析 `git worktree list --porcelain` 输出，严格绑定每个 worktree 路径与分支 ref
   */
  public static parsePorcelainWorktrees(porcelainOutput: string): PorcelainWorktreeEntry[] {
    const entries: PorcelainWorktreeEntry[] = [];
    const blocks = porcelainOutput
      .split(/\r?\n\r?\n+/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    for (const block of blocks) {
      let worktreePath: string | null = null;
      let branchRef: string | null = null;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ')) {
          branchRef = line.slice('branch '.length).trim();
        }
      }
      if (worktreePath) {
        entries.push({ worktreePath, branchRef });
      }
    }
    return entries;
  }

  /** 回退/终止后按 porcelain stanza 精确匹配目标分支并清理 worktree 与本地分支 */
  public remove(branchName: string): void {
    const targetBranch = branchName.replace(/^refs\/heads\//, '');
    const targetRef = `refs/heads/${targetBranch}`;
    try {
      const list = execFileSync('git', ['-C', this.repoPath, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      const entries = RealGitWorktree.parsePorcelainWorktrees(list);
      const matched = entries.find((entry) => entry.branchRef === targetRef);
      if (matched) {
        execFileSync(
          'git',
          ['-C', this.repoPath, 'worktree', 'remove', '--force', matched.worktreePath],
          { timeout: 15000 },
        );
      }
    } catch {
      // worktree 移除失败不阻塞分支清理（I3 定期 prune 兜底）
    }
    try {
      execFileSync('git', ['-C', this.repoPath, 'branch', '-D', targetBranch], { timeout: 10000 });
    } catch {
      // 分支清理失败不阻塞主流程
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
