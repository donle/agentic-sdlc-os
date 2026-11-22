/**
 * @file contracts.ts
 * @description 各阶段职能 Agent 的结构化输入与输出契约定义（Contract-First Design）。
 * 严禁 Agent 之间仅通过非结构化聊天文本传递核心需求，所有阶段交付物必须实现 IDomainArtifactContract 接口。
 */

import { AgentRole, BusinessRiskLevel, WorkflowStageId } from './enums.ts';

const PLACEHOLDER_WORD_PATTERN = /(?:\bTBD\b|\bTODO\b|待定|后续补充|暂不实现)/i;
const ELLIPSIS_PATTERN = /(?:\.{3,}|…)/;

/**
 * 确定性占位符检测（Pillar 1 / DS-2）：禁止未完成占位的交付物绕过门禁
 */
export function containsPlaceholderText(text: string, allowEllipsis = false): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  if (PLACEHOLDER_WORD_PATTERN.test(normalized)) {
    return true;
  }
  return !allowEllipsis && ELLIPSIS_PATTERN.test(normalized);
}

/**
 * 所有阶段结构化交付物的顶层契约接口
 */
export interface IDomainArtifactContract {
  readonly contractType: string;
  readonly stageId: WorkflowStageId;
  readonly producerRole: AgentRole;
  readonly schemaVersion: string;
  readonly summary: string;
  readonly coreRequirementIds: ReadonlyArray<string>;
  validateContractIntegrity(): ContractValidationResult;
}

/**
 * 契约完整性校验结果值对象 (Value Object)
 */
export class ContractValidationResult {
  private readonly isValidFlag: boolean;
  private readonly violations: ReadonlyArray<string>;

  public constructor(isValid: boolean, violations: ReadonlyArray<string> = []) {
    this.isValidFlag = isValid;
    this.violations = [...violations];
  }

  public isValid(): boolean {
    return this.isValidFlag;
  }

  public getViolations(): ReadonlyArray<string> {
    return this.violations;
  }
}

/**
 * Stage 0: 业务提案输入契约类
 * 注意：演示用的场景开关（协商熔断/范围缩减/瞬态重试）已迁出至 ScenarioHints（运行元数据），
 * 本契约保持纯业务字段，可安全持久化与审计。
 */
export class ProjectProposalContract implements IDomainArtifactContract {
  public readonly contractType = 'PROJECT_PROPOSAL_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_0_INITIATION;
  public readonly producerRole = AgentRole.SUPERVISOR;
  public readonly schemaVersion = '1.0.0';
  public readonly proposalId: string;
  public readonly title: string;
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly requirementDescriptions: Readonly<Record<string, string>>;
  public readonly involvesDatabaseMigration: boolean;
  public readonly involvesPermissionOrPayment: boolean;

