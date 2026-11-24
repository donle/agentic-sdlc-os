/**
 * @file WorkbenchServer.ts
 * @description 面向对象封装的企业级多角色 AI 研发协同操作系统服务端 (WorkbenchHttpServer)。
 *
 * 职责：
 * 1. 支持多层级 RBAC 用户会话识别（通过 `X-Actor-Id` 请求头或 `actorId` 参数区分顶层管理员 `PROJECT_ADMIN` 与各环节领域专家 `STAGE_SPECIALIST`）；
 * 2. 提供完整的企业级 REST API 与 SSE (`GET /api/events/stream`) 实时流推送：
 *    - `GET /api/state`：获取全局共享工作流状态与当前用户的专长领域权限矩阵；
 *    - `POST /api/runs/select`：在多个项目/工作流运行实例间切换；
 *    - `POST /api/proposals`：支持表单自定义立项提案与快速场景模板立项；
 *    - `POST /api/decisions`：强制执行后端 RBAC 阶段所有权/Admin Override 校验的人工门禁签核与冲突拍板；
 *    - `POST /api/supervisor/rollback`：受 RBAC 管控的总管 Agent 自然语言 DAG 分叉回退；
 *    - `GET /api/sandbox/file` & `POST /api/sandbox/verify`：沙箱完整源码读取与在线触发子进程真实单测/安全扫描；
 *    - `POST /api/rag/query` & `POST /api/rag/ingest`：负向经验向量库余弦相似度检索与企业红线知识录入；
 *    - `POST /api/admin/governance`：顶层管理员专属的全局风控阈值、跨阶段回退策略与 YAML 模板治理接口；
 * 3. 托管多视图模块化前端系统资源 (`src/ui/index.html`, `/styles/workbench.css`, `/dist/*.js` 及子模块)。
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ProjectProposalContract } from '../domain/contracts.ts';
import { DecisionVerdict, WorkflowStageId } from '../domain/enums.ts';
import { SystemPermissionCode } from '../domain/rbac.ts';
import type { ScenarioHints } from '../domain/scenario.ts';
import { type AuthUserView, SessionService } from './auth/SessionService.ts';
import { selectUserStore } from './auth/UserStore.ts';
import { SseBridge } from './SseBridge.ts';
import { WorkflowDslLoader } from '../engine/WorkflowDslLoader.ts';
import { WorkflowOrchestratorFacade } from '../engine/WorkflowOrchestratorFacade.ts';

interface ResolvedAuthContext {
  readonly actorUserId: string;
  readonly user: AuthUserView | null;
  readonly rawToken: string | null;
  readonly authSource: 'session' | 'invalid_token' | 'workbench_header' | 'none';
}

interface SseClientSubscription {
  readonly actorUserId: string;
  readonly subscribedRunId: string | null;
}

export class WorkbenchHttpServer {
  private readonly orchestrator: WorkflowOrchestratorFacade;
  private readonly port: number;
  private activeRunId: string;
  private readonly sseClients: Map<http.ServerResponse, SseClientSubscription>;
  public readonly sessionService: SessionService;
  private readonly sseBridge: SseBridge;

  public constructor(
    port = 4300,
    options?: {
      persistenceDir?: string;
      sandboxRootDir?: string;
    },
  ) {
    this.port = port;
    this.sseClients = new Map<http.ServerResponse, SseClientSubscription>();
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      highRiskThreshold: 60,
      persistenceDir: options?.persistenceDir,
      sandboxRootDir: options?.sandboxRootDir,
    });
    const usersFilePath = path.join(orchestrator.persistenceRepo.getStorageDir(), 'users.json');
    const userStore = selectUserStore({ usersFilePath });
    this.sessionService = new SessionService(userStore, orchestrator.rbacService);
    this.orchestrator = orchestrator;
    this.sseBridge = new SseBridge((frame, eventName, seqId, eventRunId) => {
      this.sseClients.forEach((sub: SseClientSubscription, clientRes: http.ServerResponse) => {
        if (sub.subscribedRunId !== null && eventRunId && sub.subscribedRunId !== eventRunId) {
          return;
        }
        try {
          // C1/D3/AUDIT-13：逐事件帧（run_event / user_notification），按订阅 runId 隔离
          clientRes.write(`id: ${seqId}
event: ${eventName}
data: ${frame}

`);
        } catch {
          this.sseClients.delete(clientRes);
        }
      });
    });
    this.orchestrator.eventBus.registerObserver(this.sseBridge);
    this.activeRunId = 'SEEDING';
    this.seedPromise = (async () => {
      // D1：优先从持久化恢复；失败/无数据 → 播种演示场景
      const restoreResult = orchestrator.restoreFromPersistence();
      if (restoreResult.restored) {
        this.activeRunId = orchestrator.getRestoredActiveRunId() ?? restoreResult.runIds[0];
        console.log(`[D1] 已从持久化恢复 ${restoreResult.runIds.length} 个运行实例`);
        return;
      }
      for (const warning of restoreResult.warnings) {
        console.log(`[D1] ${warning}`);
      }
      console.log('[D1] 无可恢复数据，播种演示场景...');
      const runId = await this.seedInitialInteractiveScenario();
      this.activeRunId = runId;
    })();
  }

  private seedPromise: Promise<void> = Promise.resolve();

  public getOrchestrator(): WorkflowOrchestratorFacade {
    return this.orchestrator;
  }

  /**
   * 预置两个不同进展的企业研发项目运行实例，方便多角色用户切换查看
   */
  public async seedInitialInteractiveScenario(): Promise<string> {
    // 项目 1：已完成前序阶段并停留在 Stage 4 QA 终审门禁（沙箱已生成完整源码）
    const completedCodeProposal = new ProjectProposalContract({
      proposalId: 'PROP-ENT-2026-00',
      title: '企业统一结算中心与多币种清分服务',
      summary: '已完成 PM、PD、Tech Lead 契约与 Engineer 沙箱编码，当前位于 Stage 4 QA 终审门禁',
      requirements: {
        REQ_MULTI_CURRENCY: '支持多币种实时汇率锁定与清分流水计算',
        REQ_IDEMPOTENT_LEDGER: '支持分布式幂等记账与日终对账校验',
      },
      involvesDatabaseMigration: false,
      involvesPermissionOrPayment: false,
    });
    await this.orchestrator.startProposalWorkflow({
      proposal: completedCodeProposal,
      initiatorActor: '陈工 (PM · 资深产品经理)',
    });

    // 项目 2（默认激活）：Stage 1 自愈达成 + Stage 2 PM/PD 3轮协商熔断等待拍板 + 后续含 DDL 高风险门禁
    const initialProposal = new ProjectProposalContract({
      proposalId: 'PROP-ENT-2026-01',
      title: '企业级研发权限与智能工单协同模块',
      summary: '实现跨角色需求提案、高保真组件映射、RBAC 权限表结构迁移与沙箱自动化回归验证',
      requirements: {
        REQ_RBAC_MATRIX: '支持细粒度角色权限矩阵与高风险门禁审批流',
        REQ_REALTIME_CANVAS: '支持多智能体 DAG 分叉拓扑与实时状态监视画布',
        REQ_AUDIT_EXPORT: '支持全链路不可变审计日志与驳回历史追溯导出',
      },
      involvesDatabaseMigration: true,
      involvesPermissionOrPayment: true,
    });

    const runState = await this.orchestrator.startProposalWorkflow({
      proposal: initialProposal,
      initiatorActor: '陈工 (PM · 资深产品经理)',
      scenarioHints: { forceNegotiationDeadlock: true, forceTransientRetry: true },
    });

    return runState.runId;
  }

  public async waitUntilReady(): Promise<void> {
    await this.seedPromise.catch(() => undefined);
  }

  public async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      await this.routeRequest(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知服务器异常';
      const statusCode = message.includes('[RBAC') ? 403 : 400;
      this.sendJson(res, statusCode, { ok: false, error: message });
    }
  }

  public async start(): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      await this.handleHttpRequest(req, res);
    });

    await this.seedPromise.catch(() => undefined);

    server.listen(this.port, () => {
      console.log(`========================================================================`);
      console.log(
        `🚀 Agentic SDLC OS 企业级多角色研发协同系统已启动: http://localhost:${this.port}`,
      );
      console.log(`========================================================================`);
    });

    return server;
  }

  private extractSessionToken(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.match(/sdlc_session=([^\s;]+)/);
    if (match && match[1]) {
      return match[1];
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (bearer.length > 0) {
        return bearer;
      }
    }
    return null;
  }

  private resolveAuthContext(
    req: http.IncomingMessage,
    urlObj: URL,
    body: Record<string, unknown> | undefined,
    rawToken: string | null,
    sessionUser: AuthUserView | null,
  ): ResolvedAuthContext {
    if (rawToken) {
      if (sessionUser) {
        return {
          actorUserId: sessionUser.userId,
          user: sessionUser,
          rawToken,
          authSource: 'session',
        };
      }
      return {
        actorUserId: 'UNAUTHENTICATED',
        user: null,
        rawToken,
        authSource: 'invalid_token',
      };
    }

    if (process.env.AUTH_REQUIRED === 'true') {
      return {
        actorUserId: 'UNAUTHENTICATED',
        user: null,
        rawToken: null,
        authSource: 'none',
      };
    }

    const headerActor = req.headers['x-actor-id'];
    const queryActor = urlObj.searchParams.get('actorId');
    const bodyActor = body && typeof body.actorUserId === 'string' ? body.actorUserId : undefined;
    const explicitId =
      (typeof headerActor === 'string' && headerActor.trim()) ||
      (queryActor && queryActor.trim()) ||
      (bodyActor && bodyActor.trim()) ||
      '';

    if (explicitId) {
      if (process.env.AUTH_DISABLED === 'true') {
        return {
          actorUserId: explicitId,
          user: this.sessionService.getUserById(explicitId),
          rawToken: null,
          authSource: 'workbench_header',
        };
      }
      if (this.orchestrator.rbacService.isUserActive(explicitId)) {
        return {
          actorUserId: explicitId,
          user: this.sessionService.getUserById(explicitId),
          rawToken: null,
          authSource: 'workbench_header',
        };
      }
      return {
        actorUserId: 'UNAUTHENTICATED',
        user: null,
        rawToken: null,
        authSource: 'workbench_header',
      };
    }

    if (process.env.AUTH_DISABLED === 'true') {
      return {
        actorUserId: 'user-admin-01',
        user: this.sessionService.getUserById('user-admin-01'),
        rawToken: null,
        authSource: 'none',
      };
    }

    return {
      actorUserId: 'UNAUTHENTICATED',
      user: null,
      rawToken: null,
      authSource: 'none',
    };
  }

  private resolveDefaultRunId(): string {
    const runs = this.orchestrator.stateEngine.getAllRuns();
    if (this.activeRunId && runs.some((r) => r.runId === this.activeRunId)) {
      return this.activeRunId;
    }
    return runs[runs.length - 1]?.runId ?? this.activeRunId;
  }

  private resolveRequestRunId(params: { explicitRunId?: unknown; snapshotId?: string }): string {
    if (typeof params.explicitRunId === 'string' && params.explicitRunId.trim().length > 0) {
      return params.explicitRunId.trim();
    }
    if (params.snapshotId) {
      for (const run of this.orchestrator.stateEngine.getAllRuns()) {
        if (run.findSnapshotById(params.snapshotId)) {
          return run.runId;
        }
      }
      const matchingNotif = this.orchestrator.eventBus
        .getNotificationInbox()
        .find((n) => n.relatedSnapshotId === params.snapshotId);
      if (matchingNotif) {
        return matchingNotif.runId;
      }
    }
    return this.resolveDefaultRunId();
  }

  private broadcastSseStateUpdate(changedRunId?: string): void {
    if (this.sseClients.size === 0) {
      return;
    }
    const fallbackRunId = changedRunId ?? this.resolveDefaultRunId();
    for (const [clientRes, sub] of this.sseClients.entries()) {
      if (sub.subscribedRunId !== null && changedRunId && sub.subscribedRunId !== changedRunId) {
        continue;
      }
      const targetRunId = sub.subscribedRunId ?? fallbackRunId;
      try {
        const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, sub.actorUserId);
        clientRes.write(`event: state_updated\ndata: ${JSON.stringify(state)}\n\n`);
      } catch {
        this.sseClients.delete(clientRes);
      }
    }
  }

  private async routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const urlObj = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const pathname = urlObj.pathname;

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
      const htmlPath = path.resolve(currentFileDir, '../ui/index.html');
      const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
      return;
    }

    if (method === 'GET' && pathname.endsWith('.css')) {
      // 允许托管 /styles/*.css（宿主样式）与 /kit/*.css（Meridian UI 组件库样式）
      const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
      const uiRoot = path.resolve(currentFileDir, '../ui');
      const cssPath = path.resolve(uiRoot, `.${pathname}`);
      if (cssPath.startsWith(uiRoot) && fs.existsSync(cssPath) && fs.statSync(cssPath).isFile()) {
        const cssContent = fs.readFileSync(cssPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(cssContent);
        return;
      }
    }

    if (method === 'GET' && pathname.startsWith('/dist/') && pathname.endsWith('.js')) {
      const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
      const distRoot = path.resolve(currentFileDir, '../ui/dist');
      const relativeReqPath = pathname.slice('/dist/'.length);
      const resolvedJsPath = path.resolve(distRoot, relativeReqPath);
      if (resolvedJsPath.startsWith(distRoot) && fs.existsSync(resolvedJsPath)) {
        const jsContent = fs.readFileSync(resolvedJsPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(jsContent);
        return;
      }
    }

    // ---- I2: 健康检查（运维探针，匿名放行） ----
    if (method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, {
        ok: true,
        data: {
          status: 'healthy',
          activeRunId: this.resolveDefaultRunId(),
          sseClients: this.sseClients.size,
          persistenceDir: process.env.LOCAL_PERSISTENCE_DIR ?? '.runtime-data',
          authDisabled: process.env.AUTH_DISABLED === 'true',
          authRequired: process.env.AUTH_REQUIRED === 'true',
          databaseUrl: process.env.DATABASE_URL ? 'configured' : 'json-file-mode',
          llmLiveHttp: process.env.LITELLM_ENABLE_LIVE_HTTP === 'true',
          uptimeSec: Math.round(process.uptime()),
        },
      });
      return;
    }

    // ---- F1: 登录/登出端点（匿名放行） ----
    if (method === 'POST' && pathname === '/api/auth/login') {
      const loginBody = await this.readJsonBody(req);
      const result = this.sessionService.login(
        String(loginBody.username ?? ''),
        String(loginBody.password ?? ''),
      );
      if (!result.ok) {
        const statusCode =
          result.reason === 'LOCKED' ? 423 : result.reason === 'DISABLED' ? 403 : 401;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json; charset=utf-8',
        };
        if (result.reason === 'LOCKED' && result.retryAfterSec) {
          headers['Retry-After'] = String(result.retryAfterSec);
        }
        res.writeHead(statusCode, headers);
        res.end(
          JSON.stringify({
            ok: false,
            error: `认证失败: ${result.reason}`,
            retryAfterSec: (result as { retryAfterSec?: number }).retryAfterSec,
          }),
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `sdlc_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
      });
      res.end(JSON.stringify({ ok: true, data: { user: result.user } }));
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const logoutToken = this.extractSessionToken(req);
      if (logoutToken) {
        this.sessionService.logout(logoutToken);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'sdlc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (!pathname.startsWith('/api/')) {
      this.sendJson(res, 404, { ok: false, error: `未知路由: ${method} ${pathname}` });
      return;
    }

    // ---- F1: 全局 API 会话守卫与强制改密拦截 ----
    const rawToken = this.extractSessionToken(req);
    const sessionUser = rawToken ? this.sessionService.validate(rawToken) : null;
    if (rawToken && !sessionUser) {
      this.sendJson(res, 401, { ok: false, error: '会话已过期或令牌无效，请重新登录' });
      return;
    }
    if (process.env.AUTH_REQUIRED === 'true') {
      if (!sessionUser) {
        this.sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      if (
        sessionUser.mustChangePassword &&
        pathname !== '/api/auth/me' &&
        pathname !== '/api/auth/change-password'
      ) {
        this.sendJson(res, 403, {
          ok: false,
          error: '首次登录或重置口令后必须先修改密码',
          mustChangePassword: true,
        });
        return;
      }
    }

    const body = method === 'POST' || method === 'PATCH' ? await this.readJsonBody(req) : undefined;
    const authCtx = this.resolveAuthContext(req, urlObj, body, rawToken, sessionUser);
    const actorUserId = authCtx.actorUserId;

    if (method === 'GET' && pathname === '/api/events/stream') {
      const streamActorId =
        process.env.AUTH_REQUIRED !== 'true' && authCtx.authSource === 'none'
          ? 'user-admin-01'
          : actorUserId;
      if (streamActorId === 'UNAUTHENTICATED') {
        this.sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      const subscribedRunId = urlObj.searchParams.get('runId')?.trim() || null;
      const initialRunId = subscribedRunId ?? this.resolveDefaultRunId();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const initialState = this.orchestrator.buildWorkbenchDashboardState(
        initialRunId,
        streamActorId,
      );
      res.write(`event: state_updated\ndata: ${JSON.stringify(initialState)}\n\n`);

      const rawLastId = req.headers['last-event-id'] ?? urlObj.searchParams.get('lastEventId');
      if (rawLastId !== undefined && rawLastId !== null && String(rawLastId).trim() !== '') {
        const lastEventId = Number(String(rawLastId).trim());
        if (Number.isFinite(lastEventId) && lastEventId >= 0) {
          this.sseBridge.replay(
            lastEventId,
            (frame, eventName, id) => {
              res.write(`id: ${id}\nevent: ${eventName}\ndata: ${frame}\n\n`);
            },
            subscribedRunId ?? undefined,
          );
        }
      }

      this.sseClients.set(res, { actorUserId: streamActorId, subscribedRunId });
      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const stateActorId =
        process.env.AUTH_REQUIRED !== 'true' && authCtx.authSource === 'none'
          ? 'user-admin-01'
          : actorUserId;
      if (stateActorId === 'UNAUTHENTICATED') {
        this.sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      const targetRunId = this.resolveRequestRunId({
        explicitRunId: urlObj.searchParams.get('runId'),
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, stateActorId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/runs/select') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
        );
      }
      const targetRunId = String(body?.runId ?? '').trim();
      const runState = this.orchestrator.stateEngine.getRunOrThrow(targetRunId);
      const state = this.orchestrator.buildWorkbenchDashboardState(runState.runId, actorUserId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'GET' && pathname === '/api/workflows/templates') {
      const templates = WorkflowDslLoader.listAvailableTemplates().map((t) => ({
        fileName: t.fileName,
      }));
      this.sendJson(res, 200, {
        ok: true,
        data: {
          activeTemplateFile: this.orchestrator.getWorkflowDslConfig().sourceFilePath,
          templates,
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/workflows/template') {
      const effectiveActorId =
        process.env.AUTH_REQUIRED !== 'true' && authCtx.authSource === 'none'
          ? 'user-admin-01'
          : actorUserId;
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          effectiveActorId,
          SystemPermissionCode.MANAGE_WORKFLOW_DSL_AND_GUARDRAILS,
        );
      }
      const templateFileName = String(body?.templateFileName ?? 'enterprise_sdlc.yaml');
      const available = WorkflowDslLoader.listAvailableTemplates();
      const matched = available.find((t) => t.fileName === templateFileName);
      if (!matched) {
        throw new Error(`未找到指定的工作流 YAML 模板: ${templateFileName}`);
      }
      this.orchestrator.reloadWorkflowDsl(matched.fullPath);

      const user = this.orchestrator.rbacService.getUserOrDefault(effectiveActorId);
      const proposal = new ProjectProposalContract({
        proposalId: `PROP-DSL-${Date.now()}`,
        title:
          templateFileName === 'backend_api_only.yaml'
            ? '纯后端核心清算 API 研发（动态跳过 PD 阶段）'
            : '企业级研发权限与智能工单协同模块（全栈 6 阶段）',
        summary: `当前由声明式 YAML 模板 [${templateFileName}] 动态驱动阶段拓扑流转`,
        requirements: {
          REQ_CORE_API: '核心领域接口契约与幂等状态流转',
          REQ_AUDIT_TRACE: '全链路不可变审计日志与负向经验检索',
        },
        involvesDatabaseMigration: false,
        involvesPermissionOrPayment: false,
      });

      const runState = await this.orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: `${user.displayName} (${user.jobTitle})`,
      });
      this.activeRunId = runState.runId;

      const state = this.orchestrator.buildWorkbenchDashboardState(
        runState.runId,
        effectiveActorId,
      );
      this.broadcastSseStateUpdate(runState.runId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    // ---- A4: 模型基线体检端点（admin-only）——两级端点各发 3 个固定 JSON 任务 ----
    if (method === 'POST' && pathname === '/api/admin/model-baseline') {
      if (process.env.AUTH_DISABLED !== 'true') {
        const user = this.sessionService.getUserById(actorUserId);
        if (!user || user.tier !== 'PROJECT_ADMIN' || user.status !== 'ACTIVE') {
          this.sendJson(res, 403, { ok: false, error: '仅项目管理员可执行模型体检' });
          return;
        }
      }
      const result = await this.orchestrator.modelRouter.runModelBaselineCheck();
      this.sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      if (authCtx.authSource !== 'session' || !authCtx.rawToken || !authCtx.user) {
        this.sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      const impersonating = this.sessionService.isImpersonating(authCtx.rawToken);
      this.sendJson(res, 200, {
        ok: true,
        data: { user: authCtx.user, impersonating },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/change-password') {
      if (actorUserId === 'UNAUTHENTICATED') {
        this.sendJson(res, 401, { ok: false, error: '未登录' });
        return;
      }
      const result = this.sessionService.changePassword(
        actorUserId,
        String(body?.oldPassword ?? ''),
        String(body?.newPassword ?? ''),
        authCtx.rawToken ?? undefined,
      );
      if (!result.ok) {
        this.sendJson(res, 400, { ok: false, error: result.reason });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { message: '口令已更新，其他设备已退出登录' } });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/act-as') {
      if (
        authCtx.authSource !== 'session' ||
        !authCtx.rawToken ||
        !authCtx.user ||
        authCtx.user.tier !== 'PROJECT_ADMIN'
      ) {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可切换视角' });
        return;
      }
      const result = this.sessionService.actAs(authCtx.rawToken, String(body?.targetUserId ?? ''));
      if (!result) {
        this.sendJson(res, 404, { ok: false, error: '目标成员不存在或已停用' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `sdlc_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
      });
      res.end(JSON.stringify({ ok: true, data: { user: result.user } }));
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/users') {
      const user = this.sessionService.getUserById(actorUserId);
      if (!user || user.tier !== 'PROJECT_ADMIN' || user.status !== 'ACTIVE') {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可查看成员列表' });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { users: this.sessionService.listUsers() } });
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/login-audit') {
      const user = this.sessionService.getUserById(actorUserId);
      if (!user || user.tier !== 'PROJECT_ADMIN' || user.status !== 'ACTIVE') {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可查看登录审计' });
        return;
      }
      const username = urlObj.searchParams.get('username') ?? undefined;
      const limitParam = urlObj.searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : 20;
      const entries = this.sessionService.getLoginAudit({
        username: username || undefined,
        limit: Number.isFinite(limit) ? limit : 20,
      });
      this.sendJson(res, 200, { ok: true, data: { entries } });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/users') {
      const result = this.sessionService.createUser(actorUserId, {
        username: String(body?.username ?? ''),
        displayName: String(body?.displayName ?? ''),
        jobTitle: body?.jobTitle ? String(body.jobTitle) : undefined,
        department: body?.department ? String(body.department) : undefined,
        tier: String(body?.tier ?? 'STAGE_SPECIALIST'),
        specialistDomain: String(body?.specialistDomain ?? 'SOFTWARE_ENGINEERING'),
        counterpartAgentRole: String(body?.counterpartAgentRole ?? 'ENGINEER_AGENT'),
        ownedStageIds: ((body?.ownedStageIds as string[] | undefined) ?? []).map(String),
        avatarBadge: body?.avatarBadge ? String(body.avatarBadge) : undefined,
        tempPassword: body?.tempPassword ? String(body.tempPassword) : undefined,
      });
      if (!result.ok) {
        this.sendJson(res, result.reason === '用户名已存在' ? 409 : 403, {
          ok: false,
          error: result.reason,
        });
        return;
      }
      this.sendJson(res, 201, {
        ok: true,
        data: { user: result.user, tempPassword: result.tempPassword },
      });
      return;
    }

    if (method === 'PATCH' && pathname.startsWith('/api/admin/users/')) {
      const targetUserId = pathname.split('/').pop() ?? '';
      const result = this.sessionService.updateUser(actorUserId, targetUserId, {
        displayName: body?.displayName ? String(body.displayName) : undefined,
        jobTitle: body?.jobTitle ? String(body.jobTitle) : undefined,
        department: body?.department !== undefined ? String(body.department) : undefined,
        tier:
          body?.tier === 'PROJECT_ADMIN' || body?.tier === 'STAGE_SPECIALIST'
            ? body.tier
            : undefined,
        ownedStageIds: body?.ownedStageIds
          ? ((body.ownedStageIds as string[] | undefined) ?? []).map(String)
          : undefined,
        status: body?.status ? (String(body.status) as 'ACTIVE' | 'DISABLED') : undefined,
      });
      if (!result.ok) {
        const statusCode =
          result.reason === '不能停用最后一个 ACTIVE 管理员' ||
          result.reason === '不能降级最后一个 ACTIVE 管理员'
            ? 409
            : result.reason === '目标用户不存在'
              ? 404
              : 403;
        this.sendJson(res, statusCode, {
          ok: false,
          error: result.reason,
        });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { user: result.user } });
      return;
    }

    if (
      method === 'POST' &&
      pathname.startsWith('/api/admin/users/') &&
      pathname.endsWith('/reset-password')
    ) {
      const targetUserId = pathname.split('/')[4];
      const result = this.sessionService.resetPassword(actorUserId, targetUserId);
      if (!result) {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可重置口令' });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { tempPassword: result.tempPassword } });
      return;
    }

    if (method === 'POST' && pathname === '/api/proposals') {
      const user =
        process.env.AUTH_DISABLED === 'true'
          ? this.orchestrator.rbacService.getUserOrDefault(actorUserId)
          : this.orchestrator.rbacService.assertHasPermission(
              actorUserId,
              SystemPermissionCode.CREATE_PROPOSAL,
            );
      const preset = String(body?.preset ?? 'CONFLICT_AND_DDL');

      let proposal: ProjectProposalContract;
      let scenarioHints: ScenarioHints = {};

      // J1：演示开关已迁出提案契约，由 preset 映射为 ScenarioHints（运行元数据）

      if (preset === 'CUSTOM') {
        const customTitle = String(body?.title ?? '').trim();
        const customSummary = String(body?.summary ?? '').trim() || customTitle;
        const rawReqs = (body?.requirements as Record<string, string> | undefined) ?? {};
        const cleanReqs: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawReqs)) {
          if (k.trim() && String(v).trim()) {
            cleanReqs[
              k
                .trim()
                .toUpperCase()
                .replace(/[^A-Z0-9_]/g, '_')
            ] = String(v).trim();
          }
        }
        proposal = new ProjectProposalContract({
          proposalId: `PROP-CUSTOM-${Date.now()}`,
          title: customTitle,
          summary: customSummary,
          requirements: cleanReqs,
          involvesDatabaseMigration: Boolean(body?.involvesDatabaseMigration),
          involvesPermissionOrPayment: Boolean(body?.involvesPermissionOrPayment),
        });
        scenarioHints = {
          forceNegotiationDeadlock: Boolean(body?.simulateNegotiationConflict),
          forceScopeReduction: Boolean(body?.simulateScopeReductionAttempt),
        };
      } else if (preset === 'LOW_RISK_FAST_TRACK') {
        proposal = new ProjectProposalContract({
          proposalId: `PROP-LOW-${Date.now()}`,
          title: '内部运营数据看板样式与筛选项优化',
          summary: '低风险常规迭代：验证低风险阶段自动放行并留痕，直达 Stage 4 QA 终审门禁',
          requirements: {
            REQ_FILTER_BAR: '新增按时间与部门维度快捷筛选',
            REQ_EXPORT_CSV: '支持当前表格数据一键导出 CSV',
          },
          involvesDatabaseMigration: false,
          involvesPermissionOrPayment: false,
        });
      } else if (preset === 'SCOPE_DIFF_ALERT') {
        proposal = new ProjectProposalContract({
          proposalId: `PROP-SCOPE-${Date.now()}`,
          title: '财务对账中心自动化报表开发（防虚假共识测试）',
          summary: '模拟 Agent 在协商中擅自删减核心需求条目，验证 Scope Diff 红线拦截与待核验提醒',
          requirements: {
            REQ_RECONCILE_CORE: '实现日终自动对账核心流水引擎',
            REQ_ANOMALY_ALERT: '实现差错账目实时告警推送',
            REQ_SOX_AUDIT_EXPORT: '实现合规审计签名归档报表',
          },
          involvesDatabaseMigration: false,
          involvesPermissionOrPayment: true,
        });
        scenarioHints = { forceScopeReduction: true };
      } else if (preset === 'CACHE_HIT_REUSE') {
        proposal = new ProjectProposalContract({
          proposalId: `PROP-CACHE-${Date.now()}`,
          title: '企业级研发权限与智能工单协同模块',
          summary: '复用已校验过的同构需求提案，验证 L1/L2 语义意图缓存直接命中与零 Token 消耗',
          requirements: {
            REQ_RBAC_MATRIX: '支持细粒度角色权限矩阵与高风险门禁审批流',
            REQ_REALTIME_CANVAS: '支持多智能体 DAG 分叉拓扑与实时状态监视画布',
            REQ_AUDIT_EXPORT: '支持全链路不可变审计日志与驳回历史追溯导出',
          },
          involvesDatabaseMigration: false,
          involvesPermissionOrPayment: false,
        });
      } else {
        scenarioHints = { forceNegotiationDeadlock: true, forceTransientRetry: true };
        proposal = new ProjectProposalContract({
          proposalId: `PROP-FULL-${Date.now()}`,
          title: String(body?.title ?? '企业级研发权限与智能工单协同模块'),
          summary: String(
            body?.summary ??
              '包含 PM-PD 3轮协商熔断裁决、Stage 3a 数据库 DDL 高风险门禁与 Stage 4 QA 终审',
          ),
          requirements: {
            REQ_RBAC_MATRIX: '支持细粒度角色权限矩阵与高风险门禁审批流',
            REQ_REALTIME_CANVAS: '支持多智能体 DAG 分叉拓扑与实时状态监视画布',
            REQ_AUDIT_EXPORT: '支持全链路不可变审计日志与驳回历史追溯导出',
          },
          involvesDatabaseMigration: true,
          involvesPermissionOrPayment: true,
        });
      }

      const runState = await this.orchestrator.startProposalWorkflow({
        proposal,
        initiatorActor: String(body?.initiatorActor ?? `${user.displayName} (${user.jobTitle})`),
        scenarioHints,
      });
      this.activeRunId = runState.runId;

      const state = this.orchestrator.buildWorkbenchDashboardState(runState.runId, actorUserId);
      this.broadcastSseStateUpdate(runState.runId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/decisions') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
        );
      }
      const snapshotId = String(body?.snapshotId ?? '');
      const targetRunId = this.resolveRequestRunId({
        explicitRunId: body?.runId,
        snapshotId,
      });
      const verdict = String(body?.verdict ?? DecisionVerdict.APPROVE) as DecisionVerdict;
      const reviewerActor = String(body?.reviewerActor ?? '领域专家审核员');
      const comment = String(
        body?.comment ?? '经人工交叉核验，当前阶段 Agent 契约产出符合质量标准，准予放行',
      );
      const extraTokenBudget =
        body?.extraTokenBudget !== undefined ? Number(body.extraTokenBudget) : undefined;

      await this.orchestrator.submitHumanGateDecision({
        runId: targetRunId,
        snapshotId,
        reviewerActor,
        actorUserId,
        verdict,
        comment,
        extraTokenBudget:
          extraTokenBudget !== undefined && Number.isFinite(extraTokenBudget)
            ? extraTokenBudget
            : undefined,
      });

      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/runs/retry') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.APPROVE_ASSIGNED_STAGE_GATE,
        );
      }
      const targetSnapshotOrRetryId =
        typeof body?.snapshotId === 'string' && body.snapshotId.trim().length > 0
          ? body.snapshotId.trim()
          : undefined;
      const targetRunId = this.resolveRequestRunId({
        explicitRunId: body?.runId,
        snapshotId: targetSnapshotOrRetryId,
      });
      const extraTokenBudget =
        body?.extraTokenBudget !== undefined ? Number(body.extraTokenBudget) : undefined;

      await this.orchestrator.retryAbortedStage({
        runId: targetRunId,
        reviewerActor: String(body?.reviewerActor ?? '领域专家审核员'),
        actorUserId,
        comment: body?.comment ? String(body.comment) : undefined,
        targetSnapshotOrRetryId,
        extraTokenBudget:
          extraTokenBudget !== undefined && Number.isFinite(extraTokenBudget)
            ? extraTokenBudget
            : undefined,
      });

      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/supervisor/rollback') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.INVOKE_SUPERVISOR_ROLLBACK,
        );
      }
      const targetRunId = this.resolveRequestRunId({ explicitRunId: body?.runId });
      const dialogueInstruction = String(
        body?.dialogueInstruction ??
          '回退到 PD Agent，将弹窗改为双栏折叠侧边抽屉并重新执行下游阶段',
      );
      const explicitTargetStageId = body?.targetStageId
        ? (String(body.targetStageId) as WorkflowStageId)
        : undefined;
      const humanActor = String(body?.humanActor ?? '项目总负责人');

      await this.orchestrator.invokeSupervisorConversationalRollback({
        runId: targetRunId,
        humanActor,
        actorUserId,
        dialogueInstruction,
        explicitTargetStageId,
      });

      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/comments') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
        );
      }
      const targetRunId = this.resolveRequestRunId({ explicitRunId: body?.runId });
      const stageId = String(body?.stageId ?? WorkflowStageId.STAGE_1_PM) as WorkflowStageId;
      const content = String(body?.content ?? '').trim();
      if (!content) {
        throw new Error('评论内容不能为空');
      }
      this.orchestrator.addTeamComment({
        runId: targetRunId,
        stageId,
        actorUserId,
        content,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'GET' && pathname === '/api/sandbox/file') {
      if (process.env.AUTH_DISABLED !== 'true' && authCtx.authSource !== 'none') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
        );
      }
      const targetRunId = this.resolveRequestRunId({
        explicitRunId: urlObj.searchParams.get('runId'),
      });
      const runState = this.orchestrator.stateEngine.getRunOrThrow(targetRunId);
      const workspacePath = this.orchestrator.sandboxManager.resolveWorkspacePath(
        runState.runId,
        runState.getActiveBranchId(),
      );
      const relativePath = String(urlObj.searchParams.get('path') ?? '').trim();
      const targetFull = path.resolve(workspacePath, relativePath);
      if (!targetFull.startsWith(workspacePath) || !fs.existsSync(targetFull)) {
        throw new Error(`未找到沙箱文件: ${relativePath}`);
      }
      const content = fs.readFileSync(targetFull, 'utf-8');
      this.sendJson(res, 200, {
        ok: true,
        data: {
          relativePath,
          branchId: runState.getActiveBranchId(),
          content,
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/sandbox/verify') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.EXECUTE_SANDBOX_VERIFICATION,
        );
      }
      const targetRunId = this.resolveRequestRunId({ explicitRunId: body?.runId });
      const runState = this.orchestrator.stateEngine.getRunOrThrow(targetRunId);
      const verifyResult = this.orchestrator.sandboxManager.executeSandboxVerification({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        requirementIds: runState.proposal.coreRequirementIds,
        runSubprocessNodeTest: true,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, {
        ok: true,
        data: {
          verification: verifyResult,
          dashboardState: state,
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/rag/query') {
      if (process.env.AUTH_DISABLED !== 'true' && authCtx.authSource !== 'none') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.VIEW_SHARED_WORKFLOW,
        );
      }
      const stageId = String(
        body?.stageId ?? WorkflowStageId.STAGE_3A_TECH_SPEC,
      ) as WorkflowStageId;
      const queryText = String(body?.queryText ?? '').trim();
      const matches = await this.orchestrator.auditLedger.ragEngine.retrieveTopKSimilarLessons({
        stageId,
        queryText,
        topK: 5,
      });
      this.sendJson(res, 200, { ok: true, data: { matches } });
      return;
    }

    if (method === 'POST' && pathname === '/api/rag/ingest') {
      const user =
        process.env.AUTH_DISABLED === 'true'
          ? this.orchestrator.rbacService.getUserOrDefault(actorUserId)
          : this.orchestrator.rbacService.assertHasPermission(
              actorUserId,
              SystemPermissionCode.VIEW_SHARED_WORKFLOW,
            );
      const targetRunId = this.resolveRequestRunId({ explicitRunId: body?.runId });
      const stageId = String(
        body?.stageId ?? WorkflowStageId.STAGE_3A_TECH_SPEC,
      ) as WorkflowStageId;
      const rawLesson = String(body?.lessonText ?? '').trim();
      if (!rawLesson) {
        throw new Error('避坑经验内容不能为空');
      }
      this.orchestrator.auditLedger.registerRejectionLesson(
        stageId,
        `[${user.displayName} 录入企业红线] ${rawLesson}`,
      );
      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/governance') {
      if (process.env.AUTH_DISABLED !== 'true') {
        this.orchestrator.rbacService.assertHasPermission(
          actorUserId,
          SystemPermissionCode.MANAGE_WORKFLOW_DSL_AND_GUARDRAILS,
        );
      }
      const targetRunId = this.resolveRequestRunId({ explicitRunId: body?.runId });
      this.orchestrator.updateAdminGovernanceConfig({
        actorUserId,
        maxNegotiationTurns:
          body?.maxNegotiationTurns !== undefined ? Number(body.maxNegotiationTurns) : undefined,
        highRiskScoreThreshold:
          body?.highRiskScoreThreshold !== undefined
            ? Number(body.highRiskScoreThreshold)
            : undefined,
        allowSpecialistCrossStageRollback:
          body?.allowSpecialistCrossStageRollback !== undefined
            ? Boolean(body.allowSpecialistCrossStageRollback)
            : undefined,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(targetRunId, actorUserId);
      this.broadcastSseStateUpdate(targetRunId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    this.sendJson(res, 404, { ok: false, error: `未知路由: ${method} ${pathname}` });
  }

  private readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8').trim();
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>,
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }
}

// 仅当被 node 直接执行时启动服务器；在 Windows 上 process.argv[1] 为反斜杠路径，
// 必须经 pathToFileURL 归一化后才能与 import.meta.url 严格比较
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 4300);
  const server = new WorkbenchHttpServer(port);
  server.start();
}
