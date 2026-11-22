/**
 * @file Data.tsx
 * @description Meridian UI 数据表达组件：状态标签、键值表、定义列表、计量条、环形仪表、数据表。
 *
 * 设计要点：所有这些组件的目标都是"让结构化数据以结构化方式呈现"，
 * 而不是把数据摊平成一段文字 —— 这正是旧版 UI 里"文字占满组件"的反面。
 */

import type { ReactNode } from 'react';
import { Text } from './Typography.tsx';

export type StatusTone = 'neutral' | 'brand' | 'success' | 'warn' | 'danger' | 'violet' | 'cyan';

export interface StatusChipProps {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
  readonly dot?: boolean;
  readonly solid?: boolean;
  readonly icon?: ReactNode;
  readonly className?: string;
  readonly title?: string;
}

/** 语义状态标签。dot 形态最常用，承载"当前处于什么状态"。 */
export function StatusChip({
  children,
  tone = 'neutral',
  dot = false,
  solid = false,
  icon,
  className,
  title,
}: StatusChipProps) {
  const classes = ['m-chip', solid ? 'm-chip--solid' : `m-chip--${tone}`, className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} title={title}>
      {icon}
      {dot ? <i className="m-chip__dot" /> : null}
      <span className="m-truncate">{children}</span>
    </span>
  );
}

export interface KeyValueEntry {
  readonly key: string;
  readonly value: ReactNode;
}

export interface KeyValueListProps {
  readonly items: ReadonlyArray<KeyValueEntry>;
  readonly columns?: number;
  readonly className?: string;
}

/**
 * 键值表。键列固定宽度（--m-measure-label），值列自动占满并可换行。
 * 用于"结构化事实"（快照 ID、分支、模型、责任人），不再写成一整行文字。
 */
