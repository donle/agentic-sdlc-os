/**
 * @file dsl-loader.spec.ts
 * @description Block 1 功能与结构测试：验证声明式 YAML 工作流 DSL 解析器 (`WorkflowDslLoader`)、
 * 全栈与纯后端模板动态拓扑驱动、禁用阶段过滤、以及非法 YAML 契约拦截。
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { ModelRoutingTier, WorkflowStageId } from '../src/domain/enums.ts';
import { WorkflowDslLoader } from '../src/engine/WorkflowDslLoader.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';

describe('Block 1 — 声明式可配置工作流 DSL 引擎 (WorkflowDslLoader) 测试套件', () => {
  it('1. 应正确解析默认全栈研发模板 (enterprise_sdlc.yaml) 并提取 6 阶段拓扑、Guardrails 与 BYOM 模型路由', () => {
    const config = WorkflowDslLoader.loadFromFile();
    assert.equal(config.id, 'enterprise_standard_sdlc_v1');
    assert.equal(config.guardrails.maxNegotiationTurns, 3);
    assert.equal(config.guardrails.highRiskScoreThreshold, 60);
    assert.equal(config.stages.length, 6);
    assert.deepEqual(config.getStageOrder(), [
      WorkflowStageId.STAGE_1_PM,
      WorkflowStageId.STAGE_2_PD,
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      WorkflowStageId.STAGE_3B_ENGINEER,
      WorkflowStageId.STAGE_4_QA,
      WorkflowStageId.STAGE_5_DA,
    ]);
    assert.equal(config.isForceHumanGate(WorkflowStageId.STAGE_4_QA), true);
    assert.equal(config.isForceHumanGate(WorkflowStageId.STAGE_1_PM), false);

    const privacyRoute = config.modelRouting.get(ModelRoutingTier.PRIVACY_SENSITIVE_LOCAL);
    assert.ok(privacyRoute);
    assert.equal(privacyRoute.provider, 'local-vllm');
  });

  it('2. 加载纯后端模板 (backend_api_only.yaml) 时，状态机应动态跳过 Stage 2 PD 与 Stage 5 DA 节点', async () => {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const backendYamlPath = path.resolve(currentDir, '../configs/workflows/backend_api_only.yaml');
    const orchestrator = new WorkflowOrchestratorFacade({
      dslConfigPath: backendYamlPath,
    });

    const lowRiskApiProposal = new ProjectProposalContract({
      proposalId: 'TEST-BACKEND-DSL-01',
      title: '纯后端订单清算微服务接口优化',
      summary: '纯后端需求，无需 UI 设计阶段',
      requirements: {
        REQ_BATCH_SETTLE: '支持批量订单幂等清算 API',
      },
      involvesDatabaseMigration: false,
      involvesPermissionOrPayment: false,
    });

    const runState = await orchestrator.startProposalWorkflow({
      proposal: lowRiskApiProposal,
      initiatorActor: '后端架构师-赵工',
    });

    assert.equal(runState.workflowTemplateId, 'backend_api_only_sdlc_v1');
    assert.deepEqual(runState.getStagePipeline(), [
      WorkflowStageId.STAGE_1_PM,
      WorkflowStageId.STAGE_3A_TECH_SPEC,
      WorkflowStageId.STAGE_3B_ENGINEER,
      WorkflowStageId.STAGE_4_QA,
    ]);

    // 停在 Stage 4 QA 终审门禁时，活跃快照应恰好为 4 个（不含 STAGE_2_PD）
    assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_4_QA);
    const activeSnapshots = runState.getActiveBranchSnapshots();
    assert.equal(activeSnapshots.length, 4);
    assert.equal(
      activeSnapshots.some((s) => s.stageId === WorkflowStageId.STAGE_2_PD),
      false,
      '纯后端工作流必须跳过 STAGE_2_PD',
    );
  });

  it('3. 支持在自定义 YAML 中通过 enabled: false 禁用节点，且遇到非法阶段标识时抛出明确异常', () => {
    const customYaml = `
workflow:
  id: "custom_hotfix_flow"
  name: "紧急线上 Hotfix 极简流"
  stages:
    - stageId: "STAGE_1_PM"
      agentRole: "PM_AGENT"
      enabled: true
    - stageId: "STAGE_2_PD"
      agentRole: "PD_AGENT"
      enabled: false
    - stageId: "STAGE_3B_ENGINEER"
      agentRole: "ENGINEER_AGENT"
      gatePolicy:
        mode: "FORCE_HUMAN_GATE"
`;
    const parsed = WorkflowDslLoader.parseFromString(customYaml, 'custom_hotfix.yaml');
    assert.deepEqual(parsed.getStageOrder(), [
      WorkflowStageId.STAGE_1_PM,
      WorkflowStageId.STAGE_3B_ENGINEER,
    ]);
    assert.equal(parsed.isForceHumanGate(WorkflowStageId.STAGE_3B_ENGINEER), true);

    // J2 后：合法格式的新阶段键会被注册表自动收录为自定义节点（不再抛"未知阶段"）；
    // 仍被拒绝的是**格式非法**的键（小写/超长等）与核心枚举阶段的角色非法声明。
    assert.throws(() => {
      WorkflowDslLoader.parseFromString(
        'workflow:\n  id: "bad"\n  name: "bad"\n  stages:\n    - stageId: "invalid_stage"\n      agentRole: "PM_AGENT"',
      );
    }, /非法/);
  });
});
