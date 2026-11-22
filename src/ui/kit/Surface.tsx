/**
 * @file Surface.tsx
 * @description Meridian UI 容器与提示层组件。
 */

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Text } from './Typography.tsx';

export interface PanelProps {
  readonly children: ReactNode;
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly variant?: 'default' | 'flat' | 'raised';
  readonly bodyPadding?: 'default' | 'tight' | 'flush';
  readonly className?: string;
  readonly id?: string;
}

/**
 * 主容器。头部 / 主体 / 底部三段式。
 * 主体默认 padding 随密度切换；密集表格请用 bodyPadding="flush"。
 */
export function Panel({
  children,
  title,
  subtitle,
  actions,
  footer,
  variant = 'default',
  bodyPadding = 'default',
  className,
  id,
}: PanelProps) {
  const classes = [
    'm-panel',
    variant === 'flat' ? 'm-panel--flat' : '',
    variant === 'raised' ? 'm-panel--raised' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes} id={id}>
      {title !== undefined ? (
        <header className="m-panel__header">
          <div style={{ minWidth: 0 }}>
            <div className="m-panel__title m-truncate">
              {typeof title === 'string' ? <Text variant="h3">{title}</Text> : title}
            </div>
            {subtitle !== undefined ? (
              <div className="m-panel__subtitle m-truncate">{subtitle}</div>
            ) : null}
          </div>
          {actions !== undefined ? <div className="m-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div
        className={[
          'm-panel__body',
          bodyPadding === 'tight' ? 'm-panel__body--tight' : '',
          bodyPadding === 'flush' ? 'm-panel__body--flush' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </div>
      {footer !== undefined ? <footer className="m-panel__footer">{footer}</footer> : null}
    </section>
  );
}

export interface CardProps {
  readonly children: ReactNode;
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly footer?: ReactNode;
  readonly interactive?: boolean;
  readonly inset?: boolean;
  readonly onClick?: () => void;
  readonly className?: string;
}

/** 轻量内容卡。用于列表项、方案对比等可点击单元。 */
export function Card({
  children,
  title,
  subtitle,
  footer,
  interactive = false,
  inset = false,
  onClick,
  className,
}: CardProps) {
  const classes = [
    'm-card',
    interactive ? 'm-card--interactive' : '',
    inset ? 'm-card--inset' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const content = (
    <>
      {title !== undefined ? (
        <div>
          <div className="m-h3 m-truncate">{title}</div>
          {subtitle !== undefined ? <div className="m-xs m-clamp-2">{subtitle}</div> : null}
        </div>
      ) : null}
      {children}
      {footer !== undefined ? <div className="m-xs">{footer}</div> : null}
    </>
  );
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
        style={{ textAlign: 'left', cursor: 'pointer' }}
      >
        {content}
      </div>
    );
  }
  return <div className={classes}>{content}</div>;
}

export type CalloutTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

const CALLOUT_ICON: Record<CalloutTone, IconName> = {
  neutral: 'info',
  info: 'info',
  success: 'check',
  warn: 'alert',
  danger: 'alert',
};

export interface CalloutProps {
  readonly children: ReactNode;
  readonly title?: ReactNode;
  readonly tone?: CalloutTone;
  readonly icon?: IconName | false;
  readonly className?: string;
}

/**
 * 强信息提示块。用于风险红线、范围变更、权限说明等"人必须读到"的内容。
 * 正文自动限宽，避免提示块被长文本撑成一大片。
 */
export function Callout({ children, title, tone = 'neutral', icon, className }: CalloutProps) {
  const resolvedIcon = icon === false ? null : (icon ?? CALLOUT_ICON[tone]);
  const classes = ['m-callout', tone !== 'neutral' ? `m-callout--${tone}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role={tone === 'danger' ? 'alert' : undefined}>
      {resolvedIcon ? (
        <span className="m-callout__icon">
          <Icon name={resolvedIcon} size={20} />
        </span>
      ) : null}
      <div className="m-callout__body">
        {title !== undefined ? <div className="m-callout__title">{title}</div> : null}
        <div className="m-callout__text">{children}</div>
      </div>
    </div>
  );
}

export type BannerTone = 'neutral' | 'error' | 'success' | 'warn';

export interface BannerProps {
  readonly children: ReactNode;
  readonly tone?: BannerTone;
  readonly onClose?: () => void;
  readonly className?: string;
}

/** 页面级横幅（操作结果、系统提示）。 */
export function Banner({ children, tone = 'neutral', onClose, className }: BannerProps) {
  const classes = ['m-banner', tone !== 'neutral' ? `m-banner--${tone}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role="status">
      <span className="m-banner__text">{children}</span>
      {onClose ? (
        <button type="button" className="m-iconbtn" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}
