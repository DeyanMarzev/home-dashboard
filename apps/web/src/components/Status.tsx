import type { ReactNode } from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

/** A dot plus text: status is never shown by colour alone (docs/05 § Accessibility). */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status">
      <span className={`dot dot--${tone}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Chip({ tone, children }: { tone?: Exclude<Tone, 'muted'>; children: ReactNode }) {
  return (
    <span className={`chip${tone ? ` chip--${tone}` : ''}`}>
      {tone && (
        <span className={`dot dot--${tone}`} aria-hidden="true" style={{ width: 7, height: 7 }} />
      )}
      {children}
    </span>
  );
}
