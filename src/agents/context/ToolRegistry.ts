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
import { estimateTokens } from './types.ts';
import { ContextBudgetTrimmer, type TrimmedContext } from './ContextBudgetTrimmer.ts';

export interface ToolLoopGuardOptions {
  /** 单作用域（阶段）内最大工具/外部上下文调用次数（默认 8） */
  readonly maxCallsPerStage?: number;
  /** 单次工具结果允许的最大字符长度（超长截断并标记 truncated，默认 6000） */
  readonly maxCharsPerResult?: number;
}

export interface ToolLoopGuardStats {
  readonly totalCalls: number;
  readonly deduplicatedCalls: number;
  readonly budgetBlockedCalls: number;
  readonly truncatedResults: number;
}

function stableSerializeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') {
    return JSON.stringify(args);
  }
  if (Array.isArray(args)) {
    return `[${args.map((item) => stableSerializeArgs(item)).join(',')}]`;
  }
  const record = args as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  return `{${sortedKeys.map((k) => `${JSON.stringify(k)}:${stableSerializeArgs(record[k])}`).join(',')}}`;
}

/**
 * 工具调用防死循环守卫（Pillar 3）：参数级去重 + 单阶段次数上限 + 单结果体积截断
 */
export class ToolCallLoopGuard {
  private readonly maxCallsPerStage: number;
  private readonly maxCharsPerResult: number;
  private readonly stageCallCounts = new Map<string, number>();
  private readonly dedupResults = new Map<string, string>();
  private totalCalls = 0;
  private deduplicatedCalls = 0;
  private budgetBlockedCalls = 0;
  private truncatedResults = 0;

  public constructor(options?: ToolLoopGuardOptions) {
    this.maxCallsPerStage = Math.max(1, options?.maxCallsPerStage ?? 8);
    this.maxCharsPerResult = Math.max(64, options?.maxCharsPerResult ?? 6000);
  }

  public checkCall(
    scopeKey: string,
    toolName: string,
    args: unknown,
  ):
    | { readonly allowed: true; readonly deduplicated: false }
    | { readonly allowed: false; readonly deduplicated: true; readonly cachedResult: string }
    | {
        readonly allowed: false;
        readonly deduplicated: false;
        readonly reason: 'TOOL_CALL_BUDGET_EXCEEDED';
      } {
    this.totalCalls += 1;
    const signature = `${scopeKey}::${toolName}::${stableSerializeArgs(args)}`;
    const cached = this.dedupResults.get(signature);
    if (cached !== undefined) {
      this.deduplicatedCalls += 1;
      return { allowed: false, deduplicated: true, cachedResult: cached };
    }
    const currentCount = this.stageCallCounts.get(scopeKey) ?? 0;
    if (currentCount >= this.maxCallsPerStage) {
      this.budgetBlockedCalls += 1;
      return { allowed: false, deduplicated: false, reason: 'TOOL_CALL_BUDGET_EXCEEDED' };
    }
    this.stageCallCounts.set(scopeKey, currentCount + 1);
    return { allowed: true, deduplicated: false };
  }

  public recordResult(
    scopeKey: string,
    toolName: string,
    args: unknown,
    rawOutput: string,
  ): { readonly content: string; readonly truncated: boolean } {
    const signature = `${scopeKey}::${toolName}::${stableSerializeArgs(args)}`;
    let content = rawOutput;
    let truncated = false;
    if (rawOutput.length > this.maxCharsPerResult) {
      content = `${rawOutput.slice(0, this.maxCharsPerResult)}\n...[TRUNCATED_BY_TOOL_LOOP_GUARD]`;
      truncated = true;
      this.truncatedResults += 1;
    }
    this.dedupResults.set(signature, content);
    return { content, truncated };
  }

  public getStats(): ToolLoopGuardStats {
    return {
      totalCalls: this.totalCalls,
      deduplicatedCalls: this.deduplicatedCalls,
      budgetBlockedCalls: this.budgetBlockedCalls,
      truncatedResults: this.truncatedResults,
    };
  }

  public reset(): void {
    this.stageCallCounts.clear();
    this.dedupResults.clear();
    this.totalCalls = 0;
    this.deduplicatedCalls = 0;
    this.budgetBlockedCalls = 0;
    this.truncatedResults = 0;
  }
}

export class ToolRegistry {
  private readonly providers: ContextProvider[] = [];
  private readonly trimmer: ContextBudgetTrimmer;
  private readonly loopGuard: ToolCallLoopGuard;
  /** 同 run 内缓存（避免重复调用外部系统） */
  private readonly runCache = new Map<string, ContextResult>();

  public constructor(totalContextBudget = 4000, guardOptions?: ToolLoopGuardOptions) {
    this.trimmer = new ContextBudgetTrimmer(totalContextBudget);
    this.loopGuard = new ToolCallLoopGuard(guardOptions);
  }

  public register(provider: ContextProvider): void {
    this.providers.push(provider);
  }

  public getGuardStats(): ToolLoopGuardStats {
    return this.loopGuard.getStats();
  }

  /**
   * 按 ContextNeeds 解析外部知识（受 ToolCallLoopGuard 去重、调用预算与单结果截断保护）。
   */
  public async resolve(
    needs: ReadonlyArray<ContextNeed>,
    query: ContextQuery,
  ): Promise<TrimmedContext> {
    const resolved: ResolvedContext[] = [];
    const scopeKey = `${query.runId}:${query.stageId}`;

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

      const guardDecision = this.loopGuard.checkCall(scopeKey, need.type, {
        stageId: query.stageId,
      });
      const cacheKey = `${query.runId}:${need.type}:${query.stageId}`;

      if (!guardDecision.allowed) {
        if (guardDecision.deduplicated) {
          const cached = this.runCache.get(cacheKey);
          resolved.push({
            need,
            result: cached ?? null,
            blocked: !cached && need.required,
          });
          continue;
        }
        resolved.push({
          need,
          result: null,
          blocked: need.required,
        });
        console.warn(`[ToolRegistry] 触发防死循环调用预算上限 (${scopeKey})，已阻断 ${need.type}`);
        continue;
      }

      const existingCached = this.runCache.get(cacheKey);
      if (existingCached) {
        resolved.push({ need, result: existingCached, blocked: false });
        continue;
      }

      try {
        const rawResult = await provider.resolve(query, need);
        const guarded = this.loopGuard.recordResult(
          scopeKey,
          need.type,
          { stageId: query.stageId },
          rawResult.content,
        );
        const finalResult: ContextResult = guarded.truncated
          ? {
              ...rawResult,
              content: guarded.content,
              tokenEstimate: estimateTokens(guarded.content),
              truncated: true,
            }
          : rawResult;
        this.runCache.set(cacheKey, finalResult);
        resolved.push({ need, result: finalResult, blocked: false });
      } catch (err) {
        resolved.push({
          need,
          result: null,
          blocked: need.required,
        });
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
    this.loopGuard.reset();
  }
}
