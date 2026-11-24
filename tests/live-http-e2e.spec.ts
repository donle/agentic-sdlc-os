/**
 * @file live-http-e2e.spec.ts
 * @description P1-4 部署配置契约校验 & 真实 TCP HTTP + 本地 OpenAI 兼容端点 + Cookie Auth + SSE 端到端测试。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { checkHostPrerequisites, runHttpSmokeAgainstUrl } from '../scripts/e2e-live-stack.ts';
import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';

interface ChatCompletionRequestBody {
  readonly model?: string;
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}

interface EmbeddingRequestBody {
  readonly model?: string;
  readonly input?: string;
}

interface MockInferenceMetrics {
  chatRequests: number;
  embeddingRequests: number;
  modelsRequested: string[];
}

function listAllSourceTsFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist') {
        continue;
      }
      files.push(...listAllSourceTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildDeterministicVector(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0);
  let seed = 17;
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) % 9973;
    vec[seed % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function buildStageJsonResponse(systemPrompt: string, userPrompt: string): string {
  const marker = '以下为本阶段的全部结构化输入（JSON）：\n';
  const markerIdx = userPrompt.indexOf(marker);
  let payload: Record<string, unknown> = {};
  if (markerIdx !== -1) {
    try {
      payload = JSON.parse(userPrompt.slice(markerIdx + marker.length)) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  const proposal = (payload.proposal as Record<string, unknown> | undefined) ?? {};
  const coreReqIds = Array.isArray(proposal.coreRequirementIds)
    ? proposal.coreRequirementIds.map(String)
    : ['REQ_DEFAULT'];
  const upstreamDigests = (payload.upstreamDigests as Record<string, unknown> | undefined) ?? {};
  const sandboxEnv = (payload.sandboxVerification as Record<string, unknown> | undefined) ?? {};

  if (systemPrompt.includes('上下文规划器')) {
    return JSON.stringify({ needs: [] });
  }
  if (systemPrompt.includes('受限协商中的响应方')) {
    return JSON.stringify({
      action: 'ESCALATE_TRADEOFF',
      responseResolution: '实时 HTTP 协商响应：PM/PD 保留全部需求条目，申请人工裁决组件展示形式',
      concretePatch: '保持全部需求 ID 与验收标准不变',
      optionAProposal: '方案 A：保留完整交互矩阵抽屉',
      optionBProposal: '方案 B：紧凑侧边面板展示关键字段',
    });
  }
  if (systemPrompt.includes('挑战方独立复核者')) {
    return JSON.stringify({
      accepted: true,
      critique: '挑战方独立复核通过，无隐性范围缩水',
      containsImplicitScopeCut: false,
    });
  }
  if (systemPrompt.includes('独立盲审裁判')) {
    return JSON.stringify({
      hasImplicitDowngrade: false,
      reason: '未发现范围削减或质量降级',
    });
  }
  if (systemPrompt.includes('研发流水线总管 Agent')) {
    return JSON.stringify({
      targetStageId: 'STAGE_2_PD',
      cleanInstruction: '按人工指令调整 PD 设计组件布局并重跑下游阶段',
    });
  }

  if (systemPrompt.includes('PM Agent')) {
    return JSON.stringify({
      summary: `已完成 ${String(proposal.title ?? '提案')} 的 Live HTTP PRD 拆解与埋点规划`,
      coreRequirementIds: coreReqIds,
      userStories: coreReqIds.map((reqId) => ({
        reqId,
        story: `作为企业研发角色，我需要完成 ${reqId} 的端到端能力闭环`,
        acceptanceCriteria: [`${reqId} 接口响应时间 < 200ms`, `${reqId} 全程留痕审计`],
      })),
      trackingPlanEvents: coreReqIds.map((reqId) => ({
        eventName: `evt_${reqId.toLowerCase()}_completed`,
        triggerCondition: `${reqId} 状态变更成功时上报`,
        properties: ['run_id', 'actor_user_id'],
      })),
      nonFunctionalConstraints: ['强制本地私有化脱敏', '全操作审计可回溯'],
      __intent: {
        intentCode: 'LIVE_PRD_SYNTHESIS',
        intentDescription: '实时模型完成 PRD 需求拆解',
        confidenceScore: 0.96,
      },
    });
  }

  if (systemPrompt.includes('PD Agent')) {
    const isSeedDeadlock = String(proposal.proposalId ?? '') === 'PROP-ENT-2026-01';
    return JSON.stringify({
      summary: '已完成 Design System 组件映射与无障碍规范核查',
      coreRequirementIds: coreReqIds,
      componentMappings: coreReqIds.map((reqId) => ({
        reqId,
        designSystemComponent: 'MeridianDataPanel',
        interactionStates: ['default', 'loading', 'error'],
      })),
      accessibilityChecklist: ['WCAG AA 对比度达标', '完整键盘 Tab 导航', 'ARIA live 状态播报'],
      designChallengeNote: isSeedDeadlock
        ? '复杂权限矩阵与多栏画布在紧凑视图下的交互优先级存在分歧，需确认呈现方式'
        : null,
      __intent: {
        intentCode: 'LIVE_UI_MAPPING',
        intentDescription: '实时模型完成 UI 规范映射',
        confidenceScore: 0.95,
      },
    });
  }

  if (systemPrompt.includes('Tech Lead Agent')) {
    const highRisk =
      Boolean(proposal.involvesDatabaseMigration) || Boolean(proposal.involvesPermissionOrPayment);
    return JSON.stringify({
      summary: '已完成技术架构契约、接口定义与风险评级',
      coreRequirementIds: coreReqIds,
      apiContracts: coreReqIds.map((reqId) => ({
        method: 'POST',
        endpoint: `/api/v1/${reqId.toLowerCase()}`,
        requestSchema: `${reqId}Request`,
        responseSchema: `${reqId}Response`,
      })),
      databaseDdlStatements: proposal.involvesDatabaseMigration
        ? ['ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS audit_tag TEXT;']
        : [],
      declaredRiskLevel: highRisk ? 'HIGH' : 'LOW',
      architecturePatternsUsed: ['Template Method', 'Repository Pattern'],
      __intent: {
        intentCode: 'LIVE_TECH_SPEC',
        intentDescription: '实时模型完成架构契约设计',
        confidenceScore: 0.96,
      },
    });
  }

  if (systemPrompt.includes('Engineer Agent')) {
    const rawBranch =
      typeof sandboxEnv.gitWorktreeBranch === 'string'
        ? sandboxEnv.gitWorktreeBranch
        : 'worktree/live/default';
    const rawFiles = Array.isArray(sandboxEnv.modifiedFiles) ? sandboxEnv.modifiedFiles : [];
    const modifiedFiles =
      rawFiles.length > 0
        ? rawFiles
        : coreReqIds.map((reqId) => ({
            filePath: `src/${reqId.toLowerCase()}.ts`,
            className: `${reqId}Handler`,
            designPattern: 'Strategy',
            linesChanged: 36,
          }));
    return JSON.stringify({
      summary: `已在沙箱分支 ${rawBranch} 完成代码实现与自测`,
      coreRequirementIds: coreReqIds,
      gitWorktreeBranch: rawBranch,
      modifiedFiles,
      selfTestPassed: sandboxEnv.selfTestPassed !== false,
      __intent: {
        intentCode: 'LIVE_ENGINEER_IMPL',
        intentDescription: '实时模型完成工程实现与自测',
        confidenceScore: 0.95,
      },
    });
  }

  if (systemPrompt.includes('QA Agent')) {
    const rawSuites = Array.isArray(sandboxEnv.suites) ? sandboxEnv.suites : [];
    const suites =
      rawSuites.length > 0
        ? rawSuites.map((item) => {
            const s = item as Record<string, unknown>;
            return {
              suiteName: String(s.suiteName ?? 'sandbox.spec.ts'),
              totalCases: Number(s.totalCases ?? 1),
              passedCases: Number(s.passedCases ?? 1),
              coveragePercent: Number(s.coveragePercent ?? 100),
            };
          })
        : [
            {
              suiteName: 'sandbox-live.spec.ts',
              totalCases: 1,
              passedCases: 1,
              coveragePercent: 100,
            },
          ];
    const securityIssuesFound = Number(sandboxEnv.securityIssuesFound ?? 0);
    const allMet = sandboxEnv.allAcceptanceCriteriaMet !== false && securityIssuesFound === 0;
    return JSON.stringify({
      summary: '已完成基于真实沙箱测试输出的 QA 验收报告',
      coreRequirementIds: coreReqIds,
      testSuitesExecuted: suites,
      securityIssuesFound,
      allAcceptanceCriteriaMet: allMet,
      __intent: {
        intentCode: 'LIVE_QA_VERIFY',
        intentDescription: '实时模型完成 QA 自动化核验',
        confidenceScore: 0.97,
      },
    });
  }

  // Stage 5 DA or generic fallback
  const prdDigest = (upstreamDigests.STAGE_1_PM as Record<string, unknown> | undefined) ?? {};
  const trackingNames = Array.isArray(prdDigest.trackingEventNames)
    ? prdDigest.trackingEventNames.map(String)
    : coreReqIds.map((reqId) => `evt_${reqId.toLowerCase()}_completed`);
  return JSON.stringify({
    summary: '已完成埋点核验与发布指标归因建模',
    coreRequirementIds: coreReqIds,
    verifiedTrackingEvents: trackingNames,
    projectedMetrics: [
      { metricName: '需求交付周期', baselineValue: '14d', targetValue: '4d' },
      { metricName: '契约一致性', baselineValue: '80%', targetValue: '99%' },
      { metricName: '回归故障率', baselineValue: '5%', targetValue: '<0.5%' },
    ],
    __intent: {
      intentCode: 'LIVE_DA_AUDIT',
      intentDescription: '实时模型完成埋点核验',
      confidenceScore: 0.95,
    },
  });
}

async function startMockOpenAiHttpServer(): Promise<{
  readonly server: http.Server;
  readonly baseUrl: string;
  readonly metrics: MockInferenceMetrics;
}> {
  const metrics: MockInferenceMetrics = {
    chatRequests: 0,
    embeddingRequests: 0,
    modelsRequested: [],
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf-8');
      const reqUrl = req.url ?? '/';
      if (reqUrl.startsWith('/v1/chat/completions')) {
        metrics.chatRequests += 1;
        const body = (rawBody ? JSON.parse(rawBody) : {}) as ChatCompletionRequestBody;
        if (body.model) {
          metrics.modelsRequested.push(body.model);
        }
        const sysMsg =
          body.messages?.find((m) => m.role === 'system')?.content ?? '你是研发流水线 Agent';
        const usrMsg = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const content = buildStageJsonResponse(sysMsg, usrMsg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-live-${metrics.chatRequests}`,
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 180, completion_tokens: 95, total_tokens: 275 },
          }),
        );
        return;
      }

      if (reqUrl.startsWith('/v1/embeddings')) {
        metrics.embeddingRequests += 1;
        const body = (rawBody ? JSON.parse(rawBody) : {}) as EmbeddingRequestBody;
        if (body.model) {
          metrics.modelsRequested.push(body.model);
        }
        const dim = Number(process.env.RAG_VECTOR_DIM ?? 1024);
        const embedding = buildDeterministicVector(String(body.input ?? ''), dim);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ embedding }],
            usage: { prompt_tokens: 32, total_tokens: 32 },
          }),
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown mock inference route: ${reqUrl}` }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, metrics };
}

function restoreEnvVars(snapshot: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(snapshot)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

describe('P1-4 部署配置硬化与真实 TCP/OpenAI HTTP 端到端闭环测试', () => {
  it('1. Dockerfile 应为多阶段构建、builder 不跳过构建脚本、非 root 运行并配置 HEALTHCHECK', () => {
    const dockerfilePath = path.resolve(process.cwd(), 'Dockerfile');
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    const runtimeIdx = content.indexOf('FROM node:22-alpine AS runtime');

    assert.ok(content.includes('FROM node:22-alpine AS builder'), '应声明 builder 构建阶段');
    assert.ok(runtimeIdx !== -1, '应声明 runtime 运行阶段');

    const builderSection = content.slice(0, runtimeIdx);
    const runtimeSection = content.slice(runtimeIdx);

    assert.ok(
      !builderSection.includes('--ignore-scripts'),
      'builder 阶段不得使用 --ignore-scripts 以确保 esbuild 二进制正常安装',
    );
    assert.ok(builderSection.includes('npm run build:ui'), 'builder 阶段应完成 UI 构建');
    assert.ok(runtimeSection.includes('git'), 'runtime 阶段应保留 git');
    assert.ok(runtimeSection.includes('postgresql-client'), 'runtime 阶段应保留 postgresql-client');
    assert.ok(runtimeSection.includes('wget'), 'runtime 阶段应安装 wget 供 HEALTHCHECK 探活');
    assert.ok(runtimeSection.includes('USER node'), 'runtime 阶段应以非 root node 用户运行');
    assert.ok(runtimeSection.includes('HEALTHCHECK'), 'runtime 阶段应声明 HEALTHCHECK');
    assert.ok(runtimeSection.includes('/api/health'), 'HEALTHCHECK 应探测 /api/health');
    assert.ok(
      runtimeSection.includes('"start:server"') && !runtimeSection.includes('["npm", "start"]'),
      '容器启动命令应直连 start:server，避免每次启动重复 build:ui',
    );
  });

  it('2. deploy/docker-compose.yml 与 litellm_config.yaml 应具备健康检查、持久卷与完整模型映射', () => {
    const composePath = path.resolve(process.cwd(), 'deploy', 'docker-compose.yml');
    const litellmPath = path.resolve(process.cwd(), 'deploy', 'litellm_config.yaml');
    assert.ok(fs.existsSync(litellmPath), 'deploy/litellm_config.yaml 必须存在');

    const composeDoc = parseYaml(fs.readFileSync(composePath, 'utf-8')) as {
      services?: Record<
        string,
        {
          depends_on?: Record<string, { condition?: string }>;
          environment?: string[];
          volumes?: string[];
          healthcheck?: { test?: string[] };
          command?: string[];
        }
      >;
      volumes?: Record<string, unknown>;
    };

    const pg = composeDoc.services?.['postgres-pgvector'];
    const litellm = composeDoc.services?.['litellm-router'];
    const workbench = composeDoc.services?.['agentic-workbench'];

    assert.ok(
      pg?.healthcheck?.test?.join(' ').includes('pg_isready'),
      'postgres-pgvector 应配置 pg_isready healthcheck',
    );
    assert.ok(
      litellm?.volumes?.some((v) => v.includes('litellm_config.yaml:/app/config.yaml:ro')),
      'litellm-router 应挂载 ./litellm_config.yaml',
    );
    assert.ok(
      litellm?.healthcheck?.test?.join(' ').includes('4000/health/liveliness'),
      'litellm-router 应配置健康检查探针',
    );
    assert.equal(
      workbench?.depends_on?.['postgres-pgvector']?.condition,
      'service_healthy',
      'agentic-workbench 应等待 postgres-pgvector service_healthy',
    );
    assert.equal(
      workbench?.depends_on?.['litellm-router']?.condition,
      'service_healthy',
      'agentic-workbench 应等待 litellm-router service_healthy',
    );

    const envList = workbench?.environment ?? [];
    for (const requiredPrefix of [
      'LITELLM_ENABLE_LIVE_HTTP=true',
      'LOCAL_PERSISTENCE_DIR=',
      'SANDBOX_WORKTREE_ROOT=',
      'AUTH_REQUIRED=',
      'RAG_VECTOR_DIM=',
    ]) {
      assert.ok(
        envList.some((item) => item.startsWith(requiredPrefix)),
        `agentic-workbench.environment 应包含 ${requiredPrefix}`,
      );
    }

    assert.ok(composeDoc.volumes?.runtime_data !== undefined, 'Compose 应声明 runtime_data 持久卷');
    assert.ok(
      composeDoc.volumes?.sandbox_worktrees !== undefined,
      'Compose 应声明 sandbox_worktrees 持久卷',
    );

    const litellmDoc = parseYaml(fs.readFileSync(litellmPath, 'utf-8')) as {
      model_list?: ReadonlyArray<{ model_name?: string }>;
    };
    const declaredModels = new Set((litellmDoc.model_list ?? []).map((m) => m.model_name));
    for (const expectedModel of [
      'qwen2.5-coder-32b-instruct-int4',
      'qwen2.5-coder-32b-instruct-local',
      'claude-3-7-sonnet-enterprise',
      'bge-m3-local',
    ]) {
      assert.ok(
        declaredModels.has(expectedModel),
        `deploy/litellm_config.yaml 应配置模型 ${expectedModel}`,
      );
    }
  });

  it('3. deploy/.env.example 应覆盖 src/ 中引用的全部环境变量（零漂移校验）', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const envExamplePath = path.resolve(process.cwd(), 'deploy', '.env.example');
    const envExampleContent = fs.readFileSync(envExamplePath, 'utf-8');
    const tsFiles = listAllSourceTsFiles(srcDir);
    const usedEnvVars = new Set<string>();
    const regex = /process\.env\.([A-Z0-9_]+)/g;

    for (const file of tsFiles) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const match of text.matchAll(regex)) {
        const varName = match[1];
        if (varName && varName !== 'NODE_ENV') {
          usedEnvVars.add(varName);
        }
      }
    }

    const documentedKeys = new Set<string>();
    for (const line of envExampleContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        documentedKeys.add(trimmed.slice(0, eqIdx).trim());
      }
    }

    const missingVars = [...usedEnvVars].filter((name) => !documentedKeys.has(name)).sort();
    assert.deepEqual(
      missingVars,
      [],
      `deploy/.env.example 缺少环境变量: ${missingVars.join(', ')}`,
    );
  });

  it('4. 真实 TCP HTTP + 本地 OpenAI 兼容服务端 + AUTH_REQUIRED=true + SSE + 决策/回退全链路 E2E', async () => {
    const envKeys = [
      'LITELLM_ENABLE_LIVE_HTTP',
      'LITELLM_GATEWAY_URL',
      'OLLAMA_API_BASE',
      'RAG_VECTOR_DIM',
      'AUTH_REQUIRED',
      'AUTH_DISABLED',
      'COOKIE_SECURE',
    ] as const;
    const prevEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
    }

    const tmpPersistence = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p1-4-e2e-data-'));
    const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p1-4-e2e-sb-'));
    const mockOpenAi = await startMockOpenAiHttpServer();
    let httpServer: http.Server | null = null;

    try {
      process.env.LITELLM_ENABLE_LIVE_HTTP = 'true';
      process.env.LITELLM_GATEWAY_URL = mockOpenAi.baseUrl;
      process.env.OLLAMA_API_BASE = mockOpenAi.baseUrl;
      process.env.RAG_VECTOR_DIM = '1024';
      process.env.AUTH_REQUIRED = 'true';
      process.env.AUTH_DISABLED = 'false';
      process.env.COOKIE_SECURE = 'false';

      const workbench = new WorkbenchHttpServer(0, {
        persistenceDir: tmpPersistence,
        sandboxRootDir: tmpSandbox,
        rateLimits: { windowMs: 60_000, loginMaxPerWindow: 50, expensiveMaxPerWindow: 50 },
      });
      httpServer = await workbench.start();
      const addr = httpServer.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1) 未登录拦截校验
      const unauthState = await fetch(`${baseUrl}/api/state`);
      assert.equal(unauthState.status, 401, 'AUTH_REQUIRED=true 时匿名请求 /api/state 应返回 401');

      // 2) 健康检查与静态资源
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes('<!doctype html') || htmlText.includes('<html'));
      const bundleRes = await fetch(`${baseUrl}/dist/main.js`);
      assert.equal(bundleRes.status, 200);
      const bundleText = await bundleRes.text();
      assert.ok(bundleText.length > 1000, '/dist/main.js 应返回打包后的前端 bundle');

      // 3) 登录与首次改密强制拦截
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      });
      assert.equal(loginRes.status, 200);
      const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      assert.ok(cookie.includes('sdlc_session='), '登录应下发 HttpOnly Cookie');
      const loginPayload = (await loginRes.json()) as {
        data: { user: { mustChangePassword: boolean } };
      };
      assert.equal(loginPayload.data.user.mustChangePassword, true);

      // 未改密前调用业务接口应被 403 拦截
      const blockedBeforePwd = await fetch(`${baseUrl}/api/state`, {
        headers: { Cookie: cookie },
      });
      assert.equal(blockedBeforePwd.status, 403);

      const changePwdRes = await fetch(`${baseUrl}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ oldPassword: 'admin', newPassword: 'AdminPass2026!' }),
      });
      assert.equal(changePwdRes.status, 200);

      // 4) 管理员用户管理与登录审计查询
      const createUserRes = await fetch(`${baseUrl}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          username: 'qa_live_e2e',
          displayName: 'E2E 测试专员',
          tier: 'STAGE_SPECIALIST',
          specialistDomain: 'QUALITY_ASSURANCE',
          counterpartAgentRole: 'QA_AGENT',
          ownedStageIds: ['STAGE_4_QA'],
        }),
      });
      assert.equal(createUserRes.status, 201);
      const listUsersRes = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Cookie: cookie },
      });
      assert.equal(listUsersRes.status, 200);
      const usersJson = (await listUsersRes.json()) as {
        data: { users: Array<{ username: string }> };
      };
      assert.ok(usersJson.data.users.some((u) => u.username === 'qa_live_e2e'));

      const auditRes = await fetch(`${baseUrl}/api/admin/login-audit?limit=10`, {
        headers: { Cookie: cookie },
      });
      assert.equal(auditRes.status, 200);

      // 5) 发起高风险提案 -> 验证真实 TCP HTTP 调用 OpenAI 兼容模型与嵌入端点
      const chatBefore = mockOpenAi.metrics.chatRequests;
      const embBefore = mockOpenAi.metrics.embeddingRequests;
      const propRes = await fetch(`${baseUrl}/api/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          preset: 'CUSTOM',
          title: 'Live HTTP E2E 全链路审批测试',
          summary: '包含 DDL 迁移与实时网关调用校验',
          requirements: {
            REQ_E2E_AUTH: '确保全接口鉴权生效',
            REQ_E2E_AUDIT: '确保全链路日志落盘',
          },
          involvesDatabaseMigration: true,
          involvesPermissionOrPayment: true,
        }),
      });
      assert.equal(propRes.status, 200);
      const propJson = (await propRes.json()) as {
        data: {
          run: { runId: string; status: string };
          notifications: Array<{
            relatedSnapshotId: string;
            runId: string;
            stageId: string;
            requiresHumanAction: boolean;
            resolved: boolean;
          }>;
        };
      };
      const runId = propJson.data.run.runId;
      assert.ok(
        mockOpenAi.metrics.chatRequests > chatBefore,
        '应真实通过 HTTP POST 请求 /v1/chat/completions',
      );
      assert.ok(
        mockOpenAi.metrics.embeddingRequests > embBefore,
        '应真实通过 HTTP POST 请求 /v1/embeddings',
      );
      let currentNotifications = propJson.data.notifications.filter(
        (n) => n.requiresHumanAction && !n.resolved,
      );
      assert.ok(currentNotifications.length >= 1, '高风险提案应触发人工门禁通知');

      // 6) 建立真实 SSE 连接校验事件推送
      const sseController = new AbortController();
      const sseRes = await fetch(
        `${baseUrl}/api/events/stream?runId=${encodeURIComponent(runId)}`,
        {
          headers: { Cookie: cookie },
          signal: sseController.signal,
        },
      );
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body?.getReader();
      assert.ok(reader, 'SSE 应返回可读流');
      const firstChunk = await reader.read();
      const chunkText = firstChunk.value ? new TextDecoder().decode(firstChunk.value) : '';
      assert.ok(
        chunkText.includes('event: state_updated') && chunkText.includes(runId),
        'SSE 首帧应包含目标 runId 的 state_updated 事件',
      );
      await reader.cancel().catch(() => undefined);
      sseController.abort();

      // 7) 门禁放行推进 + 总管工具检查 + 对话回退分叉
      let guardSteps = 0;
      while (currentNotifications.length > 0 && guardSteps < 4) {
        guardSteps += 1;
        const notif = currentNotifications[0];
        const decRes = await fetch(`${baseUrl}/api/decisions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            runId,
            snapshotId: notif.relatedSnapshotId,
            verdict: 'APPROVE',
            comment: 'Live HTTP E2E 审核放行',
          }),
        });
        assert.equal(decRes.status, 200);
        const decJson = (await decRes.json()) as {
          data: {
            run: { status: string };
            notifications: Array<{
              relatedSnapshotId: string;
              runId: string;
              stageId: string;
              requiresHumanAction: boolean;
              resolved: boolean;
            }>;
          };
        };
        currentNotifications = decJson.data.notifications.filter(
          (n) => n.requiresHumanAction && !n.resolved,
        );
        if (decJson.data.run.status === 'COMPLETED') {
          break;
        }
      }

      const toolsRes = await fetch(`${baseUrl}/api/supervisor/tools`, {
        headers: { Cookie: cookie },
      });
      assert.equal(toolsRes.status, 200);

      const overviewRes = await fetch(`${baseUrl}/api/supervisor/tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ toolName: 'get_run_overview', runId }),
      });
      assert.equal(overviewRes.status, 200);
      const overviewJson = (await overviewRes.json()) as { ok?: boolean };
      assert.equal(overviewJson.ok, true);

      const rollbackRes = await fetch(`${baseUrl}/api/supervisor/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          runId,
          targetStageId: 'STAGE_2_PD',
          dialogueInstruction: '回退到 Stage 2 并按紧凑抽屉布局重排',
        }),
      });
      assert.equal(rollbackRes.status, 200);
      const rollbackJson = (await rollbackRes.json()) as {
        data: { run: { activeBranchId: string } };
      };
      assert.notEqual(rollbackJson.data.run.activeBranchId, 'branch-main', '回退后应产生分叉分支');
    } finally {
      if (httpServer) {
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
      mockOpenAi.server.closeAllConnections?.();
      await new Promise<void>((resolve) => mockOpenAi.server.close(() => resolve()));
      restoreEnvVars(prevEnv);
      fs.rmSync(tmpPersistence, { recursive: true, force: true });
      fs.rmSync(tmpSandbox, { recursive: true, force: true });
    }
  });

  it('5. e2e-live-stack 脚本的 checkHostPrerequisites 与 runHttpSmokeAgainstUrl 应可执行闭环', async () => {
    const prereqs = checkHostPrerequisites();
    assert.equal(typeof prereqs.dockerAvailable, 'boolean');
    assert.equal(typeof prereqs.psqlAvailable, 'boolean');
    assert.equal(typeof prereqs.ollamaAvailable, 'boolean');

    const envKeys = ['AUTH_REQUIRED', 'AUTH_DISABLED', 'COOKIE_SECURE'] as const;
    const prevEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) {
      prevEnv[key] = process.env[key];
    }

    const tmpPersistence = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p1-4-smoke-data-'));
    const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-p1-4-smoke-sb-'));
    let httpServer: http.Server | null = null;

    try {
      process.env.AUTH_REQUIRED = 'true';
      process.env.AUTH_DISABLED = 'false';
      process.env.COOKIE_SECURE = 'false';

      const workbench = new WorkbenchHttpServer(0, {
        persistenceDir: tmpPersistence,
        sandboxRootDir: tmpSandbox,
        rateLimits: { windowMs: 60_000, loginMaxPerWindow: 50, expensiveMaxPerWindow: 50 },
      });
      httpServer = await workbench.start();
      const addr = httpServer.address() as AddressInfo;
      const report = await runHttpSmokeAgainstUrl(`http://127.0.0.1:${addr.port}`);
      assert.equal(
        report.ok,
        true,
        `runHttpSmokeAgainstUrl 失败: ${JSON.stringify(report.steps, null, 2)}`,
      );
      assert.ok(report.steps.length >= 6);
    } finally {
      if (httpServer) {
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
      }
      restoreEnvVars(prevEnv);
      fs.rmSync(tmpPersistence, { recursive: true, force: true });
      fs.rmSync(tmpSandbox, { recursive: true, force: true });
    }
  });
});
