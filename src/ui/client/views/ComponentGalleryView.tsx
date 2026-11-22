/**
 * @file ComponentGalleryView.tsx
 * @description Meridian UI 组件库总览页（评估用）。
 *
 * 目标：让每一个组件的**全部状态**都能在一屏内被看到并横向对比 ——
 * 默认 / 悬停 / 聚焦 / 禁用 / 载入 / 错误 / 空态 / 长文本 / 极窄容器，
 * 并且可以实时切换**主题**与**密度**，用来判断这套体系是否真的适合研发管控台。
 *
 * 该页面只依赖 kit 层，不依赖任何业务 DTO，是纯组件展示。
 */

import { useMemo, useState } from 'react';
import {
  Avatar,
  AvatarGroup,
  Banner,
  Breadcrumb,
  Button,
  Callout,
  Card,
  Checkbox,
  DataTable,
  DefinitionList,
  Divider,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Gauge,
  Icon,
  IconButton,
  Input,
  Inline,
  KeyValueList,
  ListRow,
  LoadingState,
  Meter,
  MetricGrid,
  Modal,
  PageHeader,
  Panel,
  Prose,
  SegmentedControl,
  Select,
  Skeleton,
  Slider,
  Stack,
  StatusChip,
  Switch,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  type TabItem,
} from '../../kit/index.ts';

type Density = 'compact' | 'comfortable' | 'spacious';
type Theme = 'light' | 'dark';

const SAMPLE_ROWS = [
  {
    id: 'SNAP-S1-001',
    stage: '产品需求 PRD',
    owner: '陈工 (PM)',
    risk: 22,
    state: 'APPROVED',
    tokens: 4820,
  },
  {
    id: 'SNAP-S2-004',
    stage: '交互与 UI 设计',
    owner: '林工 (PD/UX)',
    risk: 62,
    state: 'PENDING_HUMAN_GATE',
    tokens: 2130,
  },
  {
    id: 'SNAP-S3A-002',
    stage: '架构与表设计',
    owner: '赵工 (架构)',
    risk: 78,
    state: 'REJECTED',
    tokens: 9310,
  },
];

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel
      id={id}
      title={title}
      subtitle={note}
      bodyPadding="default"
      className="m-gallery-section"
    >
      {children}
    </Panel>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m-inline"
      style={{ alignItems: 'flex-start', gap: 'var(--m-sp-4)', flexWrap: 'wrap' }}
    >
      {children}
    </div>
  );
}

function Demo({
  label,
  children,
  width,
}: {
  label: string;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, width }}>
      <Text variant="label">{label}</Text>
      <div>{children}</div>
    </div>
  );
}

