/**
 * @file StagePromptSpecs.ts
 * @description 每个阶段的 LLM Prompt 规格（BACKEND_TODO_DESIGN A1）：
 * systemPrompt 固定角色纪律；taskInstruction 描述本阶段任务；
 * jsonSchemaHint 与各 *ArtifactContract 字段一一对应（供 LLM 精确产出）。
 * Prompt 中不内嵌上游产物全文，仅注入摘要与关键字段（体积与注入面控制）。
 */

import { createHash } from 'node:crypto';
import { WorkflowStageId } from '../../domain/enums.ts';

export const STAGE_PROMPT_VERSION = '2026-11-23.v2';

export interface StagePromptSpec {
  readonly systemPrompt: string;
  readonly taskInstruction: string;
  readonly jsonSchemaHint: string;
  /** OpenAI / vLLM / LiteLLM strict JSON Schema 约束 */
  readonly jsonSchema?: Record<string, unknown>;
  /** 中小模型首轮 1-shot 精简 JSON 示例 */
  readonly compactExampleJson?: string;
}

const INTENT_SCHEMA_PROP = {
  type: 'object',
  properties: {
    intentCode: { type: 'string' },
    intentDescription: { type: 'string' },
    confidenceScore: { type: 'number' },
  },
  required: ['intentCode', 'intentDescription', 'confidenceScore'],
} as const;

const COMMON_DISCIPLINE = `你是企业私有化研发流水线中的职能 Agent。
输出纪律（必须严格遵守）：
1. 仅输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 围栏；
2. 不得删减、合并或改写输入的 coreRequirementIds（防"虚假共识"红线，任何删减都会被审计拦截）；
3. 所有数组字段的每一项都必须完整，不得使用省略号或占位符；
4. 字符串字段用简体中文，代码/标识符保持英文。`;

