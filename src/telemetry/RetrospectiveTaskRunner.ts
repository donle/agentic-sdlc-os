/**
 * @file RetrospectiveTaskRunner.ts
 * @description 自动化复盘与成本控制指标检测任务类 (Scheduled Retrospective Task)。
 *
 * 专门用于定期或在每个迭代里程碑结束后，对整个多智能体工作流系统执行以下三维度的复盘审计：
 * 1. (a) 缓存命中率检测 (Cache Hit Rate >= 目标基线，验证 L1 精确缓存 + L2 语义意图缓存对重复/相似需求的拦截率)；
 * 2. (b) 意图识别到最终执行结果达成率 & 重试分布检测 (Intent-to-Execution Fulfillment Rate & Retry Count)；
 * 3. (c) 成本控制健康度诊断 (Token 节流率、重试损耗占比、高风险门禁拦截准确率)，并输出改进建议。
 */

import { CacheTelemetrySnapshot, PromptCacheManager } from './PromptCacheManager.ts';
import {
  IntentFulfillmentMetricsSnapshot,
  IntentFulfillmentTracker,
} from './IntentFulfillmentTracker.ts';

export interface RetrospectiveSlaThresholds {
  readonly minCacheHitRatePercent: number;
  readonly minIntentFulfillmentRatePercent: number;
  readonly maxAverageRetriesPerInvocation: number;
  readonly maxRetryTokenOverheadRatioPercent: number;
}

export class RetrospectiveMetricDiagnosis {
  public readonly metricName: string;
  public readonly observedValue: string;
  public readonly targetThreshold: string;
  public readonly passedSla: boolean;
  public readonly optimizationAction: string;

  public constructor(params: {
    metricName: string;
    observedValue: string;
    targetThreshold: string;
    passedSla: boolean;
    optimizationAction: string;
  }) {
    this.metricName = params.metricName;
    this.observedValue = params.observedValue;
    this.targetThreshold = params.targetThreshold;
    this.passedSla = params.passedSla;
    this.optimizationAction = params.optimizationAction;
  }
}

export class RetrospectiveEvaluationReport {
  public readonly reportId: string;
  public readonly evaluatedAtIso: string;
  public readonly cacheMetrics: CacheTelemetrySnapshot;
  public readonly fulfillmentMetrics: IntentFulfillmentMetricsSnapshot;
  public readonly costSavingsRatioPercent: number;
  public readonly retryTokenWasteRatioPercent: number;
  public readonly diagnoses: ReadonlyArray<RetrospectiveMetricDiagnosis>;
  public readonly overallHealthy: boolean;

  public constructor(params: {
    reportId: string;
    cacheMetrics: CacheTelemetrySnapshot;
    fulfillmentMetrics: IntentFulfillmentMetricsSnapshot;
    costSavingsRatioPercent: number;
    retryTokenWasteRatioPercent: number;
    diagnoses: ReadonlyArray<RetrospectiveMetricDiagnosis>;
  }) {
    this.reportId = params.reportId;
    this.evaluatedAtIso = new Date().toISOString();
    this.cacheMetrics = params.cacheMetrics;
    this.fulfillmentMetrics = params.fulfillmentMetrics;
    this.costSavingsRatioPercent = params.costSavingsRatioPercent;
    this.retryTokenWasteRatioPercent = params.retryTokenWasteRatioPercent;
    this.diagnoses = [...params.diagnoses];
    this.overallHealthy = this.diagnoses.every((d) => d.passedSla);
  }
}

export class RetrospectiveTaskRunner {
  private readonly cacheManager: PromptCacheManager;
  private readonly fulfillmentTracker: IntentFulfillmentTracker;
  private readonly thresholds: RetrospectiveSlaThresholds;

  public constructor(params: {
    cacheManager: PromptCacheManager;
    fulfillmentTracker: IntentFulfillmentTracker;
    thresholds?: RetrospectiveSlaThresholds;
  }) {
    this.cacheManager = params.cacheManager;
    this.fulfillmentTracker = params.fulfillmentTracker;
    this.thresholds = params.thresholds ?? {
      minCacheHitRatePercent: 30.0,
      minIntentFulfillmentRatePercent: 85.0,
      maxAverageRetriesPerInvocation: 0.65,
      maxRetryTokenOverheadRatioPercent: 20.0,
    };
  }