export function ComponentGalleryView({ onExit }: { onExit?: () => void }) {
  const [theme, setTheme] = useState<Theme>('light');
  const [density, setDensity] = useState<Density>('comfortable');
  const [tabId, setTabId] = useState('delivery');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [segValue, setSegValue] = useState('all');
  const [switchOn, setSwitchOn] = useState(true);
  const [checkOn, setCheckOn] = useState(true);
  const [sliderValue, setSliderValue] = useState(60);
  const [inputValue, setInputValue] = useState('数据库分布式乐观锁与幂等键设计');
  const [textValue, setTextValue] = useState(
    '选方案 A，按标准双栏折叠抽屉实现；同步要求补充「>200 节点自动切换聚合视图」降级态。',
  );
  const [selectValue, setSelectValue] = useState('s3a');

  const tabs = useMemo<TabItem[]>(
    () => [
      { id: 'delivery', label: 'Agent 交付了什么', count: 3 },
      { id: 'process', label: '它怎么推演出来的', count: 9 },
      { id: 'people', label: '团队意见', count: 7 },
    ],
    [],
  );

  const applyTheme = (next: Theme) => {
    setTheme(next);
  };
  const applyDensity = (next: Density) => {
    setDensity(next);
  };

  return (
    <div className="m-gallery-root" data-theme={theme} data-density={density}>
      <div className="m-gallery-bar">
        <div className="m-inline">
          <span className="m-brand-mark">A</span>
          <Text variant="h3">Meridian UI</Text>
          <StatusChip tone="violet">组件库 v1</StatusChip>
        </div>
        <div className="m-inline">
          <SegmentedControl
            ariaLabel="主题切换"
            value={theme}
            onChange={(v) => applyTheme(v as Theme)}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
          <SegmentedControl
            ariaLabel="密度切换"
            value={density}
            onChange={(v) => applyDensity(v as Density)}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'comfortable', label: '标准' },
              { value: 'spacious', label: '宽松' },
            ]}
          />
          {onExit !== undefined ? (
            <Button variant="ghost" icon="arrow-left" onClick={onExit}>
              返回工作台
            </Button>
          ) : null}
        </div>
      </div>
      <Stack gap="loose">
        <PageHeader
          title="Meridian UI · 组件库总览"
          description="面向 B 端研发管控台的组件体系。核心主张：排版有度量、密度是令牌、状态由语义色承载。顶部可实时切换主题与密度，评估组件在不同条件下的表现。"
        />

        <Callout tone="info" title="怎么用这份总览">
          <Prose maxLines={0}>
            每个区块都把同一组件的多种状态并排摆出来。特别留意「排版与度量」一节 ——
            它演示了长文本在组件内是如何被限宽、截断与分层的，这正是旧版 UI
            「文字铺满组件」问题的解法。
          </Prose>
        </Callout>

        {/* ═══════════ 排版与度量 ═══════════ */}
        <Section
          id="typography"
          title="1 · 排版与度量"
          note="字阶只有 6 级；正文按 ch 限宽；每个文本槽位必须声明角色与截断策略"
        >
          <Stack gap="loose">
            <Row>
              <Demo label="Display" width="220px">
                <Text variant="display">交付周期 4.2 天</Text>
              </Demo>
              <Demo label="H1 / H2 / H3" width="260px">
                <Text variant="h1">项目总览</Text>
                <Text variant="h2">流水线脊柱</Text>
                <Text variant="h3">Agent 交付审阅</Text>
              </Demo>
              <Demo label="Body / Sm / Xs" width="260px">
                <Text variant="body">正文字号 13.5px，行高 1.6，用于说明性文字。</Text>
                <Text variant="sm">次级文字 12.5px。</Text>
                <Text variant="xs">弱化文字 11.5px。</Text>
              </Demo>
              <Demo label="Label / Mono" width="220px">
                <Text variant="label">分组标题</Text>
                <Text variant="mono">SNAP-S2-004 · branch-v2</Text>
              </Demo>
            </Row>

            <Divider />

            <Row>
              <Demo label="无 Prose（会铺满容器）" width="300px">
                <div className="m-body">
                  已产出 UI/UX 组件规范，采用 EnterpriseSplitViewWorkbench 布局，映射 3
                  组核心视图，交互状态机补齐空态、加载骨架屏与异常重试态。
                </div>
              </Demo>
              <Demo label="Prose（限宽 68ch）" width="340px">
                <Prose maxLines={0}>
                  已产出 UI/UX 组件规范，采用 EnterpriseSplitViewWorkbench 布局，映射 3
                  组核心视图，交互状态机补齐空态、加载骨架屏与异常重试态。
                </Prose>
              </Demo>
              <Demo label="Prose + 2 行截断" width="300px">
                <Prose maxLines={2}>
                  已产出 UI/UX 组件规范，采用 EnterpriseSplitViewWorkbench 布局，映射 3
                  组核心视图，交互状态机补齐空态、加载骨架屏与异常重试态。
                </Prose>
              </Demo>
              <Demo label="单行省略" width="260px">
                <Text variant="body" clamp="1">
                  已产出 UI/UX 组件规范，采用 EnterpriseSplitViewWorkbench 布局
                </Text>
              </Demo>
            </Row>

            <Callout tone="warn" title="对比就是差异">
              <Prose maxLines={0}>
                左边"无 Prose"和右边"Prose"是同一段字。旧版 UI 里的组件几乎都是左边这样 ——
                文字直接铺满容器，视觉上把组件撑成一堵字墙。组件库强制走右边的路径。
              </Prose>
            </Callout>
          </Stack>
        </Section>

        {/* ═══════════ 容器 ═══════════ */}
        <Section id="surface" title="2 · 容器与提示" note="Panel / Card / Callout / Banner">
          <Stack gap="loose">
            <Row>
              <Demo label="Panel" width="380px">
                <Panel
                  title="Agent 交付审阅"
                  subtitle="快照 SNAP-S2-004 · 模型 qwen2.5-coder-32b-instruct-int4"
                  actions={
                    <StatusChip tone="warn" dot>
                      待拍板
                    </StatusChip>
                  }
                  footer={
                    <Text variant="xs" tone="tertiary">
                      裁决结果写入不可变审计账本
                    </Text>
                  }
                >
                  <Prose maxLines={2}>
                    组件映射清单已覆盖 3 项核心需求的用户故事，交互状态机补齐空态 / 加载态 /
                    异常态。
                  </Prose>
                </Panel>
              </Demo>
              <Demo label="Card（可交互）" width="280px">
                <Card
                  interactive
                  title="方案 A · 标准双栏折叠抽屉"
                  subtitle="零额外工期，符合 Design System 规范"
                  footer={<StatusChip tone="success">风险分 18</StatusChip>}
                >
                  <Prose maxLines={2}>完全复用现有组件库，无新增组件。</Prose>
                </Card>
              </Demo>
            </Row>

            <Row>
              <Demo label="Callout 四态" width="100%">
                <Stack gap="tight">
                  <Callout tone="info" title="信息">
                    <Prose maxLines={0}>
                      低风险阶段已自动放行，但仍生成完整快照与 HumanDecision 记录。
                    </Prose>
                  </Callout>
                  <Callout tone="success" title="通过">
                    <Prose maxLines={0}>
                      沙箱自动化测试 100% 通过且无高危漏洞，已满足全部验收标准。
                    </Prose>
                  </Callout>
                  <Callout tone="warn" title="待裁决">
                    <Prose maxLines={0}>
                      PM ↔ PD 协商已达上限 3/3 轮，需要在方案 A / B 之间拍板。
                    </Prose>
                  </Callout>
                  <Callout tone="danger" title="Scope Diff 红线">
                    <Prose maxLines={0}>
                      REQ_REALTIME_CANVAS 的 AC-02 在协商中被下调，强制触发人工确认。
                    </Prose>
                  </Callout>
                </Stack>
              </Demo>
            </Row>

            <Row>
              <Demo label="Banner" width="100%">
                <Banner tone="success">流程规则已更新，全局最大讨论轮次=3、风险分数线=60。</Banner>
              </Demo>
              <Demo label="Banner 可关闭" width="320px">
                <Banner tone="error" onClose={() => undefined}>
                  读取沙箱源码失败：文件不存在。
                </Banner>
              </Demo>
            </Row>
          </Stack>
        </Section>

        {/* ═══════════ 数据表达 ═══════════ */}
        <Section id="data" title="3 · 数据表达" note="用结构承载数据，而不是把数据摊平成文字">
          <Stack gap="loose">
            <Row>
              <Demo label="StatusChip" width="380px">
                <Inline>
                  <StatusChip tone="success" dot>
                    已签核
                  </StatusChip>
                  <StatusChip tone="warn" dot>
                    待裁决
                  </StatusChip>
                  <StatusChip tone="danger" dot>
                    已驳回
                  </StatusChip>
                  <StatusChip tone="cyan" dot>
                    自动放行
                  </StatusChip>
                  <StatusChip tone="violet" dot>
                    总管接管
                  </StatusChip>
                  <StatusChip tone="neutral">未启动</StatusChip>
                </Inline>
              </Demo>
              <Demo label="Meter" width="300px">
                <Stack gap="tight">
                  <Meter value={92} tone="violet" />
                  <Meter value={62} tone="danger" />
                  <Meter value={31} tone="success" />
                </Stack>
              </Demo>
              <Demo label="Gauge" width="220px">
                <Gauge value={62} tone="danger" suffix="/100" caption="业务风险分 · 阈值 60" />
              </Demo>
            </Row>

            <Row>
              <Demo label="KeyValueList" width="380px">
                <KeyValueList
                  items={[
                    { key: '快照 ID', value: <span className="m-mono">SNAP-S2-004</span> },
                    { key: '所属分支', value: <span className="m-mono">branch-v2</span> },
                    { key: '责任专家', value: '林工 (PD/UX)' },
                    { key: '产出摘要', value: '已产出 UI/UX 组件规范，映射 3 组核心视图' },
                  ]}
                />
              </Demo>
              <Demo label="DefinitionList" width="340px">
                <DefinitionList
                  items={[
                    {
                      term: '组件映射',
                      description: '将 3 项核心需求映射到企业组件库的对应容器与视图。',
                    },
                    {
                      term: '交互状态',
                      description: '每个组件补齐默认、加载、空态、异常重试、差异高亮五种状态。',
                    },
                  ]}
                />
              </Demo>
            </Row>

            <Row>
              <Demo label="MetricGrid" width="100%">
                <MetricGrid
                  items={[
                    { label: '活跃项目', value: '7' },
                    { label: '待裁决', value: '3' },
                    { label: '平均交付周期', value: '4.2 天' },
                    { label: 'Token 节省', value: '31%' },
                  ]}
                />
              </Demo>
            </Row>

            <Row>
              <Demo label="DataTable" width="100%">
                <DataTable
                  rows={SAMPLE_ROWS}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: 'id',
                      header: '快照 ID',
                      render: (row) => <span className="m-mono">{row.id}</span>,
                    },
                    { key: 'stage', header: '阶段', render: (row) => row.stage },
                    { key: 'owner', header: '责任人', render: (row) => row.owner },
                    {
                      key: 'risk',
                      header: '风险分',
                      numeric: true,
                      render: (row) => (
                        <span style={{ color: row.risk >= 60 ? 'var(--m-coral)' : 'var(--m-ink)' }}>
                          {row.risk}
                        </span>
                      ),
                    },
                    {
                      key: 'state',
                      header: '状态',
                      render: (row) => (
                        <StatusChip
                          tone={
                            row.state === 'APPROVED'
                              ? 'success'
                              : row.state === 'REJECTED'
                                ? 'danger'
                                : 'warn'
                          }
                          dot
                        >
                          {row.state === 'APPROVED'
                            ? '已签核'
                            : row.state === 'REJECTED'
                              ? '已驳回'
                              : '待裁决'}
                        </StatusChip>
                      ),
                    },
                    { key: 'tokens', header: 'Tokens', numeric: true, render: (row) => row.tokens },
                  ]}
                />
              </Demo>
            </Row>

            <Row>
              <Demo label="ListRow（摘要自动限宽）" width="100%">
                <Stack gap="tight">
                  <ListRow
                    leading={
                      <StatusChip tone="warn" dot>
                        待裁决
                      </StatusChip>
                    }
                    title="冲突裁决 · 交互方案 A / B 拍板"
                    description="PM ↔ PD 协商已达 3/3 轮熔断，总管 Agent 已提炼分歧点并生成方案 A（标准双栏折叠抽屉）与方案 B（定制 WebGL 画布组件）供人工拍板，方案 B 需额外 2 人日并触发架构师二次把关。"
                    meta={<span className="m-xs">12 分钟前 · 风险分 62 · 含 1 项需求范围红线</span>}
                    trailing={
                      <Button size="sm" variant="primary">
                        去处理
                      </Button>
                    }
                  />
                  <Divider />
                  <ListRow
                    leading={
                      <StatusChip tone="success" dot>
                        已签核
                      </StatusChip>
                    }
                    title="步骤 1 产品需求 PRD"
                    description="3 条 User Stories 与 3 项前置埋点事件已生成，验收标准齐备。"
                    meta={<span className="m-xs">26 分钟前 · 陈工 (PM)</span>}
                  />
                </Stack>
              </Demo>
            </Row>
          </Stack>
        </Section>

        {/* ═══════════ 操作与表单 ═══════════ */}
        <Section id="controls" title="4 · 操作与表单" note="按钮、输入、开关、滑杆、分段控件">
          <Stack gap="loose">
            <Row>
              <Demo label="Button 变体" width="100%">
                <Inline>
                  <Button variant="primary" icon="check">
                    拍板方案 A
                  </Button>
                  <Button variant="default">默认</Button>
                  <Button variant="success" icon="check">
                    通过
                  </Button>
                  <Button variant="danger" icon="close">
                    驳回重做
                  </Button>
                  <Button variant="violet" icon="git-branch">
                    下发回退指令
                  </Button>
                  <Button variant="outline">轮廓</Button>
                  <Button variant="ghost">幽灵</Button>
                </Inline>
              </Demo>
            </Row>
            <Row>
              <Demo label="尺寸 / 状态" width="100%">
                <Inline>
                  <Button size="sm" variant="primary">
                    小
                  </Button>
                  <Button size="md" variant="primary">
                    中
                  </Button>
                  <Button size="lg" variant="primary">
                    大
                  </Button>
                  <Button variant="primary" loading>
                    处理中
                  </Button>
                  <Button variant="primary" disabled>
                    已禁用
                  </Button>
                  <Button variant="danger" disabled>
                    权限不足
                  </Button>
                  <IconButton icon="refresh" label="刷新" />
                  <IconButton icon="more" label="更多" />
                  <IconButton icon="copy" label="复制 ID" />
                </Inline>
              </Demo>
            </Row>

            <Row>
              <Demo label="Field" width="300px">
                <Stack gap="tight">
                  <Field
                    label="风险分数线"
                    hint="评分 ≥ 阈值阻塞人工审核；低于阈值自动放行但留痕。"
                  >
                    <Input value="60" onChange={() => undefined} mono />
                  </Field>
                  <Field label="项目名称" error="项目名称不能为空">
                    <Input value="" onChange={() => undefined} invalid placeholder="请输入" />
                  </Field>
                  <Field label="裁决理由" required>
                    <Textarea value={textValue} onChange={setTextValue} rows={3} />
                  </Field>
                </Stack>
              </Demo>

              <Demo label="Select / Switch / Checkbox" width="280px">
                <Stack gap="tight">
                  <Select
                    value={selectValue}
                    onChange={setSelectValue}
                    ariaLabel="选择阶段"
                    options={[
                      { value: 's1', label: '步骤 1 · PM 需求与埋点' },
                      { value: 's2', label: '步骤 2 · PD 交互设计' },
                      { value: 's3a', label: '步骤 3a · Tech Lead 架构' },
                    ]}
                  />
                  <Inline>
                    <Switch checked={switchOn} onChange={setSwitchOn} ariaLabel="允许跨步骤回退" />
                    <Text variant="sm">允许环节负责人跨步骤回退</Text>
                  </Inline>
                  <Inline>
                    <Checkbox checked={checkOn} onChange={setCheckOn} ariaLabel="仅看待我裁决" />
                    <Text variant="sm">仅看待我裁决</Text>
                  </Inline>
                </Stack>
              </Demo>

              <Demo label="Slider" width="260px">
                <Stack gap="tight">
                  <Text variant="sm">
                    风险分数线：<span className="m-mono">{sliderValue}</span>
                  </Text>
                  <Slider value={sliderValue} onChange={setSliderValue} ariaLabel="风险分数线" />
                </Stack>
              </Demo>
            </Row>

            <Row>
              <Demo label="SegmentedControl" width="100%">
                <Inline>
                  <SegmentedControl
                    value={segValue}
                    onChange={setSegValue}
                    ariaLabel="待办筛选"
                    options={[
                      { value: 'all', label: '全部' },
                      { value: 'mine', label: '待我裁决', badge: 3 },
                      { value: 'conflict', label: '冲突' },
                      { value: 'scope', label: '范围红线' },
                    ]}
                  />
                </Inline>
              </Demo>
            </Row>
          </Stack>
        </Section>

        {/* ═══════════ 导航与身份 ═══════════ */}
        <Section id="navigation" title="5 · 导航与身份" note="标签页、面包屑、头像">
          <Stack gap="loose">
            <Row>
              <Demo label="Tabs" width="420px">
                <Tabs items={tabs} activeId={tabId} onChange={setTabId} ariaLabel="阶段详情" />
                <div style={{ marginTop: 12 }}>
                  <Prose maxLines={2}>
                    {tabId === 'delivery'
                      ? '交付物本体：artifactDetails 按 artifactType 分型渲染，含 Agent 自述与无障碍清单。'
                      : tabId === 'process'
                        ? '推演过程：事件链每条可展开 detailPayload，末尾挂载该快照的交付物入口。'
                        : '团队意见：全员可见的评论流，签核意见同步写入审计账本。'}
                  </Prose>
                </div>
              </Demo>
              <Demo label="Breadcrumb" width="320px">
                <Breadcrumb
                  items={[
                    { label: '项目总览' },
                    { label: '企业级研发权限与智能工单协同模块' },
                    { label: '步骤 2 · 交互与 UI 设计' },
                  ]}
                />
              </Demo>
            </Row>

            <Row>
              <Demo label="Avatar / AvatarGroup" width="380px">
                <Inline>
                  <Avatar name="王总管" color="var(--m-violet)" size="lg" badge="PMO 总监" />
                  <Avatar name="陈工" color="var(--m-brand)" />
                  <Avatar name="林工" color="var(--m-coral)" />
                  <Avatar name="赵工" color="var(--m-cyan)" />
                  <Avatar name="刘工" color="var(--m-jade)" />
                  <Avatar name="孙工" color="var(--m-amber)" />
                  <Avatar name="周工" color="#C084FC" />
                </Inline>
                <div style={{ marginTop: 10 }}>
                  <AvatarGroup
                    people={[
                      { name: '王总管', color: 'var(--m-violet)' },
                      { name: '陈工', color: 'var(--m-brand)' },
                      { name: '林工', color: 'var(--m-coral)' },
                      { name: '赵工', color: 'var(--m-cyan)' },
                      { name: '刘工', color: 'var(--m-jade)' },
                      { name: '孙工', color: 'var(--m-amber)' },
                      { name: '周工', color: '#C084FC' },
                    ]}
                  />
                </div>
              </Demo>
            </Row>
          </Stack>
        </Section>

        {/* ═══════════ 反馈态 ═══════════ */}
        <Section id="feedback" title="6 · 反馈态" note="空态 / 载入 / 错误 / 骨架屏 / 浮层">
          <Stack gap="loose">
            <Row>
              <Demo label="EmptyState" width="300px">
                <Panel bodyPadding="flush">
                  <EmptyState
                    icon="git-branch"
                    title="该运行实例尚未产生阶段快照"
                    description="发起一个研发提案后，这里会按分支展示每一步的快照版本。"
                    action={
                      <Button size="sm" variant="primary" icon="plus">
                        发起新项目
                      </Button>
                    }
                  />
                </Panel>
              </Demo>
              <Demo label="Loading / Error" width="300px">
                <Panel bodyPadding="flush">
                  <LoadingState label="正在拉取沙箱文件…" />
                </Panel>
                <div style={{ height: 12 }} />
                <Panel bodyPadding="flush">
                  <ErrorState
                    title="读取沙箱源码失败"
                    description="未找到沙箱文件: migrations/V3__rbac_matrix.sql"
                    onRetry={() => undefined}
                  />
                </Panel>
              </Demo>
              <Demo label="Skeleton" width="260px">
                <Stack gap="tight">
                  <Skeleton variant="title" />
                  <Skeleton count={3} />
                  <Skeleton variant="block" />
                </Stack>
              </Demo>
            </Row>

            <Row>
              <Demo label="Tooltip" width="220px">
                <Tooltip content="完整交付物仅对阶段负责人与项目管理员开放">
                  <Button size="sm" variant="outline" icon="lock">
                    受限内容
                  </Button>
                </Tooltip>
              </Demo>
              <Demo label="浮层" width="100%">
                <Inline>
                  <Button size="sm" variant="outline" onClick={() => setDrawerOpen(true)}>
                    打开抽屉（sm）
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setModalOpen(true)}>
                    打开模态
                  </Button>
                </Inline>
              </Demo>
            </Row>
          </Stack>
        </Section>

        <Drawer
          open={drawerOpen}
          size="sm"
          title="Agent 交付审阅"
          subtitle="快照 SNAP-S2-004 · 速览抽屉 420px"
          onClose={() => setDrawerOpen(false)}
          footer={
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              关闭
            </Button>
          }
        >
          <Prose maxLines={0}>
            sm 级抽屉用于"扫一眼就够"的场景。中级 640px 承载单阶段完整交付物； 宽级 960px
            承载裁决审阅（交付物 + 证据链 + 裁决区并排）。
          </Prose>
        </Drawer>

        <Modal
          open={modalOpen}
          title="发起新研发项目"
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                创建并启动
              </Button>
            </>
          }
        >
          <Stack gap="tight">
            <Field label="项目名称" required>
              <Input value={inputValue} onChange={setInputValue} />
            </Field>
            <Field label="业务背景" hint="用一句话说明业务目标与痛点。">
              <Textarea value={textValue} onChange={setTextValue} rows={4} />
            </Field>
          </Stack>
        </Modal>

        <Panel
          title="附：图标集"
          subtitle="24×24 viewBox · stroke 继承 currentColor · 1.6 描边 · 全部内联，无 CDN"
        >
          <Inline>
            {(
              [
                'check',
                'close',
                'alert',
                'info',
                'clock',
                'zap',
                'flag',
                'shield',
                'layers',
                'activity',
                'search',
                'plus',
                'chevron-right',
                'chevron-down',
                'arrow-right',
                'git-branch',
                'gavel',
                'code',
                'file',
                'folder',
                'message',
                'users',
                'grid',
                'settings',
                'bell',
                'sun',
                'moon',
                'eye',
                'lock',
                'play',
                'refresh',
                'download',
                'database',
                'terminal',
                'book',
              ] as const
            ).map((name) => (
              <Tooltip key={name} content={name}>
                <span
                  style={{
                    display: 'inline-grid',
                    placeItems: 'center',
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    border: '1px solid var(--m-line)',
                    color: 'var(--m-ink-2)',
                  }}
                >
                  <Icon name={name} size={18} />
                </span>
              </Tooltip>
            ))}
          </Inline>
        </Panel>
      </Stack>
    </div>
  );
}
