/**
 * @file SandboxExplorerView.tsx
 * @description 交付源码与测试沙箱（Meridian UI Kit）：文件树 + 源码阅读器 + 真实单测/安全扫描日志。
 */

import { useEffect, useState } from 'react';
import {
  Button,
  EmptyState,
  Inline,
  ListRow,
  Panel,
  SectionLabel,
  Stack,
  StatusChip,
} from '../../kit/index.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import type { DashboardStateDto } from '../types.ts';

export function SandboxExplorerView({
  state,
  apiClient,
  onApplyState,
  onBanner,
}: {
  state: DashboardStateDto;
  apiClient: WorkbenchApiClient;
  onApplyState: (nextState: DashboardStateDto) => void;
  onBanner: (message: string, type: 'error' | 'success') => void;
}) {
  const sandbox = state.sandboxWorkspaceSummary;
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [terminal, setTerminal] = useState<string>(sandbox?.latestTestCommandOutput ?? '');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setTerminal(sandbox?.latestTestCommandOutput ?? '');
  }, [sandbox?.latestTestCommandOutput, state.run?.runId]);

  useEffect(() => {
    if (!sandbox || sandbox.generatedFiles.length === 0) {
      setActivePath(null);
      setFileContent('');
      return;
    }
    const fallback = activePath ?? sandbox.generatedFiles[0].relativePath;
    setActivePath(fallback);
    apiClient
      .fetchSandboxFileContent(fallback, state.run?.runId)
      .then((res) => setFileContent(res.content))
      .catch(() => setFileContent(''));
    // 切换运行实例或分支时刷新文件树默认选中项
  }, [sandbox?.activeWorktreeBranch, state.run?.runId]);

  if (!sandbox) {
    return null;
  }

  const runTests = async () => {
    setRunning(true);
    setTerminal('⏳ 正在隔离沙箱子进程中运行真实单测与静态安全扫描...');
    try {
      const res = await apiClient.triggerLiveSandboxVerification(state.run?.runId);
      setTerminal(res.executionLog);
      onApplyState(res.dashboardState);
      const { totalTestCases, passedTestCases, failedTestCases, securityIssuesFound } =
        res.verification;
      const passRate =
        totalTestCases > 0 ? Math.round((passedTestCases / totalTestCases) * 100) : 0;
      const clean = failedTestCases === 0 && securityIssuesFound === 0 && totalTestCases > 0;
      onBanner(
        `沙箱测试完成：${passedTestCases}/${totalTestCases} 通过（通过率 ${passRate}%），安全告警 ${securityIssuesFound} 项`,
        clean ? 'success' : 'error',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '沙箱测试执行失败';
      setTerminal(msg);
      onBanner(msg, 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      title="项目代码沙箱仓库与自动化测试运行中心 (Git Worktree)"
      subtitle={`工作区路径：${sandbox.worktreePath}`}
      actions={
        <Inline>
          <StatusChip tone="cyan" dot>
            {sandbox.activeWorktreeBranch}
          </StatusChip>
          <Button
            variant="success"
            size="sm"
            loading={running}
            icon="play"
            onClick={() => void runTests()}
          >
            运行沙箱自动化单测 &amp; 安全扫描
          </Button>
        </Inline>
      }
    >
      <div className="sandbox-explorer-layout">
        <Stack gap="tight">
          <SectionLabel>已生成的源码与脚本文件树 ({sandbox.generatedFiles.length})</SectionLabel>
          {sandbox.generatedFiles.length === 0 ? (
            <EmptyState
              compact
              icon="folder"
              title="尚未进入代码实现阶段"
              description="当前项目分支尚未推进到【步骤 3b：工程师代码实现】，可在前序步骤完成确认后查看源码。"
            />
          ) : (
            <Stack gap="tight">
              {sandbox.generatedFiles.map((file) => (
                <ListRow
                  key={file.relativePath}
                  className={
                    activePath === file.relativePath ? 'gate-queue-item-active' : undefined
                  }
                  onClick={() => {
                    setActivePath(file.relativePath);
                    apiClient
                      .fetchSandboxFileContent(file.relativePath, state.run?.runId)
                      .then((res) => setFileContent(res.content))
                      .catch(() => setFileContent(file.previewSnippet));
                  }}
                  title={<code>{file.relativePath}</code>}
                  trailing={<StatusChip tone="neutral">{file.sizeBytes}B</StatusChip>}
                />
              ))}
            </Stack>
          )}
        </Stack>

        <Stack gap="normal">
          <div id="sandboxActiveFileHeader">
            <Stack gap="tight">
              <SectionLabel>源码阅读器：{activePath ?? '请选择左侧文件'}</SectionLabel>
              <pre className="code-preview-block">
                {fileContent || '// 选择左侧文件查看完整源码'}
              </pre>
            </Stack>
          </div>
          <Stack gap="tight">
            <SectionLabel>自动化测试执行与安全扫描日志</SectionLabel>
            <pre className="code-preview-block">{terminal}</pre>
          </Stack>
        </Stack>
      </div>
    </Panel>
  );
}
