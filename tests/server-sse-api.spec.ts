/**
 * @file server-sse-api.spec.ts
 * @description Block 5 功能与结构测试：验证 Web 管控台服务端 (`WorkbenchHttpServer`) 的
 * 模块化静态资源托管 (`/`, `/styles/workbench.css`, `/dist/main.js`)、
 * SSE 实时事件流推送 (`GET /api/events/stream`)、以及声明式 YAML 工作流模板热切换 API (`POST /api/workflows/template`)。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { WorkbenchHttpServer } from '../src/server/WorkbenchServer.ts';

function fetchText(
  url: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      })
      .on('error', reject);
  });
}

describe('Block 5 — Web 管控台 HTTP 服务、SSE 实时流推送与 YAML 模板热切换 API 测试套件', () => {
  it('1. 应正常托管模块化前端资源、建立 SSE /api/events/stream 实时连接并支持热切换纯后端 YAML 模板', async () => {
    const tempPersistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-srv-db-'));
    const tempSandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-sdlc-srv-sb-'));

    const workbench = new WorkbenchHttpServer(0, {
      persistenceDir: tempPersistDir,
      sandboxRootDir: tempSandboxDir,
    });
    const server = workbench.start();

    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // 1. 验证模块化 HTML、CSS 与编译后的前端 TS bundle 均可正常访问
      const htmlRes = await fetchText(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      assert.ok(htmlRes.body.includes('/styles/workbench.css'));
      assert.ok(htmlRes.body.includes('/dist/main.js'));

      const cssRes = await fetchText(`${baseUrl}/styles/workbench.css`);
      assert.equal(cssRes.status, 200);
      assert.ok(String(cssRes.headers['content-type']).includes('text/css'));

      const jsRes = await fetchText(`${baseUrl}/dist/main.js`);
      assert.equal(jsRes.status, 200);
      assert.ok(String(jsRes.headers['content-type']).includes('application/javascript'));

      // 2. 验证 SSE /api/events/stream 连接建立即推送首帧 state_updated 事件
      const firstSseFrame = await new Promise<string>((resolve, reject) => {
        const req = http.get(`${baseUrl}/api/events/stream`, (res) => {
          assert.equal(res.statusCode, 200);
          assert.ok(String(res.headers['content-type']).includes('text/event-stream'));
          res.once('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            req.destroy();
            resolve(text);
          });
        });
        req.on('error', reject);
      });

      assert.ok(firstSseFrame.includes('event: state_updated'));
      assert.ok(firstSseFrame.includes('"hasActiveRun":true'));

      // 3. 验证 POST /api/workflows/template 动态切换到 backend_api_only.yaml 纯后端 4 阶段拓扑
      const switchRes = await fetch(`${baseUrl}/api/workflows/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateFileName: 'backend_api_only.yaml' }),
      });
      assert.equal(switchRes.status, 200);
      const switchJson = (await switchRes.json()) as {
        ok: boolean;
        data: {
          stagePipelineOrder: string[];
          workflowDslSummary: { workflowId: string; stageCount: number };
        };
      };
      assert.equal(switchJson.ok, true);
      assert.equal(switchJson.data.workflowDslSummary.workflowId, 'backend_api_only_sdlc_v1');
      assert.equal(switchJson.data.workflowDslSummary.stageCount, 4);
      assert.equal(switchJson.data.stagePipelineOrder.includes('STAGE_2_PD'), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tempPersistDir, { recursive: true, force: true });
      fs.rmSync(tempSandboxDir, { recursive: true, force: true });
    }
  });
});
