# P0-1 变更说明：恢复前端 React 构建链路并替换过期静态产物

> 完成日期：2026-11-24（对应 [REMEDIATION_ORCHESTRATION_PLAN.md](./REMEDIATION_ORCHESTRATION_PLAN.md) Step 5 & [BACKEND_TODO.md](./BACKEND_TODO.md) §六 `P0-1`）。

---

## 一、问题背景与根因

1. **工作区依赖缺失**：`package.json` 已声明 `react`、`react-dom`、`@types/react`、`@types/react-dom`，但当前工作区 `node_modules/` 中缺失上述 4 个包，导致 `npm run typecheck:frontend` 与 `npm run build:ui` 无法运行。
2. **静态产物与 HTML 入口失配**：`src/ui/dist/main.js`（428 B）及同目录 `StageDisplayFormatter.js`、`WorkbenchApiClient.js`、`WorkbenchViewController.js`、`types.js` 仍为 2026-11-22 的旧版非 React DOM 控制器产物，无法挂载到 [src/ui/index.html](file:///Users/shaun/Documents/projects/agentic-sdlc-os/src/ui/index.html) 的 `<div id="root"></div>`，运行服务后访问页面会白屏。

---

## 二、核心修复内容

1. **还原前端构建依赖**：运行 `npm install --no-audit --no-fund` 依据 `package-lock.json` 还原 `react@19.3.1`、`react-dom@19.3.1`、`@types/react`、`@types/react-dom`。
2. **双端校验与全量打包**：
   - 运行 `npm run typecheck:frontend`（`tsc -p tsconfig.ui.json --noEmit`）与 `npm run lint:frontend`（`eslint "src/ui/client/**/*.{ts,tsx}" "src/ui/kit/**/*.{ts,tsx}"`）全部零错误通过；
   - 运行 `npm run build:ui`（`esbuild src/ui/client/main.tsx --bundle --outfile=src/ui/dist/main.js ...`）生成最新 React 19 ES Module 产物（391,662 字节，包含 `react-dom` / `createRoot`）。
3. **清理废弃构建残留**：删除 `src/ui/dist/` 中已无引用的 4 个 2026-11-22 旧版产物（`StageDisplayFormatter.js`、`WorkbenchApiClient.js`、`WorkbenchViewController.js`、`types.js`），使 `src/ui/dist/` 仅保留被 `index.html` 引用的唯一入口 `main.js`。
4. **补充服务端托管断言**：更新 [tests/server-sse-api.spec.ts](file:///Users/shaun/Documents/projects/agentic-sdlc-os/tests/server-sse-api.spec.ts#L63-L75)，明确校验 `GET /dist/main.js` 返回大小 > 10KB 的真实 React 19 运行时产物且不含旧版 `WorkbenchViewController`。

---

## 三、测试与验收结果

- `npm run typecheck`（后端 + 前端）：通过（0 错误）。
- `npm run lint`（后端 + 前端）：通过（0 错误）。
- `npm run format:check`：通过。
- `npm run check` 全量回归：183 项测试 / 51 套件（179 通过 / 4 既有跳过 / 0 失败）。
