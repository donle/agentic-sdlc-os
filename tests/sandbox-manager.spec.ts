/**
 * @file sandbox-manager.spec.ts
 * @description Block 4 功能与结构测试：验证 Git Worktree 隔离沙箱管理器 (`GitWorktreeSandboxManager`)
 * 的真实文件落盘、子进程 `node --test` 单测执行、静态安全漏洞扫描以及 DAG 分叉回退时的多分支物理隔离。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ProjectProposalContract } from '../src/domain/contracts.ts';
import { WorkflowOrchestratorFacade } from '../src/engine/WorkflowOrchestratorFacade.ts';
import { GitWorktreeSandboxManager } from '../src/sandbox/GitWorktreeSandboxManager.ts';

describe('Block 4 — Git Worktree 隔离代码与测试沙箱管理器测试套件', () => {
  it('1. 应在隔离沙箱目录中真实生成面向对象业务类与单测文件，并通过子进程 node --test 真实执行通过', async () => {
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-sandbox-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot);
      const provisioned = manager.provisionWorktreeAndWriteCode({
        runId: 'RUN-SANDBOX-01',
        branchId: 'branch-v1-main',
        proposalTitle: '订单风控与审计模块',
        requirementIds: ['REQ_RISK_ENGINE', 'REQ_AUDIT_LOG'],
        requirementDescriptions: {
          REQ_RISK_ENGINE: '实时交易风控评分引擎',
          REQ_AUDIT_LOG: '审计流水归档服务',
        },
        ddlStatements: ['CREATE TABLE IF NOT EXISTS trade_risk_audit (id UUID PRIMARY KEY);'],
      });

      assert.equal(provisioned.gitWorktreeBranch, 'worktree/RUN-SANDBOX-01/branch-v1-main');
      assert.equal(
        manager.readActiveGitBranch('RUN-SANDBOX-01', 'branch-v1-main'),
        'worktree/RUN-SANDBOX-01/branch-v1-main',
      );
      assert.equal(provisioned.generatedFiles.length, 2);
      for (const fileMeta of provisioned.generatedFiles) {
        assert.equal(
          fs.existsSync(fileMeta.absolutePath),
          true,
          '生成的业务类文件必须真实存在于磁盘',
        );
      }

      const ddlFile = path.join(provisioned.workspacePath, 'schema/migration.sql');
      assert.equal(fs.existsSync(ddlFile), true, 'DDL 迁移脚本必须真实落盘');

      // 在隔离沙箱子进程中真实调用 node --test 运行生成的单测文件
      const verifyResult = manager.executeSandboxVerification({
        runId: 'RUN-SANDBOX-01',
        branchId: 'branch-v1-main',
        requirementIds: ['REQ_RISK_ENGINE', 'REQ_AUDIT_LOG'],
        runSubprocessNodeTest: true,
      });

      assert.equal(verifyResult.subprocessExecuted, true);
      assert.equal(verifyResult.filesVerifiedCount, 4);
      assert.equal(verifyResult.securityIssuesFound, 0);
      // E2：真实 node:test 计数（2 个 spec 文件 × 2 个用例）与覆盖率解析
      assert.equal(verifyResult.totalTestCases, 4);
      assert.equal(verifyResult.passedTestCases, 4);
      assert.equal(verifyResult.failedTestCases, 0);
      assert.equal(verifyResult.suites.length, 2);
      assert.ok(
        verifyResult.executionLog.includes('[Suite '),
        '执行日志应包含真实 node:test 套件输出',
      );
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });

  it('2. 静态安全扫描器应能精准捕获沙箱代码中注入的 eval() 或硬编码 API Key 漏洞', async () => {
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-sec-'));
    try {
      const manager = new GitWorktreeSandboxManager(tempSandboxRoot);
      const provisioned = manager.provisionWorktreeAndWriteCode({
        runId: 'RUN-SEC-02',
        branchId: 'branch-v1-main',
        proposalTitle: '安全扫描测试',
        requirementIds: ['REQ_PAYMENT_GATEWAY'],
      });

      // 模拟在沙箱文件中注入高危 eval 调用与硬编码密钥
      const targetFile = provisioned.generatedFiles[0].absolutePath;
      fs.appendFileSync(
        targetFile,
        "\n// Injected vulnerability\nconst leak = 'sk-1234567890abcdefghijklmnop';\neval('1 + 1');\n",
        'utf-8',
      );

      const scanResult = manager.executeSandboxVerification({
        runId: 'RUN-SEC-02',
        branchId: 'branch-v1-main',
        requirementIds: ['REQ_PAYMENT_GATEWAY'],
        runSubprocessNodeTest: false,
      });

      assert.equal(scanResult.securityIssuesFound, 2);
      assert.equal(scanResult.securityFindings.length, 2);
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
    }
  });

  it('3. 总管 Agent 触发 DAG 分叉回退时，新旧分支的沙箱工作区应在磁盘上完全隔离', async () => {
    const tempSandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-fork-sb-'));
    const tempPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-fork-db-'));
    try {
      const orchestrator = new WorkflowOrchestratorFacade({
        sandboxRootDir: tempSandboxRoot,
        persistenceDir: tempPersistDir,
      });

      const proposal = new ProjectProposalContract({
        proposalId: 'TEST-FORK-SANDBOX',
        title: '沙箱多分支物理隔离验证',
        summary: '验证 branch-v1 与 branch-v2 分别拥有独立沙箱目录',
        requirements: {
          REQ_ISOLATED_MOD: '核心隔离模块',
        },
        involvesDatabaseMigration: false,
      });

      const runState = await orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: '研发负责人-吴工',
      });
      const branchV1 = runState.getActiveBranchId();

      await orchestrator.invokeSupervisorConversationalRollback({
        runId: runState.runId,
        humanActor: '研发负责人-吴工',
        dialogueInstruction: '回退到 Engineer Agent，补充幂等校验注解',
      });
      const branchV2 = runState.getActiveBranchId();

      assert.notEqual(branchV1, branchV2);
      const summaryV1 = orchestrator.sandboxManager.getWorkspaceSummary(runState.runId, branchV1);
      const summaryV2 = orchestrator.sandboxManager.getWorkspaceSummary(runState.runId, branchV2);

      assert.notEqual(summaryV1.worktreePath, summaryV2.worktreePath);
      assert.ok(summaryV1.generatedFiles.length >= 2);
      assert.ok(summaryV2.generatedFiles.length >= 2);
      // 验证回退指令已写入新分支沙箱生成的代码注释中，而旧分支保持不变
      const v2ModulePreview = summaryV2.generatedFiles[0].previewSnippet;
      assert.ok(v2ModulePreview.includes('@humanDirective'));
    } finally {
      fs.rmSync(tempSandboxRoot, { recursive: true, force: true });
      fs.rmSync(tempPersistDir, { recursive: true, force: true });
    }
  });
});
