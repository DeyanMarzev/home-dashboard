import type { ReactNode } from 'react';

/** An on/off switch: a real checkbox with role="switch", its state in text as well as shape. */
export function Switch({
  checked,
  onChange,
  disabled = false,
  children,
  hideLabel = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  /** Keep the label for screen readers only (the row already says what it is). */
  hideLabel?: boolean;
}) {
  return (
    <label className={`switch${disabled ? ' switch--disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      <span className={hideLabel ? 'sr-only' : undefined}>{children}</span>
    </label>
  );
}
