/**
 * @file Typography.tsx
 * @description Meridian UI 排版基元。
 *
 * 这是整个库解决"文字挤满组件"的第一道闸门：
 * - 组件内文字必须声明 variant（语义层级）与 clamp（截断策略）；
 * - Prose 段落自动按 --m-measure-prose 限宽，列表摘要按 --m-measure-list 限宽；
 * - 任何文本容器不允许出现未声明的裸字号。
 */

import type { ReactNode } from 'react';

export type TextVariant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'sm' | 'xs' | 'label' | 'mono';
export type TextTone =
  'primary' | 'secondary' | 'tertiary' | 'brand' | 'jade' | 'amber' | 'coral' | 'violet' | 'cyan';
export type TextClamp = 'none' | '1' | '2' | '3' | '4';

const VARIANT_CLASS: Record<TextVariant, string> = {
  display: 'm-display',
  h1: 'm-h1',
  h2: 'm-h2',
  h3: 'm-h3',
  body: 'm-body',
  sm: 'm-sm',
  xs: 'm-xs',
  label: 'm-label',
  mono: 'm-mono',
};

const TONE_CLASS: Record<TextTone, string> = {
  primary: 'm-tone-primary',
  secondary: 'm-tone-secondary',
  tertiary: 'm-tone-tertiary',
  brand: 'm-tone-brand',
  jade: 'm-tone-jade',
  amber: 'm-tone-amber',
  coral: 'm-tone-coral',
  violet: 'm-tone-violet',
  cyan: 'm-tone-cyan',
};

const CLAMP_CLASS: Record<TextClamp, string> = {
  none: '',
  '1': 'm-truncate',
  '2': 'm-clamp-2',
  '3': 'm-clamp-3',
  '4': 'm-clamp-4',
};

export interface TextProps {
  readonly children: ReactNode;
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  /** 截断策略：默认不截断；列表摘要建议 2，标题建议 1。 */
  readonly clamp?: TextClamp;
  readonly mono?: boolean;
  readonly className?: string;
  readonly title?: string;
  readonly as?: 'div' | 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'strong' | 'label' | 'code';
}

/** 统一文本组件。所有界面文字都应通过它渲染，以强制走令牌。 */
export function Text({
  children,
  variant = 'body',
  tone,
  clamp = 'none',
  mono = false,
  className,
  title,
  as = 'div',
}: TextProps) {
  const Tag = as;
  const classes = [
    VARIANT_CLASS[variant],
    tone ? TONE_CLASS[tone] : '',
    CLAMP_CLASS[clamp],
    mono ? 'm-num' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={classes} title={title}>
      {children}
    </Tag>
  );
}

export interface ProseProps {
  readonly children: ReactNode;
  /** 行数上限，默认 3 行；传 0 表示不限行但仍限宽。 */
  readonly maxLines?: number;
  readonly className?: string;
  readonly tone?: TextTone;
}

/**
 * 段落 / 说明文字容器。
 * 自动施加 --m-measure-prose 限宽 —— 这保证长说明永远不会横铺满整个组件。
 */
export function Prose({ children, maxLines = 3, className, tone }: ProseProps) {
  const classes = [
    'm-body',
    'm-measure-prose',
    maxLines === 1 ? 'm-truncate' : '',
    maxLines === 2 ? 'm-clamp-2' : '',
    maxLines === 3 ? 'm-clamp-3' : '',
    maxLines >= 4 ? 'm-clamp-4' : '',
    tone ? TONE_CLASS[tone] : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

export interface SectionLabelProps {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

/** 组件内部的次级分组标题。 */
export function SectionLabel({ children, action, className }: SectionLabelProps) {
  return (
    <div className={['m-section-label', className ?? ''].filter(Boolean).join(' ')}>
      <span className="m-truncate">{children}</span>
      {action ? <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>{action}</span> : null}
    </div>
  );
}

export interface StackProps {
  readonly children: ReactNode;
  readonly gap?: 'tight' | 'normal' | 'loose';
  readonly className?: string;
  readonly as?: 'div' | 'section' | 'ul';
}

/** 垂直布局。gap 由密度令牌驱动，compact 档自动收窄。 */
export function Stack({ children, gap = 'normal', className, as = 'div' }: StackProps) {
  const Tag = as;
  const classes = [
    'm-stack',
    gap === 'tight' ? 'm-stack--tight' : '',
    gap === 'loose' ? 'm-stack--loose' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return <Tag className={classes}>{children}</Tag>;
}

export interface InlineProps {
  readonly children: ReactNode;
  readonly wrap?: boolean;
  readonly className?: string;
}

/** 水平布局。默认不换行，配合 .m-truncate 可做"单行 + 省略号"的标准行。 */
export function Inline({ children, wrap = false, className }: InlineProps) {
  const classes = ['m-inline', wrap ? '' : 'm-inline--nowrap', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

export interface DividerProps {
  readonly vertical?: boolean;
  readonly className?: string;
}

export function Divider({ vertical = false, className }: DividerProps) {
  const classes = ['m-divider', vertical ? 'm-divider--vertical' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <div className={classes} role="separator" />;
}
