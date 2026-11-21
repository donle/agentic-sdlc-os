/**
 * @file install-git-hooks.ts
 * @description 自动配置本地 Git pre-commit 工程化质量门禁钩子（提交前强制执行 typecheck + lint + format:check + test）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function installPreCommitHook(): void {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const gitHooksDir = path.resolve(currentDir, '../.git/hooks');
  if (!fs.existsSync(gitHooksDir)) {
    return;
  }
  const preCommitPath = path.join(gitHooksDir, 'pre-commit');
  const scriptContent = `#!/bin/sh
echo "🔍 [Agentic SDLC OS] Running pre-commit engineering quality gate (typecheck + lint + format + test)..."
npm run check
`;
  fs.writeFileSync(preCommitPath, scriptContent, { encoding: 'utf-8', mode: 0o755 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installPreCommitHook();
  console.log('✅ Git pre-commit 质量门禁钩子已安装');
}
