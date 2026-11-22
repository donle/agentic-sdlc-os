/**
 * @file pluggable-nodes.spec.ts
 * @description J2 可插拔节点测试：①AgentRegistry 注册表口径（注册/覆盖/枚举保护/角色映射）；
 *              ②DSL 声明新节点（自定义阶段 + 协商目标指向自定义节点）；
 *              ③RBAC 门禁角色映射配置化；④Facade 编排检查点跳过推进。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { AgentRegistry } from '../src/agents/AgentRegistry.ts';
import { WorkflowDslLoader } from '../src/engine/WorkflowDslLoader.ts';
import { RbacGovernanceService } from '../src/engine/RbacGovernanceService.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowStageId } from '../src/domain/enums.ts';

describe('J2 — AgentRegistry 注册表', () => {
  it('1. 注册自定义节点：口径扩展（枚举 ∪ 自定义）、同键覆盖幂等、核心枚举禁止覆盖', () => {
    const registry = new AgentRegistry();
    assert.equal(registry.isValidStageId('STAGE_1_PM'), true, '核心枚举阶段天然合法');
    assert.equal(registry.isValidStageId('STAGE_6_LEGAL_REVIEW'), false, '未注册前不合法');

    const descriptor = registry.registerCustomStage({
      stageId: 'STAGE_6_LEGAL_REVIEW',
      agentRole: 'LEGAL_REVIEWER_AGENT',
      displayName: '法务合规审查',
      requiredHumanRoles: ['法务审核员 (LEGAL_REVIEWER)'],
    });
    assert.equal(descriptor.stageId, 'STAGE_6_LEGAL_REVIEW');
    assert.equal(registry.isValidStageId('STAGE_6_LEGAL_REVIEW'), true);
    assert.equal(registry.isValidAgentRole('LEGAL_REVIEWER_AGENT'), true);
    assert.equal(registry.isCustomStage('STAGE_6_LEGAL_REVIEW'), true);

    // 同键覆盖（幂等）——同一 DSL 重复解析不炸
    registry.registerCustomStage({
      stageId: 'STAGE_6_LEGAL_REVIEW',
      agentRole: 'LEGAL_REVIEWER_AGENT',
      displayName: '法务合规审查 v2',
    });
    assert.equal(registry.getCustomStage('STAGE_6_LEGAL_REVIEW')?.displayName, '法务合规审查 v2');

    // 核心枚举阶段禁止覆盖
    assert.throws(
      () =>
        registry.registerCustomStage({
          stageId: WorkflowStageId.STAGE_1_PM,
          agentRole: 'EVIL_AGENT',
          displayName: 'evil',
        }),
      /核心枚举阶段/,
    );

    // 非法键格式拦截
    assert.throws(
      () =>
        registry.registerCustomStage({
          stageId: 'stage-6-lower',
          agentRole: 'X',
          displayName: 'x',
        }),
      /大写下划线/,
    );
  });

  it('2. RBAC 角色映射：自定义节点走声明配置（缺省仅管理员），核心阶段仍走硬表', () => {
    const registry = new AgentRegistry();
    registry.registerCustomStage({
      stageId: 'STAGE_7_SECURITY_AUDIT',
      agentRole: 'SECURITY_AUDITOR_AGENT',
      displayName: '安全专项审计',
      requiredHumanRoles: ['安全审计员 (SECURITY_AUDITOR)', '最高管理员 (PROJECT_ADMIN)'],
    });
    registry.registerCustomStage({
      stageId: 'STAGE_8_UNSIGNED_NODE',
      agentRole: 'ANY_ROLE',
      displayName: '未配置映射的节点',
    });

    const rbac = new RbacGovernanceService(registry);
    assert.deepEqual(rbac.getRequiredRolesForStage('STAGE_7_SECURITY_AUDIT' as never), [
      '安全审计员 (SECURITY_AUDITOR)',
      '最高管理员 (PROJECT_ADMIN)',
    ]);
    assert.deepEqual(
      rbac.getRequiredRolesForStage('STAGE_8_UNSIGNED_NODE' as never),
      ['最高管理员 (PROJECT_ADMIN)'],
      '未声明映射的自定义节点缺省仅管理员',
    );
    assert.ok(
      rbac
        .getRequiredRolesForStage(WorkflowStageId.STAGE_3A_TECH_SPEC)
        .some((r) => r.includes('TECH_LEAD')),
      '核心阶段硬表不受影响',
    );
  });
});

const CUSTOM_YAML = `
workflow:
  id: custom_nodes_v1
  name: 含自定义检查点的流水线
  deploymentMode: SINGLE_NODE_ON_PREMISE
  guardrails:
    maxNegotiationTurns: 3
    tokenBudgetLimit: 120000
  stages:
    - stageId: STAGE_1_PM
      displayName: PRD 拆解
      agentRole: PM_AGENT
      modelTier: HIGH_REASONING
      gatePolicy:
        mode: RISK_BASED
        lowRiskAction: AUTO_PASS_WITH_AUDIT
    - stageId: STAGE_6_LEGAL_REVIEW
      displayName: 法务合规审查
      agentRole: LEGAL_REVIEWER_AGENT
      requiredHumanRoles: ["法务审核员 (LEGAL_REVIEWER)", "最高管理员 (PROJECT_ADMIN)"]
      gatePolicy:
        mode: RISK_BASED
        lowRiskAction: AUTO_PASS_WITH_AUDIT
    - stageId: STAGE_2_PD
      displayName: UI 组件映射
      agentRole: PD_AGENT
      negotiateWithStageId: STAGE_6_LEGAL_REVIEW
      gatePolicy:
        mode: RISK_BASED
        lowRiskAction: AUTO_PASS_WITH_AUDIT
`;

describe('J2 — DSL 声明新节点', () => {
  it('3. DSL 新节点经注册表自动注册并进入流水线（协商目标可指向自定义节点）', () => {
    const registry = new AgentRegistry();
    const config = WorkflowDslLoader.parseFromString(CUSTOM_YAML, 'custom_nodes.yaml', registry);
    assert.deepEqual(config.getStageOrder(), [
      WorkflowStageId.STAGE_1_PM,
      'STAGE_6_LEGAL_REVIEW',
      WorkflowStageId.STAGE_2_PD,
    ]);
    assert.equal(registry.getCustomStage('STAGE_6_LEGAL_REVIEW')?.displayName, '法务合规审查');
    assert.equal(
      registry.getRequiredHumanRoles('STAGE_6_LEGAL_REVIEW')?.[0],
      '法务审核员 (LEGAL_REVIEWER)',
    );
  });

  it('4. 同一模板重复解析幂等（同键覆盖，不抛已注册异常）', () => {
    const registry = new AgentRegistry();
    WorkflowDslLoader.parseFromString(CUSTOM_YAML, 'a.yaml', registry);
    const again = WorkflowDslLoader.parseFromString(CUSTOM_YAML, 'b.yaml', registry);
    assert.equal(again.getStageOrder().length, 3);
  });

  it('5. 核心枚举阶段声明未知角色仍被拦截（保护核心语义）', () => {
    const registry = new AgentRegistry();
    const badYaml = CUSTOM_YAML.replace('agentRole: PM_AGENT', 'agentRole: NOT_A_ROLE');
    assert.throws(
      () => WorkflowDslLoader.parseFromString(badYaml, 'bad.yaml', registry),
      /未知角色/,
    );
  });
});

describe('J2 — Facade 编排检查点（自定义节点跳过推进）', () => {
  it('6. 流水线经过自定义节点：广播检查点通知后继续推进直至完成', async () => {
    const tempYamlPath = path.join(os.tmpdir(), `agentic-j2-${Date.now()}.yaml`);
    fs.writeFileSync(tempYamlPath, CUSTOM_YAML, 'utf-8');
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        dslConfigPath: tempYamlPath,
        maxNegotiationTurns: 3,
      });
      const runState = await orchestrator.startProposalWorkflow({
        proposal: new ProjectProposalContract({
          proposalId: 'TEST-J2-1',
          title: 'J2 可插拔节点测试项目',
          summary: '流水线含自定义编排检查点',
          requirements: { R1: '需求一' },
        }),
        initiatorActor: '测试员',
      });

      assert.equal(runState.getStatus(), 'COMPLETED', '自定义节点跳过后流水线正常走完');
      const checkpointNotice = orchestrator.eventBus
        .getNotificationInbox(runState.runId)
        .find((n) => n.title.includes('编排检查点'));
      assert.ok(checkpointNotice, '应广播自定义检查点通知');
      assert.equal(checkpointNotice.stageId, 'STAGE_6_LEGAL_REVIEW' as never);
      assert.equal(checkpointNotice.requiresHumanAction, false, '检查点通知不要求人工操作');
    } finally {
      fs.rmSync(tempYamlPath, { force: true });
    }
  });
});
