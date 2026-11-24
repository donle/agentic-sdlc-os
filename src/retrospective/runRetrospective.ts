/**
 * @file runRetrospective.ts
 * @description 自动化复盘与成本控制基准评测任务入口 (Retrospective & Cost-Control Benchmark Runner)。
 *
 * 运行方式：
 *   npm run retrospective:eval               # 优先评估真实持久化历史；若无历史记录则回退隔离基准评测
 *   npm run retrospective:eval -- --benchmark    # 强制在临时隔离目录运行合成基准（不污染 .runtime-data）
 *   npm run retrospective:eval -- --history-only # 仅评估真实持久化历史运行
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ProjectProposalContract } from '../domain/contracts.ts';
import { DecisionVerdict, IntentFulfillmentStatus, WorkflowStageId } from '../domain/enums.ts';
import { WorkflowOrchestratorFacade } from '../engine/WorkflowOrchestratorFacade.ts';
import {
  IntentExecutionTraceRecord,
  IntentFulfillmentMetricsSnapshot,
} from '../telemetry/IntentFulfillmentTracker.ts';
import { CacheTelemetrySnapshot } from '../telemetry/PromptCacheManager.ts';
import {
  RetrospectiveEvaluationReport,
  RetrospectiveTaskRunner,
} from '../telemetry/RetrospectiveTaskRunner.ts';

export interface PersistedHistoryRetrospectiveSummary {
  readonly source: 'persisted_history' | 'empty';
  readonly persistenceDir: string;
  readonly restoredRunCount: number;
  readonly snapshotCount: number;
  readonly decisionCount: number;
  readonly negotiationCount: number;
  readonly report: RetrospectiveEvaluationReport | null;
}

export class RetrospectiveBenchmarkSuite {
  private readonly customPersistenceDir?: string;
  private readonly customSandboxRootDir?: string;

  public constructor(options?: { persistenceDir?: string; sandboxRootDir?: string }) {
    this.customPersistenceDir = options?.persistenceDir;
    this.customSandboxRootDir = options?.sandboxRootDir;
  }

  public async runFullSuite(): Promise<RetrospectiveEvaluationReport> {
    const useIsolatedTempDirs =
      this.customPersistenceDir === undefined || this.customSandboxRootDir === undefined;
    const tempBaseDir = useIsolatedTempDirs
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-retro-'))
      : null;
    const persistenceDir = this.customPersistenceDir ?? path.join(tempBaseDir!, 'persist');
    const sandboxRootDir = this.customSandboxRootDir ?? path.join(tempBaseDir!, 'sandbox');

    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      highRiskThreshold: 60,
      persistenceDir,
      sandboxRootDir,
    });

    try {
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
      });

      const runA = await orchestrator.startProposalWorkflow({
        proposal: proposalA,
        initiatorActor: '产品总监-陈工',
        scenarioHints: { forceNegotiationDeadlock: true, forceTransientRetry: true },
      });

      // Stage 2 PD 与 PM 发生 3 轮协商熔断 -> 人工在裁决台拍板采用方案 A
      const stage2Snap = runA.getLatestSnapshotOnActiveBranch();
      if (stage2Snap) {
        await orchestrator.submitHumanGateDecision({
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
        await orchestrator.submitHumanGateDecision({
          runId: runA.runId,
          snapshotId: stage3aSnap.snapshotId,
          reviewerActor: '首席架构师-张工',
          verdict: DecisionVerdict.APPROVE,
          comment: 'DDL 索引变更符合在线无锁迁移规范，准予进入沙箱编码',
        });
      }

      // 在进入 Stage 4 QA 门禁时，发起与总管 Agent 对话回退至 PD 阶段微调交互，测试分叉与上游缓存复用
      await orchestrator.invokeSupervisorConversationalRollback({
        runId: runA.runId,
        humanActor: '项目负责人-王工',
        dialogueInstruction: '回退到 PD Agent，把抽屉宽度调整为响应式双栏抽屉布局并重跑下游验证',
        explicitTargetStageId: WorkflowStageId.STAGE_2_PD,
      });

      // 分叉后因保留 forceNegotiationDeadlock 场景提示，先拍板 Stage 2 PD 门禁再进入 3a
      const branch2Stage2 = runA.getLatestSnapshotOnActiveBranch();
      if (branch2Stage2 && branch2Stage2.stageId === WorkflowStageId.STAGE_2_PD) {
        await orchestrator.submitHumanGateDecision({
          runId: runA.runId,
          snapshotId: branch2Stage2.snapshotId,
          reviewerActor: '设计总监-林工',
          verdict: DecisionVerdict.ARBITRATE_OPTION_A,
          comment: '回退分支确认响应式双栏抽屉布局方案 A',
        });
      }

      // 回退后新分支再次到达 Stage 3a DDL 高风险门禁 -> 核验通过（命中缓存）
      const branch2Stage3a = runA.getLatestSnapshotOnActiveBranch();
      if (branch2Stage3a && branch2Stage3a.stageId === WorkflowStageId.STAGE_3A_TECH_SPEC) {
        await orchestrator.submitHumanGateDecision({
          runId: runA.runId,
          snapshotId: branch2Stage3a.snapshotId,
          reviewerActor: '首席架构师-张工',
          verdict: DecisionVerdict.APPROVE,
          comment: '回退分支 v2 技术契约复核通过（命中缓存）',
        });
      }

      // Stage 4 QA 终审门禁 -> 核验通过，流转完成 Stage 5 DA
      const branch2Stage4 = runA.getLatestSnapshotOnActiveBranch();
      if (branch2Stage4 && branch2Stage4.stageId === WorkflowStageId.STAGE_4_QA) {
        await orchestrator.submitHumanGateDecision({
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
      });

      const runB = await orchestrator.startProposalWorkflow({
        proposal: proposalB,
        initiatorActor: '研发效能组-刘工',
      });

      const runBQaSnap = runB.getLatestSnapshotOnActiveBranch();
      if (runBQaSnap) {
        await orchestrator.submitHumanGateDecision({
          runId: runB.runId,
          snapshotId: runBQaSnap.snapshotId,
          reviewerActor: 'QA负责人-赵工',
          verdict: DecisionVerdict.APPROVE,
          comment: '热缓存流水线终审通过',
        });
      }

      return orchestrator.runRetrospectiveEvaluation();
    } finally {
      if (tempBaseDir) {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * P0-6：只读加载真实持久化历史运行实例并聚合缓存命中、意图达成、重试与成本指标（不写回合成数据）
   */
  public evaluatePersistedHistory(
    persistenceDir = this.customPersistenceDir ??
      process.env.LOCAL_PERSISTENCE_DIR ??
      '.runtime-data',
  ): PersistedHistoryRetrospectiveSummary {
    const tempSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-retro-ro-'));
    try {
      const facade = new WorkflowOrchestratorFacade({
        persistenceDir,
        sandboxRootDir: tempSandbox,
      });
      const restored = facade.restoreFromPersistence();
      if (!restored.restored || restored.runIds.length === 0) {
        return {
          source: 'empty',
          persistenceDir,
          restoredRunCount: 0,
          snapshotCount: 0,
          decisionCount: 0,
          negotiationCount: 0,
          report: null,
        };
      }

      const runs = facade.stateEngine.getAllRuns();
      const allSnapshots = runs.flatMap((r) => r.getAllSnapshots());
      const missTokensByStage = new Map<string, number[]>();
      for (const snap of allSnapshots) {
        if (!snap.cacheHit && snap.tokensConsumed > 0) {
          const list = missTokensByStage.get(snap.stageId) ?? [];
          list.push(snap.tokensConsumed);
          missTokensByStage.set(snap.stageId, list);
        }
      }

      const estimateSavedTokens = (stageId: string): number => {
        const samples = missTokensByStage.get(stageId);
        if (!samples || samples.length === 0) {
          return 600;
        }
        return Math.round(samples.reduce((acc, n) => acc + n, 0) / samples.length);
      };

      const traces: IntentExecutionTraceRecord[] = [];
      let cacheHits = 0;
      let cacheMisses = 0;
      let savedTokensTotal = 0;
      let savedCostUsdTotal = 0;

      for (const snap of allSnapshots) {
        if (snap.cacheHit) {
          cacheHits += 1;
          const estSaved = estimateSavedTokens(snap.stageId);
          savedTokensTotal += estSaved;
          savedCostUsdTotal += (estSaved / 1000) * 0.002;
        } else {
          cacheMisses += 1;
        }

        const fulfillmentStatus = snap.cacheHit
          ? IntentFulfillmentStatus.FULFILLED_VIA_CACHE
          : snap.retryCount > 0
            ? IntentFulfillmentStatus.FULFILLED_AFTER_RETRY
            : IntentFulfillmentStatus.FULFILLED_ON_FIRST_TRY;

        const retryOverheadTokens =
          snap.retryCount > 0 && snap.tokensConsumed > 0
            ? Math.round((snap.tokensConsumed * snap.retryCount) / (snap.retryCount + 1))
            : 0;

        traces.push(
          new IntentExecutionTraceRecord({
            traceId: `HIST-${snap.snapshotId}`,
            runId: snap.runId,
            branchId: snap.branchId,
            stageId: snap.stageId,
            agentRole: snap.agentRole,
            recognizedIntentCode: `RESTORED_${snap.stageId}`,
            intentConfidence: 1.0,
            retryCount: snap.retryCount,
            retryReasons: [],
            cacheHit: snap.cacheHit,
            fulfillmentStatus,
            tokensConsumed: snap.tokensConsumed,
            retryOverheadTokens,
            costUsd: Number(((snap.tokensConsumed / 1000) * 0.002).toFixed(6)),
          }),
        );
      }

      for (const run of runs) {
        const status = run.getStatus();
        if (status === 'ABORTED' || status === 'ABORTED_TOKEN_BUDGET') {
          const abortedStage = run.getCurrentStageId() ?? WorkflowStageId.STAGE_1_PM;
          traces.push(
            new IntentExecutionTraceRecord({
              traceId: `HIST-ABORT-${run.runId}`,
              runId: run.runId,
              branchId: run.getActiveBranchId(),
              stageId: abortedStage,
              agentRole: 'PM_AGENT' as never,
              recognizedIntentCode: `ABORTED_${abortedStage}`,
              intentConfidence: 0,
              retryCount: 1,
              retryReasons: [status],
              cacheHit: false,
              fulfillmentStatus: IntentFulfillmentStatus.FAILED_CONTRACT,
              tokensConsumed: 0,
              retryOverheadTokens: 0,
              costUsd: 0,
            }),
          );
        }
      }

      const cacheMetrics = new CacheTelemetrySnapshot({
        totalLookups: allSnapshots.length,
        l1ExactHits: cacheHits,
        l2SemanticHits: 0,
        cacheMisses,
        savedTokensTotal,
        savedCostUsdTotal,
      });
      const fulfillmentMetrics = new IntentFulfillmentMetricsSnapshot(traces);
      const runner = new RetrospectiveTaskRunner({
        cacheManager: facade.cacheManager,
        fulfillmentTracker: facade.fulfillmentTracker,
      });
      const report = runner.evaluateMetrics(cacheMetrics, fulfillmentMetrics);

      return {
        source: 'persisted_history',
        persistenceDir,
        restoredRunCount: runs.length,
        snapshotCount: allSnapshots.length,
        decisionCount: facade.auditLedger.getHumanDecisions().length,
        negotiationCount: facade.negotiationMediator.getNegotiationHistory().length,
        report,
      };
    } finally {
      fs.rmSync(tempSandbox, { recursive: true, force: true });
    }
  }
}

