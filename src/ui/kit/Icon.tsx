/**
 * @file Icon.tsx
 * @description Meridian UI 内联 SVG 图标集。
 *
 * 约束：
 * - 全部 24×24 viewBox，stroke 继承 currentColor，stroke-width 1.6；
 * - 不引入任何外部图标包或 CDN（内网私有化部署硬约束）；
 * - 图标只做"辅助定位"，语义永远由相邻文本承担，图标不单独承载含义。
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'check'
  | 'close'
  | 'alert'
  | 'info'
  | 'clock'
  | 'zap'
  | 'flag'
  | 'shield'
  | 'layers'
  | 'activity'
  | 'search'
  | 'plus'
  | 'minus'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'arrow-right'
  | 'arrow-left'
  | 'git-branch'
  | 'gavel'
  | 'code'
  | 'file'
  | 'folder'
  | 'message'
  | 'users'
  | 'user'
  | 'grid'
  | 'settings'
  | 'bell'
  | 'sun'
  | 'moon'
  | 'eye'
  | 'eye-off'
  | 'lock'
  | 'unlock'
  | 'play'
  | 'refresh'
  | 'download'
  | 'upload'
  | 'external'
  | 'filter'
  | 'more'
  | 'copy'
  | 'link'
  | 'trend-up'
  | 'trend-down'
  | 'database'
  | 'terminal'
  | 'book'
  | 'inbox';

const PATHS: Record<IconName, ReactElement> = {
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  alert: <path d="M12 3.5 22 20H2z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  zap: <path d="M13 2 4.5 13.5H11L10.5 22 19.5 10.5H13z" />,
  flag: <path d="M5 21V4M5 5h11l-1.8 3.5L16 12H5" />,
  shield: (
    <>
      <path d="M12 2.8 20 6v6c0 5-3.4 8-8 9.2C7.4 20 4 17 4 12V6z" />
      <path d="m9 12 2 2 4-4.5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  'chevron-up': <path d="m5 15 7-7 7 7" />,
  'arrow-right': <path d="M4 12h15M13 6l6 6-6 6" />,
  'arrow-left': <path d="M20 12H5M11 6l-6 6 6 6" />,
  'git-branch': (
    <>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 7.2v9.6M8.2 5.6h4a3 3 0 0 1 3 3v.6M8.2 18.4h4a3 3 0 0 0 3-3v-.6" />
    </>
  ),
  gavel: (
    <>
      <path d="M13.5 3.5 20 10M17 6.5 14 9.5M10 5l9 9M8.5 8.5 3 14l3.5 3.5 5.5-5.5" />
      <path d="M14 20h7" />
    </>
  ),
  code: <path d="M8.5 8 4 12l4.5 4M15.5 8l4.5 4-4.5 4M13.5 5l-3 14" />,
  file: (
    <>
      <path d="M14 3H7a1.8 1.8 0 0 0-1.8 1.8v14.4A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V7.8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  folder: (
    <path d="M3 7a1.8 1.8 0 0 1 1.8-1.8h4.4l2 2.4h7A1.8 1.8 0 0 1 20 9.4v8.2A1.8 1.8 0 0 1 18.2 19H5.8A1.8 1.8 0 0 1 4 17.2z" />
  ),
  message: <path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.4-5.1A8.5 8.5 0 1 1 21 12z" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.2a3.4 3.4 0 0 1 0 6.6M18 14.4A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.6" />
      <rect x="14" y="3" width="7" height="7" rx="1.6" />
      <rect x="3" y="14" width="7" height="7" rx="1.6" />
      <rect x="14" y="14" width="7" height="7" rx="1.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 15V10a6 6 0 1 0-12 0v5l-1.8 2.8h15.6z" />
      <path d="M10 21h4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />,
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17.8 17.8 0 0 1-3.3 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5a10 10 0 0 0 3.4-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 7.7-1.5" />
    </>
  ),
  play: <path d="M7 4.5 19 12 7 19.5z" />,
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 4v5h-5" />
    </>
  ),
  download: <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16" />,
  upload: <path d="M12 15V3M7.5 7.5 12 3l4.5 4.5M4 20h16" />,
  external: (
    <>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v5a1.8 1.8 0 0 1-1.8 1.8H5A1.8 1.8 0 0 1 3.2 19V7.8A1.8 1.8 0 0 1 5 6h5" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11 5.7" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
  'trend-up': <path d="M3 17l6-6 4 4 8-8M21 7v5h-5" />,
  'trend-down': <path d="M3 7l6 6 4-4 8 8M21 17v-5h-5" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  book: (
    <>
      <path d="M4.5 4.5A1.5 1.5 0 0 1 6 3h13v15H6a1.5 1.5 0 0 0-1.5 1.5z" />
      <path d="M4.5 19.5A1.5 1.5 0 0 1 6 18h13v3H6a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M9 7.5h6M9 11h4" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M4.6 5.3 3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5l-1.6-7.7A2 2 0 0 0 17.5 4h-11a2 2 0 0 0-1.9 1.3z" />
    </>
  ),
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  readonly title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