export const STAGE_PROMPT_SPECS: Partial<Record<WorkflowStageId, StagePromptSpec>> = {
  [WorkflowStageId.STAGE_1_PM]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 PM Agent（AI 产品经理）。`,
    taskInstruction:
      '将提案的核心需求拆解为结构化 User Stories（含量化验收标准 AC），并同步生成前置数据埋点规划（Tracking Plan）与非功能性约束。若存在 humanDirective（总管回退指令），必须将其体现到产出中。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,                       // 一句话概括本 PRD 覆盖内容
  "coreRequirementIds": string[],          // 必须与输入的 coreRequirementIds 完全一致（逐条保留）
  "userStories": [                         // 每条核心需求至少 1 条
    { "reqId": string, "story": string, "acceptanceCriteria": string[] }
  ],
  "trackingPlanEvents": [                  // 每条核心需求至少 1 个埋点事件
    { "eventName": string, "triggerCondition": string, "properties": string[] }
  ],
  "nonFunctionalConstraints": string[]     // 非功能性约束（≥2 条）
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        userStories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reqId: { type: 'string' },
              story: { type: 'string' },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            },
            required: ['reqId', 'story', 'acceptanceCriteria'],
          },
        },
        trackingPlanEvents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              eventName: { type: 'string' },
              triggerCondition: { type: 'string' },
              properties: { type: 'array', items: { type: 'string' } },
            },
            required: ['eventName', 'triggerCondition', 'properties'],
          },
        },
        nonFunctionalConstraints: { type: 'array', items: { type: 'string' } },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: [
        'summary',
        'coreRequirementIds',
        'userStories',
        'trackingPlanEvents',
        'nonFunctionalConstraints',
      ],
    },
    compactExampleJson:
      '{"summary":"已完成PRD","coreRequirementIds":["R1"],"userStories":[{"reqId":"R1","story":"作为用户需要审批流","acceptanceCriteria":["延迟<200ms"]}],"trackingPlanEvents":[{"eventName":"evt_r1_submit","triggerCondition":"提交审批","properties":["run_id"]}],"nonFunctionalConstraints":["审计留痕","零云依赖"],"__intent":{"intentCode":"PRD_SYNTHESIS","intentDescription":"拆解PRD与埋点","confidenceScore":0.95}}',
  },
  [WorkflowStageId.STAGE_2_PD]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 PD Agent（AI 体验设计师）。`,
    taskInstruction:
      '基于上游 PRD，将每条核心需求映射到企业 Design System 组件（组件名+交互状态），补充无障碍清单；若发现交互可行性冲突，在 designChallengeNote 中用一句话质询（无冲突则为 null）。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,
  "coreRequirementIds": string[],          // 与上游 PRD 一致，逐条保留
  "componentMappings": [
    { "reqId": string, "designSystemComponent": string, "interactionStates": string[] }
  ],
  "accessibilityChecklist": string[],      // ≥3 条
  "designChallengeNote": string | null     // 可行性质询（无冲突为 null）
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        componentMappings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reqId: { type: 'string' },
              designSystemComponent: { type: 'string' },
              interactionStates: { type: 'array', items: { type: 'string' } },
            },
            required: ['reqId', 'designSystemComponent', 'interactionStates'],
          },
        },
        accessibilityChecklist: { type: 'array', items: { type: 'string' } },
        designChallengeNote: { type: ['string', 'null'] },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: [
        'summary',
        'coreRequirementIds',
        'componentMappings',
        'accessibilityChecklist',
        'designChallengeNote',
      ],
    },
    compactExampleJson:
      '{"summary":"完成UI映射","coreRequirementIds":["R1"],"componentMappings":[{"reqId":"R1","designSystemComponent":"DataTable","interactionStates":["default","loading","empty"]}],"accessibilityChecklist":["WCAG AA对比度","键盘焦点可达","ARIA语义"],"designChallengeNote":null,"__intent":{"intentCode":"UI_MAPPING","intentDescription":"映射设计系统组件","confidenceScore":0.95}}',
  },
  [WorkflowStageId.STAGE_3A_TECH_SPEC]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 Tech Lead Agent（AI 架构师）。`,
    taskInstruction:
      '基于上游 PRD 与 UI 设计产出技术方案：REST 接口契约（method/endpoint/Schema）、数据库 DDL 变更（无变更则为空数组）、采用的设计模式；declaredRiskLevel 按是否含 DDL/权限支付域评定（LOW/MEDIUM/HIGH/CRITICAL）。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,
  "coreRequirementIds": string[],          // 与上游一致，逐条保留
  "apiContracts": [                        // ≥1 个接口
    { "method": string, "endpoint": string, "requestSchema": string, "responseSchema": string }
  ],
  "databaseDdlStatements": string[],       // SQL DDL 语句数组，可为空数组
  "declaredRiskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "architecturePatternsUsed": string[]     // ≥2 个模式名
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        apiContracts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              endpoint: { type: 'string' },
              requestSchema: { type: 'string' },
              responseSchema: { type: 'string' },
            },
            required: ['method', 'endpoint', 'requestSchema', 'responseSchema'],
          },
        },
        databaseDdlStatements: { type: 'array', items: { type: 'string' } },
        declaredRiskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        architecturePatternsUsed: { type: 'array', items: { type: 'string' } },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: [
        'summary',
        'coreRequirementIds',
        'apiContracts',
        'databaseDdlStatements',
        'declaredRiskLevel',
        'architecturePatternsUsed',
      ],
    },
    compactExampleJson:
      '{"summary":"完成技术契约","coreRequirementIds":["R1"],"apiContracts":[{"method":"POST","endpoint":"/api/v1/r1","requestSchema":"R1Req","responseSchema":"R1Res"}],"databaseDdlStatements":[],"declaredRiskLevel":"LOW","architecturePatternsUsed":["Template Method","Repository"],"__intent":{"intentCode":"TECH_SPEC","intentDescription":"设计接口与架构","confidenceScore":0.96}}',
  },
  [WorkflowStageId.STAGE_3B_ENGINEER]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 Engineer Agent（AI 研发工程师）。`,
    taskInstruction:
      '严格依据上游技术契约产出代码实现计划：绑定独立 Git Worktree 分支，列出每个修改文件（类名/设计模式/行数变更），并确认沙箱自测结果。若存在 humanDirective（修复/回退指令），实现必须响应它。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,
  "coreRequirementIds": string[],          // 与上游一致，逐条保留
  "gitWorktreeBranch": string,             // 使用输入上下文中的沙箱分支名
  "modifiedFiles": [                       // 每条核心需求至少 1 个文件
    { "filePath": string, "className": string, "designPattern": string, "linesChanged": number }
  ],
  "selfTestPassed": boolean                // 与输入的沙箱自测结果一致
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        gitWorktreeBranch: { type: 'string' },
        modifiedFiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              className: { type: 'string' },
              designPattern: { type: 'string' },
              linesChanged: { type: 'number' },
            },
            required: ['filePath', 'className', 'designPattern', 'linesChanged'],
          },
        },
        selfTestPassed: { type: 'boolean' },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: [
        'summary',
        'coreRequirementIds',
        'gitWorktreeBranch',
        'modifiedFiles',
        'selfTestPassed',
      ],
    },
    compactExampleJson:
      '{"summary":"完成编码与自测","coreRequirementIds":["R1"],"gitWorktreeBranch":"worktree/run/b1","modifiedFiles":[{"filePath":"src/r1.ts","className":"R1Service","designPattern":"Strategy","linesChanged":42}],"selfTestPassed":true,"__intent":{"intentCode":"ENGINEER_IMPL","intentDescription":"沙箱编码与自测","confidenceScore":0.95}}',
  },
  [WorkflowStageId.STAGE_4_QA]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 QA Agent（AI 测试工程师）。`,
    taskInstruction:
      '对照 PRD 验收标准产出质量验收报告：测试套件执行结果必须使用输入上下文中给出的沙箱真实测试数据（不得编造）；发现安全漏洞按实际数量填报；allAcceptanceCriteriaMet 必须与真实通过情况一致。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,
  "coreRequirementIds": string[],          // 与上游一致，逐条保留
  "testSuitesExecuted": [                  // 使用输入 sandboxVerification 的真实数据
    { "suiteName": string, "totalCases": number, "passedCases": number, "coveragePercent": number }
  ],
  "securityIssuesFound": number,           // 与输入一致
  "allAcceptanceCriteriaMet": boolean      // 必须与真实结果一致（谎报会被契约校验拦截）
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        testSuitesExecuted: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              suiteName: { type: 'string' },
              totalCases: { type: 'number' },
              passedCases: { type: 'number' },
              coveragePercent: { type: 'number' },
            },
            required: ['suiteName', 'totalCases', 'passedCases', 'coveragePercent'],
          },
        },
        securityIssuesFound: { type: 'number' },
        allAcceptanceCriteriaMet: { type: 'boolean' },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: [
        'summary',
        'coreRequirementIds',
        'testSuitesExecuted',
        'securityIssuesFound',
        'allAcceptanceCriteriaMet',
      ],
    },
    compactExampleJson:
      '{"summary":"自动化测试通过","coreRequirementIds":["R1"],"testSuitesExecuted":[{"suiteName":"r1.spec.ts","totalCases":2,"passedCases":2,"coveragePercent":100}],"securityIssuesFound":0,"allAcceptanceCriteriaMet":true,"__intent":{"intentCode":"QA_VERIFY","intentDescription":"验收测试与安全扫描","confidenceScore":0.97}}',
  },
  [WorkflowStageId.STAGE_5_DA]: {
    systemPrompt: `${COMMON_DISCIPLINE}

