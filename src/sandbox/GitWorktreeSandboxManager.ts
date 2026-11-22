/**
 * @file GitWorktreeSandboxManager.ts
 * @description 隔离代码与测试沙箱管理器（BACKEND_TODO E1/E2 重写版）。
 *
 * E1：配置 `GIT_REPO_PATH` 且 git 可用 → 每个任务在真实仓库上 `git worktree add` 独立分支
 *     （RealGitWorktree 封装；分支重名自动后缀、路径脏 prune 重试）；否则回落模拟模式并显式标记。
 * E2：测试结果真实采集——生成的单测为 node:test 套件，`node --test --test-reporter=spec
 *     --experimental-test-coverage` 逐文件执行并解析真实计数与覆盖率；失败/超时如实上报。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RealGitWorktree } from './RealGitWorktree.ts';
import { TestResultParser, type ParsedSuite } from './TestResultParser.ts';
import { DockerTestRuntime } from './DockerTestRuntime.ts';

export interface SandboxGeneratedFileMeta {
  readonly filePath: string;
  readonly absolutePath: string;
  readonly className: string;
  readonly designPattern: string;
  readonly linesChanged: number;
  readonly sizeBytes: number;
  readonly previewSnippet: string;
}

export interface SandboxProvisionResult {
  readonly runId: string;
  readonly branchId: string;
  readonly gitWorktreeBranch: string;
  readonly workspacePath: string;
  /** E1：true = 未配置 GIT_REPO_PATH 或 git 不可用，回落到模拟 HEAD 模式 */
  readonly simulated: boolean;
  readonly generatedFiles: ReadonlyArray<SandboxGeneratedFileMeta>;
}

export interface SandboxVerificationResult {
  readonly workspacePath: string;
  readonly filesVerifiedCount: number;
  /** E2：来自 node:test 真实解析 */
  readonly totalTestCases: number;
  readonly passedTestCases: number;
  readonly failedTestCases: number;
  readonly coveragePercent: number | null;
  readonly suites: ReadonlyArray<ParsedSuite>;
  readonly securityIssuesFound: number;
  readonly securityFindings: ReadonlyArray<string>;
  readonly subprocessExecuted: boolean;
  readonly executionLog: string;
  /** E3：测试执行运行时（docker = 一次性容器；host-fallback = docker 请求但降级宿主） */
  readonly runtime: 'host' | 'docker' | 'host-fallback';
}

export class GitWorktreeSandboxManager {
  private readonly sandboxRootDir: string;
  private readonly latestExecutionLogs: Map<string, string>;
  /** E1：真实仓库路径（null = 模拟模式） */
  public readonly repoPath: string | null;
  private realGit: RealGitWorktree | null = null;
  /** 真实 worktree 的分支名映射（真实模式下 readActiveGitBranch 用） */
  private readonly realBranchByWorkspace = new Map<string, string>();
  /** E3：docker 测试运行时（SANDBOX_RUNTIME=docker 时启用） */
  private readonly dockerRuntime: DockerTestRuntime;

  public constructor(
    sandboxRootDir?: string,
    options?: { repoPath?: string; dockerRuntime?: DockerTestRuntime },
  ) {
    this.sandboxRootDir =
      sandboxRootDir ??
      path.resolve(process.cwd(), process.env.SANDBOX_WORKTREE_ROOT ?? '.sandbox-worktrees');
    this.latestExecutionLogs = new Map<string, string>();
    this.dockerRuntime = options?.dockerRuntime ?? new DockerTestRuntime();
    const repoPath = options?.repoPath ?? process.env.GIT_REPO_PATH ?? '';
    if (
      repoPath &&
      fs.existsSync(repoPath) &&
      RealGitWorktree.isGitAvailable() &&
      RealGitWorktree.isGitRepository(repoPath)
    ) {
      this.repoPath = repoPath;
      this.realGit = new RealGitWorktree(repoPath, this.sandboxRootDir);
    } else {
      this.repoPath = null;
      void this.repoPath;
    }
  }

  public isSimulated(): boolean {
    return this.realGit === null;
  }

  public getSandboxRootDir(): string {
    return this.sandboxRootDir;
  }

