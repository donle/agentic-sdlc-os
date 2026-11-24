/**
 * @file DetailDrawer.tsx
 * @description 全局右侧滑出详情抽屉（L2/L3）：支持 sm (420px) / md (640px) / lg (960px) 三级宽度，由 App 统一管理开关。
 */

import { useEffect } from 'react';
import { Button } from '../../kit/index.ts';

export type DrawerSize = 'sm' | 'md' | 'lg';

export interface DrawerContent {
  readonly title: string;
  readonly subtitle?: string;
  readonly size?: DrawerSize;
  readonly body: React.ReactNode;
  readonly actions?: React.ReactNode;
}

export function DetailDrawer({
  content,
  onClose,
}: {
  content: DrawerContent | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && content !== null) {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [content, onClose]);

  useEffect(() => {
    document.body.classList.toggle('drawer-open-lock', content !== null);
    return () => document.body.classList.remove('drawer-open-lock');
  }, [content]);

  if (content === null) {
    return null;
  }

  const size: DrawerSize = content.size ?? 'md';

  return (
    <div
      className="drawer-backdrop open"
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) {
          onClose();
        }
      }}
    >
      <aside className={`drawer-panel drawer-panel--${size}`} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div className="drawer-header-text">
            <div className="drawer-title">{content.title}</div>
            {content.subtitle ? <div className="drawer-subtitle">{content.subtitle}</div> : null}
          </div>
          <Button size="sm" variant="ghost" icon="close" onClick={onClose}>
            关闭
          </Button>
        </div>
        <div className="drawer-body">{content.body}</div>
        {content.actions ? <div className="drawer-actions">{content.actions}</div> : null}
      </aside>
    </div>
  );
}
