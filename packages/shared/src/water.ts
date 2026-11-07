import { addLondonDays, londonDateString, londonParts } from './london.js';
import type { Point } from './series-math.js';

/** The leak check looks at the quietest hour between midnight and 05:00 (docs/03 § thames_water). */
export const NIGHT_END_HOUR = 5;
/** Alert after this many nights in a row with water flowing at night. */
export const LEAK_NIGHTS = 3;

export interface NightMinimum {
  /** The London date the night ends on (the morning): "1–2 Nov" is night "2026-11-02". */
  night: string;
  /** Litres in the quietest hour between 00:00 and 05:00. */
  minLitres: number;
  /** All 5 hours present. */
  complete: boolean;
}

/** Quietest hour of each night, from hourly litres ([start of hour, litres], oldest first). */
export function nightMinimums(hourly: readonly Point[]): NightMinimum[] {
  const nights = new Map<string, number[]>();
  for (const [t, litres] of hourly) {
    const d = new Date(t);
    if (londonParts(d).hour >= NIGHT_END_HOUR) continue;
    const night = londonDateString(d);
    nights.set(night, [...(nights.get(night) ?? []), litres]);
  }
  return [...nights.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([night, values]) => ({
      night,
      minLitres: Math.min(...values),
      complete: values.length >= NIGHT_END_HOUR,
    }));
}

export type LeakState = 'ok' | 'watch' | 'leak' | 'unknown';

/**
 * Leak status from the most recent complete nights: a leak when the last 3 nights all had
 * flow, watch when the latest night did, ok when it didn't.
 */
export function leakStatus(nights: readonly NightMinimum[]): {
  state: LeakState;
  consecutive: number;
  nightsChecked: number;
} {
  const complete = nights.filter((n) => n.complete);
  let consecutive = 0;
  for (let i = complete.length - 1; i >= 0 && complete[i]!.minLitres > 0; i--) consecutive++;
  const state: LeakState =
    complete.length === 0
      ? 'unknown'
      : consecutive >= LEAK_NIGHTS
        ? 'leak'
        : consecutive > 0
          ? 'watch'
          : 'ok';
  return { state, consecutive, nightsChecked: complete.length };
}

/** "1–2 Nov", "31 Oct–1 Nov" for the night ending on `night`. */
export function nightLabel(night: string): string {
  const fmt = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    return {
      day: d.getUTCDate(),
      month: d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }).slice(0, 3),
    };
  };
  const before = fmt(addLondonDays(night, -1));
  const after = fmt(night);
  return before.month === after.month
    ? `${before.day}–${after.day} ${after.month}`
    : `${before.day} ${before.month}–${after.day} ${after.month}`;
}

/** Pence for a day's water: litres → m³ × unit rate per m³, plus the daily standing charge. */
export function waterDayPence(
  litres: number,
  tariff: { unitRatePence: number; standingPence: number },
): number {
  return Math.round((litres / 1000) * tariff.unitRatePence + tariff.standingPence);
}
