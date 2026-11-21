/**
 * @file WorkbenchApiClient.ts
 * @description 企业级多角色前端 REST API 与 SSE (Server-Sent Events) 客户端，自动携带当前登录角色身份 (`X-Actor-Id`)。
 */

import type { DashboardStateDto, RagQueryMatchDto } from './types.ts';

interface ApiResponseEnvelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

export class WorkbenchApiClient {
  private activeActorUserId = 'user-admin-01';
  private activeEventSource: EventSource | null = null;

  public getActiveActorUserId(): string {
    return this.activeActorUserId;
  }

  public setActiveActorUserId(userId: string): void {
    this.activeActorUserId = userId;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Actor-Id': this.activeActorUserId,
    };
  }

  public async fetchDashboardState(runId?: string): Promise<DashboardStateDto> {
    const query = new URLSearchParams({ actorId: this.activeActorUserId });
    if (runId) {
      query.set('runId', runId);
    }
    const res = await fetch(`/api/state?${query.toString()}`, {
      headers: this.buildHeaders(),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '加载状态失败');
    }
    return json.data;
  }

  public async selectRun(runId: string): Promise<DashboardStateDto> {
    const res = await fetch('/api/runs/select', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ runId, actorUserId: this.activeActorUserId }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '切换项目运行实例失败');
    }
    return json.data;
  }

  public async launchPresetProposal(preset: string): Promise<DashboardStateDto> {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ preset, actorUserId: this.activeActorUserId }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '启动提案失败');
    }
    return json.data;
  }

  public async createCustomProposal(params: {
    title: string;
    summary: string;
    requirements: Record<string, string>;
    involvesDatabaseMigration: boolean;
    involvesPermissionOrPayment: boolean;
    simulateNegotiationConflict: boolean;
  }): Promise<DashboardStateDto> {
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        preset: 'CUSTOM',
        actorUserId: this.activeActorUserId,
        ...params,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '创建自定义研发提案失败');
    }
    return json.data;
  }

  public async switchWorkflowTemplate(templateFileName: string): Promise<DashboardStateDto> {
    const res = await fetch('/api/workflows/template', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        templateFileName,
        actorUserId: this.activeActorUserId,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '切换工作流 YAML 模板失败');
    }
    return json.data;
  }

  public async submitGateDecision(
    snapshotId: string,
    verdict: string,
    comment: string,
  ): Promise<DashboardStateDto> {
    const res = await fetch('/api/decisions', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        snapshotId,
        verdict,
        actorUserId: this.activeActorUserId,
        comment,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '提交审核决定失败');
    }
    return json.data;
  }

  public async postTeamComment(stageId: string, content: string): Promise<DashboardStateDto> {
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        stageId,
        content,
        actorUserId: this.activeActorUserId,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '发表团队评论失败');
    }
    return json.data;
  }

  public async sendSupervisorRollback(
    targetStageId: string,
    dialogueInstruction: string,
  ): Promise<DashboardStateDto> {
    const res = await fetch('/api/supervisor/rollback', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        targetStageId: targetStageId || undefined,
        dialogueInstruction,
        actorUserId: this.activeActorUserId,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '回退执行失败');
    }
    return json.data;
  }

  public async fetchSandboxFileContent(relativePath: string): Promise<{
    readonly relativePath: string;
    readonly branchId: string;
    readonly content: string;
  }> {
    const query = new URLSearchParams({
      path: relativePath,
      actorId: this.activeActorUserId,
    });
    const res = await fetch(`/api/sandbox/file?${query.toString()}`, {
      headers: this.buildHeaders(),
    });
    const json = (await res.json()) as ApiResponseEnvelope<{
      relativePath: string;
      branchId: string;
      content: string;
    }>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '读取沙箱源码文件失败');
    }
    return json.data;
  }

  public async triggerLiveSandboxVerification(): Promise<{
    readonly executionLog: string;
    readonly dashboardState: DashboardStateDto;
  }> {
    const res = await fetch('/api/sandbox/verify', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ actorUserId: this.activeActorUserId }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<{
      verification: { executionLog: string };
      dashboardState: DashboardStateDto;
    }>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '执行沙箱自动化测试失败');
    }
    return {
      executionLog: json.data.verification.executionLog,
      dashboardState: json.data.dashboardState,
    };
  }

  public async queryNegativeExperienceRag(
    stageId: string,
    queryText: string,
  ): Promise<ReadonlyArray<RagQueryMatchDto>> {
    const res = await fetch('/api/rag/query', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ stageId, queryText }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<{
      matches: ReadonlyArray<RagQueryMatchDto>;
    }>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '检索负向经验向量库失败');
    }
    return json.data.matches;
  }

  public async ingestNegativeExperienceLesson(
    stageId: string,
    lessonText: string,
  ): Promise<DashboardStateDto> {
    const res = await fetch('/api/rag/ingest', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        stageId,
        lessonText,
        actorUserId: this.activeActorUserId,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '录入避坑经验失败');
    }
    return json.data;
  }

  public async updateAdminGovernanceConfig(params: {
    maxNegotiationTurns: number;
    highRiskScoreThreshold: number;
    allowSpecialistCrossStageRollback: boolean;
  }): Promise<DashboardStateDto> {
    const res = await fetch('/api/admin/governance', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        actorUserId: this.activeActorUserId,
        ...params,
      }),
    });
    const json = (await res.json()) as ApiResponseEnvelope<DashboardStateDto>;
    if (!json.ok || !json.data) {
      throw new Error(json.error ?? '更新管理员治理策略失败');
    }
    return json.data;
  }

  public subscribeRealtimeEventStream(
    onStateUpdate: (state: DashboardStateDto) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): EventSource | null {
    if (typeof EventSource === 'undefined') {
      return null;
    }
    if (this.activeEventSource) {
      this.activeEventSource.close();
    }
    const source = new EventSource(
      `/api/events/stream?actorId=${encodeURIComponent(this.activeActorUserId)}`,
    );
    this.activeEventSource = source;

    source.addEventListener('open', () => {
      if (onConnectionChange) {
        onConnectionChange(true);
      }
    });
    source.addEventListener('state_updated', (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as DashboardStateDto;
        onStateUpdate(parsed);
      } catch {
        // Ignore malformed SSE payload
      }
    });
    source.addEventListener('error', () => {
      if (onConnectionChange) {
        onConnectionChange(false);
      }
    });
    return source;
  }
}
