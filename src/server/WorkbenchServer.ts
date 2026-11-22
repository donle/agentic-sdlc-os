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
import type { ScenarioHints } from '../domain/scenario.ts';
import { SessionService } from './auth/SessionService.ts';
import { SseBridge } from './SseBridge.ts';
import { WorkflowDslLoader } from '../engine/WorkflowDslLoader.ts';
import { WorkflowOrchestratorFacade } from '../engine/WorkflowOrchestratorFacade.ts';

export class WorkbenchHttpServer {
  private readonly orchestrator: WorkflowOrchestratorFacade;
  private readonly port: number;
  private activeRunId: string;
  private readonly sseClients: Map<http.ServerResponse, string>;
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
    this.sseClients = new Map<http.ServerResponse, string>();
    const orchestrator = new WorkflowOrchestratorFacade({
      maxNegotiationTurns: 3,
      highRiskThreshold: 60,
      persistenceDir: options?.persistenceDir,
      sandboxRootDir: options?.sandboxRootDir,
    });
    this.sessionService = new SessionService();
    this.orchestrator = orchestrator;
    this.sseBridge = new SseBridge((frame, eventName, seqId) => {
      this.sseClients.forEach((_clientData: string, clientRes: http.ServerResponse) => {
        try {
          // C1/D3：逐事件帧（run_event / user_notification）
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

  public async start(): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      try {
        await this.routeRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知服务器异常';
        const statusCode = message.includes('[RBAC') ? 403 : 400;
        this.sendJson(res, statusCode, { ok: false, error: message });
      }
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

  private resolveActorUserId(
    req: http.IncomingMessage,
    urlObj: URL,
    body?: Record<string, unknown>,
  ): string {
    // AUTH_DISABLED=true（本地开发/测试）→ 保留旧 X-Actor-Id 行为
    if (process.env.AUTH_DISABLED === 'true') {
      const headerActor = req.headers['x-actor-id'];
      if (typeof headerActor === 'string' && headerActor.trim().length > 0) {
        return headerActor.trim();
      }
      const queryActor = urlObj.searchParams.get('actorId');
      if (queryActor && queryActor.trim().length > 0) {
        return queryActor.trim();
      }
      if (body && typeof body.actorUserId === 'string' && body.actorUserId.trim().length > 0) {
        return body.actorUserId.trim();
      }
      return 'user-admin-01';
    }
    // F1：从会话 Cookie / Bearer token 提取 userId
    const cookieHeader = req.headers.cookie ?? '';
    const match = cookieHeader.match(/sdlc_session=([^\s;]+)/);
    if (match) {
      const user = this.sessionService.validate(match[1]);
      if (user) {
        return user.userId;
      }
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const user = this.sessionService.validate(authHeader.slice(7));
      if (user) {
        return user.userId;
      }
    }
    return 'UNAUTHENTICATED';
  }

  private broadcastSseStateUpdate(): void {
    if (this.sseClients.size === 0) {
      return;
    }
    for (const [clientRes, actorUserId] of this.sseClients.entries()) {
      try {
        const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
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

    if (method === 'GET' && pathname === '/api/events/stream') {
      const actorUserId = this.resolveActorUserId(req, urlObj);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const initialState = this.orchestrator.buildWorkbenchDashboardState(
        this.activeRunId,
        actorUserId,
      );
      res.write(`event: state_updated\ndata: ${JSON.stringify(initialState)}\n\n`);
      this.sseClients.set(res, actorUserId);
      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const actorUserId = this.resolveActorUserId(req, urlObj);
      const requestedRunId = urlObj.searchParams.get('runId') ?? this.activeRunId;
      this.activeRunId = requestedRunId;
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/runs/select') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const targetRunId = String(body.runId ?? '').trim();
      const runState = this.orchestrator.stateEngine.getRunOrThrow(targetRunId);
      this.activeRunId = runState.runId;
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
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
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const templateFileName = String(body.templateFileName ?? 'enterprise_sdlc.yaml');
      const available = WorkflowDslLoader.listAvailableTemplates();
      const matched = available.find((t) => t.fileName === templateFileName);
      if (!matched) {
        throw new Error(`未找到指定的工作流 YAML 模板: ${templateFileName}`);
      }
      this.orchestrator.reloadWorkflowDsl(matched.fullPath);

      const user = this.orchestrator.rbacService.getUserOrDefault(actorUserId);
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

      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    // ---- F1: 认证端点 ----
    // ---- A4: 模型基线体检端点（admin-only）——两级端点各发 3 个固定 JSON 任务 ----
    if (method === 'POST' && pathname === '/api/admin/model-baseline') {
      const actorUserId = this.resolveActorUserId(req, urlObj, {});
      if (process.env.AUTH_DISABLED !== 'true') {
        const user = this.sessionService.getUserById(actorUserId);
        if (!user || user.tier !== 'PROJECT_ADMIN') {
          this.sendJson(res, 403, { ok: false, error: '仅项目管理员可执行模型体检' });
          return;
        }
      }
      const result = await this.orchestrator.modelRouter.runModelBaselineCheck();
      this.sendJson(res, 200, { ok: true, data: result });
      return;
    }

    // ---- I2: 健康检查（运维探针） ----
    if (method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, {
        ok: true,
        data: {
          status: 'healthy',
          activeRunId: this.activeRunId,
          sseClients: this.sseClients.size,
          persistenceDir: process.env.LOCAL_PERSISTENCE_DIR ?? '.runtime-data',
          authDisabled: process.env.AUTH_DISABLED === 'true',
          databaseUrl: process.env.DATABASE_URL ? 'configured' : 'json-file-mode',
          llmLiveHttp: process.env.LITELLM_ENABLE_LIVE_HTTP === 'true',
          uptimeSec: Math.round(process.uptime()),
        },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await this.readJsonBody(req);
      const result = this.sessionService.login(
        String(body.username ?? ''),
        String(body.password ?? ''),
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
      const cookie = req.headers.cookie?.match(/sdlc_session=([^\s;]+)/);
      if (cookie) {
        this.sessionService.logout(cookie[1]);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': 'sdlc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const cookie = req.headers.cookie?.match(/sdlc_session=([^\s;]+)/);
      const token =
        cookie?.[1] ??
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '');
      const user = token ? this.sessionService.validate(token) : null;
      const impersonating = token ? this.sessionService.isImpersonating(token) : null;
      if (!user) {
        this.sendJson(res, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        data: { user, impersonating },
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/change-password') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      if (actorUserId === 'UNAUTHENTICATED') {
        this.sendJson(res, 401, { ok: false, error: '未登录' });
        return;
      }
      const result = this.sessionService.changePassword(
        actorUserId,
        String(body.oldPassword ?? ''),
        String(body.newPassword ?? ''),
      );
      if (!result.ok) {
        this.sendJson(res, 400, { ok: false, error: result.reason });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { message: '口令已更新，其他设备已退出登录' } });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/act-as') {
      const body = await this.readJsonBody(req);
      const cookie = req.headers.cookie?.match(/sdlc_session=([^\s;]+)/);
      const adminToken =
        cookie?.[1] ??
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '');
      const result = this.sessionService.actAs(adminToken, String(body.targetUserId ?? ''));
      if (!result) {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可切换视角' });
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
      const actorUserId = this.resolveActorUserId(req, urlObj);
      const user = this.sessionService.getUserById(actorUserId);
      if (!user || user.tier !== 'PROJECT_ADMIN') {
        this.sendJson(res, 403, { ok: false, error: '仅项目管理员可查看成员列表' });
        return;
      }
      this.sendJson(res, 200, { ok: true, data: { users: this.sessionService.listUsers() } });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/users') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const result = this.sessionService.createUser(actorUserId, {
        username: String(body.username ?? ''),
        displayName: String(body.displayName ?? ''),
        jobTitle: body.jobTitle ? String(body.jobTitle) : undefined,
        department: body.department ? String(body.department) : undefined,
        tier: String(body.tier ?? 'STAGE_SPECIALIST'),
        specialistDomain: String(body.specialistDomain ?? 'SOFTWARE_ENGINEERING'),
        counterpartAgentRole: String(body.counterpartAgentRole ?? 'ENGINEER_AGENT'),
        ownedStageIds: ((body.ownedStageIds as string[] | undefined) ?? []).map(String),
        avatarBadge: body.avatarBadge ? String(body.avatarBadge) : undefined,
        tempPassword: body.tempPassword ? String(body.tempPassword) : undefined,
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
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const targetUserId = pathname.split('/').pop() ?? '';
      const result = this.sessionService.updateUser(actorUserId, targetUserId, {
        displayName: body.displayName ? String(body.displayName) : undefined,
        jobTitle: body.jobTitle ? String(body.jobTitle) : undefined,
        ownedStageIds: body.ownedStageIds
          ? ((body.ownedStageIds as string[] | undefined) ?? []).map(String)
          : undefined,
        status: body.status ? (String(body.status) as 'ACTIVE' | 'DISABLED') : undefined,
      });
      if (!result.ok) {
        this.sendJson(res, result.reason === '不能停用最后一个 ACTIVE 管理员' ? 409 : 403, {
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
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
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
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const user = this.orchestrator.rbacService.getUserOrDefault(actorUserId);
      const preset = String(body.preset ?? 'CONFLICT_AND_DDL');

      let proposal: ProjectProposalContract;
      let scenarioHints: ScenarioHints = {};

      // J1：演示开关已迁出提案契约，由 preset 映射为 ScenarioHints（运行元数据）

      if (preset === 'CUSTOM') {
        const customTitle = String(body.title ?? '').trim();
        const customSummary = String(body.summary ?? '').trim() || customTitle;
        const rawReqs = (body.requirements as Record<string, string> | undefined) ?? {};
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
          involvesDatabaseMigration: Boolean(body.involvesDatabaseMigration),
          involvesPermissionOrPayment: Boolean(body.involvesPermissionOrPayment),
        });
        scenarioHints = {
          forceNegotiationDeadlock: Boolean(body.simulateNegotiationConflict),
          forceScopeReduction: Boolean(body.simulateScopeReductionAttempt),
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
          title: String(body.title ?? '企业级研发权限与智能工单协同模块'),
          summary: String(
            body.summary ??
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
        initiatorActor: String(body.initiatorActor ?? `${user.displayName} (${user.jobTitle})`),
        scenarioHints,
      });
      this.activeRunId = runState.runId;

      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/decisions') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const snapshotId = String(body.snapshotId ?? '');
      const verdict = String(body.verdict ?? DecisionVerdict.APPROVE) as DecisionVerdict;
      const reviewerActor = String(body.reviewerActor ?? '领域专家审核员');
      const comment = String(
        body.comment ?? '经人工交叉核验，当前阶段 Agent 契约产出符合质量标准，准予放行',
      );

      await this.orchestrator.submitHumanGateDecision({
        runId: this.activeRunId,
        snapshotId,
        reviewerActor,
        actorUserId,
        verdict,
        comment,
      });

      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/supervisor/rollback') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const dialogueInstruction = String(
        body.dialogueInstruction ?? '回退到 PD Agent，将弹窗改为双栏折叠侧边抽屉并重新执行下游阶段',
      );
      const explicitTargetStageId = body.targetStageId
        ? (String(body.targetStageId) as WorkflowStageId)
        : undefined;
      const humanActor = String(body.humanActor ?? '项目总负责人');

      await this.orchestrator.invokeSupervisorConversationalRollback({
        runId: this.activeRunId,
        humanActor,
        actorUserId,
        dialogueInstruction,
        explicitTargetStageId,
      });

      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/comments') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const stageId = String(body.stageId ?? WorkflowStageId.STAGE_1_PM) as WorkflowStageId;
      const content = String(body.content ?? '').trim();
      if (!content) {
        throw new Error('评论内容不能为空');
      }
      this.orchestrator.addTeamComment({
        runId: this.activeRunId,
        stageId,
        actorUserId,
        content,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'GET' && pathname === '/api/sandbox/file') {
      const runState = this.orchestrator.stateEngine.getRunOrThrow(this.activeRunId);
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
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const runState = this.orchestrator.stateEngine.getRunOrThrow(this.activeRunId);
      const verifyResult = this.orchestrator.sandboxManager.executeSandboxVerification({
        runId: runState.runId,
        branchId: runState.getActiveBranchId(),
        requirementIds: runState.proposal.coreRequirementIds,
        runSubprocessNodeTest: true,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
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
      const body = await this.readJsonBody(req);
      const stageId = String(body.stageId ?? WorkflowStageId.STAGE_3A_TECH_SPEC) as WorkflowStageId;
      const queryText = String(body.queryText ?? '').trim();
      const matches = await this.orchestrator.auditLedger.ragEngine.retrieveTopKSimilarLessons({
        stageId,
        queryText,
        topK: 5,
      });
      this.sendJson(res, 200, { ok: true, data: { matches } });
      return;
    }

    if (method === 'POST' && pathname === '/api/rag/ingest') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      const user = this.orchestrator.rbacService.getUserOrDefault(actorUserId);
      const stageId = String(body.stageId ?? WorkflowStageId.STAGE_3A_TECH_SPEC) as WorkflowStageId;
      const rawLesson = String(body.lessonText ?? '').trim();
      if (!rawLesson) {
        throw new Error('避坑经验内容不能为空');
      }
      this.orchestrator.auditLedger.registerRejectionLesson(
        stageId,
        `[${user.displayName} 录入企业红线] ${rawLesson}`,
      );
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
      this.sendJson(res, 200, { ok: true, data: state });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/governance') {
      const body = await this.readJsonBody(req);
      const actorUserId = this.resolveActorUserId(req, urlObj, body);
      this.orchestrator.updateAdminGovernanceConfig({
        actorUserId,
        maxNegotiationTurns:
          body.maxNegotiationTurns !== undefined ? Number(body.maxNegotiationTurns) : undefined,
        highRiskScoreThreshold:
          body.highRiskScoreThreshold !== undefined
            ? Number(body.highRiskScoreThreshold)
            : undefined,
        allowSpecialistCrossStageRollback:
          body.allowSpecialistCrossStageRollback !== undefined
            ? Boolean(body.allowSpecialistCrossStageRollback)
            : undefined,
      });
      const state = this.orchestrator.buildWorkbenchDashboardState(this.activeRunId, actorUserId);
      this.broadcastSseStateUpdate();
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