  /**
   * 执行复盘指标检测并输出结构化成本控制诊断报告
   */
  public executeRetrospectiveCheck(): RetrospectiveEvaluationReport {
    const cacheMetrics = this.cacheManager.getMetricsSnapshot();
    const fulfillmentMetrics = this.fulfillmentTracker.getMetricsSnapshot();

    const theoreticalTotalTokens =
      fulfillmentMetrics.totalTokensConsumed + cacheMetrics.savedTokensTotal;
    const costSavingsRatioPercent =
      theoreticalTotalTokens === 0
        ? 0
        : Number(((cacheMetrics.savedTokensTotal / theoreticalTotalTokens) * 100).toFixed(2));

    const retryTokenWasteRatioPercent =
      fulfillmentMetrics.totalTokensConsumed === 0
        ? 0
        : Number(
            (
              (fulfillmentMetrics.totalRetryOverheadTokens /
                fulfillmentMetrics.totalTokensConsumed) *
              100
            ).toFixed(2),
          );

    const diagnoses: RetrospectiveMetricDiagnosis[] = [
      new RetrospectiveMetricDiagnosis({
        metricName: '(a) 缓存命中率 (L1 精确 + L2 语义意图缓存)',
        observedValue: `${cacheMetrics.cacheHitRatePercent}% (命中 ${cacheMetrics.totalHits}/${cacheMetrics.totalLookups} 次，节省 ${cacheMetrics.savedTokensTotal} Tokens)`,
        targetThreshold: `>= ${this.thresholds.minCacheHitRatePercent}%`,
        passedSla: cacheMetrics.cacheHitRatePercent >= this.thresholds.minCacheHitRatePercent,
        optimizationAction:
          cacheMetrics.cacheHitRatePercent >= this.thresholds.minCacheHitRatePercent
            ? '缓存命中率达标；持续将已批准快照回填至 L2 语义指纹池。'
            : '缓存命中率偏低；建议放宽 L2 语义意图指纹归一化规则，并将高频公共组件规范预热入库。',
      }),
      new RetrospectiveMetricDiagnosis({
        metricName: '(b-1) 意图识别到最终执行结果达成率',
        observedValue: `${fulfillmentMetrics.fulfillmentRatePercent}% (首次直通率 ${fulfillmentMetrics.firstPassSuccessRatePercent}%)`,
        targetThreshold: `>= ${this.thresholds.minIntentFulfillmentRatePercent}%`,
        passedSla:
          fulfillmentMetrics.fulfillmentRatePercent >=
          this.thresholds.minIntentFulfillmentRatePercent,
        optimizationAction:
          fulfillmentMetrics.fulfillmentRatePercent >=
          this.thresholds.minIntentFulfillmentRatePercent
            ? '意图识别与契约交付达成率健康。'
            : '部分阶段未能达成契约或触发熔断；建议将失败案例写入负向经验飞轮 (Rejected History RAG) 强化前置约束。',
      }),
      new RetrospectiveMetricDiagnosis({
        metricName: '(b-2) 平均重试次数与重试分布',
        observedValue: `${fulfillmentMetrics.averageRetriesPerInvocation} 次/调用 (0次:${fulfillmentMetrics.retryDistribution.zeroRetries}, 1次:${fulfillmentMetrics.retryDistribution.oneRetry}, >=2次:${fulfillmentMetrics.retryDistribution.twoOrMoreRetries})`,
        targetThreshold: `<= ${this.thresholds.maxAverageRetriesPerInvocation} 次/调用`,
        passedSla:
          fulfillmentMetrics.averageRetriesPerInvocation <=
          this.thresholds.maxAverageRetriesPerInvocation,
        optimizationAction:
          fulfillmentMetrics.averageRetriesPerInvocation <=
          this.thresholds.maxAverageRetriesPerInvocation
            ? '自愈重试次数处于合理成本区间。'
            : '重试偏多推高 Token 成本；建议检查输出 JSON Schema 约束提示词，或升级对应节点的模型路由层级。',
      }),
      new RetrospectiveMetricDiagnosis({
        metricName: '(c) 成本控制效能 (重试损耗占比 & 缓存节流比)',
        observedValue: `缓存节流比 ${costSavingsRatioPercent}% | 重试损耗占比 ${retryTokenWasteRatioPercent}% | 净支出 $${fulfillmentMetrics.totalCostUsd}`,
        targetThreshold: `重试损耗 <= ${this.thresholds.maxRetryTokenOverheadRatioPercent}%`,
        passedSla: retryTokenWasteRatioPercent <= this.thresholds.maxRetryTokenOverheadRatioPercent,
        optimizationAction:
          retryTokenWasteRatioPercent <= this.thresholds.maxRetryTokenOverheadRatioPercent
            ? 'Token 预算与成本控制表现优异。'
            : '重试消耗过多无效 Token，建议下调单节点 Max Execution Retries 或开启增量修复模式。',
      }),
    ];

    return new RetrospectiveEvaluationReport({
      reportId: `RETRO-${Date.now()}`,
      cacheMetrics,
      fulfillmentMetrics,
      costSavingsRatioPercent,
      retryTokenWasteRatioPercent,
      diagnoses,
    });
  }
}