function printReport(title: string, report: RetrospectiveEvaluationReport): void {
  console.log('================================================================================');
  console.log(title);
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

// 仅当直接作为 CLI 脚本执行时输出复盘报告（兼容 Windows/macOS pathToFileURL）
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  const suite = new RetrospectiveBenchmarkSuite();

  if (args.has('--benchmark')) {
    const report = await suite.runFullSuite();
    printReport('📊 AI 原生多智能体研发协同系统 —— 隔离基准复盘与成本控制检测报告', report);
  } else {
    const historySummary = suite.evaluatePersistedHistory();
    if (historySummary.source === 'persisted_history' && historySummary.report) {
      printReport(
        `📊 真实历史运行复盘报告（目录: ${historySummary.persistenceDir} | Runs: ${historySummary.restoredRunCount} | 快照: ${historySummary.snapshotCount} | 裁决: ${historySummary.decisionCount}）`,
        historySummary.report,
      );
    } else if (args.has('--history-only')) {
      console.log(
        `[Retrospective] 目录 [${historySummary.persistenceDir}] 暂无持久化历史运行实例，跳过合成基准。`,
      );
    } else {
      console.log(
        `[Retrospective] 目录 [${historySummary.persistenceDir}] 暂无持久化历史记录，在临时隔离目录执行合成基准评测...`,
      );
      const report = await suite.runFullSuite();
      printReport('📊 AI 原生多智能体研发协同系统 —— 隔离基准复盘与成本控制检测报告', report);
    }
  }
}
