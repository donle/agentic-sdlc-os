/**
 * @file GitContextProvider.ts
 * @description 模块 3：Git 仓库结构上下文提供者（STAGE_3A_TECH_SPEC 最高价值外部知识）。
 * 让 Tech Lead Agent 在设计接口契约前能看到真实代码库结构和已有数据库 Schema。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ContextNeed, ContextProvider, ContextQuery, ContextResult } from './types.ts';
import { estimateTokens } from './types.ts';

export class GitContextProvider implements ContextProvider {
  public readonly name = 'git';
  private readonly repoPath: string;

  public constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  public canResolve(need: ContextNeed): boolean {
    return need.type === 'code_structure' || need.type === 'db_schema';
  }

  public async resolve(query: ContextQuery, need: ContextNeed): Promise<ContextResult> {
    if (need.type === 'code_structure') {
      return this.resolveCodeStructure(query, need);
    }
    if (need.type === 'db_schema') {
      return this.resolveDbSchema(query, need);
    }
    return { type: need.type, content: '', tokenEstimate: 0, source: this.name, isReal: false };
  }

  /** 读取代码库目录树（限深 3）+ 关键文件摘要 */
  private resolveCodeStructure(_query: ContextQuery, _need: ContextNeed): ContextResult {
    try {
      const tree = this.buildDirectoryTree(this.repoPath, 3);
      const keyFiles = this.readKeyFiles(this.repoPath);
      const content = JSON.stringify({ directoryTree: tree, keyFiles }, null, 0);
      return {
        type: 'code_structure',
        content,
        tokenEstimate: estimateTokens(content),
        source: `${this.name}:code_structure`,
        isReal: true,
      };
    } catch (err) {
      return {
        type: 'code_structure',
        content: `读取代码结构失败: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
        tokenEstimate: 50,
        source: `${this.name}:error`,
        isReal: false,
      };
    }
  }

  /** 搜索仓库中的 SQL Schema 文件（*.sql / schema/ 目录 / migration/ 目录） */
  private resolveDbSchema(_query: ContextQuery, _need: ContextNeed): ContextResult {
    try {
      const sqlFiles = this.findSqlFiles(this.repoPath);
      const schemaContent = sqlFiles.slice(0, 5).map((f) => {
        const content = fs.readFileSync(f, 'utf-8');
        return { file: path.relative(this.repoPath, f), ddl: content.slice(0, 500) };
      });
      const content = JSON.stringify(schemaContent, null, 0);
      return {
        type: 'db_schema',
        content,
        tokenEstimate: estimateTokens(content),
        source: `${this.name}:db_schema`,
        isReal: true,
      };
    } catch {
      return {
        type: 'db_schema',
        content: '未找到 SQL Schema 文件',
        tokenEstimate: 20,
        source: `${this.name}:db_schema`,
        isReal: false,
      };
    }
  }

  /** 构建目录树（限深） */
  private buildDirectoryTree(dir: string, maxDepth: number, prefix = ''): string[] {
    if (maxDepth <= 0) {
      return [];
    }
    const lines: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          lines.push(`${rel}/`);
          lines.push(...this.buildDirectoryTree(path.join(dir, entry.name), maxDepth - 1, rel));
        } else if (
          entry.name.endsWith('.ts') ||
          entry.name.endsWith('.json') ||
          entry.name.endsWith('.sql')
        ) {
          lines.push(rel);
        }
      }
    } catch {
      // 权限不足等
    }
    return lines.slice(0, 100); // 限制总行数
  }

  /** 读取关键文件（package.json / tsconfig / README 前 N 行） */
  private readKeyFiles(repoPath: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of ['package.json', 'tsconfig.json']) {
      const p = path.join(repoPath, name);
      if (fs.existsSync(p)) {
        try {
          result[name] = fs.readFileSync(p, 'utf-8').slice(0, 500);
        } catch {
          /* skip */
        }
      }
    }
    return result;
  }

  /** 搜索 SQL 文件 */
  private findSqlFiles(dir: string): string[] {
    const results: string[] = [];
    const search = (d: string, depth: number): void => {
      if (depth > 3 || results.length >= 10) {
        return;
      }
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
          }
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            search(full, depth + 1);
          } else if (entry.name.endsWith('.sql')) {
            results.push(full);
          }
        }
      } catch {
        /* skip */
      }
    };
    search(dir, 0);
    return results;
  }
}