  public constructor(params: {
    proposalId: string;
    title: string;
    summary: string;
    requirements: Record<string, string>;
    involvesDatabaseMigration?: boolean;
    involvesPermissionOrPayment?: boolean;
  }) {
    this.proposalId = params.proposalId;
    this.title = params.title;
    this.summary = params.summary;
    this.requirementDescriptions = { ...params.requirements };
    this.coreRequirementIds = Object.keys(params.requirements);
    this.involvesDatabaseMigration = Boolean(params.involvesDatabaseMigration);
    this.involvesPermissionOrPayment = Boolean(params.involvesPermissionOrPayment);
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (!this.title.trim()) {
      errors.push('提案标题不能为空');
    }
    if (this.coreRequirementIds.length === 0) {
      errors.push('提案必须包含至少一项核心需求条目');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }

  public toSerializableRecord(): Record<string, unknown> {
    return {
      proposalId: this.proposalId,
      title: this.title,
      summary: this.summary,
      requirementDescriptions: { ...this.requirementDescriptions },
      coreRequirementIds: [...this.coreRequirementIds],
      involvesDatabaseMigration: this.involvesDatabaseMigration,
      involvesPermissionOrPayment: this.involvesPermissionOrPayment,
    };
  }

  public static fromSerializableRecord(raw: Record<string, unknown>): ProjectProposalContract {
    return new ProjectProposalContract({
      proposalId: String(raw.proposalId ?? ''),
      title: String(raw.title ?? ''),
      summary: String(raw.summary ?? ''),
      requirements: (raw.requirementDescriptions as Record<string, string> | undefined) ?? {},
      involvesDatabaseMigration: Boolean(raw.involvesDatabaseMigration),
      involvesPermissionOrPayment: Boolean(raw.involvesPermissionOrPayment),
    });
  }
}

/**
 * Stage 1: PM Agent 输出的 PRD 与前置埋点规划契约类
 */
export class PrdArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'PRD_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_1_PM;
  public readonly producerRole = AgentRole.PRODUCT_MANAGER;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly userStories: ReadonlyArray<{
    readonly reqId: string;
    readonly story: string;
    readonly acceptanceCriteria: ReadonlyArray<string>;
  }>;
  public readonly trackingPlanEvents: ReadonlyArray<{
    readonly eventName: string;
    readonly triggerCondition: string;
    readonly properties: ReadonlyArray<string>;
  }>;
  public readonly nonFunctionalConstraints: ReadonlyArray<string>;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    userStories: ReadonlyArray<{
      reqId: string;
      story: string;
      acceptanceCriteria: ReadonlyArray<string>;
    }>;
    trackingPlanEvents: ReadonlyArray<{
      eventName: string;
      triggerCondition: string;
      properties: ReadonlyArray<string>;
    }>;
    nonFunctionalConstraints: ReadonlyArray<string>;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.userStories = [...params.userStories];
    this.trackingPlanEvents = [...params.trackingPlanEvents];
    this.nonFunctionalConstraints = [...params.nonFunctionalConstraints];
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (this.userStories.length === 0) {
      errors.push('PRD 必须包含结构化 User Stories');
    }
    if (this.trackingPlanEvents.length === 0) {
      errors.push('PRD 阶段必须包含前置数据埋点规划 (Tracking Plan)');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}

/**
 * Stage 2: PD Agent 输出的 UI/UX 设计契约类
 */
export class UiDesignArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'UI_DESIGN_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_2_PD;
  public readonly producerRole = AgentRole.PRODUCT_DESIGNER;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly componentMappings: ReadonlyArray<{
    readonly reqId: string;
    readonly designSystemComponent: string;
    readonly interactionStates: ReadonlyArray<string>;
  }>;
  public readonly accessibilityChecklist: ReadonlyArray<string>;
  public readonly designChallengeNote: string | null;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    componentMappings: ReadonlyArray<{
      reqId: string;
      designSystemComponent: string;
      interactionStates: ReadonlyArray<string>;
    }>;
    accessibilityChecklist: ReadonlyArray<string>;
    designChallengeNote?: string | null;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.componentMappings = [...params.componentMappings];
    this.accessibilityChecklist = [...params.accessibilityChecklist];
    this.designChallengeNote = params.designChallengeNote ?? null;
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (this.componentMappings.length === 0) {
      errors.push('UI 设计契约必须包含组件库映射关系');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}

/**
 * Stage 3a: Tech Lead Agent 输出的技术架构与数据契约类
 */
export class TechSpecArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'TECH_SPEC_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_3A_TECH_SPEC;
  public readonly producerRole = AgentRole.TECH_LEAD;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly apiContracts: ReadonlyArray<{
    readonly method: string;
    readonly endpoint: string;
    readonly requestSchema: string;
    readonly responseSchema: string;
  }>;
  public readonly databaseDdlStatements: ReadonlyArray<string>;
  public readonly declaredRiskLevel: BusinessRiskLevel;
  public readonly architecturePatternsUsed: ReadonlyArray<string>;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    apiContracts: ReadonlyArray<{
      method: string;
      endpoint: string;
      requestSchema: string;
      responseSchema: string;
    }>;
    databaseDdlStatements: ReadonlyArray<string>;
    declaredRiskLevel: BusinessRiskLevel;
    architecturePatternsUsed: ReadonlyArray<string>;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.apiContracts = [...params.apiContracts];
    this.databaseDdlStatements = [...params.databaseDdlStatements];
    this.declaredRiskLevel = params.declaredRiskLevel;
    this.architecturePatternsUsed = [...params.architecturePatternsUsed];
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (this.apiContracts.length === 0) {
      errors.push('技术方案契约必须定义至少一个 API 接口规范');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}

/**
 * Stage 3b: Engineer Agent 输出的隔离沙箱代码实现契约类
 */
export class CodeImplementationArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'CODE_IMPLEMENTATION_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_3B_ENGINEER;
  public readonly producerRole = AgentRole.SOFTWARE_ENGINEER;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly gitWorktreeBranch: string;
  public readonly modifiedFiles: ReadonlyArray<{
    readonly filePath: string;
    readonly className: string;
    readonly designPattern: string;
    readonly linesChanged: number;
  }>;
  public readonly selfTestPassed: boolean;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    gitWorktreeBranch: string;
    modifiedFiles: ReadonlyArray<{
      filePath: string;
      className: string;
      designPattern: string;
      linesChanged: number;
    }>;
    selfTestPassed: boolean;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.gitWorktreeBranch = params.gitWorktreeBranch;
    this.modifiedFiles = [...params.modifiedFiles];
    this.selfTestPassed = params.selfTestPassed;
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (!this.gitWorktreeBranch.trim()) {
      errors.push('工程实现必须绑定隔离的 Git Worktree 分支');
    }
    if (this.modifiedFiles.length === 0) {
      errors.push('工程实现必须包含结构化代码文件变更记录');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}

/**
 * Stage 4: QA Agent 输出的自动化测试与质量门禁报告契约类
 */
export class QaVerificationArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'QA_VERIFICATION_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_4_QA;
  public readonly producerRole = AgentRole.QUALITY_ASSURANCE;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly testSuitesExecuted: ReadonlyArray<{
    readonly suiteName: string;
    readonly totalCases: number;
    readonly passedCases: number;
    readonly coveragePercent: number;
  }>;
  public readonly securityIssuesFound: number;
  public readonly allAcceptanceCriteriaMet: boolean;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    testSuitesExecuted: ReadonlyArray<{
      suiteName: string;
      totalCases: number;
      passedCases: number;
      coveragePercent: number;
    }>;
    securityIssuesFound: number;
    allAcceptanceCriteriaMet: boolean;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.testSuitesExecuted = [...params.testSuitesExecuted];
    this.securityIssuesFound = params.securityIssuesFound;
    this.allAcceptanceCriteriaMet = params.allAcceptanceCriteriaMet;
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (this.testSuitesExecuted.length === 0) {
      errors.push('QA 验证报告必须包含自动化测试套件执行结果');
    }
    const totalCases = this.testSuitesExecuted.reduce((acc, s) => acc + s.totalCases, 0);
    const passedCases = this.testSuitesExecuted.reduce((acc, s) => acc + s.passedCases, 0);
    if (this.allAcceptanceCriteriaMet) {
      if (totalCases === 0 || passedCases < totalCases) {
        errors.push(
          `QA 契约完整性违规：测试套件存在未通过或零执行用例 (${passedCases}/${totalCases})，allAcceptanceCriteriaMet 不得谎报为 true`,
        );
      }
      if (this.securityIssuesFound > 0) {
        errors.push(
          `QA 契约完整性违规：存在 ${this.securityIssuesFound} 个未清零的高危安全漏洞，allAcceptanceCriteriaMet 不得谎报为 true`,
        );
      }
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}

/**
 * Stage 5: DA Agent 输出的埋点核验与业务效果分析契约类
 */
export class DataAnalysisArtifactContract implements IDomainArtifactContract {
  public readonly contractType = 'DATA_ANALYSIS_ARTIFACT_CONTRACT';
  public readonly stageId = WorkflowStageId.STAGE_5_DA;
  public readonly producerRole = AgentRole.DATA_ANALYST;
  public readonly schemaVersion = '1.0.0';
  public readonly summary: string;
  public readonly coreRequirementIds: ReadonlyArray<string>;
  public readonly verifiedTrackingEvents: ReadonlyArray<string>;
  public readonly projectedMetrics: ReadonlyArray<{
    readonly metricName: string;
    readonly baselineValue: string;
    readonly targetValue: string;
  }>;

  public constructor(params: {
    summary: string;
    coreRequirementIds: ReadonlyArray<string>;
    verifiedTrackingEvents: ReadonlyArray<string>;
    projectedMetrics: ReadonlyArray<{
      metricName: string;
      baselineValue: string;
      targetValue: string;
    }>;
  }) {
    this.summary = params.summary;
    this.coreRequirementIds = [...params.coreRequirementIds];
    this.verifiedTrackingEvents = [...params.verifiedTrackingEvents];
    this.projectedMetrics = [...params.projectedMetrics];
  }

  public validateContractIntegrity(): ContractValidationResult {
    const errors: string[] = [];
    if (this.verifiedTrackingEvents.length === 0) {
      errors.push('DA 报告必须核验 Stage 1 定义的埋点事件');
    }
    return new ContractValidationResult(errors.length === 0, errors);
  }
}
