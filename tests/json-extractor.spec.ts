/**
 * @file json-extractor.spec.ts
 * @description A1 边界单测：JsonExtractor 从 LLM 输出中提取 JSON 的各种异常场景。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsonExtractor } from '../src/agents/prompt/JsonExtractor.ts';

describe('A1 — JsonExtractor 边界测试', () => {
  it('1. 正常 JSON 直接解析成功', () => {
    const result = JsonExtractor.extract('{"summary":"ok","coreRequirementIds":["R1"]}');
    assert.equal(result.ok, true);
    assert.ok(result.value);
  });

  it('2. markdown ```json 围栏包裹的 JSON 能提取', () => {
    const text = '好的，以下是结果：\n```json\n{"summary":"ok"}\n```\n希望有帮助';
    const result = JsonExtractor.extract(text);
    assert.equal(result.ok, true);
    assert.deepEqual((result.value as Record<string, unknown>).summary, 'ok');
  });

  it('3. JSON 前后有散文（无围栏）也能通过大括号定位提取', () => {
    const text = '这是我的分析。{"summary":"ok"} 以上是我的建议。';
    const result = JsonExtractor.extract(text);
    assert.equal(result.ok, true);
  });

  it('4. 纯散文（无任何大括号）→ OUTPUT_NOT_JSON', () => {
    const result = JsonExtractor.extract('抱歉，我无法完成此任务。');
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('JSON'));
  });

  it('5. 空字符串 → 报错', () => {
    assert.equal(JsonExtractor.extract('').ok, false);
    assert.equal(JsonExtractor.extract('   ').ok, false);
  });

  it('6. JSON 数组（非对象）→ 拒绝', () => {
    const result = JsonExtractor.extract('[1,2,3]');
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('不是 JSON 对象'));
  });

  it('7. JSON 含语法错误（截断）→ 报错', () => {
    const result = JsonExtractor.extract('{"summary":"ok"');
    assert.equal(result.ok, false);
  });

  it('8. 嵌套 JSON（围栏内含多层对象）正常解析', () => {
    const text =
      '```json\n{"summary":"ok","userStories":[{"reqId":"R1","acceptanceCriteria":["AC1"]}]}\n```';
    const result = JsonExtractor.extract(text);
    assert.equal(result.ok, true);
    const val = result.value as { userStories: unknown[] };
    assert.equal(val.userStories.length, 1);
  });

  it('9. 嵌套对象 + 后续散文 → 取最外层完整对象', () => {
    // 真实 LLM 场景：一个 JSON 对象 + 可能的解释文字（不会有两个独立 JSON 对象）
    const text = '{"a":{"b":1},"c":"val"} 以上是我的输出。';
    const result = JsonExtractor.extract(text);
    assert.equal(result.ok, true);
    const val = result.value as Record<string, unknown>;
    assert.ok('a' in val);
  });
});
