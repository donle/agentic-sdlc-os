/**
 * @file IntentFulfillmentTracker.ts
 * @description 意图识别到最终执行结果达成率 & 重试次数追踪器。
 *
 * 复盘核心指标 (b)：
 * 1. 意图识别到最终执行结果的达成率 (Intent-to-Execution Fulfillment Rate)
 * 2. 一次通过率 (First-Try Fulfillment Rate)
 * 3. 平均重试次数与重试分布 (Retry Count & Retry Histogram)
 * 4. 成本控制效能分析 (实际消耗 Tokens vs 缓存节省 Tokens vs 重试浪费 Tokens)
 */

import { AgentRole, IntentFulfillmentStatus, WorkflowStageId } from '../domain/enums.ts';

/**
 * 单次 Agent 意图识别与执行追踪记录实体
 */
export class IntentExecutionTraceRecord {
  public static fromJSON(raw: Record<string, unknown>): IntentExecutionTraceRecord {
    const retryReasons = Array.isArray(raw.retryReasons)
      ? raw.retryReasons.map((item) => String(item))
      : [];
    return new IntentExecutionTraceRecord({
      traceId: String(raw.traceId ?? ''),
      runId: String(raw.runId ?? ''),
      branchId: String(raw.branchId ?? ''),
      stageId: String(raw.stageId ?? WorkflowStageId.STAGE_1_PM) as WorkflowStageId,
      agentRole: String(raw.agentRole ?? AgentRole.PRODUCT_MANAGER) as AgentRole,
      recognizedIntentCode: String(raw.recognizedIntentCode ?? ''),
      intentConfidence: Number(raw.intentConfidence ?? 0),
      retryCount: Number(raw.retryCount ?? 0),
      retryReasons,
      cacheHit: Boolean(raw.cacheHit),
      fulfillmentStatus: String(
        raw.fulfillmentStatus ?? IntentFulfillmentStatus.FULFILLED_ON_FIRST_TRY,
      ) as IntentFulfillmentStatus,
      tokensConsumed: Number(raw.tokensConsumed ?? 0),
      retryOverheadTokens: Number(raw.retryOverheadTokens ?? 0),
      costUsd: Number(raw.costUsd ?? 0),
      timestampIso: raw.timestampIso ? String(raw.timestampIso) : undefined,
    });
  }

  public readonly traceId: string;
  public readonly runId: string;
  public readonly branchId: string;
  public readonly stageId: WorkflowStageId;
  public readonly agentRole: AgentRole;
  public readonly recognizedIntentCode: string;
  public readonly intentConfidence: number;
  public readonly retryCount: number;
  public readonly retryReasons: ReadonlyArray<string>;
  public readonly cacheHit: boolean;
  public readonly fulfillmentStatus: IntentFulfillmentStatus;
  public readonly tokensConsumed: number;
  public readonly retryOverheadTokens: number;
  public readonly costUsd: number;
  public readonly timestampIso: string;

  public constructor(params: {
    traceId: string;
    runId: string;
    branchId: string;
    stageId: WorkflowStageId;
    agentRole: AgentRole;
    recognizedIntentCode: string;
    intentConfidence: number;
    retryCount: number;
    retryReasons: ReadonlyArray<string>;
    cacheHit: boolean;
    fulfillmentStatus: IntentFulfillmentStatus;
    tokensConsumed: number;
    retryOverheadTokens: number;
    costUsd: number;
    timestampIso?: string;
  }) {
    this.traceId = params.traceId;
    this.runId = params.runId;
    this.branchId = params.branchId;
    this.stageId = params.stageId;
    this.agentRole = params.agentRole;
    this.recognizedIntentCode = params.recognizedIntentCode;
    this.intentConfidence = params.intentConfidence;
    this.retryCount = params.retryCount;
    this.retryReasons = [...params.retryReasons];
    this.cacheHit = params.cacheHit;
    this.fulfillmentStatus = params.fulfillmentStatus;
    this.tokensConsumed = params.tokensConsumed;
    this.retryOverheadTokens = params.retryOverheadTokens;
    this.costUsd = params.costUsd;
    this.timestampIso = params.timestampIso ?? new Date().toISOString();
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      traceId: this.traceId,
      runId: this.runId,
      branchId: this.branchId,
      stageId: this.stageId,
      agentRole: this.agentRole,
      recognizedIntentCode: this.recognizedIntentCode,
      intentConfidence: this.intentConfidence,
      retryCount: this.retryCount,
      retryReasons: [...this.retryReasons],
      cacheHit: this.cacheHit,
      fulfillmentStatus: this.fulfillmentStatus,
      tokensConsumed: this.tokensConsumed,
      retryOverheadTokens: this.retryOverheadTokens,
      costUsd: this.costUsd,
      timestampIso: this.timestampIso,
    };
  }

  public isFulfilled(): boolean {
    return (
      this.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_ON_FIRST_TRY ||
      this.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_AFTER_RETRY ||
      this.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_VIA_CACHE
    );
  }
}