  public resolveWorkspacePath(runId: string, branchId: string): string {
    const safeRun = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeBranch = branchId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sandboxRootDir, safeRun, safeBranch);
  }

  private static toPascalCase(raw: string): string {
    return raw
      .split(/[^a-zA-Z0-9]+/)
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
  }

  /**
   * 创建隔离沙箱工作区（真实 worktree 或模拟模式）并落盘业务代码与 node:test 单测
   */
  public provisionWorktreeAndWriteCode(params: {
    runId: string;
    branchId: string;
    proposalTitle: string;
    requirementIds: ReadonlyArray<string>;
    requirementDescriptions?: Readonly<Record<string, string>>;
    ddlStatements?: ReadonlyArray<string>;
    humanDirective?: string | null;
  }): SandboxProvisionResult {
    const fallbackPath = this.resolveWorkspacePath(params.runId, params.branchId);
    let workspacePath = fallbackPath;
    let gitBranchName = `worktree/${params.runId}/${params.branchId}`;
    let simulated = true;

    if (this.realGit) {
      try {
        const added = this.realGit.add(params.runId, params.branchId);
        workspacePath = added.workspacePath;
        gitBranchName = added.branchName;
        simulated = false;
        this.realBranchByWorkspace.set(workspacePath, added.branchName);
      } catch (err) {
        // D-2：真实 worktree 失败 → 回落模拟模式（显式标记，不阻塞流水线）
        console.warn(
          `[Sandbox] 真实 worktree 创建失败，回落模拟模式: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (simulated) {
      // 模拟模式：保留伪造 .git HEAD 引用（readActiveGitBranch 依赖）
      const gitDir = path.join(workspacePath, '.git');
      fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${gitBranchName}\n`, 'utf-8');
    } else {
      // E2：显式 ESM 工程（node:test 运行环境）
      fs.writeFileSync(
        path.join(workspacePath, 'package.json'),
        JSON.stringify({ name: `sandbox-${params.runId}`, type: 'module' }, null, 2),
        'utf-8',
      );
    }

    const generatedFiles: SandboxGeneratedFileMeta[] = [];

    for (const reqId of params.requirementIds) {
      const pascalName = GitWorktreeSandboxManager.toPascalCase(reqId);
      const className = `${pascalName}DomainService`;
      const reqDesc = params.requirementDescriptions?.[reqId] ?? reqId;
      const relModulePath = `src/modules/${reqId.toLowerCase()}/${className}.ts`;
      const absModulePath = path.join(workspacePath, relModulePath);

      fs.mkdirSync(path.dirname(absModulePath), { recursive: true });

      const directiveComment = params.humanDirective
        ? ` * @humanDirective ${params.humanDirective}\n`
        : '';

      const moduleCode = [
        '/**',
        ` * @file ${className}.ts`,
        ` * @proposal ${params.proposalTitle}`,
        ` * @requirement ${reqId} — ${reqDesc}`,
        ` * @branch ${gitBranchName}`,
        directiveComment.trimEnd(),
        ' */',
        '',
        'export interface ExecutionPayload {',
        '  readonly actorId: string;',
        '  readonly payload: Readonly<Record<string, unknown>>;',
        '}',
        '',
        'export interface ExecutionReceipt {',
        '  readonly requirementId: string;',
        '  readonly handledByClass: string;',
        '  readonly branchId: string;',
        '  readonly verified: boolean;',
        '  readonly auditEventName: string;',
        '}',
        '',
        `export class ${className} {`,
        `  public readonly requirementId = '${reqId}';`,
        `  public readonly branchId = '${params.branchId}';`,
        '',
        '  public executeBusinessRule(input: ExecutionPayload): ExecutionReceipt {',
        '    if (!input.actorId || input.actorId.trim().length === 0) {',
        "      throw new Error('Actor ID is required for audit traceability');",
        '    }',
        '    return {',
        '      requirementId: this.requirementId,',
        `      handledByClass: '${className}',`,
        '      branchId: this.branchId,',
        '      verified: true,',
        `      auditEventName: 'sdlc_feature_${reqId.toLowerCase()}_interacted',`,
        '    };',
        '  }',
        '}',
        '',
      ]
        .filter((line) => line !== '')
        .join('\n');

      fs.writeFileSync(absModulePath, `${moduleCode}\n`, 'utf-8');

      // E2：node:test 风格单测（2 个真实用例：主路径 + 空 actorId 防护）
      const relTestPath = `tests/${reqId.toLowerCase()}.sandbox.spec.ts`;
      const absTestPath = path.join(workspacePath, relTestPath);
      fs.mkdirSync(path.dirname(absTestPath), { recursive: true });

      const testCode = [
        "import * as assert from 'node:assert/strict';",
        "import test from 'node:test';",
        `import { ${className} } from '../${relModulePath.replace(/\\/g, '/')}';`,
        '',
        `test('${className}.executeBusinessRule 返回已验证审计回执', () => {`,
        `  const svc = new ${className}();`,
        `  const receipt = svc.executeBusinessRule({ actorId: 'qa-bot', payload: {} });`,
        '  assert.equal(receipt.verified, true);',
        `  assert.equal(receipt.requirementId, '${reqId}');`,
        `  assert.equal(receipt.auditEventName, 'sdlc_feature_${reqId.toLowerCase()}_interacted');`,
        '});',
        '',
        `test('${className}.executeBusinessRule 空 actorId 触发审计防护异常', () => {`,
        `  const svc = new ${className}();`,
        `  assert.throws(() => svc.executeBusinessRule({ actorId: '', payload: {} }));`,
        '});',
        '',
      ].join('\n');

      fs.writeFileSync(absTestPath, `${testCode}\n`, 'utf-8');

      const stat = fs.statSync(absModulePath);
      const lineCount = moduleCode.split('\n').length + testCode.split('\n').length;

      generatedFiles.push({
        filePath: relModulePath,
        absolutePath: absModulePath,
        className,
        designPattern: 'Strategy & Template Method Pattern',
        linesChanged: lineCount,
        sizeBytes: stat.size,
        previewSnippet: moduleCode.split('\n').slice(0, 14).join('\n'),
      });
    }

    if (params.ddlStatements && params.ddlStatements.length > 0) {
      const relSqlPath = 'schema/migration.sql';
      const absSqlPath = path.join(workspacePath, relSqlPath);
      fs.mkdirSync(path.dirname(absSqlPath), { recursive: true });
      const sqlContent = `-- Sandbox DDL Migration for ${gitBranchName}\n${params.ddlStatements.join('\n\n')}\n`;
      fs.writeFileSync(absSqlPath, sqlContent, 'utf-8');
    }

    return {
      runId: params.runId,
      branchId: params.branchId,
      gitWorktreeBranch: gitBranchName,
      workspacePath,
      simulated,
      generatedFiles,
    };
  }

  /** E1：真实模式下的 worktree/分支清理（模拟模式为纯目录，交由 I3 归档策略） */
  public cleanupWorktree(runId: string, branchId: string): void {
    const branchName = this.realBranchByWorkspace.get(this.resolveWorkspacePath(runId, branchId));
    if (this.realGit && branchName) {
      this.realGit.remove(branchName);
    }
  }

  /**
   * I3：worktree 保留策略——保留最近 N 个 run 的沙箱目录（默认 10，env `SANDBOX_WORKTREE_RETENTION` 可调），
   * 更旧的连分支清理（真实模式先 git worktree remove）后删除。
   * `protectRunIds`（活跃/刚终态的 run）无论多旧都不清除。
   */
  public enforceWorktreeRetention(params?: {
    keepLastN?: number;
    protectRunIds?: ReadonlyArray<string>;
  }): { removedRunIds: string[]; retainedRunIds: string[] } {
    const configured = Number(process.env.SANDBOX_WORKTREE_RETENTION ?? 10);
    const keepLastN = Math.max(
      1,
      params?.keepLastN ?? (Number.isFinite(configured) ? configured : 10),
    );
    const protectedNames = new Set((params?.protectRunIds ?? []).map((id) => this.sanitizeId(id)));

    const runDirEntries = fs
      .readdirSync(this.sandboxRootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        mtimeMs: fs.statSync(path.join(this.sandboxRootDir, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // 最新在前

    const retainedRunIds: string[] = [];
    const removedRunIds: string[] = [];
    for (const entry of runDirEntries) {
      if (protectedNames.has(entry.name)) {
        retainedRunIds.push(entry.name);
        continue;
      }
      if (retainedRunIds.length < keepLastN) {
        retainedRunIds.push(entry.name);
        continue;
      }
      this.removeRunDirectory(entry.name);
      removedRunIds.push(entry.name);
    }
    return { removedRunIds, retainedRunIds };
  }

  /** 目录名即 sanitize 后的 runId（resolveWorkspacePath 同一规则） */
  private sanitizeId(raw: string): string {
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private removeRunDirectory(safeRunId: string): void {
    const runDir = path.join(this.sandboxRootDir, safeRunId);
    if (!fs.existsSync(runDir)) {
      return;
    }
    for (const branchEntry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (branchEntry.isDirectory()) {
        try {
          this.cleanupWorktree(safeRunId, branchEntry.name);
        } catch {
          // git worktree remove 失败不阻断目录清理
        }
      }
    }
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  /**
   * 读取沙箱工作区的 Git 分支引用（真实 worktree 走映射；模拟模式读伪造 HEAD）
   */
  public readActiveGitBranch(runId: string, branchId: string): string | null {
    const realBranch = this.realBranchByWorkspace.get(this.resolveWorkspacePath(runId, branchId));
    if (realBranch) {
      return realBranch;
    }
    const workspacePath = this.resolveWorkspacePath(runId, branchId);
    const headFile = path.join(workspacePath, '.git', 'HEAD');
    if (!fs.existsSync(headFile)) {
      return null;
    }
    const raw = fs.readFileSync(headFile, 'utf-8').trim();
    return raw.replace(/^ref:\s*refs\/heads\//, '');
  }

  /**
   * E2：对沙箱真实执行 node:test 套件并解析计数/覆盖率 + 静态安全扫描
   */
  public executeSandboxVerification(params: {
    runId: string;
    branchId: string;
    requirementIds: ReadonlyArray<string>;
    runSubprocessNodeTest?: boolean;
  }): SandboxVerificationResult {
    const workspacePath = this.resolveWorkspacePath(params.runId, params.branchId);
    const securityFindings: string[] = [];
    let filesVerifiedCount = 0;
    const testFilesToRun: string[] = [];

    for (const reqId of params.requirementIds) {
      const pascalName = GitWorktreeSandboxManager.toPascalCase(reqId);
      const className = `${pascalName}DomainService`;
      const absModulePath = path.join(
        workspacePath,
        `src/modules/${reqId.toLowerCase()}/${className}.ts`,
      );
      const absTestPath = path.join(workspacePath, `tests/${reqId.toLowerCase()}.sandbox.spec.ts`);

      if (fs.existsSync(absModulePath)) {
        filesVerifiedCount += 1;
        const content = fs.readFileSync(absModulePath, 'utf-8');
        if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) {
          securityFindings.push(`检测到高危动态代码执行调用: ${absModulePath}`);
        }
        if (/\bsk-[a-zA-Z0-9]{16,}\b/.test(content)) {
          securityFindings.push(`检测到硬编码 API 密钥泄露: ${absModulePath}`);
        }
      }
      if (fs.existsSync(absTestPath)) {
        filesVerifiedCount += 1;
        testFilesToRun.push(absTestPath);
      }
    }

    const suites: ParsedSuite[] = [];
    let subprocessExecuted = false;
    let subprocessOutput = '';
    // E3：运行时选择——SANDBOX_RUNTIME=docker 且 docker 可用 → 一次性容器执行；
    // 请求了但不可用/执行失败 → 显式降级宿主机（host-fallback），绝不阻塞流水线
    let runtime: 'host' | 'docker' | 'host-fallback' = 'host';
    let useDocker = false;
    if (DockerTestRuntime.isRuntimeRequested()) {
      if (this.dockerRuntime.isDockerAvailable()) {
        useDocker = true;
        runtime = 'docker';
      } else {
        runtime = 'host-fallback';
        console.warn(
          '[Sandbox] SANDBOX_RUNTIME=docker 但 docker 守护进程不可用 → 降级宿主机执行（D-2）',
        );
      }
    }
    if ((params.runSubprocessNodeTest ?? true) && testFilesToRun.length > 0) {
      subprocessExecuted = true;
      const outputs: string[] = [];
      for (const testFile of testFilesToRun) {
        let suite: ParsedSuite;
        if (useDocker) {
          const suiteName = testFile.replace(/\\/g, '/').split('/').slice(-2).join('/');
          const resultsDir = path.join(
            this.sandboxRootDir,
            'docker-results',
            params.runId,
            params.branchId,
          );
          try {
            const dockerResult = this.dockerRuntime.runSuite(testFile, workspacePath, resultsDir);
            suite = TestResultParser.parseSuiteOutput(
              dockerResult.output,
              suiteName,
              dockerResult.timedOut,
            );
            if (suite.timedOut || (dockerResult.exitCode !== null && dockerResult.exitCode !== 0)) {
              runtime = 'host-fallback';
            }
          } catch (err) {
            runtime = 'host-fallback';
            console.warn(
              `[Sandbox] docker 容器执行失败 → 单套件降级宿主机: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
            );
            suite = TestResultParser.runSuite(testFile, workspacePath, 15000);
          }
        } else {
          suite = TestResultParser.runSuite(testFile, workspacePath, 15000);
        }
        suites.push(suite);
        outputs.push(
          `[Suite ${suite.suiteName}] 通过 ${suite.passedCases}/${suite.totalCases}` +
            (suite.failedCases > 0 ? `（失败 ${suite.failedCases}）` : '') +
            (suite.coveragePercent !== null ? `，行覆盖率 ${suite.coveragePercent}%` : ''),
        );
      }
      subprocessOutput = outputs.join('\n');
    }

    const totalTestCases = suites.reduce((acc, s) => acc + s.totalCases, 0);
    const passedTestCases = suites.reduce((acc, s) => acc + s.passedCases, 0);
    const failedTestCases = suites.reduce((acc, s) => acc + s.failedCases, 0);
    const coverageValues = suites
      .map((s) => s.coveragePercent)
      .filter((v): v is number => v !== null);
    const coveragePercent =
      coverageValues.length > 0
        ? Number((coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length).toFixed(1))
        : null;

    const logLines = [
      `[Sandbox Test Runner] Workspace: ${workspacePath}`,
      `[Sandbox Test Runner] Git Worktree Branch: ${this.readActiveGitBranch(params.runId, params.branchId) ?? 'N/A'}`,
      `[Sandbox Runtime] ${runtime}`,
      `[Sandbox Test Runner] Verified ${filesVerifiedCount} generated files (${params.requirementIds.length} Domain Services + ${testFilesToRun.length} Spec Suites)`,
      `[Sandbox Security Scanner] Static AST/Regex scan completed: ${securityFindings.length} high-risk vulnerabilities found`,
      subprocessExecuted
        ? `[Node Test Subprocess Output]\n${subprocessOutput}`
        : '[Assertion Check] 测试子进程未执行（runSubprocessNodeTest=false）',
    ];
    const executionLog = logLines.join('\n');
    this.latestExecutionLogs.set(`${params.runId}::${params.branchId}`, executionLog);

    return {
      workspacePath,
      filesVerifiedCount,
      totalTestCases,
      passedTestCases,
      failedTestCases,
      coveragePercent,
      suites,
      securityIssuesFound: securityFindings.length,
      securityFindings,
      subprocessExecuted,
      executionLog,
      runtime,
    };
  }

  /**
   * 汇总指定运行实例与分支的沙箱文件列表与最新测试输出，供前端管控台实时展示
   */
  public getWorkspaceSummary(
    runId: string,
    branchId: string,
  ): {
    readonly activeWorktreeBranch: string;
    readonly worktreePath: string;
    readonly generatedFiles: ReadonlyArray<{
      readonly relativePath: string;
      readonly sizeBytes: number;
      readonly previewSnippet: string;
    }>;
    readonly latestTestCommandOutput: string;
  } {
    const workspacePath = this.resolveWorkspacePath(runId, branchId);
    const activeWorktreeBranch =
      this.readActiveGitBranch(runId, branchId) ?? `worktree/${runId}/${branchId}`;

    const collectedFiles: Array<{
      relativePath: string;
      sizeBytes: number;
      previewSnippet: string;
    }> = [];

    const walkDir = (dir: string): void => {
      if (!fs.existsSync(dir)) {
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else {
          const stat = fs.statSync(full);
          const content = fs.readFileSync(full, 'utf-8');
          collectedFiles.push({
            relativePath: path.relative(workspacePath, full),
            sizeBytes: stat.size,
            previewSnippet: content.split('\n').slice(0, 16).join('\n'),
          });
        }
      }
    };

    walkDir(workspacePath);

    return {
      activeWorktreeBranch,
      worktreePath: workspacePath,
      generatedFiles: collectedFiles,
      latestTestCommandOutput: this.latestExecutionLogs.get(`${runId}::${branchId}`) ?? '',
    };
  }
}
