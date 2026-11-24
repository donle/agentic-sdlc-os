/**
 * @file DagWorkflowStateEngine.ts
 * @description 状态模式与备忘录模式 (State & Memento Pattern) 实现的 DAG 有向无环图工作流状态机引擎。
 *
 * 核心能力：
 * 1. 管理从 `STAGE_1_PM` 到 `STAGE_5_DA` 的有序阶段流转；
 * 2. 维护每个分支（`branch-main`, `branch-v2`, ...）的不可变快照链 (`StageSnapshotMemento`)；
 * 3. 实现无脏数据污染的 **Fork 分叉回退 (`forkBranchFromStage`)**：
 *    当用户通过总管 Agent 要求回退到某一历史阶段重做时，绝不覆盖或删除已有历史，
 *    而是将原分支上目标阶段及下游快照全部标记为 `SUPERSEDED（已废弃）`，
 *    同时从目标阶段的上游父节点分叉出新分支，继承上游已批准的干净上下文重新执行。
 */

import { type IDomainArtifactContract, ProjectProposalContract } from '../domain/contracts.ts';
import { SnapshotLifecycleState, WorkflowStageId } from '../domain/enums.ts';
import { StageSnapshotMemento } from '../domain/models.ts';
import type { ScenarioHints } from '../domain/scenario.ts';

export const STANDARD_STAGE_PIPELINE: ReadonlyArray<WorkflowStageId> = [
  WorkflowStageId.STAGE_1_PM,
  WorkflowStageId.STAGE_2_PD,
  WorkflowStageId.STAGE_3A_TECH_SPEC,
  WorkflowStageId.STAGE_3B_ENGINEER,
  WorkflowStageId.STAGE_4_QA,
  WorkflowStageId.STAGE_5_DA,
];

export type WorkflowRunStatus =
  'RUNNING' | 'PAUSED_AT_HUMAN_GATE' | 'COMPLETED' | 'ABORTED' | 'ABORTED_TOKEN_BUDGET';

export class WorkflowRunState {
  public readonly runId: string;
  public readonly proposal: ProjectProposalContract;
  public readonly initiatorActor: string;
  public readonly workflowTemplateId: string;
  public readonly createdAtIso: string;
  /** 演示/测试场景开关（运行元数据，见 domain/scenario.ts，不属于提案契约） */
  public readonly scenarioHints: ScenarioHints;
  private readonly stagePipeline: ReadonlyArray<WorkflowStageId>;
  private activeBranchId: string;
  private branchCounter: number;
  private currentStageIndex: number;
  private runStatus: WorkflowRunStatus;
  private pendingRollbackDirective: string | null;
  private tokenBudget: number;
  private tokensUsedTotal = 0;
  private readonly allSnapshots: StageSnapshotMemento[];
  private readonly branchHistory: string[];

  public constructor(params: {
    runId: string;
    proposal: ProjectProposalContract;
    initiatorActor: string;
    stagePipeline?: ReadonlyArray<WorkflowStageId>;
    workflowTemplateId?: string;
    createdAtIso?: string;
    scenarioHints?: ScenarioHints;
    tokenBudget?: number;
  }) {
    this.runId = params.runId;
    this.proposal = params.proposal;
    this.initiatorActor = params.initiatorActor;
    this.workflowTemplateId = params.workflowTemplateId ?? 'enterprise_standard_sdlc_v1';
    this.createdAtIso = params.createdAtIso ?? new Date().toISOString();
    this.scenarioHints = params.scenarioHints ?? {};
    this.tokenBudget =
      typeof params.tokenBudget === 'number' && Number.isFinite(params.tokenBudget)
        ? Math.floor(params.tokenBudget)
        : 120000;
    this.stagePipeline = params.stagePipeline
      ? [...params.stagePipeline]
      : [...STANDARD_STAGE_PIPELINE];
    this.activeBranchId = 'branch-v1-main';
    this.branchCounter = 1;
    this.currentStageIndex = 0;
    this.runStatus = 'RUNNING';
    this.pendingRollbackDirective = null;
    this.allSnapshots = [];
    this.branchHistory = [this.activeBranchId];
  }

  public getStagePipeline(): ReadonlyArray<WorkflowStageId> {
    return [...this.stagePipeline];
  }

  public getActiveBranchId(): string {
    return this.activeBranchId;
  }

  public getBranchCounter(): number {
    return this.branchCounter;
  }

  public getBranches(): ReadonlyArray<string> {
    return [...this.branchHistory];
  }

  public getCurrentStageId(): WorkflowStageId | null {
    if (this.currentStageIndex >= this.stagePipeline.length) {
      return null;
    }
    return this.stagePipeline[this.currentStageIndex];
  }

