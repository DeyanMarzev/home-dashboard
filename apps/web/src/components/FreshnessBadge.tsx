import type { Freshness } from '@home/shared';
import { AlertIcon, ClockIcon } from './icons.js';

/**
 * Renders from `freshness.state` and its label only: never fixed text (CLAUDE.md rule 1).
 * Pass a freshness already re-ticked for now (useFreshnessNow) so it turns Late on its own.
 */
export function FreshnessBadge({
  freshness,
  compact = false,
  suffix,
}: {
  freshness: Freshness;
  compact?: boolean;
  suffix?: string;
}) {
  const text =
    (compact ? freshness.compactLabel : freshness.label) + (suffix ? ` · ${suffix}` : '');
  return (
    <span className={`badge badge--${freshness.state}`} title={freshness.label}>
      {freshness.state === 'live' && <span className="badge-dot" aria-hidden="true" />}
      {freshness.state === 'delayed' && <ClockIcon />}
      {freshness.state === 'late' && <AlertIcon />}
      {text}
    </span>
  );
}

/** For a source that isn't switched on in config/sources.yaml yet. */
export function NotConnectedBadge() {
  return <span className="badge badge--neutral">Not connected</span>;
}
