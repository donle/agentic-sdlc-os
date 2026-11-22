/**
 * @file Controls.tsx
 * @description Meridian UI 操作类组件：按钮、表单控件、分段控件。
 */

import type { ChangeEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Text } from './Typography.tsx';

export type ButtonVariant =
  'default' | 'primary' | 'success' | 'danger' | 'violet' | 'ghost' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  readonly children?: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly iconRight?: IconName;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly block?: boolean;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly onClick?: () => void;
  readonly className?: string;
  readonly ariaLabel?: string;
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  block = false,
  type = 'button',
  onClick,
  className,
  ariaLabel,
}: ButtonProps) {
  const classes = [
    'm-btn',
    variant !== 'default' ? `m-btn--${variant}` : '',
    size !== 'md' ? `m-btn--${size}` : '',
    block ? 'm-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <span className="m-btn__spinner" />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children !== undefined ? <span className="m-truncate">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
}

export interface IconButtonProps {
  readonly icon: IconName;
  readonly label: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly size?: 14 | 16 | 18 | 20;
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  className,
  size = 16,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={['m-iconbtn', className ?? ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly badge?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  readonly options: ReadonlyArray<SegmentedControlOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={['m-seg', className ?? ''].filter(Boolean).join(' ')}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          className="m-seg__item"
          aria-selected={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
          {opt.badge !== undefined ? <span className="m-tabs__count">{opt.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface FieldProps {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly htmlFor?: string;
}

/** 表单字段容器：标签 + 控件 + 提示/错误。 */
export function Field({ label, hint, error, required, children, className, htmlFor }: FieldProps) {
  return (
    <div className={['m-field', className ?? ''].filter(Boolean).join(' ')}>
      {label !== undefined ? (
        <label className="m-field__label" htmlFor={htmlFor}>
          {label}
          {required ? <span style={{ color: 'var(--m-coral)' }}>*</span> : null}
        </label>
      ) : null}
      {children}
      {error !== undefined ? (
        <div className="m-field__error">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      ) : hint !== undefined ? (
        <div className="m-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

export interface InputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly mono?: boolean;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Input({
  value,
  onChange,
  placeholder,
  disabled = false,
  invalid = false,
  mono = false,
  ariaLabel,
  id,
  className,
}: InputProps) {
  return (
    <input
      id={id}
      type="text"
      className={['m-input', mono ? 'm-mono' : '', className ?? ''].filter(Boolean).join(' ')}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(ev: ChangeEvent<HTMLInputElement>) => onChange(ev.target.value)}
    />
  );
}

export interface TextareaProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled = false,
  invalid = false,
  ariaLabel,
  id,
  className,
}: TextareaProps) {
  return (
    <textarea
      id={id}
      className={['m-textarea', className ?? ''].filter(Boolean).join(' ')}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(ev: ChangeEvent<HTMLTextAreaElement>) => onChange(ev.target.value)}
    />
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  readonly value: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly id?: string;
  readonly className?: string;
}

export function Select({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  id,
  className,
}: SelectProps) {
  return (
    <select
      id={id}
      className={['m-select', className ?? ''].filter(Boolean).join(' ')}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(ev: ChangeEvent<HTMLSelectElement>) => onChange(ev.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function Switch({ checked, onChange, disabled = false, ariaLabel, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={['m-switch', className ?? ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    />
  );
}

export interface CheckboxProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={['m-checkbox', className ?? ''].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    >
      {checked ? <Icon name="check" size={11} /> : null}
    </button>
  );
}

export interface SliderProps {
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: SliderProps) {
  return (
    <input
      type="range"
      className={['m-slider', className ?? ''].filter(Boolean).join(' ')}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(ev: ChangeEvent<HTMLInputElement>) => onChange(Number(ev.target.value))}
    />
  );
}

export interface StatProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
}

/** 轻量只读统计位（不做成卡片，避免页面里卡片套卡片）。 */
export function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="m-metric">
      <Text variant="xs" tone="tertiary" clamp="1">
        {label}
      </Text>
      <div className="m-metric__value">{value}</div>
      {hint !== undefined ? (
        <Text variant="xs" tone="tertiary" clamp="1">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}
