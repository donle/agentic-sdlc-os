# E3 实现文档：docker 沙箱测试运行时

> 对应 `BACKEND_TODO_DESIGN.md` §M3 "E3 docker 运行时"，2026-11-23 完成。

## 问题背景

E2 已把单测执行真实化，但测试在**宿主机进程**直接运行：被测代码可访问宿主文件系统与网络，
与"沙箱"承诺不符。E3 把生成的单测放进一次性容器执行，实现真正的执行隔离。

## 实现方案

### 1. DockerTestRuntime（新增 `src/sandbox/DockerTestRuntime.ts`）

对设计的**一处偏离**（已在此记录）：设计稿点名 dockerode，实现改用 **docker CLI**
（`execFileSync`）——与 `PgPersistenceDriver` 的 psql CLI 先例一致，零新增 npm 依赖
（单机私有化是硬约束），语义等价（一次性容器 + 网络隔离 + 超时 kill）。

每个 spec 套件一次 `docker run`：

```
docker run --rm --name sdlc-verify-<hash>-<ts> \
  --network none \
  -v <worktree>:/workspace:ro \
  -v <resultsDir>:/results:rw \
  -w /workspace \
  node:22-alpine \
  sh -c "node --test --test-reporter=spec --experimental-test-coverage /workspace/tests/x.sandbox.spec.ts 2>&1 | tee /results/x.log"
```

- **只读 worktree**：容器内代码不可被篡改；**读写结果目录**：`tee` 留档供审计（`<sandboxRoot>/docker-results/<runId>/<branchId>/`）。
- **`--network none`**：被测代码无法外联。
- **超时 kill**：宿主 CLI 被 kill 后容器可能残留 → best-effort `docker rm -f`（清理失败不掩盖主结果）。
- 可注入 `probeCommand` / `runCommand`（测试零 docker 依赖）。
- `SANDBOX_DOCKER_IMAGE` 可换镜像（默认 `node:22-alpine`）。

### 2. 沙箱验证运行时切换（`GitWorktreeSandboxManager.executeSandboxVerification`）

```
SANDBOX_RUNTIME 未设置            → runtime: 'host'（E2 行为，零变化）
SANDBOX_RUNTIME=docker + 可用     → runtime: 'docker'（容器执行，TestResultParser.parseSuiteOutput 同口径解析）
SANDBOX_RUNTIME=docker 但不可用   → runtime: 'host-fallback'（WARN + 宿主机执行）
容器单套件非 0 退出码或超时       → 保留容器已解析的结果，当前将 runtime 标为 'host-fallback'（不会在宿主机重跑；pipe/退出码问题见 #12）
dockerRuntime.runSuite() 抛异常   → 进入 catch 分支，该套件降级宿主机 TestResultParser.runSuite() 重跑并标 'host-fallback'
```

- `SandboxVerificationResult` 新增 `runtime` 字段（审计口径）；执行日志新增 `[Sandbox Runtime] <runtime>` 行。
- 探测结果进程级缓存（不重复探测）。
- 既有解析口径抽为 `TestResultParser.parseSuiteOutput`（宿主机/docker 共用，超时无输出如实记 1 条失败）。

### 3. 同步执行说明

docker 路径与宿主机路径一致使用同步 `execFileSync`——通过 `prepareStageEnvironment()` 接入 `SoftwareEngineerAgent` 与 `QualityAssuranceAgent`（在线 LLM 与离线模板降级两条路径均在步骤 4 统一触发，离线路径复用同一准备结果）以及 `/api/sandbox/verify`，无需改动 6 个 Agent 的主签名。代价：容器运行期间阻塞事件循环；若后续异步化，需一并改造 `prepareStageEnvironment`、`synthesizeTemplateArtifact` 与 `/api/sandbox/verify`。

## 边界处理

1. **docker 未安装/守护进程不可达** → host-fallback 显式降级 + WARN，流水线永不阻塞（D-2）。
2. **仅 `dockerRuntime.runSuite()` 抛出异常时才在宿主机重跑该套件**；若容器成功返回非零退出码/超时但未抛异常，则保留容器输出解析结果，同时当前实现仍会将 `runtime` 标为 `'host-fallback'`（且 BusyBox `sh` 无 `pipefail` 下 `node --test | tee` 会返回 `tee` 退出码，已统一登记 `BACKEND_TODO.md` §五 `#12`）。
3. **容器内测试超时** → CLI kill + `docker rm -f` 清理；解析口径如实记 1 条失败。
4. **Windows 路径**：`-v` 挂载由 Docker Desktop 处理盘符路径；容器内路径统一 `/workspace` 正斜杠。

## 验证（tests/docker-runtime.spec.ts，5 项）

1. 命令构造：`--network none` / `:/workspace:ro` / `:/results:rw` / `-w /workspace` / tee 留档 / 容器内路径
2. 超时 → `timedOut` + `docker rm -f` 调用 + 解析如实记失败
3. 集成：docker 可用（注入假运行时）→ `runtime=docker` + 容器输出计数 + 结果目录落盘
4. 降级：docker 不可用 → `runtime=host-fallback` + 宿主机真实执行（真实 node:test 跑模板套件）
5. 默认未请求 → `runtime=host`（E2 行为回归）

**完成时测试基线**：117 项（113 过 / 4 既有 skip / 0 失败）；typecheck + lint + prettier 全绿。（当前全库基线：143 项 / 45 套件，139 过 / 4 既有 skip）

## 遗留

- `BACKEND_TODO.md` §五 `#12`：`sh -c "... | tee ..."` 管道吞没 `node --test` 退出码，以及容器测试断言失败与 Docker 引擎故障均被归为 `host-fallback`。
- `docker-results/` 与 I3 冲突：`DockerTestRuntime` 日志目录落在 `<sandboxRoot>/docker-results/<runId>/`，而 I3 `enforceWorktreeRetention` 扫描 `sandboxRootDir` 时未排除 `docker-results`，超限后会将其一并按运行目录清理。
- simulated 模式未在 worktree 根写 `package.json`（`type: "module"`），容器以只读挂载 `/workspace:ro` 运行 `.ts` 测试依赖 `node:22-alpine` 具体次版本的内置 ESM/strip-types 行为；此外 `Dockerfile` 目前未安装 `docker-cli`，容器部署下若无外挂 CLI/socket 将自动降级 `host-fallback`。
- 同步阻塞事件循环（见上）；与 `prepareStageEnvironment` / `synthesizeTemplateArtifact` async 化一并考虑。
- coverage 依赖镜像内 node 版本行为（`node:22-alpine` 需带 `--experimental-test-coverage`；若镜像精简无 tee 可换镜像）。
