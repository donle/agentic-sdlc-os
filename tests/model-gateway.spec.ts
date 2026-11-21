/**
 * @file model-gateway.spec.ts
 * @description Block 2 功能与结构测试：验证 BYOM 混合模型路由网关 (`ModelRouterGateway`)、
 * 企业敏感数据脱敏中间件 (`PayloadDesensitizer`)、OpenAI/LiteLLM `/v1/chat/completions` 协议适配器、
 * 离线优雅降级以及模型能力基线体检 (`evaluateEndpointBaseline`)。
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelRoutingTier } from '../src/domain/enums.ts';
import {
  ModelRouterGateway,
  type OpenAiCompatibleChatRequest,
} from '../src/patterns/ModelRouterGateway.ts';

describe('Block 2 — BYOM 混合模型路由网关、脱敏中间件与基线体检测试套件', () => {
  it('1. 发往混合高阶模型的 Prompt 应自动脱敏数据库连接串、API Key 与内网 IPv4，而发往本地私有模型则保留原样', () => {
    const gateway = new ModelRouterGateway();
    const sensitivePrompt = [
      '请分析以下配置：',
      'DB_URL=postgresql://prod_admin:SuperSecret99!@10.24.16.88:5432/core_ledger',
      'OPENAI_KEY=sk-proj-1234567890abcdefghijklmnop',
      'INTERNAL_NODE=192.168.10.45',
    ].join('\n');

    // 高阶混合模型层级 (isLocalPrivateModel = false) 必须执行脱敏
    const hybridPrepared = gateway.preparePromptForTier(
      ModelRoutingTier.HIGH_REASONING_HYBRID,
      sensitivePrompt,
    );
    assert.ok(hybridPrepared.redactedCount >= 3, '应至少脱敏 3 处敏感凭据');
    assert.equal(hybridPrepared.sanitizedText.includes('SuperSecret99!'), false);
    assert.equal(hybridPrepared.sanitizedText.includes('sk-proj-1234567890'), false);
    assert.equal(hybridPrepared.sanitizedText.includes('192.168.10.45'), false);
    assert.ok(hybridPrepared.redactedCategories.includes('DATABASE_CREDENTIAL'));
    assert.ok(hybridPrepared.redactedCategories.includes('API_SECRET_KEY'));
    assert.ok(hybridPrepared.redactedCategories.includes('INTERNAL_IPV4'));

    // 本地私有模型层级 (isLocalPrivateModel = true) 数据不出内网，不额外破坏原始代码上下文
    const localPrepared = gateway.preparePromptForTier(
      ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      sensitivePrompt,
    );
    assert.equal(localPrepared.redactedCount, 0);
    assert.equal(localPrepared.sanitizedText, sensitivePrompt);
  });

  it('2. invokeChatCompletion 应遵循 OpenAI/LiteLLM /v1/chat/completions 协议，并在网关异常时平滑降级', async () => {
    let capturedUrl = '';
    const payloadList: OpenAiCompatibleChatRequest[] = [];

    const gateway = new ModelRouterGateway(async (url, payload) => {
      capturedUrl = url;
      payloadList.push(payload);
      return {
        id: 'chatcmpl-test-001',
        model: payload.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ status: 'LIVE_GATEWAY_OK', stories: 3 }),
            },
          },
        ],
        usage: {
          prompt_tokens: 420,
          completion_tokens: 180,
          total_tokens: 600,
        },
      };
    });

    const liveResult = await gateway.invokeChatCompletion({
      tier: ModelRoutingTier.HIGH_REASONING_HYBRID,
      systemPrompt: 'You are an enterprise PM Agent.',
      userPrompt: 'Connect to redis://default:MyPass123@10.0.0.9:6379 and generate PRD',
      fallbackContentGenerator: () => JSON.stringify({ status: 'FALLBACK' }),
    });

    assert.equal(liveResult.usedLiveGateway, true);
    assert.ok(capturedUrl.endsWith('/v1/chat/completions'));
    assert.equal(payloadList.length, 1);
    // 验证发往网关的报文已经脱敏
    const sentUserMsg = payloadList[0].messages[1]?.content ?? '';
    assert.equal(sentUserMsg.includes('MyPass123'), false);
    assert.equal(liveResult.receipt.totalTokens, 600);
    assert.ok(liveResult.receipt.redactedCount >= 1);

    // 验证当网关抛出网络异常时，自动回退到确定性引擎而不中断流水线
    gateway.setHttpTransport(async () => {
      throw new Error('ECONNREFUSED: Local LiteLLM gateway offline');
    });

    const fallbackResult = await gateway.invokeChatCompletion({
      tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      systemPrompt: 'System',
      userPrompt: 'Generate code',
      fallbackContentGenerator: () => JSON.stringify({ status: 'DETERMINISTIC_FALLBACK_OK' }),
    });

    assert.equal(fallbackResult.usedLiveGateway, false);
    assert.ok(fallbackResult.content.includes('DETERMINISTIC_FALLBACK_OK'));
  });

  it('3. evaluateEndpointBaseline 应能准确校验候选模型的 JSON Schema 契约遵循能力', () => {
    const gateway = new ModelRouterGateway();

    const goodEval = gateway.evaluateEndpointBaseline({
      tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      sampleJsonOutput: JSON.stringify({
        summary: 'PRD summary',
        userStories: [{ reqId: 'REQ_1' }],
        trackingPlanEvents: [{ eventName: 'evt_1' }],
      }),
      requiredKeys: ['summary', 'userStories', 'trackingPlanEvents'],
    });
    assert.equal(goodEval.jsonSchemaAdherencePassed, true);
    assert.equal(goodEval.missingKeys.length, 0);

    const badEval = gateway.evaluateEndpointBaseline({
      tier: ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL,
      sampleJsonOutput: JSON.stringify({ summary: 'Incomplete output' }),
      requiredKeys: ['summary', 'userStories', 'trackingPlanEvents'],
    });
    assert.equal(badEval.jsonSchemaAdherencePassed, false);
    assert.deepEqual(badEval.missingKeys, ['userStories', 'trackingPlanEvents']);
  });
});
