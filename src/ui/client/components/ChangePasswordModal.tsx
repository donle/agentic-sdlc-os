/**
 * @file ChangePasswordModal.tsx
 * @description F1/P0-2 修改登录口令弹窗：支持首次登录/重置口令强制改密（forced=true）与日常主动改密。
 */

import { useState, type FormEvent } from 'react';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';

export function ChangePasswordModal({
  open,
  forced,
  username,
  apiClient,
  onSuccess,
  onClose,
  onLogout,
}: {
  open: boolean;
  forced: boolean;
  username?: string;
  apiClient: WorkbenchApiClient;
  onSuccess: () => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const handleSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!oldPassword || !newPassword) {
      setErrorMessage('请填写原口令与新口令');
      return;
    }
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setErrorMessage('新口令至少 8 位且必须同时包含字母与数字');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('两次输入的新口令不一致');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await apiClient.changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onSuccess();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '修改口令失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop open"
      onClick={(ev) => {
        if (!forced && ev.target === ev.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="modal-card" style={{ maxWidth: 460 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--border-subtle)',
            paddingBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 16 }}>
            {forced ? '🔒 首次登录 / 重置后强制修改口令' : '🔑 修改登录口令'}
          </h3>
          {!forced ? (
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              ✕
            </button>
          ) : null}
        </div>

        <form className="supervisor-form" onSubmit={(ev) => void handleSubmit(ev)}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {forced
              ? `账号 [${username ?? ''}] 当前必须更新初始/临时口令后方可访问工作台业务功能。`
              : `正在为账号 [${username ?? ''}] 更新登录口令（成功后将自动吊销其他设备会话）。`}
          </div>

          <label className="auth-field">
            <span>当前口令</span>
            <input
              type="password"
              className="input-control"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(ev) => setOldPassword(ev.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="auth-field">
            <span>新口令（≥ 8 位，需含字母与数字）</span>
            <input
              type="password"
              className="input-control"
              autoComplete="new-password"
              value={newPassword}
              onChange={(ev) => setNewPassword(ev.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="auth-field">
            <span>确认新口令</span>
            <input
              type="password"
              className="input-control"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(ev) => setConfirmPassword(ev.target.value)}
              disabled={submitting}
            />
          </label>

          {errorMessage ? <div className="auth-error-box">{errorMessage}</div> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            {forced ? (
              <button type="button" className="btn" onClick={onLogout} disabled={submitting}>
                退出登录
              </button>
            ) : (
              <button type="button" className="btn" onClick={onClose} disabled={submitting}>
                取消
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? '正在保存…' : '确认修改口令'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
