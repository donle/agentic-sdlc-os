/**
 * @file WorkbenchApiClient.ts
 * @description 企业级多角色前端 REST API 与 SSE (Server-Sent Events) 客户端：
 * 优先使用 F1 HttpOnly 会话 Cookie（`credentials: 'same-origin'`），演示未登录模式向下兼容 `X-Actor-Id`。
 */

import type {
  AuthMeDto,
  AuthUserDto,
  DashboardStateDto,
  EventHistoryPageDto,
  LoginAuditEntryDto,
  ModelBaselineCheckDto,
  NotificationDto,
  RagQueryMatchDto,
  SandboxVerificationSummaryDto,
  WorkflowDomainEventDto,
  WorkflowTemplateItemDto,
} from './types.ts';

interface ApiResponseEnvelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly mustChangePassword?: boolean;
  readonly retryAfterSec?: number;
}

export class ApiHttpError extends Error {
  public readonly statusCode: number;
  public readonly mustChangePassword: boolean;
  public readonly retryAfterSec?: number;

  public constructor(
    statusCode: number,
    message: string,
    extra?: { mustChangePassword?: boolean; retryAfterSec?: number },
  ) {
    super(message);
    this.name = 'ApiHttpError';
    this.statusCode = statusCode;
    this.mustChangePassword = Boolean(extra?.mustChangePassword);
    this.retryAfterSec = extra?.retryAfterSec;
  }
}

export class WorkbenchApiClient {
  private activeActorUserId = 'user-admin-01';
  private activeRunId: string | null = null;
  private activeEventSource: EventSource | null = null;
  private sessionAuthenticated = false;
  private readonly baseUrl: string;
  private readonly cookieJarEnabled: boolean;
  private readonly cookieStore = new Map<string, string>();
  private onUnauthorizedCallback: (() => void) | null = null;
  private onMustChangePasswordCallback: (() => void) | null = null;

  public constructor(options?: { baseUrl?: string; cookieJar?: boolean }) {
    this.baseUrl = options?.baseUrl?.replace(/\/$/, '') ?? '';
    this.cookieJarEnabled = Boolean(options?.cookieJar);
  }

  public setAuthCallbacks(callbacks: {
    onUnauthorized?: (() => void) | null;
    onMustChangePassword?: (() => void) | null;
  }): void {
    if (callbacks.onUnauthorized !== undefined) {
      this.onUnauthorizedCallback = callbacks.onUnauthorized;
    }
    if (callbacks.onMustChangePassword !== undefined) {
      this.onMustChangePasswordCallback = callbacks.onMustChangePassword;
    }
  }

  public isSessionAuthenticated(): boolean {
    return this.sessionAuthenticated;
  }

  public setSessionAuthenticated(authenticated: boolean): void {
    this.sessionAuthenticated = authenticated;
  }

  public getActiveActorUserId(): string {
    return this.activeActorUserId;
  }

  public setActiveActorUserId(userId: string): void {
    this.activeActorUserId = userId;
  }

  public getActiveRunId(): string | null {
    return this.activeRunId;
  }

  public setActiveRunId(runId: string | null): void {
    this.activeRunId = runId;
  }

  private trackActiveRun(state: DashboardStateDto): DashboardStateDto {
    if (state.run?.runId) {
      this.activeRunId = state.run.runId;
    }
    return state;
  }

