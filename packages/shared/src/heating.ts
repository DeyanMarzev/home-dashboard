import type { Point } from './series-math.js';

/**
 * Heating maths for the Heating page and /api/summary/heating (docs/04). Inputs are chart
 * points ([ISO time, value], oldest first): `hvac_heating` states (0/1, or 0–1 averages when
 * bucketed), Nest temperatures and boiler pipe temperatures.
 */

/** A return temperature below this lets a condensing boiler condense (recover flue heat). */
export const CONDENSING_LIMIT_C = 55;
/** Firing periods shorter than this are "short cycles". */
export const SHORT_CYCLE_SECONDS = 15 * 60;

export interface Run {
  from: string;
  to: string;
}

const ms = (t: string) => Date.parse(t);
const iso = (n: number) => new Date(n).toISOString();

/**
 * When a state series was "on" (value > threshold). Each point holds until the next one, but
 * never longer than `holdSeconds` (a gap in the data isn't counted as on), and the last
 * point holds until `until` at most. Adjacent on-points merge into one run.
 */
export function stateRuns(
  points: readonly Point[],
  holdSeconds: number,
  until: Date,
  threshold = 0.5,
): Run[] {
  const runs: Run[] = [];
  points.forEach(([t, v], i) => {
    if (v <= threshold) return;
    const next = points[i + 1];
    const end = Math.min(
      next ? ms(next[0]) : until.getTime(),
      ms(t) + holdSeconds * 1000,
      until.getTime(),
    );
    if (end <= ms(t)) return;
    const last = runs[runs.length - 1];
    if (last && ms(last.to) >= ms(t)) last.to = iso(Math.max(ms(last.to), end));
    else runs.push({ from: t, to: iso(end) });
  });
  return runs;
}

/** Runs clipped to [from, to). */
export function clipRuns(runs: readonly Run[], from: Date, to: Date): Run[] {
  return runs.flatMap((r) => {
    const a = Math.max(ms(r.from), from.getTime());
    const b = Math.min(ms(r.to), to.getTime());
    return b > a ? [{ from: iso(a), to: iso(b) }] : [];
  });
}

export function totalSeconds(runs: readonly Run[]): number {
  return runs.reduce((s, r) => s + (ms(r.to) - ms(r.from)) / 1000, 0);
}

/**
 * Share of firing time with the return pipe below the condensing limit, from the return
 * probe's readings that fall inside firing runs. Null without any such readings.
 */
export function condensingShare(
  runs: readonly Run[],
  returnPoints: readonly Point[],
  limitC = CONDENSING_LIMIT_C,
): number | null {
  const inside = returnPoints.filter(([t]) =>
    runs.some((r) => ms(t) >= ms(r.from) && ms(t) < ms(r.to)),
  );
  if (inside.length === 0) return null;
  return inside.filter(([, v]) => v < limitC).length / inside.length;
}

/** The reading at or just before `t` (or the first one after, if none before). */
function valueAt(points: readonly Point[], t: number): number | null {
  let best: Point | undefined;
  for (const p of points) {
    if (ms(p[0]) <= t) best = p;
    else break;
  }
  return (best ?? points.find((p) => ms(p[0]) > t))?.[1] ?? null;
}

export interface WarmUp {
  /** °C per hour, averaged over firing runs of 20 min or more. */
  ratePerHour: number;
  /** The longest of those runs. */
  longest: { from: string; to: string; startC: number; endC: number };
}

/** How fast the house warms while the boiler fires, from the thermostat's temperature. */
export function warmUp(runs: readonly Run[], temperature: readonly Point[]): WarmUp | null {
  const measured = runs
    .filter((r) => ms(r.to) - ms(r.from) >= 20 * 60_000)
    .flatMap((r) => {
      const startC = valueAt(temperature, ms(r.from));
      const endC = valueAt(temperature, ms(r.to));
      return startC === null || endC === null
        ? []
        : [{ ...r, startC, endC, hours: (ms(r.to) - ms(r.from)) / 3600_000 }];
    });
  if (measured.length === 0) return null;
  const hours = measured.reduce((s, r) => s + r.hours, 0);
  const rise = measured.reduce((s, r) => s + (r.endC - r.startC), 0);
  const longest = measured.reduce((a, b) => (b.hours > a.hours ? b : a));
  return {
    ratePerHour: rise / hours,
    longest: { from: longest.from, to: longest.to, startC: longest.startC, endC: longest.endC },
  };
}

export interface HeatingTip {
  title: string;
  detail: string;
}

/** Rule-based "worth trying" suggestions (docs/05 § Heating). */
export function heatingTips(i: {
  flowPeakC: number | null;
  condensingShare: number | null;
  warmUp: WarmUp | null;
  shortCycles: number;
}): HeatingTip[] {
  const tips: HeatingTip[] = [];
  if (
    i.flowPeakC !== null &&
    i.flowPeakC > 60 &&
    (i.condensingShare === null || i.condensingShare < 0.9)
  ) {
    tips.push({
      title: 'Lower the boiler flow temperature',
      detail: `Flow peaked at ${Math.round(i.flowPeakC)} °C. Around 55 °C would keep the return low enough to condense more of the time.`,
    });
  }
  if (i.warmUp && i.warmUp.longest.endC > i.warmUp.longest.startC) {
    const minutes = Math.round((ms(i.warmUp.longest.to) - ms(i.warmUp.longest.from)) / 60_000);
    if (minutes >= 90) {
      tips.push({
        title: `Longest warm-up took ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`,
        detail: `From ${i.warmUp.longest.startC.toFixed(1)} °C to ${i.warmUp.longest.endC.toFixed(1)} °C at ${i.warmUp.ratePerHour.toFixed(1)} °C an hour. A warmer night setting would shorten it.`,
      });
    }
  }
  if (i.shortCycles >= 3) {
    tips.push({
      title: `${i.shortCycles} short cycles`,
      detail:
        'Firing for under 15 minutes at a time wastes gas and wears the boiler. A lower flow temperature often helps.',
    });
  }
  return tips;
}