你是 DA Agent（AI 数据分析师）。`,
    taskInstruction:
      '核验 Stage 1 定义的前置埋点事件（逐项对照上游 PRD 的 trackingPlanEvents），并给出上线后核心指标的目标基线投影。',
    jsonSchemaHint: `输出 JSON 字段：
{
  "summary": string,
  "coreRequirementIds": string[],          // 与上游一致，逐条保留
  "verifiedTrackingEvents": string[],      // 与上游埋点事件名一一对应
  "projectedMetrics": [                    // ≥3 个指标
    { "metricName": string, "baselineValue": string, "targetValue": string }
  ]
}`,
    jsonSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        summary: { type: 'string' },
        coreRequirementIds: { type: 'array', items: { type: 'string' } },
        verifiedTrackingEvents: { type: 'array', items: { type: 'string' } },
        projectedMetrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metricName: { type: 'string' },
              baselineValue: { type: 'string' },
              targetValue: { type: 'string' },
            },
            required: ['metricName', 'baselineValue', 'targetValue'],
          },
        },
        __intent: INTENT_SCHEMA_PROP,
      },
      required: ['summary', 'coreRequirementIds', 'verifiedTrackingEvents', 'projectedMetrics'],
    },
    compactExampleJson:
      '{"summary":"埋点与指标核验完成","coreRequirementIds":["R1"],"verifiedTrackingEvents":["evt_r1_submit"],"projectedMetrics":[{"metricName":"采纳率","baselineValue":"0%","targetValue":"85%"},{"metricName":"耗时","baselineValue":"300ms","targetValue":"180ms"},{"metricName":"错误率","baselineValue":"2%","targetValue":"0.1%"}],"__intent":{"intentCode":"DA_AUDIT","intentDescription":"埋点核验与归因","confidenceScore":0.94}}',
  },
};

/** 计算指定阶段的 Prompt 规格版本号哈希（Prompt/Schema 变更后自动隔离旧缓存） */
export function computePromptSpecHash(stageId: WorkflowStageId): string {
  const spec = STAGE_PROMPT_SPECS[stageId];
  const raw = spec
    ? `${STAGE_PROMPT_VERSION}|${spec.systemPrompt}|${spec.taskInstruction}|${spec.jsonSchemaHint}`
    : `${STAGE_PROMPT_VERSION}|CUSTOM|${stageId}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}
