/**
 * @file scenario.ts
 * @description 演示/测试场景开关（ScenarioHints）—— 运行实例的元数据，不属于任何领域契约。
 *
 * 设计依据：BACKEND_TODO_DESIGN.md 全局决策 D-4 与 J1：
 * 演示开关（协商熔断/范围缩减/瞬态重试）原本挂在 ProjectProposalContract 上，
 * 会污染持久化与审计数据模型；现迁出为 WorkflowRunState 的运行元数据，
 * 由服务端 preset 端点或测试工厂注入，不随提案契约持久化到业务数据。
 */

export interface ScenarioHints {
  /** 演示：PM↔PD 协商演满最大轮次触发熔断（真实模式下由 LLM 共识判定自然触发） */
  readonly forceNegotiationDeadlock?: boolean;
  /** 演示：PM 产物故意缩减核心需求，触发 Scope Diff 告警 */
  readonly forceScopeReduction?: boolean;
  /** 演示：Stage 1 首次执行注入瞬态契约偏差，验证自愈重试（A2 后也可由 mock transport 注入） */
  readonly forceTransientRetry?: boolean;
  /** B2 演示：QA 验证注入未通过缺陷，驱动 Engineer 修复闭环（自动打回 3b → 超限仲裁） */
  readonly forceQaFailure?: boolean;
}

export function emptyScenarioHints(): ScenarioHints {
  return {};
}

export function hasAnyHint(hints: ScenarioHints | undefined): boolean {
  if (!hints) {
    return false;
  }
  return Boolean(
    hints.forceNegotiationDeadlock || hints.forceScopeReduction || hints.forceTransientRetry,
  );
}
