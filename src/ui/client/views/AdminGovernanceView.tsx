/**
 * @file AdminGovernanceView.tsx
 * @description 团队成员目录与 RBAC 分工表 + 流程规则设置 + 协同效率 KPI。
 */

import { useEffect, useState } from 'react';
import type { DashboardStateDto, ModelBaselineCheckDto } from '../types.ts';
import type { WorkbenchApiClient } from '../WorkbenchApiClient.ts';
import { stageMeta } from '../lib/display.ts';

export function AdminGovernanceView({
  state,
  apiClient,
  onActorChange,
  onRefreshState,
  onBanner,
}: {
  state: DashboardStateDto;
  apiClient: WorkbenchApiClient;
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

  useEffect(() => {
    setMaxTurns(state.workflowDslSummary?.maxNegotiationTurns ?? 3);
    setRiskThreshold(state.workflowDslSummary?.highRiskScoreThreshold ?? 60);
    setAllowCross(state.rbacContext?.allowSpecialistCrossStageRollback ?? true);
  }, [state.workflowDslSummary, state.rbacContext]);

  const report = state.retrospectiveReport;
  const roster = state.rbacContext?.roster ?? [];
  const currentUserId = state.rbacContext?.currentUser.userId;

  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>团队成员目录与步骤分工权限表</span>
          </div>
          <span className="pill pill-blue">全员共享项目与评论 · 按专长步骤分配确认权限</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="rbac-table">
            <thead>
              <tr>
                <th>团队成员</th>
                <th>角色层级</th>
                <th>岗位与所属部门</th>
                <th>协同搭档 Agent</th>
                <th>项目信息与评论权限</th>
                <th>负责把关确认的研发步骤</th>
                <th>体验该成员视角</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((u) => {
                const stepNames = (u.ownedStageIds ?? [])
                  .filter((id) => id !== 'STAGE_0_INITIATION')
                  .map((id) => stageMeta(id).shortName);
                return (
                  <tr
                    key={u.userId}
                    style={
                      u.userId === currentUserId
                        ? { background: 'rgba(99,102,241,0.14)' }
                        : undefined
                    }
                  >
                    <td>
                      <strong>
                        {u.avatarBadge} {u.displayName}
                      </strong>
                    </td>
                    <td>
                      <span className={`pill ${u.isProjectAdmin ? 'pill-purple' : 'pill-cyan'}`}>
                        {u.isProjectAdmin ? '项目最高管理员' : '环节专业负责人'}
                      </span>
                    </td>
                    <td>
                      {u.jobTitle}{' '}
                      <span style={{ color: 'var(--text-muted)' }}>({u.department})</span>
                    </td>
                    <td>
                      <code>{u.counterpartAgentRole}</code>
                    </td>
                    <td>
                      <span className="pill pill-green">查看全部步骤 + 发表团队评论</span>
                    </td>
                    <td>
                      {u.isProjectAdmin ? (
                        <span className="pill pill-purple">
                          全流程所有步骤均可拍板确认 + 流程规则管理
                        </span>
                      ) : (
                        stepNames.map((s) => (
                          <span className="pill pill-blue" style={{ marginRight: 4 }} key={s}>
                            {s}
                          </span>
                        ))
                      )}
                    </td>
                    <td>
                      {u.userId === currentUserId ? (
                        <span className="pill pill-blue">当前登录成员</span>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '4px 9px', fontSize: 11.5 }}
                          onClick={() => onActorChange(u.userId)}
                        >
                          切换为此成员登录
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="main-grid">
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>项目流程与讨论规则设置 (仅项目管理员可修改)</span>
            </div>
            <span className={`pill ${isAdmin ? 'pill-purple' : 'pill-muted'}`}>
              {isAdmin ? '👑 当前为项目管理员 · 可直接修改' : '🔒 仅项目管理员可修改规则'}
            </span>
          </div>
          <div className="supervisor-form">
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
            <div className="form-row">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={allowCross}
                  onChange={(ev) => setAllowCross(ev.target.checked)}
                />
                允许各环节负责人通过总管 Agent 发起跨步骤回退
              </label>
            </div>
            <div className="form-row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-purple"
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
                {isAdmin ? '💾 保存流程规则设置' : '🔒 保存流程规则设置 (需管理员身份)'}
              </button>
            </div>
            <div className="form-row" style={{ marginTop: 10, alignItems: 'flex-start' }}>
              <button
                type="button"
                className="btn"
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
                {baselineLoading
                  ? '⏳ 体检执行中（两级端点 × 3 任务）…'
                  : isAdmin
                    ? '🩺 执行模型体检 (A4)'
                    : '🔒 执行模型体检 (需管理员身份)'}
              </button>
              {baseline && !baseline.offline && (
                <div style={{ display: 'grid', gap: 6, width: '100%' }}>
                  {['PRIVACY_SENSITIVE_LOCAL', 'HIGH_REASONING_HYBRID'].map((tier) => {
                    const tierReports = baseline.reports.filter((r) => r.tier === tier);
                    if (tierReports.length === 0) {
                      return (
                        <div key={tier} style={{ fontSize: 12.5, opacity: 0.75 }}>
                          {tier}：无体检报告（任务执行失败或端点不可达）
                        </div>
                      );
                    }
                    const passed = tierReports.filter((r) => r.jsonSchemaAdherencePassed).length;
                    const model = tierReports[0].modelIdentifier;
                    const missing = tierReports
                      .filter((r) => !r.jsonSchemaAdherencePassed)
                      .flatMap((r) => r.missingKeys);
                    return (
                      <div key={tier} style={{ fontSize: 12.5 }}>
                        <span
                          className={`pill ${passed === tierReports.length ? 'pill-green' : 'pill-amber'}`}
                        >
                          {passed}/{tierReports.length} 通过
                        </span>{' '}
                        <strong>{tier}</strong> · {model}
                        {missing.length > 0 && (
                          <span style={{ opacity: 0.8 }}> · 缺失字段: {missing.join(', ')}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>Agent 协同效率与方案复用统计</span>
            </div>
            <span
              className={`pill ${report?.overallHealthy ? 'pill-green' : 'pill-amber'}`}
              id="retroHealthBadge"
            >
              {report
                ? report.overallHealthy
                  ? '✅ 协同效率达标'
                  : '⚠️ 存在复盘关注项'
                : '统计中'}
            </span>
          </div>
          {report ? (
            <>
              <div className="telemetry-kpi-grid">
                <div className="kpi-box">
                  <div className="kpi-label">(a) 历史方案复用率</div>
                  <div className="kpi-value">{report.cacheMetrics.cacheHitRatePercent}%</div>
                  <div className="kpi-sub">
                    复用 {report.cacheMetrics.totalHits}/{report.cacheMetrics.totalLookups} · 省{' '}
                    {report.cacheMetrics.savedTokensTotal} Tokens
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">(b-1) 步骤意图达成率</div>
                  <div className="kpi-value">
                    {report.fulfillmentMetrics.fulfillmentRatePercent}%
                  </div>
                  <div className="kpi-sub">
                    首次直通率 {report.fulfillmentMetrics.firstPassSuccessRatePercent}%
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">(b-2) 平均自愈修正次数</div>
                  <div className="kpi-value">
                    {report.fulfillmentMetrics.averageRetriesPerInvocation}
                  </div>
                  <div className="kpi-sub">
                    0次:{report.fulfillmentMetrics.retryDistribution.zeroRetries} | 1次:
                    {report.fulfillmentMetrics.retryDistribution.oneRetry} | ≥2次:
                    {report.fulfillmentMetrics.retryDistribution.twoOrMoreRetries}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">(c) 研发算力节省比</div>
                  <div className="kpi-value">{report.costSavingsRatioPercent}%</div>
                  <div className="kpi-sub">累计成本 ${report.fulfillmentMetrics.totalCostUsd}</div>
                </div>
              </div>
              <div className="diagnosis-list">
                {report.diagnoses.map((d) => (
                  <div className="diagnosis-item" key={d.metricName}>
                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}
                    >
                      <span>
                        {d.passedSla ? '✅' : '⚠️'} {d.metricName}
                      </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        基线 {d.targetThreshold}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>
                      当前表现：{d.observedValue}
                    </div>
                    <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                      建议：{d.optimizationAction}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}
