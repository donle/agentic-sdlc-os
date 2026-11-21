/**
 * @file runRetrospective.ts
 * @description 自动化复盘与成本控制基准评测任务入口 (Retrospective & Cost-Control Benchmark Runner)。
 *
 * 运行方式：
 *   node --experimental-strip-types src/retrospective/runRetrospective.ts
 *
 * 评测覆盖场景：
 *   1. 场景 A（冷启动 + 自愈重试）：模拟首次契约格式轻微偏差，验证 Agent 自愈重试与高风险 DDL 门禁拦截；
 *   2. 场景 B（PM-PD 协商熔断 + 总管对话回退）：验证 3 轮讨论限制熔断、人工拍板裁决以及总管 DAG 分叉回退；
 *   3. 场景 C（相似提案热缓存复用）：验证 L1 精确缓存与 L2 语义意图缓存命中率与零 Token 成本控制。
 */

import { ProjectProposalContract } from '../domain/contracts.ts';
import { DecisionVerdict, WorkflowStageId } from '../domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../engine/WorkflowOrchestratorFacade.ts';
import { RetrospectiveEvaluationReport } from '../telemetry/RetrospectiveTaskRunner.ts';

export class RetrospectiveBenchmarkSuite {
  private readonly orchestrator: WorkflowOrchestratorFacade;

