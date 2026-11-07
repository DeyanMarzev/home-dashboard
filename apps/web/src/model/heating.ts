import { londonDayBounds } from '@home/shared';

export interface SetpointSegment {
  /** Percent of the day. */
  start: number;
  width: number;
  value: number | null;
  /** Warmer half of the day's range: drawn in heat colours. */
  warm: boolean;
}

/**
 * Today's observed target temperatures as bar segments across the London day (00:00–24:00).
 * Each setpoint holds until the next; the rest of the day after `now` is unknown (null), since
 * the Nest API doesn't expose its schedule.
 */
export function setpointSegments(
  setpoints: readonly (readonly [string, number])[],
  date: string,
  now: Date,
): SetpointSegment[] {
  const { from, to } = londonDayBounds(date);
  const span = to.getTime() - from.getTime();
  const pct = (t: number) =>
    ((Math.min(Math.max(t, from.getTime()), to.getTime()) - from.getTime()) / span) * 100;
  const values = setpoints.map(([, v]) => v);
  const mid = values.length ? (Math.min(...values) + Math.max(...values)) / 2 : 0;
  const end = Math.min(now.getTime(), to.getTime());

  const segments: SetpointSegment[] = [];
  setpoints.forEach(([t, v], i) => {
    const start = Date.parse(t);
    const stop = Math.min(i + 1 < setpoints.length ? Date.parse(setpoints[i + 1]![0]) : end, end);
    if (stop <= start) return;
    const last = segments[segments.length - 1];
    if (last && last.value === v) last.width = pct(stop) - last.start;
    else
      segments.push({
        start: pct(start),
        width: pct(stop) - pct(start),
        value: v,
        warm: v > mid || values.every((x) => x === v),
      });
  });
  const known = segments.length
    ? segments[segments.length - 1]!.start + segments[segments.length - 1]!.width
    : pct(from.getTime());
  if (known < 100) segments.push({ start: known, width: 100 - known, value: null, warm: false });
  return segments;
}

/** "2:05" (h:mm) for runtime bars. */
export function hoursMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
