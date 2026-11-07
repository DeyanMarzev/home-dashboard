import type { ReactNode } from 'react';

/** Big number with a smaller, muted unit: `20.4°C`. */
export function Value({
  value,
  unit,
  className = 'big',
}: {
  value: ReactNode;
  unit?: string;
  className?: string;
}) {
  return (
    <span className={className}>
      {value}
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

export function StatTile({
  label,
  badge,
  value,
  unit,
  context,
  flex,
}: {
  label: string;
  badge?: ReactNode;
  value: ReactNode;
  unit?: string;
  context?: ReactNode;
  flex?: string;
}) {
  return (
    <div className="tile" style={flex ? { flex } : undefined}>
      <span className="tile-label">
        <span>{label}</span>
        {badge}
      </span>
      <Value value={value} unit={unit} />
      {context !== undefined && <span className="context">{context}</span>}
    </div>
  );
}

/** A card with a title, a badge next to it, optional right-aligned meta, and a body. */
export function Panel({
  title,
  id,
  badge,
  meta,
  flex,
  warn = false,
  children,
}: {
  title: string;
  id: string;
  badge?: ReactNode;
  meta?: ReactNode;
  flex?: string;
  warn?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`card${warn ? ' card--warn' : ''}`}
      style={flex ? { flex } : undefined}
    >
      <div className="card-head">
        <div className="card-title">
          <h2 id={id}>{title}</h2>
          {badge}
        </div>
        {meta !== undefined && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Skeleton({ height = 20 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden="true" />;
}

export function ProgressBar({
  label,
  right,
  percent,
  ariaLabel,
}: {
  label: ReactNode;
  right?: ReactNode;
  percent: number;
  ariaLabel: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="progress">
      <div className="progress-label">
        <span>{label}</span>
        {right !== undefined && <span className="muted">{right}</span>}
      </div>
      <div className="progress-track" role="img" aria-label={ariaLabel}>
        <div
          className={`progress-fill${clamped >= 85 ? ' progress-fill--warn' : ''}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