  private resolveRunIdPayload(runId?: string): { runId?: string } {
    const target = runId ?? this.activeRunId ?? undefined;
    return target ? { runId: target } : {};
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (!this.sessionAuthenticated) {
      headers['X-Actor-Id'] = this.activeActorUserId;
    }
    if (this.cookieJarEnabled && this.cookieStore.size > 0) {
      headers['Cookie'] = [...this.cookieStore.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return headers;
  }

  private captureResponseCookies(res: Response): void {
    if (!this.cookieJarEnabled) {
      return;
    }
    const headersWithSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof headersWithSetCookie.getSetCookie === 'function'
        ? headersWithSetCookie.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];
    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0]?.trim();
      if (!firstPart) {
        continue;
      }
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx <= 0) {
        continue;
      }
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (/Max-Age=0\b/i.test(raw) || val === '') {
        this.cookieStore.delete(name);
      } else {
        this.cookieStore.set(name, val);
      }
    }
  }

  private async requestJson<T>(
    urlPath: string,
    init?: RequestInit & { suppressAuthCallbacks?: boolean },
  ): Promise<T> {
    const { suppressAuthCallbacks, headers: extraHeaders, ...restInit } = init ?? {};
    const mergedHeaders: Record<string, string> = {
      ...this.buildHeaders(),
      ...(extraHeaders as Record<string, string> | undefined),
    };
    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      credentials: 'same-origin',
      ...restInit,
      headers: mergedHeaders,
    });
    this.captureResponseCookies(res);
    const json = (await res.json().catch(() => ({ ok: false }))) as ApiResponseEnvelope<T>;
    if (!res.ok || !json.ok) {
      const retryHeader = res.headers.get('retry-after');
      const retryAfterSec =
        json.retryAfterSec ??
        (retryHeader && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) : undefined);
      if (res.status === 401 && !suppressAuthCallbacks) {
        this.sessionAuthenticated = false;
        this.onUnauthorizedCallback?.();
      }
      if (res.status === 403 && json.mustChangePassword && !suppressAuthCallbacks) {
        this.onMustChangePasswordCallback?.();
      }
      throw new ApiHttpError(res.status, json.error ?? `请求失败 (${res.status})`, {
        mustChangePassword: json.mustChangePassword,
        retryAfterSec,
      });
    }
    return json.data as T;
  }

  // ---- F1 / F2 认证与用户管理 API ----

  public async fetchAuthMe(): Promise<AuthMeDto> {
    const data = await this.requestJson<AuthMeDto>('/api/auth/me', {
      suppressAuthCallbacks: true,
    });
    this.sessionAuthenticated = true;
    this.activeActorUserId = data.user.userId;
    return data;
  }

  public async login(username: string, password: string): Promise<AuthUserDto> {
    const data = await this.requestJson<{ user: AuthUserDto }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      suppressAuthCallbacks: true,
    });
    this.sessionAuthenticated = true;
    this.activeActorUserId = data.user.userId;
    return data.user;
  }

  public async logout(): Promise<void> {
    try {
      await this.requestJson<Record<string, unknown>>('/api/auth/logout', {
        method: 'POST',
        body: JSON.stringify({}),
        suppressAuthCallbacks: true,
      });
    } finally {
      this.sessionAuthenticated = false;
      this.cookieStore.clear();
    }
  }

  public async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.requestJson<Record<string, unknown>>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  }

  public async actAs(targetUserId: string): Promise<AuthMeDto> {
    const data = await this.requestJson<AuthMeDto>('/api/auth/act-as', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
    this.sessionAuthenticated = true;
    this.activeActorUserId = data.user.userId;
    return data;
  }

  public async exitActAs(): Promise<AuthMeDto> {
    const data = await this.requestJson<AuthMeDto>('/api/auth/exit-act-as', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    this.sessionAuthenticated = true;
    this.activeActorUserId = data.user.userId;
    return data;
  }

  public async listAdminUsers(): Promise<ReadonlyArray<AuthUserDto>> {
    const data = await this.requestJson<{ users: ReadonlyArray<AuthUserDto> }>('/api/admin/users');
    return data.users;
  }

  public async createAdminUser(input: {
    username: string;
    displayName: string;
    jobTitle?: string;
    department?: string;
    tier: 'PROJECT_ADMIN' | 'STAGE_SPECIALIST';
    specialistDomain: string;
    counterpartAgentRole: string;
    ownedStageIds: ReadonlyArray<string>;
    avatarBadge?: string;
    tempPassword?: string;
  }): Promise<{ user: AuthUserDto; tempPassword?: string }> {
    return await this.requestJson<{ user: AuthUserDto; tempPassword?: string }>(
      '/api/admin/users',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  }

  public async updateAdminUser(
    userId: string,
    patch: {
      displayName?: string;
      jobTitle?: string;
      department?: string;
      tier?: 'PROJECT_ADMIN' | 'STAGE_SPECIALIST';
      ownedStageIds?: ReadonlyArray<string>;
      status?: 'ACTIVE' | 'DISABLED';
    },
  ): Promise<AuthUserDto> {
    const data = await this.requestJson<{ user: AuthUserDto }>(
      `/api/admin/users/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    return data.user;
  }

  public async resetAdminUserPassword(userId: string): Promise<{ tempPassword: string }> {
    return await this.requestJson<{ tempPassword: string }>(
      `/api/admin/users/${encodeURIComponent(userId)}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
  }

  public async fetchLoginAudit(params?: {
    username?: string;
    limit?: number;
  }): Promise<ReadonlyArray<LoginAuditEntryDto>> {
    const query = new URLSearchParams();
    if (params?.username) {
      query.set('username', params.username);
    }
    if (params?.limit) {
      query.set('limit', String(params.limit));
    }
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const data = await this.requestJson<{ entries: ReadonlyArray<LoginAuditEntryDto> }>(
      `/api/admin/login-audit${suffix}`,
    );
    return data.entries;
  }

  // ---- 核心工作流业务 API ----

  public async fetchDashboardState(runId?: string): Promise<DashboardStateDto> {
    const targetRunId = runId ?? this.activeRunId ?? undefined;
    const query = new URLSearchParams();
    if (!this.sessionAuthenticated) {
      query.set('actorId', this.activeActorUserId);
    }
    if (targetRunId) {
      query.set('runId', targetRunId);
    }
    const qs = query.toString();
    const data = await this.requestJson<DashboardStateDto>(`/api/state${qs ? `?${qs}` : ''}`);
    return this.trackActiveRun(data);
  }

  public async selectRun(runId: string): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = { runId };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/runs/select', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async launchPresetProposal(preset: string): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = { preset };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/proposals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async createCustomProposal(params: {
    title: string;
    summary: string;
    requirements: Record<string, string>;
    involvesDatabaseMigration: boolean;
    involvesPermissionOrPayment: boolean;
    simulateNegotiationConflict: boolean;
  }): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      preset: 'CUSTOM',
      ...params,
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/proposals', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async listWorkflowTemplates(): Promise<{
    readonly activeTemplateFile: string;
    readonly templates: ReadonlyArray<WorkflowTemplateItemDto>;
  }> {
    return await this.requestJson<{
      activeTemplateFile: string;
      templates: ReadonlyArray<WorkflowTemplateItemDto>;
    }>('/api/workflows/templates');
  }

  /** G3：按阶段与时间范围分页拉取交互历史事件 */
  public async fetchEventHistory(params?: {
    runId?: string;
    stageId?: string;
    since?: string;
    until?: string;
    offset?: number;
    limit?: number;
  }): Promise<EventHistoryPageDto> {
    const query = new URLSearchParams();
    const targetRunId = params?.runId ?? this.activeRunId ?? undefined;
    if (targetRunId) {
      query.set('runId', targetRunId);
    }
    if (params?.stageId) {
      query.set('stageId', params.stageId);
    }
    if (params?.since) {
      query.set('since', params.since);
    }
    if (params?.until) {
      query.set('until', params.until);
    }
    if (params?.offset !== undefined) {
      query.set('offset', String(params.offset));
    }
    if (params?.limit !== undefined) {
      query.set('limit', String(params.limit));
    }
    const qs = query.toString();
    return await this.requestJson<EventHistoryPageDto>(`/api/events/history${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
  }

  public async switchWorkflowTemplate(templateFileName: string): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = { templateFileName };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/workflows/template', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async submitGateDecision(
    snapshotId: string,
    verdict: string,
    comment: string,
    runId?: string,
    extraTokenBudget?: number,
  ): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
      snapshotId,
      verdict,
      comment,
    };
    if (extraTokenBudget !== undefined) {
      payload.extraTokenBudget = extraTokenBudget;
    }
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/decisions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async retryAbortedRun(params: {
    runId?: string;
    snapshotId?: string;
    comment?: string;
    extraTokenBudget?: number;
  }): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(params.runId),
    };
    if (params.snapshotId) {
      payload.snapshotId = params.snapshotId;
    }
    if (params.comment) {
      payload.comment = params.comment;
    }
    if (params.extraTokenBudget !== undefined) {
      payload.extraTokenBudget = params.extraTokenBudget;
    }
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/runs/retry', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async postTeamComment(
    stageId: string,
    content: string,
    runId?: string,
  ): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
      stageId,
      content,
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/comments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async sendSupervisorRollback(
    targetStageId: string,
    dialogueInstruction: string,
    runId?: string,
  ): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
      targetStageId: targetStageId || undefined,
      dialogueInstruction,
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/supervisor/rollback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async fetchSandboxFileContent(
    relativePath: string,
    runId?: string,
  ): Promise<{
    readonly relativePath: string;
    readonly branchId: string;
    readonly content: string;
  }> {
    const targetRunId = runId ?? this.activeRunId ?? undefined;
    const query = new URLSearchParams({ path: relativePath });
    if (!this.sessionAuthenticated) {
      query.set('actorId', this.activeActorUserId);
    }
    if (targetRunId) {
      query.set('runId', targetRunId);
    }
    return await this.requestJson<{
      relativePath: string;
      branchId: string;
      content: string;
    }>(`/api/sandbox/file?${query.toString()}`);
  }

  public async triggerLiveSandboxVerification(runId?: string): Promise<{
    readonly verification: SandboxVerificationSummaryDto;
    readonly executionLog: string;
    readonly dashboardState: DashboardStateDto;
  }> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<{
      verification: SandboxVerificationSummaryDto;
      dashboardState: DashboardStateDto;
    }>('/api/sandbox/verify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return {
      verification: data.verification,
      executionLog: data.verification.executionLog,
      dashboardState: this.trackActiveRun(data.dashboardState),
    };
  }

  public async queryNegativeExperienceRag(
    stageId: string,
    queryText: string,
  ): Promise<ReadonlyArray<RagQueryMatchDto>> {
    const data = await this.requestJson<{ matches: ReadonlyArray<RagQueryMatchDto> }>(
      '/api/rag/query',
      {
        method: 'POST',
        body: JSON.stringify({ stageId, queryText }),
      },
    );
    return data.matches;
  }

  /** A4：执行模型能力基线体检（admin-only；两级端点各 3 个固定 JSON 任务） */
  public async runModelBaseline(): Promise<ModelBaselineCheckDto> {
    return await this.requestJson<ModelBaselineCheckDto>('/api/admin/model-baseline', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async ingestNegativeExperienceLesson(
    stageId: string,
    lessonText: string,
    runId?: string,
  ): Promise<DashboardStateDto> {
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
      stageId,
      lessonText,
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/rag/ingest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public async updateAdminGovernanceConfig(params: {
    maxNegotiationTurns: number;
    highRiskScoreThreshold: number;
    allowSpecialistCrossStageRollback: boolean;
    runId?: string;
  }): Promise<DashboardStateDto> {
    const { runId, ...rest } = params;
    const payload: Record<string, unknown> = {
      ...this.resolveRunIdPayload(runId),
      ...rest,
    };
    if (!this.sessionAuthenticated) {
      payload.actorUserId = this.activeActorUserId;
    }
    const data = await this.requestJson<DashboardStateDto>('/api/admin/governance', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.trackActiveRun(data);
  }

  public closeRealtimeEventStream(): void {
    if (this.activeEventSource) {
      this.activeEventSource.close();
      this.activeEventSource = null;
    }
  }

  public subscribeRealtimeEventStream(
    onStateUpdate: (state: DashboardStateDto) => void,
    onConnectionChange?: (connected: boolean) => void,
    runId?: string,
    handlers?: {
      onRunEvent?: (event: WorkflowDomainEventDto) => void;
      onUserNotification?: (notif: NotificationDto) => void;
    },
  ): () => void {
    if (typeof EventSource === 'undefined') {
      return () => undefined;
    }
    this.closeRealtimeEventStream();
    const query = new URLSearchParams();
    if (!this.sessionAuthenticated) {
      query.set('actorId', this.activeActorUserId);
    }
    const targetRunId = runId ?? this.activeRunId ?? undefined;
    if (targetRunId) {
      query.set('runId', targetRunId);
    }
    const qs = query.toString();
    const source = new EventSource(`${this.baseUrl}/api/events/stream${qs ? `?${qs}` : ''}`);
    this.activeEventSource = source;

    source.addEventListener('open', () => {
      onConnectionChange?.(true);
    });
    source.addEventListener('state_updated', (event: Event) => {
      try {
        const raw = (event as { data?: unknown }).data;
        if (typeof raw !== 'string') {
          return;
        }
        const parsed = JSON.parse(raw) as DashboardStateDto;
        this.trackActiveRun(parsed);
        onStateUpdate(parsed);
      } catch {
        // Ignore malformed SSE payload
      }
    });
    source.addEventListener('run_event', (event: Event) => {
      try {
        const raw = (event as { data?: unknown }).data;
        if (typeof raw !== 'string') {
          return;
        }
        const parsed = JSON.parse(raw) as WorkflowDomainEventDto;
        handlers?.onRunEvent?.(parsed);
      } catch {
        // Ignore malformed incremental event payload
      }
    });
    source.addEventListener('user_notification', (event: Event) => {
      try {
        const raw = (event as { data?: unknown }).data;
        if (typeof raw !== 'string') {
          return;
        }
        const parsed = JSON.parse(raw) as NotificationDto;
        handlers?.onUserNotification?.(parsed);
      } catch {
        // Ignore malformed incremental notification payload
      }
    });
    source.addEventListener('error', () => {
      onConnectionChange?.(false);
    });

    return () => {
      source.close();
      if (this.activeEventSource === source) {
        this.activeEventSource = null;
      }
    };
  }
}