/**
 * 意图达成率与重试指标聚合快照值对象
 */
export class IntentFulfillmentMetricsSnapshot {
  public readonly totalInvocations: number;
  public readonly fulfilledTotalCount: number;
  public readonly fulfilledFirstTryCount: number;
  public readonly fulfilledAfterRetryCount: number;
  public readonly fulfilledViaCacheCount: number;
  public readonly escalatedToHumanCount: number;
  public readonly failedContractCount: number;
  public readonly fulfillmentRatePercent: number;
  public readonly firstPassSuccessRatePercent: number;
  public readonly totalRetryCount: number;
  public readonly averageRetriesPerInvocation: number;
  public readonly retryDistribution: Readonly<{
    zeroRetries: number;
    oneRetry: number;
    twoOrMoreRetries: number;
  }>;
  public readonly totalTokensConsumed: number;
  public readonly totalRetryOverheadTokens: number;
  public readonly totalCostUsd: number;

  public constructor(traces: ReadonlyArray<IntentExecutionTraceRecord>) {
    this.totalInvocations = traces.length;
    this.fulfilledFirstTryCount = traces.filter(
      (t) => t.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_ON_FIRST_TRY,
    ).length;
    this.fulfilledAfterRetryCount = traces.filter(
      (t) => t.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_AFTER_RETRY,
    ).length;
    this.fulfilledViaCacheCount = traces.filter(
      (t) => t.fulfillmentStatus === IntentFulfillmentStatus.FULFILLED_VIA_CACHE,
    ).length;
    this.escalatedToHumanCount = traces.filter(
      (t) => t.fulfillmentStatus === IntentFulfillmentStatus.ESCALATED_TO_HUMAN,
    ).length;
    this.failedContractCount = traces.filter(
      (t) => t.fulfillmentStatus === IntentFulfillmentStatus.FAILED_CONTRACT,
    ).length;

    this.fulfilledTotalCount =
      this.fulfilledFirstTryCount + this.fulfilledAfterRetryCount + this.fulfilledViaCacheCount;

    this.fulfillmentRatePercent =
      this.totalInvocations === 0
        ? 0
        : Number(((this.fulfilledTotalCount / this.totalInvocations) * 100).toFixed(2));

    this.firstPassSuccessRatePercent =
      this.totalInvocations === 0
        ? 0
        : Number(
            (
              ((this.fulfilledFirstTryCount + this.fulfilledViaCacheCount) /
                this.totalInvocations) *
              100
            ).toFixed(2),
          );

    this.totalRetryCount = traces.reduce((acc, item) => acc + item.retryCount, 0);
    this.averageRetriesPerInvocation =
      this.totalInvocations === 0
        ? 0
        : Number((this.totalRetryCount / this.totalInvocations).toFixed(2));

    this.retryDistribution = {
      zeroRetries: traces.filter((t) => t.retryCount === 0).length,
      oneRetry: traces.filter((t) => t.retryCount === 1).length,
      twoOrMoreRetries: traces.filter((t) => t.retryCount >= 2).length,
    };

    this.totalTokensConsumed = traces.reduce((acc, item) => acc + item.tokensConsumed, 0);
    this.totalRetryOverheadTokens = traces.reduce((acc, item) => acc + item.retryOverheadTokens, 0);
    this.totalCostUsd = Number(traces.reduce((acc, item) => acc + item.costUsd, 0).toFixed(6));
  }
}

export class IntentFulfillmentTracker {
  private readonly traces: IntentExecutionTraceRecord[];

  public constructor() {
    this.traces = [];
  }

  public recordTrace(trace: IntentExecutionTraceRecord): void {
    this.traces.push(trace);
  }

  /** P1-2：从持久化快照幂等恢复执行追踪记录 */
  public restoreTrace(trace: IntentExecutionTraceRecord): void {
    if (!trace.traceId || this.traces.some((t) => t.traceId === trace.traceId)) {
      return;
    }
    this.traces.push(trace);
  }

  public getTraces(runId?: string): ReadonlyArray<IntentExecutionTraceRecord> {
    if (!runId) {
      return [...this.traces];
    }
    return this.traces.filter((item) => item.runId === runId);
  }

  public getMetricsSnapshot(runId?: string): IntentFulfillmentMetricsSnapshot {
    const targetTraces = this.getTraces(runId);
    return new IntentFulfillmentMetricsSnapshot(targetTraces);
  }
}
