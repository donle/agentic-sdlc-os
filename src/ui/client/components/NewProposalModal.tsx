/**
 * @file NewProposalModal.tsx
 * @description 新建研发项目弹窗：自定义提案表单 + 4 个示例场景一键启动。
 */

import { useState } from 'react';

export interface CustomProposalInput {
  readonly title: string;
  readonly summary: string;
  readonly requirements: Record<string, string>;
  readonly involvesDatabaseMigration: boolean;
  readonly involvesPermissionOrPayment: boolean;
  readonly simulateNegotiationConflict: boolean;
}

export function NewProposalModal({
  open,
  onClose,
  onSubmitCustom,
  onLaunchPreset,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitCustom: (input: CustomProposalInput) => void;
  onLaunchPreset: (preset: string, label: string) => void;
}) {
  const [title, setTitle] = useState('企业级供应链智能合同风控与审批中台');
  const [summary, setSummary] = useState(
    '构建合同条款风险识别、多角色审批流转与沙箱自动化合规校验闭环',
  );
  const [reqsRaw, setReqsRaw] = useState(
    'REQ_CONTRACT_SCAN: 支持合同敏感条款自动识别与风险分级\nREQ_APPROVAL_CHAIN: 支持多级角色权限门禁与会签流转\nREQ_AUDIT_ARCHIVE: 支持合同审批全链路不可变审计归档',
  );
  const [ddl, setDdl] = useState(true);
  const [auth, setAuth] = useState(true);
  const [conflict, setConflict] = useState(false);

  if (!open) {
    return null;
  }

  const submit = () => {
    const requirements: Record<string, string> = {};
    for (const line of reqsRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        requirements[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 1).trim();
      } else {
        requirements[`REQ_${Object.keys(requirements).length + 1}`] = trimmed;
      }
    }
    onSubmitCustom({
      title,
      summary,
      requirements,
      involvesDatabaseMigration: ddl,
      involvesPermissionOrPayment: auth,
      simulateNegotiationConflict: conflict,
    });
  };

  const presets: ReadonlyArray<{ preset: string; label: string; className: string }> = [
    {
      preset: 'CONFLICT_AND_DDL',
      label: '示例 1：PM 与 PD 3轮讨论分歧 + 架构表设计',
      className: 'btn-primary',
    },
    {
      preset: 'LOW_RISK_FAST_TRACK',
      label: '示例 2：常规迭代项目直达步骤 4 QA 验收',
      className: '',
    },
    { preset: 'SCOPE_DIFF_ALERT', label: '示例 3：需求范围变更提醒项目', className: 'btn-warning' },
    {
      preset: 'CACHE_HIT_REUSE',
      label: '示例 4：复用历史方案加速交付项目',
      className: 'btn-success',
    },
  ];

  return (
    <div
      className="modal-backdrop open"
      onClick={(ev) => ev.target === ev.currentTarget && onClose()}
    >
      <div className="modal-card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--border-subtle)',
            paddingBottom: 12,
          }}
        >
          <h3 style={{ fontSize: 16 }}>发起新研发项目 (自动拆解为多 Agent 协同步骤)</h3>
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="supervisor-form">
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            填写自定义研发项目名称、业务背景与核心功能诉求：
          </div>
          <input
            type="text"
            className="input-control"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            placeholder="输入项目名称..."
          />
          <input
            type="text"
            className="input-control"
            value={summary}
            onChange={(ev) => setSummary(ev.target.value)}
            placeholder="输入项目背景与目标..."
          />
          <textarea
            className="textarea-control"
            rows={4}
            value={reqsRaw}
            onChange={(ev) => setReqsRaw(ev.target.value)}
            placeholder="每行一条核心功能需求，格式 REQ_CODE: 需求描述"
          />
          <div className="form-row" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={ddl} onChange={(ev) => setDdl(ev.target.checked)} />
              包含数据库表结构变更 (步骤 3a 需架构师确认)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={auth} onChange={(ev) => setAuth(ev.target.checked)} />
              涉及核心权限/支付安全域
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={conflict}
                onChange={(ev) => setConflict(ev.target.checked)}
              />
              演示步骤 2 UI 设计师与产品经理多轮讨论分歧
            </label>
          </div>
          <button type="button" className="btn btn-primary" onClick={submit}>
            立即创建项目并启动多智能体分步协同
          </button>
        </div>

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            或快速切换示例项目场景：
          </div>
          <div className="form-row">
            {presets.map((p) => (
              <button
                type="button"
                key={p.preset}
                className={`btn ${p.className}`}
                onClick={() => onLaunchPreset(p.preset, p.label)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
