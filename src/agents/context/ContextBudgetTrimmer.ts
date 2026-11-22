/**
 * @file ContextBudgetTrimmer.ts
 * @description 上下文 Token 预算裁剪器：确保注入 prompt 的外部上下文总 token 不超预算。
 * 策略：required 优先 → 按 maxTokens 声明排序 → 超出截断内容（保留首行摘要）。
 */

import type { ContextNeed, ResolvedContext } from './types.ts';
import { estimateTokens } from './types.ts';

export interface TrimmedContext {
  readonly included: ReadonlyArray<ResolvedContext>;
  readonly truncated: ReadonlyArray<{ type: string; reason: string }>;
  readonly totalTokens: number;
}

export class ContextBudgetTrimmer {
  private readonly totalBudget: number;

  public constructor(totalBudget = 4000) {
    this.totalBudget = totalBudget;
  }

  public trim(
    needs: ReadonlyArray<ContextNeed>,
    resolved: ReadonlyArray<ResolvedContext>,
  ): TrimmedContext {
    const included: ResolvedContext[] = [];
    const truncated: Array<{ type: string; reason: string }> = [];
    let used = 0;

    // 1. required 优先，其次按 maxTokens 降序（大预算 = 高优先级）
    const sorted = needs
      .map((need) => {
        const match = resolved.find((r) => r.need.type === need.type && r.result !== null);
        return { need, resolved: match ?? null };
      })
      .filter((item) => item.resolved !== null)
      .sort((a, b) => {
        if (a.need.required !== b.need.required) {
          return a.need.required ? -1 : 1;
        }
        return b.need.maxTokens - a.need.maxTokens;
      });

    for (const { need, resolved: item } of sorted) {
      if (!item || !item.result) {
        continue;
      }

      const contentTokens = estimateTokens(item.result.content);
      const effectiveTokens = Math.min(contentTokens, need.maxTokens);

      if (used + effectiveTokens <= this.totalBudget) {
        // 全量保留
        included.push({
          need,
          result: item.result,
          blocked: false,
        });
        used += effectiveTokens;
      } else {
        const remaining = this.totalBudget - used;
        if (remaining > 100) {
          // 截断内容保留前半
          const charsAllowed = remaining * 3; // 逆向估算
          const trimmedContent = item.result.content.slice(0, charsAllowed) + '…[截断]';
          included.push({
            need,
            result: { ...item.result, content: trimmedContent, tokenEstimate: remaining },
            blocked: false,
          });
          used += remaining;
          truncated.push({
            type: need.type,
            reason: `超出预算，截断至 ${remaining} tokens`,
          });
        } else {
          truncated.push({
            type: need.type,
            reason: `预算不足（剩余 ${remaining} tokens），跳过`,
          });
        }
      }
    }

    // 未解析的 required 项也记录
    for (const need of needs) {
      const has = resolved.find((r) => r.need.type === need.type);
      if (!has || !has.result) {
        if (need.required) {
          truncated.push({ type: need.type, reason: 'Provider 未能提供（required）' });
        }
      }
    }

    return { included, truncated, totalTokens: used };
  }
}
