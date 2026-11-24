/**
 * @file DependencyVersionsProvider.ts
 * @description P1-3：`STAGE_3B_ENGINEER` 必需上下文 `dependency_versions` 的真实本地 `package.json` 提供者。
 * 读取当前工程或工作区的 `package.json` 版本与依赖清单（零硬编码、缺失时安全降级）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ContextNeed, ContextProvider, ContextQuery, ContextResult } from './types.ts';
import { estimateTokens } from './types.ts';

export class DependencyVersionsProvider implements ContextProvider {
  public readonly name = 'dependency-versions';
  private readonly repoPath: string;

  public constructor(repoPath?: string) {
    this.repoPath = repoPath ?? (process.env.GIT_REPO_PATH || process.cwd());
  }

  public canResolve(need: ContextNeed): boolean {
    return need.type === 'dependency_versions';
  }

  public async resolve(_query: ContextQuery, _need: ContextNeed): Promise<ContextResult> {
    const pkgPath = path.join(this.repoPath, 'package.json');
    if (!fs.existsSync(pkgPath) || !fs.statSync(pkgPath).isFile()) {
      const fallbackContent = JSON.stringify({
        nodeVersion: process.version,
        dependencies: {},
        devDependencies: {},
        note: 'package.json not found in workspace root',
      });
      return {
        type: 'dependency_versions',
        content: fallbackContent,
        tokenEstimate: estimateTokens(fallbackContent),
        source: 'local:package.json:missing',
        isReal: false,
      };
    }

    try {
      const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const compact = {
        name: String(raw.name ?? ''),
        type: String(raw.type ?? ''),
        nodeVersion: process.version,
        engines: raw.engines ?? {},
        dependencies: raw.dependencies ?? {},
        devDependencies: raw.devDependencies ?? {},
      };
      const content = JSON.stringify(compact);
      return {
        type: 'dependency_versions',
        content,
        tokenEstimate: estimateTokens(content),
        source: 'local:package.json',
        isReal: true,
      };
    } catch (err) {
      const errContent = JSON.stringify({
        nodeVersion: process.version,
        error: err instanceof Error ? err.message.slice(0, 100) : String(err),
      });
      return {
        type: 'dependency_versions',
        content: errContent,
        tokenEstimate: estimateTokens(errContent),
        source: 'local:package.json:error',
        isReal: false,
      };
    }
  }
}
