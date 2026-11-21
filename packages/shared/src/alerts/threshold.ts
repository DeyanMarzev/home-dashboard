import type { AlertLevel, ThresholdRule } from './schema.js';

/**
 * Threshold rules (docs/09 §3 Rule types), as a pure function of a series' recent readings.
 * "Continuously beyond a level for `for`" = the trailing run of readings beyond it started at
 * least `for` ago. The collector re-evaluates every minute from the stored readings, so a
 * restart, or a reading written by another process, changes nothing.
 */

export interface ReadingPoint {
  /** Epoch ms. */
  ts: number;
  value: number;
}

export type ThresholdAction =
  | { kind: 'none' }
  | { kind: 'open'; level: AlertLevel; value: number; since: number }
  | { kind: 'escalate'; value: number; since: number }
  | { kind: 'resolve'; value: number };

const beyond = (rule: ThresholdRule, value: number, level: number) =>
  rule.direction === 'above' ? value > level : value < level;
/** Back inside the clear level: at or under it (above rules), at or over it (below rules). */
const inside = (rule: ThresholdRule, value: number) =>
  rule.direction === 'above' ? value <= rule.clear.level : value >= rule.clear.level;

/** Start of the trailing run of points matching `test`, or null if the newest doesn't. */
function runSince(points: readonly ReadingPoint[], test: (v: number) => boolean): number | null {
  let since: number | null = null;
  for (let i = points.length - 1; i >= 0 && test(points[i]!.value); i--) since = points[i]!.ts;
  return since;
}

/**
 * What to do now for one series. `points` are its readings in time order covering at least
 * `windowSeconds(rule)`; `open` is the level of its open event, if any. With `stale` data
 * (the source is Late) nothing opens, escalates or resolves: the state is frozen.
 */
export function evaluateThreshold(
  rule: ThresholdRule,
  points: readonly ReadingPoint[],
  open: AlertLevel | null,
  now: number,
  stale: boolean,
): ThresholdAction {
  const last = points.at(-1);
  if (stale || !last) return { kind: 'none' };
  const held = (since: number | null, forSeconds: number) =>
    since !== null && now - since >= forSeconds * 1000;

  const alertSince = rule.alert
    ? runSince(points, (v) => beyond(rule, v, rule.alert!.level))
    : null;
  const alertHeld = rule.alert !== undefined && held(alertSince, rule.alert.for);

  if (open === null) {
    if (alertHeld) return { kind: 'open', level: 'alert', value: last.value, since: alertSince! };
    const warningSince = runSince(points, (v) => beyond(rule, v, rule.warning.level));
    if (held(warningSince, rule.warning.for))
      return { kind: 'open', level: 'warning', value: last.value, since: warningSince! };
    return { kind: 'none' };
  }
  if (open === 'warning' && alertHeld)
    return { kind: 'escalate', value: last.value, since: alertSince! };
  if (
    held(
      runSince(points, (v) => inside(rule, v)),
      rule.clear.for,
    )
  )
    return { kind: 'resolve', value: last.value };
  return { kind: 'none' };
}

/**
 * How far back to read: the longest `for` plus room for sparse readings (two of the source's
 * intervals, at least 10 minutes).
 */
export function windowSeconds(rule: ThresholdRule, cadenceSeconds: number | null): number {
  const longest = Math.max(rule.warning.for, rule.alert?.for ?? 0, rule.clear.for);
  return longest + Math.max(2 * (cadenceSeconds ?? 0), 600);
}
