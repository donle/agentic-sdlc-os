/**
 * @file AdminGovernanceView.tsx
 * @description 团队成员目录与 F2 账号/权限 CRUD 管理 + 登录审计日志 + 流程规则设置 + 协同效率 KPI（Meridian UI Kit）。
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  Inline,
  Input,
  MetricGrid,
  Panel,
  SectionLabel,
  Select,
  Stack,
  StatusChip,
  Text,
} from '../../kit/index.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import { stageMeta } from '../lib/display.ts';
import type {
  AuthUserDto,
  DashboardStateDto,
  LoginAuditEntryDto,
  ModelBaselineCheckDto,
} from '../types.ts';

const STAGE_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'STAGE_0_INITIATION', label: '0. 立项' },
  { id: 'STAGE_1_PM', label: '1. PM 需求' },
  { id: 'STAGE_2_PD', label: '2. PD 设计' },
  { id: 'STAGE_3A_TECH_SPEC', label: '3a. 架构设计' },
  { id: 'STAGE_3B_ENGINEER', label: '3b. 工程师编码' },
  { id: 'STAGE_4_QA', label: '4. QA 测试' },
  { id: 'STAGE_5_DA', label: '5. DA 复盘' },
];

const DOMAIN_AGENT_PRESETS: ReadonlyArray<{
  domain: string;
  agentRole: string;
  label: string;
}> = [
  { domain: 'PRODUCT_MANAGEMENT', agentRole: 'PM_AGENT', label: '产品管理 (PM_AGENT)' },
  { domain: 'PRODUCT_DESIGN_UX', agentRole: 'PD_AGENT', label: '交互与设计 (PD_AGENT)' },
  {
    domain: 'SYSTEM_ARCHITECTURE',
    agentRole: 'TECH_LEAD_AGENT',
    label: '系统架构 (TECH_LEAD_AGENT)',
  },
  {
    domain: 'SOFTWARE_ENGINEERING',
    agentRole: 'ENGINEER_AGENT',
    label: '软件研发 (ENGINEER_AGENT)',
  },
  { domain: 'QUALITY_ASSURANCE', agentRole: 'QA_AGENT', label: '质量保证 (QA_AGENT)' },
  { domain: 'DATA_ANALYTICS', agentRole: 'DA_AGENT', label: '数据分析 (DA_AGENT)' },
  {
    domain: 'GLOBAL_ADMINISTRATION',
    agentRole: 'SUPERVISOR_AGENT',
    label: '全局管理 (SUPERVISOR_AGENT)',
  },
];

export function AdminGovernanceView({
  state,
  apiClient,
  authMode,
  onActorChange,
  onRefreshState,
  onBanner,
}: {
  state: DashboardStateDto;
  apiClient: WorkbenchApiClient;
  authMode: 'loading' | 'authenticated' | 'unauthenticated' | 'demo_mode';
  onActorChange: (userId: string) => void;
  onRefreshState: () => Promise<void>;
  onBanner: (message: string, type: 'error' | 'success') => void;
}) {
  const isAdmin = Boolean(state.rbacContext?.currentUser.isProjectAdmin);
  const [maxTurns, setMaxTurns] = useState(3);
  const [riskThreshold, setRiskThreshold] = useState(60);
  const [allowCross, setAllowCross] = useState(true);
  const [baseline, setBaseline] = useState<ModelBaselineCheckDto | null>(null);
  const [baselineLoading, setBaselineLoading] = useState(false);

  const [adminUsers, setAdminUsers] = useState<ReadonlyArray<AuthUserDto>>([]);
  const [auditEntries, setAuditEntries] = useState<ReadonlyArray<LoginAuditEntryDto>>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newJobTitle, setNewJobTitle] = useState('研发工程师');
  const [newDepartment, setNewDepartment] = useState('核心产品研发部');
  const [newTier, setNewTier] = useState<'PROJECT_ADMIN' | 'STAGE_SPECIALIST'>('STAGE_SPECIALIST');
  const [newDomain, setNewDomain] = useState('SOFTWARE_ENGINEERING');
  const [newStages, setNewStages] = useState<string[]>(['STAGE_3B_ENGINEER']);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingStages, setEditingStages] = useState<string[]>([]);
  const [issuedCredentialHint, setIssuedCredentialHint] = useState<string | null>(null);

  useEffect(() => {
    setMaxTurns(state.workflowDslSummary?.maxNegotiationTurns ?? 3);
    setRiskThreshold(state.workflowDslSummary?.highRiskScoreThreshold ?? 60);
    setAllowCross(state.rbacContext?.allowSpecialistCrossStageRollback ?? true);
  }, [state.workflowDslSummary, state.rbacContext]);

  const loadAdminDirectoryAndAudit = useCallback(async () => {
    if (!isAdmin) {
      setAdminUsers([]);
      setAuditEntries([]);
      return;
    }
    try {
      const [users, entries] = await Promise.all([
        apiClient.listAdminUsers(),
        apiClient.fetchLoginAudit({ limit: 20 }),
      ]);
      setAdminUsers(users);
      setAuditEntries(entries);
    } catch {
      // 非管理员或鉴权未就绪时保留花名册只读视图
    }
  }, [apiClient, isAdmin]);

  useEffect(() => {
    void loadAdminDirectoryAndAudit();
  }, [loadAdminDirectoryAndAudit, authMode, state.rbacContext?.currentUser.userId]);

  const report = state.retrospectiveReport;
  const roster = state.rbacContext?.roster ?? [];
  const currentUserId = state.rbacContext?.currentUser.userId;
  const adminUsersById = new Map(adminUsers.map((u) => [u.userId, u]));

  const toggleStageInList = (list: string[], stageId: string): string[] =>
    list.includes(stageId) ? list.filter((s) => s !== stageId) : [...list, stageId];

  const handleCreateUser = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!newUsername.trim() || !newDisplayName.trim()) {
      onBanner('请填写账号用户名与展示姓名', 'error');
      return;
    }
    const preset =
      DOMAIN_AGENT_PRESETS.find((p) => p.domain === newDomain) ?? DOMAIN_AGENT_PRESETS[3];
    try {
      const created = await apiClient.createAdminUser({
        username: newUsername.trim(),
        displayName: newDisplayName.trim(),
        jobTitle: newJobTitle.trim() || '团队成员',
        department: newDepartment.trim(),
        tier: newTier,
        specialistDomain: preset.domain,
        counterpartAgentRole: preset.agentRole,
        ownedStageIds: newStages,
      });
      setIssuedCredentialHint(
        `已创建账号 [${created.user.username}]（${created.user.displayName}），一次性初始临时口令：${created.tempPassword ?? '(已设置)'}`,
      );
      setNewUsername('');
      setNewDisplayName('');
      setShowCreateForm(false);
      await loadAdminDirectoryAndAudit();
      await onRefreshState();
      onBanner(`成员 [${created.user.displayName}] 创建成功`, 'success');
    } catch (err) {
      onBanner(err instanceof Error ? err.message : '创建成员失败', 'error');
    }
  };

  return (
    <Stack gap="loose">
      <Panel
        title="团队成员目录与步骤分工权限表"
        actions={
          <Inline wrap>
            <StatusChip tone="brand">全员共享项目与评论 · 按专长步骤分配确认权限</StatusChip>
            {isAdmin ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setShowCreateForm((prev) => !prev)}
              >
                {showCreateForm ? '收起创建表单' : '+ 新增团队成员'}
              </Button>
            ) : null}
          </Inline>
        }
      >
        <Stack gap="normal">
          {issuedCredentialHint ? (
            <Callout tone="success" title="一次性初始/重置临时口令已生成">
              <Inline className="m-between" wrap>
                <Text variant="sm">{issuedCredentialHint}</Text>
                <Button size="sm" variant="outline" onClick={() => setIssuedCredentialHint(null)}>
                  关闭
                </Button>
              </Inline>
            </Callout>
          ) : null}

          {isAdmin && showCreateForm ? (
            <Card inset title="创建新企业成员 (F2)">
              <form
                className="col-stack"
                style={{ gap: 10 }}
                onSubmit={(ev) => void handleCreateUser(ev)}
              >
                <div className="form-row">
                  <Input
                    ariaLabel="登录用户名"
                    placeholder="登录用户名（如 eng2）"
                    value={newUsername}
                    onChange={setNewUsername}
                  />
                  <Input
                    ariaLabel="成员展示名"
                    placeholder="成员展示名（如 张工 (研发)）"
                    value={newDisplayName}
                    onChange={setNewDisplayName}
                  />
                  <Input
                    ariaLabel="岗位名称"
                    placeholder="岗位名称"
                    value={newJobTitle}
                    onChange={setNewJobTitle}
                  />
                  <Input
                    ariaLabel="所属部门"
                    placeholder="所属部门"
                    value={newDepartment}
                    onChange={setNewDepartment}
                  />
                </div>
                <div className="form-row">
                  <Select
                    ariaLabel="成员角色层级"
                    value={newTier}
                    onChange={(val) =>
                      setNewTier(val === 'PROJECT_ADMIN' ? 'PROJECT_ADMIN' : 'STAGE_SPECIALIST')
                    }
                    options={[
                      { value: 'STAGE_SPECIALIST', label: '环节专业负责人 (STAGE_SPECIALIST)' },
                      { value: 'PROJECT_ADMIN', label: '项目最高管理员 (PROJECT_ADMIN)' },
                    ]}
                  />
                  <Select
                    ariaLabel="专业领域与搭档 Agent"
                    value={newDomain}
                    onChange={setNewDomain}
                    options={DOMAIN_AGENT_PRESETS.map((p) => ({
                      value: p.domain,
                      label: p.label,
                    }))}
                  />
                </div>
                <Inline wrap>
                  <Text variant="xs" tone="secondary">
                    负责把关步骤：
                  </Text>
                  {STAGE_OPTIONS.map((st) => (
                    <label
                      key={st.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    >
                      <input
                        type="checkbox"
                        checked={newStages.includes(st.id)}
                        onChange={() => setNewStages((prev) => toggleStageInList(prev, st.id))}
                      />
                      {st.label}
                    </label>
                  ))}
                </Inline>
                <Inline>
                  <Button type="submit" size="sm" variant="primary">
                    确认创建并生成临时口令
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowCreateForm(false)}>
                    取消
                  </Button>
                </Inline>
              </form>
            </Card>
          ) : null}

          <div style={{ overflowX: 'auto' }}>
            <table className="rbac-table">
              <thead>
                <tr>
                  <th>团队成员</th>
                  <th>角色层级</th>
                  <th>岗位与所属部门</th>
                  <th>协同搭档 Agent</th>
                  <th>负责把关确认的研发步骤</th>
                  <th>状态 / 操作</th>
                </tr>
              </thead>
              <tbody>
                {(adminUsers.length > 0 ? adminUsers : roster).map((u) => {
                  const authRec = adminUsersById.get(u.userId);
                  const isUserAdmin = u.tier === 'PROJECT_ADMIN';
                  const status = authRec?.status ?? 'ACTIVE';
                  const stepNames = (u.ownedStageIds ?? [])
                    .filter((id) => id !== 'STAGE_0_INITIATION')
                    .map((id) => stageMeta(id).shortName);
                  const isEditing = editingUserId === u.userId;

                  return (
                    <tr
                      key={u.userId}
                      style={
                        u.userId === currentUserId
                          ? { background: 'var(--m-brand-soft)' }
                          : undefined
                      }
                    >
                      <td>
                        <strong>
                          {u.avatarBadge} {u.displayName}
                        </strong>
                        {authRec ? (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            @{authRec.username}
                            {authRec.mustChangePassword ? ' · 待改密' : ''}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <StatusChip tone={isUserAdmin ? 'violet' : 'cyan'}>
                          {isUserAdmin ? '项目最高管理员' : '环节专业负责人'}
                        </StatusChip>
                      </td>
                      <td>
                        {u.jobTitle}{' '}
                        <span style={{ color: 'var(--text-muted)' }}>({u.department})</span>
                      </td>
                      <td>
                        <code>{u.counterpartAgentRole}</code>
                      </td>
                      <td>
                        {isEditing ? (
                          <Inline wrap>
                            {STAGE_OPTIONS.map((st) => (
                              <label
                                key={st.id}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 3,
                                  fontSize: 11,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={editingStages.includes(st.id)}
                                  onChange={() =>
                                    setEditingStages((prev) => toggleStageInList(prev, st.id))
                                  }
                                />
                                {st.label}
                              </label>
                            ))}
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={async () => {
                                try {
                                  await apiClient.updateAdminUser(u.userId, {
                                    ownedStageIds: editingStages,
                                  });
                                  setEditingUserId(null);
                                  await loadAdminDirectoryAndAudit();
                                  await onRefreshState();
                                  onBanner(`已更新 [${u.displayName}] 的负责步骤`, 'success');
                                } catch (err) {
                                  onBanner(
                                    err instanceof Error ? err.message : '更新步骤失败',
                                    'error',
                                  );
                                }
                              }}
                            >
                              保存
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingUserId(null)}
                            >
                              取消
                            </Button>
                          </Inline>
                        ) : isUserAdmin ? (
                          <StatusChip tone="violet">全流程拍板确认 + 流程规则管理</StatusChip>
                        ) : (
                          <Inline wrap>
                            {stepNames.map((s) => (
                              <StatusChip tone="brand" key={s}>
                                {s}
                              </StatusChip>
                            ))}
                          </Inline>
                        )}
                      </td>
                      <td>
                        <Inline wrap>
                          <StatusChip tone={status === 'ACTIVE' ? 'success' : 'danger'} dot>
                            {status}
                          </StatusChip>
                          {u.userId === currentUserId ? (
                            <StatusChip tone="brand">当前登录</StatusChip>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onActorChange(u.userId)}
                            >
                              {authMode === 'authenticated' ? '代班视角' : '切换成员'}
                            </Button>
                          )}
                          {isAdmin && authRec ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingUserId(u.userId);
                                  setEditingStages([...u.ownedStageIds]);
                                }}
                              >
                                改权
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  try {
                                    const res = await apiClient.resetAdminUserPassword(u.userId);
                                    setIssuedCredentialHint(
                                      `已重置 [${authRec.username}] 口令，新临时口令：${res.tempPassword}`,
                                    );
                                    await loadAdminDirectoryAndAudit();
                                  } catch (err) {
                                    onBanner(
                                      err instanceof Error ? err.message : '重置口令失败',
                                      'error',
                                    );
                                  }
                                }}
                              >
                                重置口令
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  const nextStatus = status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
                                  try {
                                    await apiClient.updateAdminUser(u.userId, {
                                      status: nextStatus,
                                    });
                                    await loadAdminDirectoryAndAudit();
                                    await onRefreshState();
                                    onBanner(
                                      `已将 [${authRec.username}] 状态设为 ${nextStatus}`,
                                      'success',
                                    );
                                  } catch (err) {
                                    onBanner(
                                      err instanceof Error ? err.message : '更新成员状态失败',
                                      'error',
                                    );
                                  }
                                }}
                              >
                                {status === 'ACTIVE' ? '停用' : '启用'}
                              </Button>
                            </>
                          ) : null}
                        </Inline>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Stack>
      </Panel>

      {isAdmin ? (
        <Panel
          title="安全登录与视角切换审计日志 (F1/F2)"
          actions={
            <Button
              size="sm"
              variant="outline"
              icon="refresh"
              onClick={() => void loadAdminDirectoryAndAudit()}
            >
              刷新审计日志
            </Button>
          }
        >
          {auditEntries.length === 0 ? (
            <EmptyState
              compact
              title="暂无登录审计记录"
              description="通过真实账号登录或管理员代班切换后将在此自动留痕。"
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="rbac-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>账号</th>
                    <th>结果</th>
                    <th>事件类型</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.id}</td>
                      <td>
                        <code>{entry.username}</code>
                      </td>
                      <td>
                        <StatusChip tone={entry.success ? 'success' : 'danger'} dot>
                          {entry.success ? '成功' : '拦截'}
                        </StatusChip>
                      </td>
                      <td>
                        <code>{entry.reason}</code>
                      </td>
                      <td>{entry.createdAtIso}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      <div className="main-grid">
        <Panel
          title="项目流程与讨论规则设置"
          actions={
            <StatusChip tone={isAdmin ? 'violet' : 'neutral'} dot>
              {isAdmin ? '项目管理员 · 可直接修改' : '仅管理员可修改规则'}
            </StatusChip>
          }
        >
          <Stack gap="normal">
            <div className="form-row">
              <label style={{ minWidth: 220, fontSize: 12.5 }}>Agent 自动讨论最大轮次上限:</label>
              <input
                type="number"
                className="input-control"
                min={1}
                max={10}
                value={maxTurns}
                onChange={(ev) => setMaxTurns(Number(ev.target.value))}
              />
            </div>
            <div className="form-row">
              <label style={{ minWidth: 220, fontSize: 12.5 }}>
                需人工确认的风险分数线 (0-100):
              </label>
              <input
                type="number"
                className="input-control"
                min={20}
                max={100}
                value={riskThreshold}
                onChange={(ev) => setRiskThreshold(Number(ev.target.value))}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={allowCross}
                onChange={(ev) => setAllowCross(ev.target.checked)}
              />
              允许各环节负责人通过总管 Agent 发起跨步骤回退
            </label>
            <Inline wrap>
              <Button
                variant="violet"
                size="sm"
                onClick={async () => {
                  try {
                    await apiClient.updateAdminGovernanceConfig({
                      maxNegotiationTurns: maxTurns,
                      highRiskScoreThreshold: riskThreshold,
                      allowSpecialistCrossStageRollback: allowCross,
                    });
                    await onRefreshState();
                    onBanner(
                      `[管理员设置已更新] 已保存全局最大讨论轮次=${maxTurns}、人工确认风险分数线=${riskThreshold}`,
                      'success',
                    );
                  } catch (err) {
                    onBanner(
                      err instanceof Error ? err.message : '更新设置被权限校验拦截',
                      'error',
                    );
                  }
                }}
              >
                {isAdmin ? '保存流程规则设置' : '🔒 保存流程规则设置 (需管理员)'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                loading={baselineLoading}
                disabled={!isAdmin || baselineLoading}
                onClick={async () => {
                  setBaselineLoading(true);
                  try {
                    const result = await apiClient.runModelBaseline();
                    setBaseline(result);
                    if (result.offline) {
                      onBanner('[模型体检] 当前为离线模式（未启用在线网关），未执行体检', 'error');
                    } else {
                      const total = result.reports.length;
                      const passed = result.reports.filter(
                        (r) => r.jsonSchemaAdherencePassed,
                      ).length;
                      onBanner(
                        `[模型体检完成] ${passed}/${total} 个任务通过 JSON 契约遵循度校验`,
                        passed === total && total > 0 ? 'success' : 'error',
                      );
                    }
                  } catch (err) {
                    onBanner(
                      err instanceof Error ? err.message : '模型体检被权限校验拦截',
                      'error',
                    );
                  } finally {
                    setBaselineLoading(false);
                  }
                }}
              >
                {isAdmin ? '🩺 执行模型体检 (A4)' : '🔒 执行模型体检 (需管理员)'}
              </Button>
            </Inline>

            {baseline && !baseline.offline ? (
              <Stack gap="tight">
                {['PRIVACY_SENSITIVE_LOCAL', 'HIGH_REASONING_HYBRID'].map((tier) => {
                  const tierReports = baseline.reports.filter((r) => r.tier === tier);
                  if (tierReports.length === 0) {
                    return (
                      <Text key={tier} variant="xs" tone="tertiary">
                        {tier}：无体检报告（任务执行失败或端点不可达）
                      </Text>
                    );
                  }
                  const passed = tierReports.filter((r) => r.jsonSchemaAdherencePassed).length;
                  const model = tierReports[0].modelIdentifier;
                  const missing = tierReports
                    .filter((r) => !r.jsonSchemaAdherencePassed)
                    .flatMap((r) => r.missingKeys);
                  return (
                    <Inline key={tier} wrap>
                      <StatusChip tone={passed === tierReports.length ? 'success' : 'warn'}>
                        {passed}/{tierReports.length} 通过
                      </StatusChip>
                      <Text variant="xs" as="strong">
                        {tier} · {model}
                      </Text>
                      {missing.length > 0 ? (
                        <Text variant="xs" tone="secondary">
                          缺失字段：{missing.join(', ')}
                        </Text>
                      ) : null}
                    </Inline>
                  );
                })}
              </Stack>
            ) : null}
          </Stack>
        </Panel>

        <Panel
          title="Agent 协同效率与方案复用统计"
          actions={
            <StatusChip tone={report?.overallHealthy ? 'success' : 'warn'} dot>
              {report ? (report.overallHealthy ? '协同效率达标' : '存在复盘关注项') : '统计中'}
            </StatusChip>
          }
        >
          {report ? (
            <Stack gap="normal">
              <MetricGrid
                columns={2}
                items={[
                  {
                    label: '(a) 历史方案复用率',
                    value: `${report.cacheMetrics.cacheHitRatePercent}%`,
                    delta: `复用 ${report.cacheMetrics.totalHits}/${report.cacheMetrics.totalLookups} · 省 ${report.cacheMetrics.savedTokensTotal} Tokens`,
                  },
                  {
                    label: '(b-1) 步骤意图达成率',
                    value: `${report.fulfillmentMetrics.fulfillmentRatePercent}%`,
                    delta: `首次直通率 ${report.fulfillmentMetrics.firstPassSuccessRatePercent}%`,
                  },
                  {
                    label: '(b-2) 平均自愈修正次数',
                    value: String(report.fulfillmentMetrics.averageRetriesPerInvocation),
                    delta: `0次:${report.fulfillmentMetrics.retryDistribution.zeroRetries} | 1次:${report.fulfillmentMetrics.retryDistribution.oneRetry} | ≥2次:${report.fulfillmentMetrics.retryDistribution.twoOrMoreRetries}`,
                  },
                  {
                    label: '(c) 研发算力节省比',
                    value: `${report.costSavingsRatioPercent}%`,
                    delta: `累计成本 $${report.fulfillmentMetrics.totalCostUsd}`,
                  },
                ]}
              />

              <SectionLabel>复盘 SLA 诊断条目</SectionLabel>
              <Stack gap="tight">
                {report.diagnoses.map((d) => (
                  <Card
                    key={d.metricName}
                    inset
                    title={
                      <Inline className="m-between" wrap>
                        <Text variant="sm" as="strong">
                          {d.passedSla ? '✅' : '⚠️'} {d.metricName}
                        </Text>
                        <StatusChip tone={d.passedSla ? 'success' : 'warn'}>
                          基线 {d.targetThreshold}
                        </StatusChip>
                      </Inline>
                    }
                    subtitle={`当前表现：${d.observedValue}`}
                  >
                    <Text variant="xs" tone="secondary">
                      建议：{d.optimizationAction}
                    </Text>
                  </Card>
                ))}
              </Stack>
            </Stack>
          ) : (
            <EmptyState compact title="暂无复盘指标数据" />
          )}
        </Panel>
      </div>
    </Stack>
  );
}
