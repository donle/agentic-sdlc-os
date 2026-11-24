/**
 * @file e2e-live-stack.ts
 * @description P1-4 实网运行栈与部署健康检查/E2E 验证脚本：
 * 1. `--check-env`: 检测宿主机是否安装 docker / psql / ollama 以及关键环境变量配置情况；
 * 2. `--compose-config`: 校验 `deploy/docker-compose.yml` 编排语法与依赖拓扑；
 * 3. `--pg-verify`: 对目标 DATABASE_URL 幂等应用 `deploy/init-pgvector-schema.sql` 并核对 pgvector 扩展与全部 14 张表；
 * 4. `--http-smoke [url]`: 对运行中的 Workbench 实例执行真实 HTTP 健康检查、认证登录、首次改密、提案创建、SSE 首帧接收与总管工具调用校验。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HostPrerequisitesReport {
  readonly dockerAvailable: boolean;
  readonly dockerComposeAvailable: boolean;
  readonly psqlAvailable: boolean;
  readonly ollamaAvailable: boolean;
  readonly databaseUrlConfigured: boolean;
  readonly liveHttpEnabled: boolean;
}

export interface CommandCheckOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

export interface HttpSmokeStepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface HttpSmokeReport {
  readonly baseUrl: string;
  readonly ok: boolean;
  readonly steps: ReadonlyArray<HttpSmokeStepResult>;
}

const EXPECTED_PG_TABLES: ReadonlyArray<string> = [
  'workflow_runs',
  'dag_branches',
  'stage_snapshots',
  'human_decisions',
  'rejected_history_rag',
  'semantic_intent_cache',
  'intent_execution_traces',
  'stage_comments',
  'users',
  'auth_sessions',
  'auth_login_audit',
  'notifications',
  'live_events',
  'audit_entries',
  'system_runtime_state',
];

function isBinaryAvailable(binary: string, args: ReadonlyArray<string>): boolean {
  try {
    execFileSync(binary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export function checkHostPrerequisites(): HostPrerequisitesReport {
  return {
    dockerAvailable: isBinaryAvailable('docker', ['--version']),
    dockerComposeAvailable: isBinaryAvailable('docker', ['compose', 'version']),
    psqlAvailable: isBinaryAvailable('psql', ['--version']),
    ollamaAvailable: isBinaryAvailable('ollama', ['--version']),
    databaseUrlConfigured: Boolean(process.env.DATABASE_URL?.trim()),
    liveHttpEnabled: process.env.LITELLM_ENABLE_LIVE_HTTP === 'true',
  };
}

export function verifyComposeConfig(repoRoot = process.cwd()): CommandCheckOutcome {
  const composePath = path.resolve(repoRoot, 'deploy', 'docker-compose.yml');
  try {
    execFileSync('docker', ['compose', '-f', composePath, 'config', '--quiet'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return { ok: true, detail: `docker compose config passed (${composePath})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `docker compose config skipped/failed: ${msg}` };
  }
}

export function verifyPgSchema(
  databaseUrl = process.env.DATABASE_URL ?? '',
  repoRoot = process.cwd(),
): CommandCheckOutcome {
  if (!databaseUrl.trim()) {
    return { ok: false, detail: 'DATABASE_URL 未设置' };
  }
  const schemaPath = path.resolve(repoRoot, 'deploy', 'init-pgvector-schema.sql');
  try {
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', schemaPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    const tableOutput = execFileSync(
      'psql',
      [
        databaseUrl,
        '-t',
        '-A',
        '-c',
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        encoding: 'utf-8',
      },
    );
    const existingTables = new Set(
      tableOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    const missing = EXPECTED_PG_TABLES.filter((table) => !existingTables.has(table));
    if (missing.length > 0) {
      return { ok: false, detail: `PG 缺少表: ${missing.join(', ')}` };
    }

    const vectorExt = execFileSync(
      'psql',
      [databaseUrl, '-t', '-A', '-c', "SELECT extname FROM pg_extension WHERE extname = 'vector';"],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        encoding: 'utf-8',
      },
    ).trim();
    if (vectorExt !== 'vector') {
      return { ok: false, detail: 'PG 未安装或未启用 pgvector 扩展' };
    }
    return {
      ok: true,
      detail: `PG schema & pgvector verified (${EXPECTED_PG_TABLES.length} tables)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `PG schema verify failed: ${msg}` };
  }
}

function extractCookieHeader(headers: Headers): string | null {
  const raw = headers.get('set-cookie');
  if (!raw) {
    return null;
  }
  const firstSegment = raw.split(';')[0]?.trim();
  return firstSegment && firstSegment.includes('=') ? firstSegment : null;
}

export async function runHttpSmokeAgainstUrl(
  baseUrl: string,
  options?: {
    readonly username?: string;
    readonly initialPassword?: string;
    readonly updatedPassword?: string;
  },
): Promise<HttpSmokeReport> {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const username = options?.username ?? 'admin';
  const initialPassword = options?.initialPassword ?? 'admin';
  const updatedPassword = options?.updatedPassword ?? 'AdminPass2026!';
  const steps: HttpSmokeStepResult[] = [];
  let cookieHeader: string | null;

  const pushStep = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
  };

  try {
    const healthRes = await fetch(`${cleanBase}/api/health`);
    const healthJson = (await healthRes.json()) as { ok?: boolean; data?: { status?: string } };
    const healthOk = healthRes.status === 200 && healthJson.ok === true;
    pushStep('GET /api/health', healthOk, `status=${healthRes.status}`);
    if (!healthOk) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    const htmlRes = await fetch(`${cleanBase}/`);
    const bundleRes = await fetch(`${cleanBase}/dist/main.js`);
    const assetsOk = htmlRes.status === 200 && bundleRes.status === 200;
    pushStep(
      'GET / & /dist/main.js',
      assetsOk,
      `html=${htmlRes.status}, bundle=${bundleRes.status}`,
    );
    if (!assetsOk) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    let loginRes = await fetch(`${cleanBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: initialPassword }),
    });
    if (loginRes.status === 401 && updatedPassword !== initialPassword) {
      loginRes = await fetch(`${cleanBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: updatedPassword }),
      });
    }
    const loginJson = (await loginRes.json()) as {
      ok?: boolean;
      data?: { user?: { mustChangePassword?: boolean } };
    };
    cookieHeader = extractCookieHeader(loginRes.headers);
    const loginOk = loginRes.status === 200 && loginJson.ok === true && cookieHeader !== null;
    pushStep(
      'POST /api/auth/login',
      loginOk,
      `status=${loginRes.status}, hasCookie=${cookieHeader !== null}`,
    );
    if (!loginOk || !cookieHeader) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    if (loginJson.data?.user?.mustChangePassword) {
      const chgRes = await fetch(`${cleanBase}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({ oldPassword: initialPassword, newPassword: updatedPassword }),
      });
      const chgJson = (await chgRes.json()) as { ok?: boolean };
      const chgOk = chgRes.status === 200 && chgJson.ok === true;
      pushStep('POST /api/auth/change-password', chgOk, `status=${chgRes.status}`);
      if (!chgOk) {
        return { baseUrl: cleanBase, ok: false, steps };
      }
    } else {
      pushStep('POST /api/auth/change-password', true, 'skipped (already changed)');
    }

    const stateRes = await fetch(`${cleanBase}/api/state`, {
      headers: { Cookie: cookieHeader },
    });
    const stateJson = (await stateRes.json()) as {
      ok?: boolean;
      data?: { run?: { runId?: string } };
    };
    const activeRunId = stateJson.data?.run?.runId ?? '';
    const stateOk = stateRes.status === 200 && stateJson.ok === true && activeRunId.length > 0;
    pushStep('GET /api/state', stateOk, `status=${stateRes.status}, runId=${activeRunId}`);
    if (!stateOk) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    const proposalRes = await fetch(`${cleanBase}/api/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        preset: 'CUSTOM',
        title: 'P1-4 Smoke Live Proposal',
        summary: 'Automated HTTP smoke verification proposal',
        requirements: {
          REQ_HEALTH_AUDIT: 'Verify end-to-end API and SSE delivery',
        },
        involvesDatabaseMigration: false,
        involvesPermissionOrPayment: false,
      }),
    });
    const proposalJson = (await proposalRes.json()) as {
      ok?: boolean;
      data?: { run?: { runId?: string } };
    };
    const newRunId = proposalJson.data?.run?.runId ?? '';
    const proposalOk =
      proposalRes.status === 200 && proposalJson.ok === true && newRunId.length > 0;
    pushStep('POST /api/proposals', proposalOk, `status=${proposalRes.status}, runId=${newRunId}`);
    if (!proposalOk) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    const abortController = new AbortController();
    const sseTimer = setTimeout(() => abortController.abort(), 4000);
    let sseOk = false;
    let sseDetail = '';
    try {
      const sseRes = await fetch(
        `${cleanBase}/api/events/stream?runId=${encodeURIComponent(newRunId)}`,
        {
          headers: { Cookie: cookieHeader },
          signal: abortController.signal,
        },
      );
      const reader = sseRes.body?.getReader();
      if (sseRes.status === 200 && reader) {
        const chunk = await reader.read();
        const text = chunk.value ? new TextDecoder().decode(chunk.value) : '';
        sseOk = text.includes('event: state_updated') && text.includes('data:');
        sseDetail = `status=${sseRes.status}, bytes=${text.length}`;
        await reader.cancel().catch(() => undefined);
      } else {
        sseDetail = `status=${sseRes.status}`;
      }
    } finally {
      clearTimeout(sseTimer);
      abortController.abort();
    }
    pushStep('GET /api/events/stream', sseOk, sseDetail);
    if (!sseOk) {
      return { baseUrl: cleanBase, ok: false, steps };
    }

    const supRes = await fetch(`${cleanBase}/api/supervisor/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ toolName: 'get_run_overview', runId: newRunId }),
    });
    const supJson = (await supRes.json()) as { ok?: boolean };
    const supOk = supRes.status === 200 && supJson.ok === true;
    pushStep('POST /api/supervisor/tools', supOk, `status=${supRes.status}`);

    return { baseUrl: cleanBase, ok: steps.every((s) => s.ok), steps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushStep('unexpected_error', false, msg);
    return { baseUrl: cleanBase, ok: false, steps };
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const checkEnvOnly = args.includes('--check-env') || args.length === 0;
  const doCompose = args.includes('--compose-config');
  const doPg = args.includes('--pg-verify');
  const smokeIdx = args.indexOf('--http-smoke');
  const doHttpSmoke = smokeIdx !== -1;
  const smokeUrl =
    doHttpSmoke && args[smokeIdx + 1] && !args[smokeIdx + 1].startsWith('--')
      ? args[smokeIdx + 1]
      : `http://127.0.0.1:${process.env.PORT ?? '4300'}`;

  let hasFailure = false;

  if (checkEnvOnly || doCompose || doPg) {
    const prereqs = checkHostPrerequisites();
    console.log('[e2e:live] host prerequisites:', JSON.stringify(prereqs));
    if (strict && (!prereqs.dockerComposeAvailable || !prereqs.psqlAvailable)) {
      hasFailure = true;
    }
  }

  if (doCompose) {
    const composeOutcome = verifyComposeConfig();
    console.log('[e2e:live] compose config:', JSON.stringify(composeOutcome));
    if (!composeOutcome.ok && strict) {
      hasFailure = true;
    }
  }

  if (doPg) {
    const pgOutcome = verifyPgSchema();
    console.log('[e2e:live] pg verify:', JSON.stringify(pgOutcome));
    if (!pgOutcome.ok) {
      hasFailure = true;
    }
  }

  if (doHttpSmoke) {
    const envPath = path.resolve(process.cwd(), 'deploy', '.env.example');
    const report = await runHttpSmokeAgainstUrl(smokeUrl);
    console.log('[e2e:live] http smoke:', JSON.stringify(report));
    if (!report.ok || !fs.existsSync(envPath)) {
      hasFailure = true;
    }
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  runCli().catch((err: unknown) => {
    console.error('[e2e:live] fatal:', err);
    process.exitCode = 1;
  });
}