  public constructor() {
    this.orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      highRiskThreshold: 60,
    });
  }

  public runFullSuite(): RetrospectiveEvaluationReport {
    // 1. 场景 A：带数据库 DDL 变更的企业订单研发提案（含 Stage 1 瞬态重试自愈）
    const proposalA = new ProjectProposalContract({
      proposalId: 'PROP-BENCH-001',
      title: '企业私有化研发协同工作台 v1.0',
      summary: '构建从提案到 QA 的多智能体流水线与不可变审计中心',
      requirements: {
        REQ_DAG_ENGINE: '支持任意阶段 DAG 快照分叉回退与脏数据隔离',
        REQ_RISK_GATE: '基于业务风险评分动态决定低风险自动放行或高风险阻塞',
        REQ_AUDIT_LEDGER: '记录所有人工签核与驳回历史用于反向追责',
      },
      involvesDatabaseMigration: true,
      involvesPermissionOrPayment: true,
      simulateNegotiationConflict: true,
    });

    const runA = this.orchestrator.startProposalWorkflow({
      proposal: proposalA,
      initiatorActor: '产品总监-陈工',
      simulateTransientRetryOnStage1: true,
    });

    // Stage 2 PD 与 PM 发生 3 轮协商熔断 -> 人工在裁决台拍板采用方案 A
    const stage2Snap = runA.getLatestSnapshotOnActiveBranch();
    if (stage2Snap) {
      this.orchestrator.submitHumanGateDecision({
        runId: runA.runId,
        snapshotId: stage2Snap.snapshotId,
        reviewerActor: '设计总监-林工',
        verdict: DecisionVerdict.ARBITRATE_OPTION_A,
        comment: '同意采用企业标准双栏折叠抽屉组件，控制首期交付风险',
      });
    }

    // Stage 3a Tech Lead 因包含 DDL 变更触发高风险门禁 -> 架构师核验通过
    const stage3aSnap = runA.getLatestSnapshotOnActiveBranch();
    if (stage3aSnap) {
      this.orchestrator.submitHumanGateDecision({
        runId: runA.runId,
        snapshotId: stage3aSnap.snapshotId,
        reviewerActor: '首席架构师-张工',
        verdict: DecisionVerdict.APPROVE,
        comment: 'DDL 索引变更符合在线无锁迁移规范，准予进入沙箱编码',
      });
    }

    // 在进入 Stage 4 QA 门禁时，发起与总管 Agent 对话回退至 PD 阶段微调交互，测试分叉与上游缓存复用
    this.orchestrator.invokeSupervisorConversationalRollback({
      runId: runA.runId,
      humanActor: '项目负责人-王工',
      dialogueInstruction: '回退到 PD Agent，把抽屉宽度调整为响应式双栏抽屉布局并重跑下游验证',
      explicitTargetStageId: WorkflowStageId.STAGE_2_PD,
    });

    // 回退后新分支再次到达 Stage 3a DDL 高风险门禁 -> 核验通过
    const branch2Stage3a = runA.getLatestSnapshotOnActiveBranch();
    if (branch2Stage3a) {
      this.orchestrator.submitHumanGateDecision({
        runId: runA.runId,
        snapshotId: branch2Stage3a.snapshotId,
        reviewerActor: '首席架构师-张工',
        verdict: DecisionVerdict.APPROVE,
        comment: '回退分支 v2 技术契约复核通过（命中缓存）',
      });
    }

    // Stage 4 QA 终审门禁 -> 核验通过，流转完成 Stage 5 DA
    const branch2Stage4 = runA.getLatestSnapshotOnActiveBranch();
    if (branch2Stage4) {
      this.orchestrator.submitHumanGateDecision({
        runId: runA.runId,
        snapshotId: branch2Stage4.snapshotId,
        reviewerActor: 'QA负责人-赵工',
        verdict: DecisionVerdict.APPROVE,
        comment: '全部自动化契约与回归测试 100% 通过，准予上线',
      });
    }

    // 2. 场景 B：发起同构核心需求的二期验证提案，检验 L1/L2 双层缓存命中率与零 Token 节流效果
    const proposalB = new ProjectProposalContract({
      proposalId: 'PROP-BENCH-002',
      title: '企业私有化研发协同工作台 v1.0',
      summary: '同构需求回归验证（测试 L1/L2 缓存直接命中）',
      requirements: {
        REQ_DAG_ENGINE: '支持任意阶段 DAG 快照分叉回退与脏数据隔离',
        REQ_RISK_GATE: '基于业务风险评分动态决定低风险自动放行或高风险阻塞',
        REQ_AUDIT_LEDGER: '记录所有人工签核与驳回历史用于反向追责',
      },
      involvesDatabaseMigration: false,
      involvesPermissionOrPayment: false,
      simulateNegotiationConflict: false,
    });

    const runB = this.orchestrator.startProposalWorkflow({
      proposal: proposalB,
      initiatorActor: '研发效能组-刘工',
    });

    const runBQaSnap = runB.getLatestSnapshotOnActiveBranch();
    if (runBQaSnap) {
      this.orchestrator.submitHumanGateDecision({
        runId: runB.runId,
        snapshotId: runBQaSnap.snapshotId,
        reviewerActor: 'QA负责人-赵工',
        verdict: DecisionVerdict.APPROVE,
        comment: '热缓存流水线终审通过',
      });
    }

    return this.orchestrator.runRetrospectiveEvaluation();
  }
}

// 当直接作为脚本执行时输出详细复盘报告
if (import.meta.url === `file://${process.argv[1]}`) {
  const suite = new RetrospectiveBenchmarkSuite();
  const report = suite.runFullSuite();

  console.log('================================================================================');
  console.log('📊 AI 原生多智能体研发协同系统 —— 自动化复盘与成本控制检测报告');
  console.log('================================================================================');
  console.log(`报告编号: ${report.reportId}`);
  console.log(`生成时间: ${report.evaluatedAtIso}`);
  console.log(`整体健康度: ${report.overallHealthy ? '✅ 全部达标 (HEALTHY)' : '⚠️ 存在待优化项'}`);
  console.log('--------------------------------------------------------------------------------');
  for (const diag of report.diagnoses) {
    console.log(`${diag.passedSla ? '✅' : '❌'} ${diag.metricName}`);
    console.log(`   • 实测数值: ${diag.observedValue}`);
    console.log(`   • 目标基线: ${diag.targetThreshold}`);
    console.log(`   • 复盘建议: ${diag.optimizationAction}`);
  }
  console.log('================================================================================');
}
