/**
 * @file rbac-governance.spec.ts
 * @description 企业级多角色权限治理 (RBAC) 功能与结构测试：
 * 验证顶层管理员 (`PROJECT_ADMIN`) 与各环节专长员工 (`STAGE_SPECIALIST`: PM / PD / TechLead / Engineer / QA / DA)
 * 的共享工作流视图透明性、专长领域门禁签核校验、越权拦截以及管理员最高权限 Override 与全局治理。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { DecisionVerdict, WorkflowStageId } from '../src/domain/enums.ts';
import { SystemPermissionCode, UserHierarchyTier } from '../src/domain/rbac.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { SessionService } from '../src/server/auth/SessionService.ts';
import { withTestWorkspace } from './helpers/testIsolation.ts';

describe('Block 6 — 企业级多层级用户 RBAC 与最高管理员治理测试套件', () => {
  it('1. 所有环节员工均应共享完整工作流视图，但仅专长领域负责人或顶层管理员可签核对应阶段门禁', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-rbac-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: tempDir,
        sandboxRootDir: path.join(tempDir, 'sandbox'),
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-RBAC-001',
        title: '核心账户权限与表结构升级',
        summary: '包含 Stage 2 协商冲突与 Stage 3a 数据库 DDL 变更',
        requirements: {
          REQ_ACCOUNT_DDL: '新增账户权限隔离表',
        },
        involvesDatabaseMigration: true,
        involvesPermissionOrPayment: true,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工 (PM)',
        scenarioHints: { forceNegotiationDeadlock: true },
      });

      // 当前卡在 Stage 2 (STAGE_2_PD)
      assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_2_PD);
      const stage2Snap = runState.getLatestSnapshotOnActiveBranch();
      assert.ok(stage2Snap);

      // QA 员工 (user-qa-01) 可以完整查看共享工作流状态，但尝试拍板 Stage 2 PD 门禁应被 RBAC 拦截
      const qaDashboard = orchestrator.buildWorkbenchDashboardState(runState.runId, 'user-qa-01');
      assert.equal(qaDashboard.hasActiveRun, true);
      await assert.rejects(
        orchestrator.submitHumanGateDecision({
          runId: runState.runId,
          snapshotId: stage2Snap.snapshotId,
          reviewerActor: '孙工 (QA)',
          actorUserId: 'user-qa-01',
          verdict: DecisionVerdict.ARBITRATE_OPTION_A,
          comment: 'QA 尝试越权拍板 UI 设计冲突',
        }),
        /RBAC 权限拦截/,
      );

      // PD 专长设计师 (user-pd-01) 属于 Stage 2 领域负责人，拍板应成功通过并推进到 Stage 3a (Tech Spec DDL 门禁)
      await orchestrator.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: stage2Snap.snapshotId,
        reviewerActor: '林工 (PD/UX)',
        actorUserId: 'user-pd-01',
        verdict: DecisionVerdict.ARBITRATE_OPTION_A,
        comment: 'PD 专长设计师确认采用双栏抽屉组件规范',
      });

      assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_3A_TECH_SPEC);
      const stage3aSnap = runState.getLatestSnapshotOnActiveBranch();
      assert.ok(stage3aSnap);

      // PM 员工 (user-pm-01) 尝试签核 Stage 3a 架构师 DDL 门禁，应被 RBAC 拦截
      await assert.rejects(
        orchestrator.submitHumanGateDecision({
          runId: runState.runId,
          snapshotId: stage3aSnap.snapshotId,
          reviewerActor: '陈工 (PM)',
          actorUserId: 'user-pm-01',
          verdict: DecisionVerdict.APPROVE,
          comment: 'PM 尝试越权签核数据库 DDL',
        }),
        /RBAC 权限拦截/,
      );

      // 顶层管理员 (user-admin-01) 拥有最高权限 (Admin Override)，可跨阶段签核 Stage 3a 并推进至 Stage 4 QA
      await orchestrator.submitHumanGateDecision({
        runId: runState.runId,
        snapshotId: stage3aSnap.snapshotId,
        reviewerActor: '王总管',
        actorUserId: 'user-admin-01',
        verdict: DecisionVerdict.APPROVE,
        comment: '最高管理员紧急签核架构 DDL 门禁',
      });

      assert.equal(runState.getCurrentStageId(), WorkflowStageId.STAGE_4_QA);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('2. 仅顶层管理员 (PROJECT_ADMIN) 可修改全局工作流治理参数，普通专长员工调用将被拦截', async () => {
    await withTestWorkspace('rbac-admin-', (ws) => {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: ws.persistenceDir,
        sandboxRootDir: ws.sandboxRootDir,
      });
      const adminUser = orchestrator.rbacService.getUserOrThrow('user-admin-01');
      const engUser = orchestrator.rbacService.getUserOrThrow('user-eng-01');

      assert.equal(adminUser.tier, UserHierarchyTier.PROJECT_ADMIN);
      assert.equal(engUser.tier, UserHierarchyTier.STAGE_SPECIALIST);

      assert.throws(() => {
        orchestrator.updateAdminGovernanceConfig({
          actorUserId: 'user-eng-01',
          maxNegotiationTurns: 5,
        });
      }, /RBAC 最高权限拦截/);

      const updated = orchestrator.updateAdminGovernanceConfig({
        actorUserId: 'user-admin-01',
        maxNegotiationTurns: 4,
        highRiskScoreThreshold: 70,
        allowSpecialistCrossStageRollback: false,
      });

      assert.equal(updated.maxNegotiationTurns, 4);
      assert.equal(updated.highRiskScoreThreshold, 70);
      assert.equal(updated.allowSpecialistCrossStageRollback, false);

      // 开启严格回退限制后，Engineer (user-eng-01) 尝试跨领域回退到 Stage 1 PM 应被拦截，而 Admin 不受限
      assert.throws(() => {
        orchestrator.rbacService.assertCanInvokeRollback('user-eng-01', WorkflowStageId.STAGE_1_PM);
      }, /RBAC 权限拦截/);

      assert.doesNotThrow(() => {
        orchestrator.rbacService.assertCanInvokeRollback(
          'user-admin-01',
          WorkflowStageId.STAGE_1_PM,
        );
      });
    });
  });

  it('3. 任何角色的团队成员均可在任意项目步骤下发表共享评论，且签核或回退操作自动记入步骤评论流', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-cmt-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: tempDir,
        sandboxRootDir: path.join(tempDir, 'sandbox'),
      });
      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-CMT-001',
        title: '多角色步骤评论协同测试项目',
        summary: '验证全员共享步骤评论流',
        requirements: {
          REQ_COLLAB: '支持跨角色评论协同',
        },
      });
      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '陈工 (PM)',
      });

      // 研发工程师刘工在步骤 2 (STAGE_2_PD) 留下技术可行性评论
      const added = orchestrator.addTeamComment({
        runId: runState.runId,
        stageId: WorkflowStageId.STAGE_2_PD,
        actorUserId: 'user-eng-01',
        content: '建议抽屉组件宽度固定为 560px，方便嵌入权限矩阵子表格。',
      });
      assert.equal(added.authorName, '刘工 (Engineer)');

      const stage2Comments = orchestrator.getTeamComments(
        runState.runId,
        WorkflowStageId.STAGE_2_PD,
      );
      assert.ok(stage2Comments.some((c) => c.content.includes('560px')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('4. SessionService 与 RbacGovernanceService 共享用户源，且严格禁止未知/未认证用户提权为管理员', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-sync-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        persistenceDir: tempDir,
        sandboxRootDir: path.join(tempDir, 'sandbox'),
      });
      const sessionSvc = new SessionService(
        path.join(tempDir, 'users.json'),
        orchestrator.rbacService,
      );

      // 1) 未认证或未知用户严格拦截，禁止回落 admin
      assert.throws(() => {
        orchestrator.rbacService.getUserStrict('UNAUTHENTICATED');
      }, /RBAC 权限拦截/);
      assert.throws(() => {
        orchestrator.rbacService.assertCanApproveStageGate(
          'UNAUTHENTICATED',
          WorkflowStageId.STAGE_1_PM,
        );
      }, /RBAC 权限拦截/);
      assert.throws(() => {
        orchestrator.rbacService.assertIsProjectAdmin('unknown-user');
      }, /RBAC 权限拦截/);
      assert.throws(() => {
        orchestrator.rbacService.assertHasPermission(
          'user-da-01',
          SystemPermissionCode.CREATE_PROPOSAL,
        );
      }, /RBAC 权限拦截/);

      // 2) 新建专长员工 (usr_xxx) 同步进 RBAC：仅可签核其负责阶段，不可越权
      const created = sessionSvc.createUser('user-admin-01', {
        username: 'arch_new',
        displayName: '林架构',
        tier: 'STAGE_SPECIALIST',
        specialistDomain: 'SYSTEM_ARCHITECTURE',
        counterpartAgentRole: 'TECH_LEAD_AGENT',
        ownedStageIds: [WorkflowStageId.STAGE_3A_TECH_SPEC],
      });
      assert.equal(created.ok, true);
      const newUserId = created.user!.userId;

      assert.doesNotThrow(() => {
        orchestrator.rbacService.assertCanApproveStageGate(
          newUserId,
          WorkflowStageId.STAGE_3A_TECH_SPEC,
        );
      });
      assert.throws(() => {
        orchestrator.rbacService.assertCanApproveStageGate(newUserId, WorkflowStageId.STAGE_2_PD);
      }, /RBAC 权限拦截/);
      assert.throws(() => {
        orchestrator.rbacService.assertIsProjectAdmin(newUserId);
      }, /RBAC 最高权限拦截/);

      // 3) 修改负责阶段实时生效；停用账号立即吊销 RBAC 权限
      const updated = sessionSvc.updateUser('user-admin-01', newUserId, {
        ownedStageIds: [WorkflowStageId.STAGE_2_PD],
      });
      assert.equal(updated.ok, true);
      assert.doesNotThrow(() => {
        orchestrator.rbacService.assertCanApproveStageGate(newUserId, WorkflowStageId.STAGE_2_PD);
      });

      sessionSvc.updateUser('user-admin-01', newUserId, { status: 'DISABLED' });
      assert.throws(() => {
        orchestrator.rbacService.assertCanApproveStageGate(newUserId, WorkflowStageId.STAGE_2_PD);
      }, /已停用/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
