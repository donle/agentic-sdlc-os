/**
 * @file Navigation.tsx
 * @description Meridian UI 导航与身份类组件：标签页、面包屑、头像。
 */

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Text } from './Typography.tsx';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly icon?: IconName;
}

export interface TabsProps {
  readonly items: ReadonlyArray<TabItem>;
  readonly activeId: string;
  readonly onChange: (id: string) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}

/** 标签页。计数用等宽数字，避免切换时宽度抖动。 */
export function Tabs({ items, activeId, onChange, ariaLabel, className }: TabsProps) {
  return (
    <div
      className={['m-tabs', className ?? ''].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="m-tabs__item"
          aria-selected={item.id === activeId}
          onClick={() => onChange(item.id)}
        >
          {item.icon !== undefined ? <Icon name={item.icon} size={14} /> : null}
          <span>{item.label}</span>
          {item.count !== undefined ? <span className="m-tabs__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface BreadcrumbItem {
  readonly label: string;
  readonly onClick?: () => void;
}

export interface BreadcrumbProps {
  readonly items: ReadonlyArray<BreadcrumbItem>;
  readonly className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav
      className={['m-breadcrumb', className ?? ''].filter(Boolean).join(' ')}
      aria-label="面包屑"
    >
      {items.map((item, idx) => (
        <span key={`${item.label}-${idx}`} style={{ display: 'inline-flex', gap: 'var(--m-sp-2)' }}>
          {idx > 0 ? <Icon name="chevron-right" size={12} className="m-breadcrumb__sep" /> : null}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                color: 'var(--m-brand)',
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ) : (
            <span style={{ color: 'var(--m-ink-3)' }}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export interface AvatarProps {
  readonly name: string;
  readonly color?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly badge?: string;
  readonly className?: string;
}

/** 头像。取姓名首字 + 语义色，天然区分 7 个角色。 */
export function Avatar({
  name,
  color = 'var(--m-brand)',
  size = 'md',
  badge,
  className,
}: AvatarProps) {
  const initial = name.trim().charAt(0) || 'U';
  const classes = [
    'm-avatar',
    size === 'sm' ? 'm-avatar--sm' : '',
    size === 'lg' ? 'm-avatar--lg' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      style={{ background: color }}
      title={badge ? `${name} · ${badge}` : name}
      aria-label={name}
    >
      {initial}
    </span>
  );
}

export interface AvatarGroupProps {
  readonly people: ReadonlyArray<{ name: string; color?: string; badge?: string }>;
  readonly max?: number;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}

/** 头像组。超出 max 时折叠为 +N。 */
export function AvatarGroup({ people, max = 5, size = 'md', className }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <div className={['m-avatar-group', className ?? ''].filter(Boolean).join(' ')}>
      {shown.map((p) => (
        <Avatar key={p.name} name={p.name} color={p.color} badge={p.badge} size={size} />
      ))}
      {rest > 0 ? (
        <span
          className="m-avatar"
          style={{ background: 'var(--m-surface-3)', color: 'var(--m-ink-3)' }}
          title={`另有 ${rest} 人`}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
}

/** 页面标题区。标题 + 一句说明 + 右侧操作，说明文字限宽不铺满。 */
export function PageHeader({ title, description, actions, meta, className }: PageHeaderProps) {
  return (
    <div
      className={['m-row', className ?? ''].filter(Boolean).join(' ')}
      style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 'var(--m-sp-4)' }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <Text variant="h1" clamp="1">
          {title}
        </Text>
        {description !== undefined ? (
          <div className="m-sm m-measure-prose" style={{ marginTop: 4 }}>
            {description}
          </div>
        ) : null}
        {meta !== undefined ? (
          <div className="m-inline" style={{ marginTop: 8 }}>
            {meta}
          </div>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="m-inline" style={{ flex: 'none' }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
