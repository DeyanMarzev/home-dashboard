import {
  formatLondonDayMonth,
  formatLondonTime,
  londonCalendarDaysBetween,
  londonDayNumber,
} from './london.js';
import { LIVE_THRESHOLD_SECONDS } from './registry.js';

/**
 * Freshness: one rule for every source (docs/03-sources-and-freshness.md). Used by the API
 * in responses and by the web app to re-tick badges every minute without refetching.
 * Badges render `label` / `compactLabel` only: never hardcode "Live" or "1 day behind".
 */

export type FreshnessState = 'live' | 'delayed' | 'late';

export interface FreshnessPolicy {
  expectedDelaySeconds: number;
  /** poll interval or push interval; null if unknown (e.g. cron-scheduled). */
  cadenceSeconds: number | null;
  /** null = default grace for delayed sources. */
  graceSeconds: number | null;
}

/** The newest reading of a series. `intervalSeconds` is set for `interval_total` series. */
export interface LatestPoint {
  ts: Date | string;
  intervalSeconds?: number | null;
}

export interface Freshness {
  state: FreshnessState;
  /** Newest instant the data covers (ISO, UTC); null if the series never reported. */
  dataTo: string | null;
  lagSeconds: number | null;
  /** Whole Europe/London calendar days between the last covered day and today. */
  daysBehind: number | null;
  /** e.g. `Live`, `Data to 5 Nov · 1 day behind`, `No data since 13:10`. */
  label: string;
  /** For tiles, e.g. `Live`, `1 day behind`, `No data since 13:10`. */
  compactLabel: string;
}

export const MIN_LIVE_WINDOW_SECONDS = 5 * 60;
export const DEFAULT_GRACE_SECONDS = 12 * 3600;
export { LIVE_THRESHOLD_SECONDS };

export function isLiveCapable(policy: FreshnessPolicy): boolean {
  return policy.expectedDelaySeconds <= LIVE_THRESHOLD_SECONDS;
}

/**
 * The newest instant a series' data covers: its latest `ts` for gauge/state series, and
 * `ts + interval` (end of the last complete interval) for interval_total series.
 */
export function dataToOf(latest: LatestPoint): Date {
  const ts = new Date(latest.ts);
  return new Date(ts.getTime() + (latest.intervalSeconds ?? 0) * 1000);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function freshness(
  policy: FreshnessPolicy,
  latest: LatestPoint | null,
  now: Date = new Date(),
): Freshness {
  if (latest === null) {
    return {
      state: 'late',
      dataTo: null,
      lagSeconds: null,
      daysBehind: null,
      label: 'No data yet',
      compactLabel: 'No data yet',
    };
  }

  const dataTo = dataToOf(latest);
  // An interval series whose data ends at 00:00 covers the previous day, not this one.
  const lastCovered = latest.intervalSeconds ? new Date(dataTo.getTime() - 1) : dataTo;
  // Clock skew between sources can put dataTo slightly in the future: treat as no lag.
  const lagSeconds = Math.max(0, Math.round((now.getTime() - dataTo.getTime()) / 1000));
  const daysBehind = Math.max(0, londonCalendarDaysBetween(lastCovered, now));

  let state: FreshnessState;
  if (isLiveCapable(policy)) {
    const window = Math.max(3 * (policy.cadenceSeconds ?? 0), MIN_LIVE_WINDOW_SECONDS);
    state = lagSeconds <= window ? 'live' : 'late';
  } else {
    const grace = policy.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    state = lagSeconds <= policy.expectedDelaySeconds + grace ? 'delayed' : 'late';
  }

  let label: string;
  let compactLabel: string;
  if (state === 'live') {
    label = compactLabel = 'Live';
  } else if (state === 'delayed') {
    const behind = daysBehind === 0 ? 'up to date' : `${plural(daysBehind, 'day')} behind`;
    label = `Data to ${formatLondonDayMonth(lastCovered)} · ${behind}`;
    compactLabel = daysBehind === 0 ? 'Up to date' : `${plural(daysBehind, 'day')} behind`;
  } else {
    const sameDay = londonDayNumber(lastCovered) === londonDayNumber(now);
    label = compactLabel = sameDay
      ? `No data since ${formatLondonTime(dataTo)}`
      : `No data since ${formatLondonDayMonth(lastCovered)}`;
  }

  return { state, dataTo: dataTo.toISOString(), lagSeconds, daysBehind, label, compactLabel };
}

const SEVERITY: Record<FreshnessState, number> = { live: 0, delayed: 1, late: 2 };

/**
 * Freshness of a panel built from several series: the worst state wins
 * (late > delayed > live); within the same state, the oldest data (never-reported first).
 * Returns null for an empty list.
 */
export function combineFreshness(list: readonly Freshness[]): Freshness | null {
  let worst: Freshness | null = null;
  for (const f of list) {
    if (worst === null) {
      worst = f;
      continue;
    }
    const bySeverity = SEVERITY[f.state] - SEVERITY[worst.state];
    if (bySeverity > 0 || (bySeverity === 0 && isOlder(f, worst))) worst = f;
  }
  return worst;
}

function isOlder(a: Freshness, b: Freshness): boolean {
  if (a.dataTo === null) return b.dataTo !== null;
  if (b.dataTo === null) return false;
  return Date.parse(a.dataTo) < Date.parse(b.dataTo);
}
