/** Small calculations over chart points ([ISO time, value], oldest first). */

export type Point = readonly [string, number];

export function stats(points: readonly Point[]): { min: number; max: number; avg: number } | null {
  if (points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const [, v] of points) {
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
  }
  return { min, max, avg: sum / points.length };
}

/** Total time (seconds) above a threshold, counting each bucket of `bucketSeconds` whose value exceeds it. */
export function secondsAbove(
  points: readonly Point[],
  threshold: number,
  bucketSeconds: number,
): number {
  return points.filter(([, v]) => v > threshold).length * bucketSeconds;
}

/** Averages several aligned series bucket by bucket (e.g. one "indoor" line from every room). */
export function averageSeries(series: readonly (readonly Point[])[]): [string, number][] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const points of series) {
    for (const [t, v] of points) {
      const s = sums.get(t) ?? { sum: 0, n: 0 };
      s.sum += v;
      s.n++;
      sums.set(t, s);
    }
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, { sum, n }]) => [t, sum / n]);
}

/** Groups points into windows of `windowSeconds` (aligned to UTC) and averages each. */
export function averageByWindow(
  points: readonly Point[],
  windowSeconds: number,
): [string, number][] {
  const groups = new Map<number, { sum: number; n: number }>();
  for (const [t, v] of points) {
    const key = Math.floor(Date.parse(t) / 1000 / windowSeconds) * windowSeconds;
    const g = groups.get(key) ?? { sum: 0, n: 0 };
    g.sum += v;
    g.n++;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([k, { sum, n }]) => [new Date(k * 1000).toISOString(), sum / n]);
}

/**
 * The window of `count` consecutive points with the lowest average (e.g. the greenest 4 h of
 * half-hourly carbon forecasts: count 8). Returns its first point's time, the time just after
 * its last point, and the average; null if there aren't enough points.
 */
export function lowestWindow(
  points: readonly Point[],
  count: number,
  stepSeconds: number,
): { from: string; to: string; avg: number } | null {
  if (points.length < count) return null;
  let best = -1;
  let bestSum = Infinity;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i]![1];
    if (i >= count) sum -= points[i - count]![1];
    if (i >= count - 1 && sum < bestSum) {
      bestSum = sum;
      best = i - count + 1;
    }
  }
  const from = points[best]![0];
  const to = new Date(Date.parse(points[best + count - 1]![0]) + stepSeconds * 1000).toISOString();
  return { from, to, avg: bestSum / count };
}
