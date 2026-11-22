/**
 * @file Feedback.tsx
 * @description Meridian UI 反馈与浮层组件：空态、载入、错误、骨架屏、抽屉、模态、提示。
 */

import { useEffect, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Button } from './Controls.tsx';

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly icon?: IconName;
  readonly action?: ReactNode;
  readonly compact?: boolean;
  readonly className?: string;
}

/** 空态。说明文字限宽，不铺满。 */
export function EmptyState({
  title,
  description,
  icon = 'inbox',
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={['m-empty', className ?? ''].filter(Boolean).join(' ')}
      style={compact ? { padding: 'var(--m-sp-6) var(--m-sp-4)' } : undefined}
    >
      <span className="m-empty__icon">
        <Icon name={icon} size={22} />
      </span>
      <div className="m-empty__title">{title}</div>
      {description !== undefined ? <div className="m-empty__text">{description}</div> : null}
      {action !== undefined ? <div style={{ marginTop: 4 }}>{action}</div> : null}
    </div>
  );
}

export interface LoadingStateProps {
  readonly label?: ReactNode;
  readonly className?: string;
}

/** 载入态。 */
export function LoadingState({ label = '加载中…', className }: LoadingStateProps) {
  return (
    <div className={['m-loading', className ?? ''].filter(Boolean).join(' ')} role="status">
      <span className="m-spinner" />
      <span>{label}</span>
    </div>
  );
}

export interface ErrorStateProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly onRetry?: () => void;
  readonly className?: string;
}

/** 错误态。 */
export function ErrorState({
  title = '操作失败',
  description,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={['m-empty', className ?? ''].filter(Boolean).join(' ')}
      role="alert"
      style={{ color: 'var(--m-coral)' }}
    >
      <span className="m-empty__icon" style={{ color: 'var(--m-coral)' }}>
        <Icon name="alert" size={22} />
      </span>
      <div className="m-empty__title" style={{ color: 'var(--m-coral)' }}>
        {title}
      </div>
      {description !== undefined ? <div className="m-empty__text">{description}</div> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" icon="refresh" onClick={onRetry}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

export interface SkeletonProps {
  readonly variant?: 'text' | 'title' | 'block';
  readonly width?: string;
  readonly height?: string;
  readonly count?: number;
  readonly className?: string;
}

/** 骨架屏。 */
export function Skeleton({ variant = 'text', width, height, count = 1, className }: SkeletonProps) {
  return (
    <>
      {Array.from({ length: count }, (_, idx) => (
        <div
          key={idx}
          className={[
            'm-skeleton',
            variant === 'title' ? 'm-skeleton--title' : '',
            variant === 'block' ? 'm-skeleton--block' : 'm-skeleton--text',
            className ?? '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ width, height }}
        />
      ))}
    </>
  );
}

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** 轻提示。内容限宽 280px，避免长文撑破。 */
export function Tooltip({ content, children, className }: TooltipProps) {
  return (
    <span className={['m-tooltip', className ?? ''].filter(Boolean).join(' ')}>
      {children}
      <span className="m-tooltip__bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}

export interface DrawerProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}

/**
 * 抽屉。分三级宽度：sm 速览 / md 详情 / lg 审阅。
 * 旧版固定 500px，无法承载交付物全文 —— 这里是三级抽屉的来源。
 */
export function Drawer({
  open,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
  onClose,
}: DrawerProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return (
    <>
      <div className="m-overlay" onClick={onClose} />
      <aside
        className={`m-drawer m-drawer--${size} m-drawer--open`}
        role="dialog"
        aria-modal="true"
      >
        <header className="m-drawer__header">
          <div style={{ minWidth: 0 }}>
            <div className="m-h2 m-truncate">{title}</div>
            {subtitle !== undefined ? <div className="m-xs m-truncate">{subtitle}</div> : null}
          </div>
          <button type="button" className="m-iconbtn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="m-drawer__body">{children}</div>
        {footer !== undefined ? <footer className="m-drawer__footer">{footer}</footer> : null}
      </aside>
    </>
  );
}

export interface ModalProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly width?: number;
}

/** 模态框。 */
export function Modal({ open, title, children, footer, onClose, width = 560 }: ModalProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return (
    <>
      <div className="m-overlay" onClick={onClose} />
      <div className="m-modal">
        <div
          className="m-modal__card"
          style={{ width: `min(${width}px, 100%)` }}
          role="dialog"
          aria-modal="true"
        >
          <header className="m-modal__header">
            <div className="m-h3 m-truncate">{title}</div>
            <button type="button" className="m-iconbtn" onClick={onClose} aria-label="关闭">
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="m-modal__body">{children}</div>
          {footer !== undefined ? <footer className="m-modal__footer">{footer}</footer> : null}
        </div>
      </div>
    </>
  );
}