export function KeyValueList({ items, columns = 1, className }: KeyValueListProps) {
  return (
    <div
      className={['m-kv', className ?? ''].filter(Boolean).join(' ')}
      style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
    >
      {items.map((item) => (
        <div key={item.key} style={{ display: 'contents' }}>
          <div className="m-kv__key">{item.key}</div>
          <div className="m-kv__val">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

export interface DefinitionItem {
  readonly term: ReactNode;
  readonly description: ReactNode;
}

export interface DefinitionListProps {
  readonly items: ReadonlyArray<DefinitionItem>;
  readonly className?: string;
}

/** 定义列表：术语 + 说明。说明文字自动限宽，不会横铺。 */
export function DefinitionList({ items, className }: DefinitionListProps) {
  return (
    <dl className={['m-dl', className ?? ''].filter(Boolean).join(' ')}>
      {items.map((item, idx) => (
        <div key={idx} className="m-dl__row">
          <dt className="m-dl__term">{item.term}</dt>
          <dd className="m-dl__desc">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

export type MeterTone = 'brand' | 'success' | 'warn' | 'danger' | 'violet' | 'cyan';

export interface MeterProps {
  readonly value: number;
  readonly max?: number;
  readonly tone?: MeterTone;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly label?: ReactNode;
  readonly className?: string;
}

/** 线性计量条：进度 / 相似度 / 风险占比。 */
export function Meter({
  value,
  max = 100,
  tone = 'brand',
  size = 'md',
  label,
  className,
}: MeterProps) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const classes = [
    'm-meter',
    tone !== 'brand' ? `m-meter--${tone}` : '',
    size !== 'md' ? `m-meter--${size}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span className="m-meter__fill" style={{ width: `${pct}%` }} />
      {label !== undefined ? <span className="m-sr-only">{label}</span> : null}
    </div>
  );
}

export interface GaugeProps {
  readonly value: number;
  readonly max?: number;
  readonly size?: number;
  readonly tone?: MeterTone;
  readonly caption?: ReactNode;
  readonly suffix?: string;
  readonly className?: string;
}

/** 语义色调 → 令牌名（success/warn/danger 在令牌层对应 jade/amber/coral） */
const TONE_TOKEN: Record<MeterTone, string> = {
  brand: 'brand',
  success: 'jade',
  warn: 'amber',
  danger: 'coral',
  violet: 'violet',
  cyan: 'cyan',
};

/** 环形仪表：风险分 / 达成率等单值指标。 */
export function Gauge({
  value,
  max = 100,
  size = 52,
  tone = 'brand',
  caption,
  suffix,
  className,
}: GaugeProps) {
  const stroke = Math.max(3, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const toneColor = `var(--m-${TONE_TOKEN[tone]})`;
  return (
    <div className={['m-gauge', className ?? ''].filter(Boolean).join(' ')}>
      <svg
        className="m-gauge__svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${value}${suffix ?? ''}`}
      >
        <circle
          className="m-gauge__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="m-gauge__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={toneColor}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <div>
        <div className="m-gauge__num" style={{ color: toneColor }}>
          {value}
          {suffix !== undefined ? (
            <span style={{ fontSize: 'var(--m-fs-xs)', color: 'var(--m-ink-3)' }}>{suffix}</span>
          ) : null}
        </div>
        {caption !== undefined ? <div className="m-gauge__cap">{caption}</div> : null}
      </div>
    </div>
  );
}

export interface DataColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly width?: string;
  readonly numeric?: boolean;
  readonly render: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<DataColumn<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T, index: number) => string;
  readonly empty?: ReactNode;
  readonly maxHeight?: number;
  readonly className?: string;
}

/**
 * 紧凑数据表：粘性表头、紧凑行高、数字列右对齐且等宽。
 * 单元格内容超出时由各列自行截断，不撑破表格。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  maxHeight = 420,
  className,
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return <>{empty ?? null}</>;
  }
  return (
    <div
      className={['m-table-wrap', className ?? ''].filter(Boolean).join(' ')}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="m-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  width: col.width,
                  textAlign: col.numeric ? 'right' : 'left',
                }}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={col.numeric ? 'm-table__num' : undefined}
                  style={{ textAlign: col.numeric ? 'right' : 'left' }}
                >
                  {col.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ListRowProps {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly meta?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onClick?: () => void;
  readonly className?: string;
}

/**
 * 列表行：标题 + 摘要 + 元信息 + 尾部操作。
 * 摘要受 --m-measure-list 限宽并两行截断 —— 列表永远不会变成一堵字墙。
 */
export function ListRow({
  leading,
  title,
  description,
  meta,
  trailing,
  onClick,
  className,
}: ListRowProps) {
  const inner = (
    <>
      {leading !== undefined ? <span style={{ flex: 'none' }}>{leading}</span> : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="m-h3 m-truncate">{title}</div>
        {description !== undefined ? (
          <div className="m-sm m-clamp-2 m-measure-list">{description}</div>
        ) : null}
        {meta !== undefined ? (
          <div className="m-xs" style={{ marginTop: 4 }}>
            {meta}
          </div>
        ) : null}
      </div>
      {trailing !== undefined ? (
        <span style={{ flex: 'none', display: 'inline-flex', gap: 'var(--m-sp-2)' }}>
          {trailing}
        </span>
      ) : null}
    </>
  );
  const classes = ['m-row', className ?? ''].filter(Boolean).join(' ');
  if (onClick) {
    return (
      <div
        className={classes}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onClick();
          }
        }}
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          textAlign: 'left',
          width: '100%',
          cursor: 'pointer',
        }}
      >
        {inner}
      </div>
    );
  }
  return <div className={classes}>{inner}</div>;
}

export interface MetricGridProps {
  readonly items: ReadonlyArray<{ label: ReactNode; value: ReactNode; delta?: ReactNode }>;
  readonly columns?: number;
  readonly className?: string;
}

/** 指标网格：一行若干个统计值，数字等宽对齐。 */
export function MetricGrid({ items, columns = 4, className }: MetricGridProps) {
  return (
    <div
      className={className ?? ''}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 'var(--m-gap)',
      }}
    >
      {items.map((item, idx) => (
        <div key={idx} className="m-metric">
          <Text variant="xs" tone="tertiary" clamp="1">
            {item.label}
          </Text>
          <div className="m-metric__value">{item.value}</div>
          {item.delta !== undefined ? <div className="m-metric__delta">{item.delta}</div> : null}
        </div>
      ))}
    </div>
  );
}
