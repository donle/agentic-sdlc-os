/**
 * @file ToolRegistry.ts
 * @description C1 上下文工具注册表：注册 ContextProvider，按 ContextNeed 解析外部知识，
 * 通过 ContextBudgetTrimmer 控制注入总量。支持 MCP 服务器与内部 Provider。
 */

import type {
  ContextNeed,
  ContextProvider,
  ContextQuery,
  ContextResult,
  ResolvedContext,
} from './types.ts';
import { ContextBudgetTrimmer, type TrimmedContext } from './ContextBudgetTrimmer.ts';

export class ToolRegistry {
  private readonly providers: ContextProvider[] = [];
  private readonly trimmer: ContextBudgetTrimmer;
  /** 同 run 内缓存（避免重复调用外部系统） */
  private readonly runCache = new Map<string, ContextResult>();

  public constructor(totalContextBudget = 4000) {
    this.trimmer = new ContextBudgetTrimmer(totalContextBudget);
  }

  public register(provider: ContextProvider): void {
    this.providers.push(provider);
  }

  /**
   * 按 ContextNeeds 解析外部知识。
   * 1. 遍历 needs，找到匹配的 Provider
   * 2. 调用 Provider.resolve()（带 run 级缓存）
   * 3. 通过 BudgetTrimmer 裁剪
   * 4. 返回结构化上下文（含 blocked 项信息）
   */
  public async resolve(
    needs: ReadonlyArray<ContextNeed>,
    query: ContextQuery,
  ): Promise<TrimmedContext> {
    const resolved: ResolvedContext[] = [];

    for (const need of needs) {
      const provider = this.providers.find((p) => p.canResolve(need));
      if (!provider) {
        resolved.push({
          need,
          result: null,
          blocked: need.required,
        });
        continue;
      }

      const cacheKey = `${query.runId}:${need.type}:${query.stageId}`;
      const cached = this.runCache.get(cacheKey);
      if (cached) {
        resolved.push({ need, result: cached, blocked: false });
        continue;
      }

      try {
        const result = await provider.resolve(query, need);
        this.runCache.set(cacheKey, result);
        resolved.push({ need, result, blocked: false });
      } catch (err) {
        if (need.required) {
          resolved.push({
            need,
            result: null,
            blocked: true,
          });
        } else {
          resolved.push({
            need,
            result: null,
            blocked: false,
          });
        }
        // 静默降级（D-2），记录警告
        console.warn(
          `[ToolRegistry] ${provider.name} 解析 ${need.type} 失败: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
        );
      }
    }

    return this.trimmer.trim(needs, resolved);
  }

  /** 同步读取 run 级缓存（供 buildStagePrompt 注入外部上下文，不触发网络请求） */
  public getCached(runId: string, type: string, stageId: string): ContextResult | null {
    const cacheKey = `${runId}:${type}:${stageId}`;
    return this.runCache.get(cacheKey) ?? null;
  }

  /** 清空 run 级缓存（新提案/新分支时调用） */
  public clearRunCache(): void {
    this.runCache.clear();
  }
}
