/**
 * @file index.ts
 * @description Meridian UI 组件库统一出口。
 *
 * 引入方式：
 *   import { Panel, StatusChip, Text } from '../kit/index.ts';
 *
 * 命名规范：
 * - 所有 CSS 类以 `m-` 前缀（与旧版 workbench.css 完全隔离，可并存）；
 * - 所有设计令牌以 `--m-` 前缀；
 * - 组件不直接读业务 DTO，业务适配层放在 `src/ui/client/lib/`。
 */

export { Icon, type IconName, type IconProps } from './Icon.tsx';

export {
  Text,
  Prose,
  SectionLabel,
  Stack,
  Inline,
  Divider,
  type TextVariant,
  type TextTone,
  type TextClamp,
  type TextProps,
  type ProseProps,
  type SectionLabelProps,
  type StackProps,
  type InlineProps,
  type DividerProps,
} from './Typography.tsx';

export {
  Panel,
  Card,
  Callout,
  Banner,
  type PanelProps,
  type CardProps,
  type CalloutProps,
  type CalloutTone,
  type BannerProps,
  type BannerTone,
} from './Surface.tsx';

export {
  Button,
  IconButton,
  SegmentedControl,
  Field,
  Input,
  Textarea,
  Select,
  Switch,
  Checkbox,
  Slider,
  Stat,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  type IconButtonProps,
  type SegmentedControlProps,
  type SegmentedControlOption,
  type FieldProps,
  type InputProps,
  type TextareaProps,
  type SelectProps,
  type SelectOption,
  type SwitchProps,
  type CheckboxProps,
  type SliderProps,
  type StatProps,
} from './Controls.tsx';

export {
  StatusChip,
  KeyValueList,
  DefinitionList,
  Meter,
  Gauge,
  DataTable,
  ListRow,
  MetricGrid,
  type StatusChipProps,
  type StatusTone,
  type KeyValueEntry,
  type KeyValueListProps,
  type DefinitionItem,
  type DefinitionListProps,
  type MeterProps,
  type MeterTone,
  type GaugeProps,
  type DataColumn,
  type DataTableProps,
  type ListRowProps,
  type MetricGridProps,
} from './Data.tsx';

export {
  Tabs,
  Breadcrumb,
  Avatar,
  AvatarGroup,
  PageHeader,
  type TabItem,
  type TabsProps,
  type BreadcrumbItem,
  type BreadcrumbProps,
  type AvatarProps,
  type AvatarGroupProps,
  type PageHeaderProps,
} from './Navigation.tsx';

export {
  EmptyState,
  LoadingState,
  ErrorState,
  Skeleton,
  Tooltip,
  Drawer,
  Modal,
  type EmptyStateProps,
  type LoadingStateProps,
  type ErrorStateProps,
  type SkeletonProps,
  type TooltipProps,
  type DrawerProps,
  type ModalProps,
} from './Feedback.tsx';
