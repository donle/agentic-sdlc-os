/**
 * @file perspective.ts
 * @description §12 视角分级信息模型状态机（L1 摘要 / L2 评审 / L3 全局管理），完全基于后端 rbacContext 推导。
 */

import type { RbacContextDto, StageAccessEvaluationDto } from '../types.ts';

export type PerspectiveLevel = 'L3' | 'L2_L1';
export type StageDensity = 'L2' | 'L1';

export interface PerspectiveState {
  readonly level: PerspectiveLevel;
  readonly isAdmin: boolean;
  readonly ownedStageIds: ReadonlyArray<string>;
  readonly badgeText: string;
  readonly summaryText: string;
  readonly getStageDensity: (stageId: string) => StageDensity;
  readonly isStageAdminOverride: (stageId: string) => boolean;
  readonly canApproveStage: (stageId: string) => boolean;
  readonly getDenialReason: (stageId: string) => string | null;
}

export function derivePerspective(rbacContext?: RbacContextDto): PerspectiveState {
  const isAdmin = Boolean(rbacContext?.currentUser.isProjectAdmin);
  const ownedStageIds = rbacContext?.currentUser.ownedStageIds ?? [];
  const matrix: Readonly<Record<string, StageAccessEvaluationDto>> =
    rbacContext?.stageAccessMatrix ?? {};
  const level: PerspectiveLevel = isAdmin ? 'L3' : 'L2_L1';

  const getStageDensity = (stageId: string): StageDensity => {
    if (isAdmin) {
      return 'L2';
    }
    const access = matrix[stageId];
    if (access) {
      return access.isDirectDomainOwner || access.canApproveOrArbitrate ? 'L2' : 'L1';
    }
    return ownedStageIds.includes(stageId) ? 'L2' : 'L1';
  };

  const isStageAdminOverride = (stageId: string): boolean => {
    return Boolean(matrix[stageId]?.isAdminOverride);
  };

  const canApproveStage = (stageId: string): boolean => {
    return Boolean(matrix[stageId]?.canApproveOrArbitrate);
  };

  const getDenialReason = (stageId: string): string | null => {
    const access = matrix[stageId];
    if (access?.denialReason) {
      return access.denialReason;
    }
    if (getStageDensity(stageId) === 'L1') {
      return '仅该步骤对应领域的负责人与项目管理员可查看完整交付物与执行签核';
    }
    return null;
  };

  return {
    level,
    isAdmin,
    ownedStageIds,
    badgeText: isAdmin
      ? 'L3 全局管理视角 · 全阶段展开'
      : `L2 负责 ${ownedStageIds.length} 个阶段 · L1 其余仅结论摘要`,
    summaryText: isAdmin
      ? '全局 KPI / 分支演化 / 跨阶段签核与规则配置全量解锁'
      : '你负责的阶段完整展示交付物与推演证据；他人阶段收敛为结论摘要',
    getStageDensity,
    isStageAdminOverride,
    canApproveStage,
    getDenialReason,
  };
}