  public getCurrentStageIndex(): number {
    return this.currentStageIndex;
  }

  public getStatus(): WorkflowRunStatus {
    return this.runStatus;
  }

  public setStatus(status: WorkflowRunStatus): void {
    this.runStatus = status;
  }

  public consumePendingRollbackDirective(): string | null {
    const directive = this.pendingRollbackDirective;
    this.pendingRollbackDirective = null;
    return directive;
  }

  /** B3：累计本 run 的真实 Token 消耗（供预算守卫与持久化） */
  public recordTokenUsage(delta: number): void {
    if (delta > 0) {
      this.tokensUsedTotal += delta;
    }
  }

  /** D1：从持久化快照恢复私有字段（仅 StateReconstructor 调用） */
  public restoreInternals(params: {
    activeBranchId: string;
    currentStageIndex: number;
    branchCounter: number;
    branchHistory: string[];
    tokensUsedTotal: number;
    status: string;
    autoRepairCounts?: Record<string, number>;
  }): void {
    this.activeBranchId = params.activeBranchId;
    this.currentStageIndex = params.currentStageIndex;
    this.branchCounter = params.branchCounter;
    this.branchHistory.length = 0;
    for (const b of params.branchHistory) {
      this.branchHistory.push(b);
    }
    this.tokensUsedTotal = params.tokensUsedTotal;
    this.runStatus = params.status as WorkflowRunStatus;
    this.autoRepairCounts.clear();
    if (params.autoRepairCounts) {
      for (const [key, count] of Object.entries(params.autoRepairCounts)) {
        if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
          this.autoRepairCounts.set(key, Math.floor(count));
        }
      }
    }
  }

  public getTokensUsedTotal(): number {
    return this.tokensUsedTotal;
  }

  public getTokenBudget(): number {
    return this.tokenBudget;
  }

  /** AUDIT-10：追加当前运行的 Token 预算上限（供预算熔断恢复 RETRY_STAGE 使用） */
  public increaseTokenBudget(extraTokens: number): number {
    if (Number.isFinite(extraTokens) && extraTokens > 0) {
      this.tokenBudget += Math.floor(extraTokens);
    }
    return this.tokenBudget;
  }

  /** B2：每类自动修复闭环的已尝试次数（防死循环；key 如 QA_TO_ENG） */
  private readonly autoRepairCounts = new Map<string, number>();

  public getAutoRepairCountsRecord(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [key, count] of this.autoRepairCounts.entries()) {
      record[key] = count;
    }
    return record;
  }

  public recordAutoRepair(key: string): number {
    const next = (this.autoRepairCounts.get(key) ?? 0) + 1;
    this.autoRepairCounts.set(key, next);
    return next;
  }

  public getAutoRepairCount(key: string): number {
    return this.autoRepairCounts.get(key) ?? 0;
  }

  public advanceToNextStage(): void {
    this.currentStageIndex += 1;
    if (this.currentStageIndex >= this.stagePipeline.length) {
      this.runStatus = 'COMPLETED';
    } else {
      this.runStatus = 'RUNNING';
    }
  }

  public appendSnapshot(snapshot: StageSnapshotMemento): void {
    this.allSnapshots.push(snapshot);
  }

  public getAllSnapshots(): ReadonlyArray<StageSnapshotMemento> {
    return [...this.allSnapshots];
  }

  public getActiveBranchSnapshots(): ReadonlyArray<StageSnapshotMemento> {
    return this.allSnapshots.filter(
      (s) =>
        s.branchId === this.activeBranchId && s.getState() !== SnapshotLifecycleState.SUPERSEDED,
    );
  }

  public findSnapshotById(snapshotId: string): StageSnapshotMemento | undefined {
    return this.allSnapshots.find((s) => s.snapshotId === snapshotId);
  }

  public getLatestSnapshotOnActiveBranch(): StageSnapshotMemento | null {
    const activeSnaps = this.getActiveBranchSnapshots();
    return activeSnaps.length > 0 ? activeSnaps[activeSnaps.length - 1] : null;
  }

  /**
   * 获取当前活跃分支上所有已批准的上游阶段交付物契约字典
   */
  public getApprovedUpstreamArtifactsMap(): Map<WorkflowStageId, IDomainArtifactContract> {
    const map = new Map<WorkflowStageId, IDomainArtifactContract>();
    for (const snap of this.getActiveBranchSnapshots()) {
      const state = snap.getState();
      if (
        state === SnapshotLifecycleState.APPROVED ||
        state === SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK
      ) {
        map.set(snap.stageId, snap.artifact);
      }
    }
    return map;
  }

  /**
   * 【核心 DAG 分叉回退算法】
   * 回退到指定的 `targetStageId`：
   * 1. 将当前活跃分支上从 `targetStageId` 开始及其下游的所有快照标记为 `SUPERSEDED`；
   * 2. 创建新的分支号（如 `branch-v2-from-STAGE_2_PD`）；
   * 3. 将 `targetStageId` 之前的上游已批准快照克隆挂载到新分支下，保证上游上下文连续；
   * 4. 将执行指针重置回 `targetStageId`，并挂载人类给总管 Agent 的修正指令。
   */
  public forkAndRollbackToStage(
    targetStageId: WorkflowStageId,
    humanDirective: string,
  ): {
    previousBranchId: string;
    newBranchId: string;
    supersededSnapshotIds: string[];
    forkedFromParentSnapshotId: string | null;
  } {
    const targetIndex = this.stagePipeline.indexOf(targetStageId);
    if (targetIndex === -1) {
      throw new Error(`非法回退阶段标识：${targetStageId}`);
    }

    const previousBranchId = this.activeBranchId;
    const currentBranchSnaps = this.allSnapshots.filter((s) => s.branchId === previousBranchId);

    const supersededSnapshotIds: string[] = [];
    const upstreamApprovedToCarryOver: StageSnapshotMemento[] = [];

    for (const snap of currentBranchSnaps) {
      const snapStageIndex = this.stagePipeline.indexOf(snap.stageId);
      if (snapStageIndex >= targetIndex) {
        if (snap.getState() !== SnapshotLifecycleState.SUPERSEDED) {
          snap.transitionState(SnapshotLifecycleState.SUPERSEDED);
          supersededSnapshotIds.push(snap.snapshotId);
        }
      } else if (
        snap.getState() === SnapshotLifecycleState.APPROVED ||
        snap.getState() === SnapshotLifecycleState.AUTO_APPROVED_LOW_RISK
      ) {
        upstreamApprovedToCarryOver.push(snap);
      }
    }

    this.branchCounter += 1;
    const newBranchId = `branch-v${this.branchCounter}-rollback-${targetStageId}`;
    this.activeBranchId = newBranchId;
    this.branchHistory.push(newBranchId);

    // 将目标阶段之前的干净上游快照挂载到新分支，构建完整 DAG 拓扑链
    let lastParentId: string | null = null;
    for (const upstreamSnap of upstreamApprovedToCarryOver) {
      const inheritedSnap: StageSnapshotMemento = new StageSnapshotMemento({
        snapshotId: `${upstreamSnap.snapshotId}-fork-v${this.branchCounter}`,
        runId: this.runId,
        parentSnapshotId: lastParentId,
        branchId: newBranchId,
        stageId: upstreamSnap.stageId,
        agentRole: upstreamSnap.agentRole,
        modelUsed: `${upstreamSnap.modelUsed} (Inherited-Snapshot)`,
        artifact: upstreamSnap.artifact,
        riskScore: upstreamSnap.riskScore,
        riskLevel: upstreamSnap.riskLevel,
        riskReasons: upstreamSnap.riskReasons,
        gateAction: upstreamSnap.gateAction,
        scopeDiffReport: upstreamSnap.scopeDiffReport,
        cacheHit: true,
        retryCount: 0,
        tokensConsumed: 0,
        initialState: upstreamSnap.getState(),
      });
      this.allSnapshots.push(inheritedSnap);
      lastParentId = inheritedSnap.snapshotId;
    }

    this.currentStageIndex = targetIndex;
    this.pendingRollbackDirective = humanDirective;
    this.runStatus = 'RUNNING';

    return {
      previousBranchId,
      newBranchId,
      supersededSnapshotIds,
      forkedFromParentSnapshotId: lastParentId,
    };
  }
}

export class DagWorkflowStateEngine {
  private readonly runs: Map<string, WorkflowRunState>;

  public constructor() {
    this.runs = new Map<string, WorkflowRunState>();
  }

  public createRun(params: {
    runId: string;
    proposal: ProjectProposalContract;
    initiatorActor: string;
    stagePipeline?: ReadonlyArray<WorkflowStageId>;
    workflowTemplateId?: string;
    scenarioHints?: ScenarioHints;
    tokenBudget?: number;
  }): WorkflowRunState {
    const runState = new WorkflowRunState(params);
    this.runs.set(runState.runId, runState);
    return runState;
  }

  public getRunOrThrow(runId: string): WorkflowRunState {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`未找到工作流运行实例 [${runId}]`);
    }
    return run;
  }

  public getAllRuns(): ReadonlyArray<WorkflowRunState> {
    return Array.from(this.runs.values());
  }
}
