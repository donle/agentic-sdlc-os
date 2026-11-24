/**
 * @file DockerTestRuntime.ts
 * @description E3：docker 沙箱测试运行时——`SANDBOX_RUNTIME=docker` 时，把生成的单测放进
 * 一次性 `node:22-alpine` 容器执行：worktree 挂载只读、结果目录挂载读写、`--network none`、超时 kill。
 *
 * 实现说明（对设计的偏离，记录于 docs/E3_DOCKER_RUNTIME.md）：设计稿点名 dockerode，
 * 本实现改用 **docker CLI**（execFileSync），与 PgPersistenceDriver 的 psql CLI 先例一致——
 * 零新增 npm 依赖（单机私有化是硬约束），语义等价（一次性容器 + 网络隔离 + 超时）。
 * 同步执行与宿主机路径（E2 的 execFileSync）口径一致。
 *
 * D-2 降级链：docker 未安装 / 探测失败 / 容器执行失败 → 回落宿主机执行并显式标记
 * `runtime: 'host-fallback'`，绝不阻塞流水线。
 */

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DockerSuiteResult {
  /** 容器内 spec 输出（重定向写入结果目录后再标准输出打印的同一份内容） */
  readonly output: string;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  /** AUDIT-12：仅超时 / 引擎错误 (125/126/127) / 守护进程或镜像不可用才为 true；单测失败返回 false */
  readonly infrastructureFailure: boolean;
  readonly image: string;
  /** 完整 docker 命令（审计日志用） */
  readonly containerCommand: string;
}

interface DockerRunOutcome {
  readonly output: string;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
}

export class DockerTestRuntime {
  private readonly image: string;
  private dockerProbeCache: boolean | null = null;
  private readonly probeCommand: () => boolean;
  private readonly runCommand: (args: string[], timeoutMs: number) => DockerRunOutcome;

  public constructor(params?: {
    image?: string;
    probeCommand?: () => boolean;
    runCommand?: (args: string[], timeoutMs: number) => DockerRunOutcome;
  }) {
    this.image = params?.image ?? process.env.SANDBOX_DOCKER_IMAGE ?? 'node:22-alpine';
    this.probeCommand =
      params?.probeCommand ??
      (() => {
        try {
          execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      });
    this.runCommand =
      params?.runCommand ??
      ((args, timeoutMs) => {
        try {
          const output = execFileSync('docker', args, { encoding: 'utf-8', timeout: timeoutMs });
          return { output, timedOut: false, exitCode: 0 };
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; killed?: boolean; status?: number };
          return {
            output: [e.stdout, e.stderr].filter(Boolean).join('\n'),
            timedOut: e.killed === true,
            exitCode: typeof e.status === 'number' ? e.status : null,
          };
        }
      });
  }

  /** 是否请求了 docker 运行时（env SANDBOX_RUNTIME=docker） */
  public static isRuntimeRequested(): boolean {
    return process.env.SANDBOX_RUNTIME === 'docker';
  }

  /** 探测 docker 守护进程可用性（结果缓存，进程生命周期内不重复探测） */
  public isDockerAvailable(): boolean {
    if (this.dockerProbeCache === null) {
      this.dockerProbeCache = this.probeCommand();
    }
    return this.dockerProbeCache;
  }

  /**
   * AUDIT-12：区分"Docker 引擎/镜像基础设施故障"与"容器内测试断言失败 (如 exitCode=1)"
   */
  public static isInfrastructureFailure(outcome: DockerRunOutcome): boolean {
    if (outcome.timedOut || outcome.exitCode === null) {
      return true;
    }
    if (outcome.exitCode === 125 || outcome.exitCode === 126 || outcome.exitCode === 127) {
      return true;
    }
    return /cannot connect to the docker daemon|error response from daemon|unable to find image|no such image|pull access denied|permission denied.*docker/i.test(
      outcome.output,
    );
  }

  /**
   * 在一次性容器内执行单个 spec 套件：
   * - worktree 以只读挂载（容器内代码不可被篡改）
   * - 结果目录以读写挂载（重定向写入日志并回显内容，严格保留退出码）
   * - `--network none`（被测代码无法外联）
   * - 超时 kill 宿主 docker CLI + best-effort 强制移除容器
   */
  public runSuite(
    testFileAbsPath: string,
    workspacePath: string,
    resultsDir: string,
    timeoutMs = 15000,
  ): DockerSuiteResult {
    fs.mkdirSync(resultsDir, { recursive: true });
    const containerTestPath = `/workspace/${path
      .relative(workspacePath, testFileAbsPath)
      .replace(/\\/g, '/')}`;
    const resultsBasename = path.basename(testFileAbsPath).replace(/\.spec\.ts$/, '.log');
    const containerName = `sdlc-verify-${crypto
      .createHash('sha1')
      .update(testFileAbsPath)
      .digest('hex')
      .slice(0, 10)}-${Date.now()}`;

    const args = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '-v',
      `${workspacePath}:/workspace:ro`,
      '-v',
      `${resultsDir}:/results:rw`,
      '-w',
      '/workspace',
      this.image,
      'sh',
      '-c',
      `node --experimental-strip-types --test --test-reporter=spec --experimental-test-coverage "${containerTestPath}" > "/results/${resultsBasename}" 2>&1; ec=$?; cat "/results/${resultsBasename}"; exit $ec`,
    ];

    const outcome = this.runCommand(args, timeoutMs);
    if (outcome.timedOut) {
      // 超时 kill 的只是宿主 CLI，容器可能仍在运行——best-effort 强制移除
      try {
        this.runCommand(['rm', '-f', containerName], 5000);
      } catch {
        // 清理失败不掩盖主结果
      }
    }

    return {
      output: outcome.output,
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      infrastructureFailure: DockerTestRuntime.isInfrastructureFailure(outcome),
      image: this.image,
      containerCommand: `docker ${args.join(' ')}`,
    };
  }
}
