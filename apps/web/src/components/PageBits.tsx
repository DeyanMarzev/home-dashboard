import {
  formatDuration,
  freshness,
  LIVE_THRESHOLD_SECONDS,
  type Freshness,
  type SourceInfo,
} from '@home/shared';
import type { ReactNode } from 'react';
import { useSources } from '../api/hooks.js';
import { useNow } from '../lib/now-context.js';
import { Empty } from './Cards.js';
import { FreshnessBadge, NotConnectedBadge } from './FreshnessBadge.js';

/** The single subtitle badge on pages where everything shares one freshness (docs/05). */
export function PageFreshness({ freshness: f }: { freshness: Freshness | null }) {
  if (!f) return null;
  const label =
    f.state === 'live'
      ? 'Whole page live'
      : `Whole page: ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`;
  return <FreshnessBadge freshness={{ ...f, label }} />;
}

/**
 * The one-line key under Overview/Energy headers explaining Live vs Delayed. Its examples are
 * computed with the real freshness rules from the registry's delayed sources, not typed in.
 */
export function FreshnessKey() {
  const now = useNow();
  const { data } = useSources();
  const delayed = (data ?? [])
    .filter((s) => s.policy.expectedDelaySeconds > LIVE_THRESHOLD_SECONDS)
    .sort((a, b) => a.policy.expectedDelaySeconds - b.policy.expectedDelaySeconds);
  const liveExample = freshness(
    { expectedDelaySeconds: 0, cadenceSeconds: null, graceSeconds: null },
    { ts: now },
    now,
  );
  const first = delayed[0];
  const delayedExample = first
    ? freshness(
        first.policy,
        { ts: new Date(now.getTime() - first.policy.expectedDelaySeconds * 1000) },
        now,
      )
    : null;
  const days = (s: SourceInfo) =>
    formatDuration(s.policy.expectedDelaySeconds).replace(
      /^(\d+)d$/,
      (_, n: string) => `${n} day${n === '1' ? '' : 's'}`,
    );
  return (
    <p className="key">
      <span>
        <FreshnessBadge freshness={liveExample} />
        updates within minutes
      </span>
      {delayedExample && (
        <span>
          <FreshnessBadge freshness={delayedExample} compact />
          supplier data that arrives later: {delayed.map((s) => `${s.name} ${days(s)}`).join(', ')}
        </span>
      )}
    </p>
  );
}

/** Badge for a source: its freshness, or "Not connected" if it's disabled in the registry. */
export function SourceBadge({
  source,
  freshness: f,
  compact,
}: {
  source: SourceInfo | undefined;
  freshness?: Freshness | null;
  compact?: boolean;
}) {
  if (source && !source.enabled) return <NotConnectedBadge />;
  const shown = f ?? source?.freshness;
  return shown ? <FreshnessBadge freshness={shown} compact={compact} /> : null;
}

/** Body for a panel whose source isn't switched on yet. */
export function NotConnected({
  source,
  children,
}: {
  source: SourceInfo | undefined;
  children?: ReactNode;
}) {
  return <Empty>{children ?? `${source?.name ?? 'This source'}: not connected yet`}</Empty>;
}
