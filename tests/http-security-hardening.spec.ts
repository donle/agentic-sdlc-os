/**
 * @file http-security-hardening.spec.ts
 * @description P0-5 验收测试套件：验证 WorkbenchHttpServer 的请求体大小/超时保护、安全响应头与 Secure Cookie、
 * 滑动窗口限流 (429)、path.sep 兄弟目录前缀防穿越，以及默认模式匿名收口与统一强制改密拦截。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';

interface MockHttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly bodyText: string;
  readonly json: Record<string, unknown>;
}

async function dispatchRaw(
  server: WorkbenchHttpServer,
  params: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    reqStream?: Readable;
    body?: Record<string, unknown>;
  },
): Promise<MockHttpResponse> {
  const req = (params.reqStream ??
    Readable.from(
      params.body ? [Buffer.from(JSON.stringify(params.body))] : [],
    )) as unknown as http.IncomingMessage;
  req.method = params.method;
  req.url = params.url;
  req.headers = { ...(params.headers ?? {}) };

  let statusCode = 200;
  const headers: Record<string, string | string[]> = {};
  const outChunks: Buffer[] = [];

  const res = {
    writeHead(code: number, hdrs?: Record<string, string | string[]>): http.ServerResponse {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
      return res as unknown as http.ServerResponse;
    },
    write(chunk: string | Buffer): boolean {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer): http.ServerResponse {
      if (chunk) {
        outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return res as unknown as http.ServerResponse;
    },
  } as unknown as http.ServerResponse;

  await server.handleHttpRequest(req, res);
  const bodyText = Buffer.concat(outChunks).toString('utf-8');
  let json: Record<string, unknown>;
  try {
    json = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { statusCode, headers, bodyText, json };
}

describe('P0-5 — WorkbenchServer HTTP 安全加固与默认模式越权收敛', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, val: string | undefined): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('1. 请求体超限返回 413，读取超时返回 408', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-body-'));
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
        maxBodyBytes: 64,
        bodyTimeoutMs: 40,
      });
      await server.waitUntilReady();

      const oversized = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'admin', password: 'x'.repeat(200) },
      });
      assert.equal(oversized.statusCode, 413);

      const stalledStream = new PassThrough();
      stalledStream.write('{"username":');
      const timeoutRes = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        reqStream: stalledStream,
      });
      stalledStream.destroy();
      assert.equal(timeoutRes.statusCode, 408);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2. HTML/静态资源/API 响应附带安全头，HTTPS 场景 Set-Cookie 带 Secure', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-hdr-'));
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
      });
      await server.waitUntilReady();

      const htmlRes = await dispatchRaw(server, { method: 'GET', url: '/' });
      assert.equal(htmlRes.statusCode, 200);
      assert.equal(htmlRes.headers['x-content-type-options'], 'nosniff');
      assert.equal(htmlRes.headers['x-frame-options'], 'DENY');
      assert.equal(htmlRes.headers['referrer-policy'], 'same-origin');
      assert.ok(String(htmlRes.headers['content-security-policy']).includes("default-src 'self'"));

      const cssRes = await dispatchRaw(server, { method: 'GET', url: '/styles/workbench.css' });
      assert.equal(cssRes.statusCode, 200);
      assert.equal(cssRes.headers['x-content-type-options'], 'nosniff');
      assert.equal(cssRes.headers['x-frame-options'], 'DENY');

      const healthRes = await dispatchRaw(server, { method: 'GET', url: '/api/health' });
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.headers['x-content-type-options'], 'nosniff');

      const httpsLogin = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-proto': 'https' },
        body: { username: 'admin', password: 'admin' },
      });
      assert.equal(httpsLogin.statusCode, 200);
      assert.ok(String(httpsLogin.headers['set-cookie']).includes('; Secure'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. 登录与高开销接口触发滑动窗口速率限制返回 429 与 Retry-After', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-rate-'));
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
        rateLimits: { windowMs: 60_000, loginMaxPerWindow: 2, expensiveMaxPerWindow: 2 },
      });
      await server.waitUntilReady();

      const login1 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        body: { username: 'admin', password: 'wrong' },
      });
      assert.equal(login1.statusCode, 401);

      const login2 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        body: { username: 'admin', password: 'wrong' },
      });
      assert.equal(login2.statusCode, 401);

      const login3 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        body: { username: 'admin', password: 'wrong' },
      });
      assert.equal(login3.statusCode, 429);
      assert.ok(Number(login3.headers['retry-after']) >= 1);

      // 另一 IP 不受影响，继续测试高开销接口 /api/proposals 限流
      const adminLogin = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '10.0.0.2' },
        body: { username: 'admin', password: 'admin' },
      });
      assert.equal(adminLogin.statusCode, 200);
      const adminCookie = `sdlc_session=${
        String(adminLogin.headers['set-cookie']).match(/sdlc_session=([^\s;]+)/)![1]
      }`;
      await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { cookie: adminCookie },
        body: { oldPassword: 'admin', newPassword: 'AdminNewPassword1' },
      });

      const p1 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { cookie: adminCookie, 'x-forwarded-for': '10.0.0.2' },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(p1.statusCode, 200);

      const p2 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { cookie: adminCookie, 'x-forwarded-for': '10.0.0.2' },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(p2.statusCode, 200);

      const p3 = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/proposals',
        headers: { cookie: adminCookie, 'x-forwarded-for': '10.0.0.2' },
        body: { preset: 'LOW_RISK_FAST_TRACK' },
      });
      assert.equal(p3.statusCode, 429);
      assert.ok(Number(p3.headers['retry-after']) >= 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. 兄弟目录前缀路径穿越防御（+ path.sep）阻断越权文件读取', async () => {
    setEnv('AUTH_REQUIRED', undefined);
    setEnv('AUTH_DISABLED', undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-path-'));
    const sandboxDir = path.join(tmpDir, 'sandbox');
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: sandboxDir,
      });
      await server.waitUntilReady();

      const stateRes = await dispatchRaw(server, { method: 'GET', url: '/api/state' });
      const runInfo = (stateRes.json.data as { run: { runId: string; activeBranchId: string } })
        .run;
      const wsPath = server
        .getOrchestrator()
        .sandboxManager.resolveWorkspacePath(runInfo.runId, runInfo.activeBranchId);

      // 构造同前缀兄弟目录 <wsPath>-evil/secret.txt，验证加装 path.sep 后不会误命中
      const siblingDir = `${wsPath}-evil`;
      fs.mkdirSync(siblingDir, { recursive: true });
      fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'TOP_SECRET', 'utf-8');
      const siblingName = path.basename(siblingDir);

      const evilRes = await dispatchRaw(server, {
        method: 'GET',
        url: `/api/sandbox/file?runId=${encodeURIComponent(runInfo.runId)}&path=${encodeURIComponent(`../${siblingName}/secret.txt`)}`,
        headers: { 'x-actor-id': 'user-admin-01' },
      });
      assert.equal(evilRes.statusCode, 400);
      assert.ok(String(evilRes.json.error).includes('未找到沙箱文件'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('5. 默认模式下收敛匿名访问（templates/sandbox/rag）并统一拦截 mustChangePassword=true 会话', async () => {
    setEnv('AUTH_REQUIRED', undefined);
    setEnv('AUTH_DISABLED', undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p05-default-'));
    try {
      const server = new WorkbenchHttpServer(0, {
        persistenceDir: path.join(tmpDir, 'persist'),
        sandboxRootDir: path.join(tmpDir, 'sandbox'),
      });
      await server.waitUntilReady();

      const anonTemplates = await dispatchRaw(server, {
        method: 'GET',
        url: '/api/workflows/templates',
      });
      assert.equal(anonTemplates.statusCode, 403);

      const anonSandboxFile = await dispatchRaw(server, {
        method: 'GET',
        url: '/api/sandbox/file?path=package.json',
      });
      assert.equal(anonSandboxFile.statusCode, 403);

      const anonRagQuery = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/rag/query',
        body: { stageId: 'STAGE_3A_TECH_SPEC', queryText: 'SQL' },
      });
      assert.equal(anonRagQuery.statusCode, 403);

      // 默认模式下已登录但 mustChangePassword=true 的会话同样必须被拦截（除 me/change-password/logout/health）
      const pmLogin = await dispatchRaw(server, {
        method: 'POST',
        url: '/api/auth/login',
        body: { username: 'pm', password: 'pm' },
      });
      assert.equal(pmLogin.statusCode, 200);
      const pmCookie = `sdlc_session=${
        String(pmLogin.headers['set-cookie']).match(/sdlc_session=([^\s;]+)/)![1]
      }`;

      const blockedTemplates = await dispatchRaw(server, {
        method: 'GET',
        url: '/api/workflows/templates',
        headers: { cookie: pmCookie },
      });
      assert.equal(blockedTemplates.statusCode, 403);
      assert.equal(blockedTemplates.json.mustChangePassword, true);

      const blockedState = await dispatchRaw(server, {
        method: 'GET',
        url: '/api/state',
        headers: { cookie: pmCookie },
      });
      assert.equal(blockedState.statusCode, 403);
      assert.equal(blockedState.json.mustChangePassword, true);

      // /api/auth/me 仍允许读取以供前端识别强制改密状态
      const meAllowed = await dispatchRaw(server, {
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie: pmCookie },
      });
      assert.equal(meAllowed.statusCode, 200);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
