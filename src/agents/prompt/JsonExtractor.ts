/**
 * @file JsonExtractor.ts
 * @description 从 LLM 输出文本中稳健提取 JSON 对象（BACKEND_TODO_DESIGN A1 边界 1/7）。
 * 处理：```json 围栏、前后缀散文、首尾多余逗号容忍度（不修复，仅定位）、空输出。
 */

export interface JsonExtractionResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export class JsonExtractor {
  /**
   * 提取首个合法 JSON 对象；失败时返回结构化错误（供自愈重试的 violations 收集）
   */
  public static extract(text: string): JsonExtractionResult {
    if (!text || text.trim().length === 0) {
      return { ok: false, error: 'LLM 输出为空' };
    }
    const candidates: string[] = [];

    // 候选 1：剥离 markdown 代码围栏
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      candidates.push(fence[1]);
    }

    // 候选 2：截取首个 { 到最后一个 }（容忍前后散文）
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(text.slice(firstBrace, lastBrace + 1));
    }

    // 候选 3：原文
    candidates.push(text);

    let lastError = '无法定位 JSON 对象';
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate.trim()) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return { ok: true, value };
        }
        lastError = 'LLM 输出不是 JSON 对象（数组或标量）';
      } catch (err) {
        lastError = `JSON 解析失败: ${err instanceof Error ? err.message.slice(0, 120) : '未知错误'}`;
      }
    }
    return { ok: false, error: lastError };
  }
}
