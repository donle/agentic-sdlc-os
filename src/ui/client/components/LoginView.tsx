/**
 * @file LoginView.tsx
 * @description F1/P0-2 登录界面：支持独立登录页模式与演示模式按需弹窗登录，展示错误提示与锁定倒计时。
 */

import { useState, type FormEvent } from 'react';
import type { AuthUserDto } from '../types.ts';
import { ApiHttpError, type WorkbenchApiClient } from '../WorkbenchApiClient.ts';

export function LoginView({
  apiClient,
  onLoginSuccess,
  onCancel,
}: {
  apiClient: WorkbenchApiClient;
  onLoginSuccess: (user: AuthUserDto) => void;
  onCancel?: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!username.trim() || !password) {
      setErrorMessage('请输入用户名与登录口令');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const user = await apiClient.login(username.trim(), password);
      onLoginSuccess(user);
    } catch (err) {
      if (err instanceof ApiHttpError && err.retryAfterSec) {
        setErrorMessage(`${err.message}（请 ${err.retryAfterSec} 秒后再试）`);
      } else {
        setErrorMessage(err instanceof Error ? err.message : '登录失败，请检查账号或口令');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-badge">A</span>
          <div>
            <h1 className="auth-title">Agentic SDLC OS</h1>
            <p className="auth-subtitle">企业级多智能体研发协同控制台 · 成员身份认证</p>
          </div>
        </div>

        <form className="auth-form" onSubmit={(ev) => void handleSubmit(ev)}>
          <label className="auth-field">
            <span>成员账号 (Username)</span>
            <input
              type="text"
              className="input-control"
              autoComplete="username"
              placeholder="例如 admin / pm / pd / arch / eng / qa / da"
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="auth-field">
            <span>登录口令 (Password)</span>
            <input
              type="password"
              className="input-control"
              autoComplete="current-password"
              placeholder="首次登录默认口令与账号同名（如 admin）"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              disabled={submitting}
            />
          </label>

          {errorMessage ? <div className="auth-error-box">{errorMessage}</div> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            {onCancel ? (
              <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
                返回工作台
              </button>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? '正在验证身份…' : '登录控制台'}
            </button>
          </div>
        </form>

        <div className="auth-hint-box">
          会话基于 HttpOnly Cookie（8 小时滑动续期）；首次登录或重置口令后将强制要求更新密码。
        </div>
      </div>
    </div>
  );
}
