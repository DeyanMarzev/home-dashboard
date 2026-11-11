import {
  DAQI_LABELS,
  daqiLevel,
  londonDateString,
  type DaqiLevel,
  type ReadingsResponse,
} from '@home/shared';
import type { Tone } from '../components/Status.js';

type Series = ReadingsResponse['series'][number];

/** Values by time for each metric, with the metric's `prefix` removed. */
function byTime(series: readonly Series[], prefix: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const s of series) {
    if (!s.meta.metric.startsWith(prefix)) continue;
    const field = s.meta.metric.slice(prefix.length);
    for (const [ts, value] of s.points) {
      const row = out.get(ts) ?? new Map<string, number>();
      row.set(field, value);
      out.set(ts, row);
    }
  }
  return out;
}

export interface HourRow {
  ts: string;
  temperature: number;
  rainChance: number | null;
  code: number | null;
  isDay: boolean;
  wind: number | null;
  gust: number | null;
}

/** The hourly forecast (`forecast_*`), in time order; hours without a temperature are left out. */
export function hourlyRows(series: readonly Series[]): HourRow[] {
  return [...byTime(series, 'forecast_')]
    .flatMap(([ts, v]): HourRow[] => {
      const temperature = v.get('temperature');
      if (temperature === undefined) return [];
      return [
        {
          ts,
          temperature,
          rainChance: v.get('precipitation_probability') ?? null,
          code: v.get('weather_code') ?? null,
          isDay: v.get('is_day') !== 0,
          wind: v.get('wind_speed') ?? null,
          gust: v.get('wind_gust') ?? null,
        },
      ];
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface DayRow {
  /** London date, YYYY-MM-DD. */
  date: string;
  /** The day's London midnight (ISO). */
  ts: string;
  code: number | null;
  max: number | null;
  min: number | null;
  rainChance: number | null;
  rainMm: number | null;
  wind: number | null;
  gust: number | null;
  /** Instants (ISO); stored as seconds after the day's London midnight. */
  sunrise: string | null;
  sunset: string | null;
}

/** The daily forecast (`forecast_day_*`), one row per London day, in order. */
export function dailyRows(series: readonly Series[]): DayRow[] {
  const at = (ts: string, seconds: number | undefined) =>
    seconds === undefined ? null : new Date(Date.parse(ts) + seconds * 1000).toISOString();
  return [...byTime(series, 'forecast_day_')]
    .map(([ts, v]) => ({
      date: londonDateString(new Date(ts)),
      ts,
      code: v.get('weather_code') ?? null,
      max: v.get('temperature_max') ?? null,
      min: v.get('temperature_min') ?? null,
      rainChance: v.get('precipitation_probability') ?? null,
      rainMm: v.get('precipitation') ?? null,
      wind: v.get('wind_speed_max') ?? null,
      gust: v.get('wind_gust_max') ?? null,
      sunrise: at(ts, v.get('sunrise')),
      sunset: at(ts, v.get('sunset')),
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** The worst forecast DAQI on each London day (from `forecast_daqi` points). */
export function daqiByDay(points: readonly (readonly [string, number])[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [ts, index] of points) {
    const day = londonDateString(new Date(ts));
    out.set(day, Math.max(out.get(day) ?? 0, index));
  }
  return out;
}

export type PressureTrend = 'rising_fast' | 'rising' | 'steady' | 'falling' | 'falling_fast';
export const PRESSURE_TREND_LABELS: Record<PressureTrend, string> = {
  rising_fast: 'Rising fast',
  rising: 'Rising',
  steady: 'Steady',
  falling: 'Falling',
  falling_fast: 'Falling fast',
};

/**
 * How pressure moved over the last 3 hours (points oldest first): steady within 1 hPa, "fast"
 * from 3.5 hPa (the usual tendency thresholds). Null without 2½ hours of history.
 */
export function pressureTrend(
  points: readonly (readonly [string, number])[],
): { trend: PressureTrend; change: number } | null {
  const last = points.at(-1);
  if (!last) return null;
  const end = Date.parse(last[0]);
  const before = [...points].reverse().find(([ts]) => end - Date.parse(ts) >= 3 * 3600_000);
  const earliest = before ?? points[0]!;
  if (end - Date.parse(earliest[0]) < 2.5 * 3600_000) return null;
  const change = Math.round((last[1] - earliest[1]) * 10) / 10;
  const size = Math.abs(change);
  const trend: PressureTrend =
    size < 1
      ? 'steady'
      : change > 0
        ? size >= 3.5
          ? 'rising_fast'
          : 'rising'
        : size >= 3.5
          ? 'falling_fast'
          : 'falling';
  return { trend, change };
}

export const DAQI_TONE: Record<DaqiLevel, Tone> = {
  low: 'good',
  moderate: 'warn',
  high: 'bad',
  very_high: 'bad',
};

/** "Low · 2". */
export function daqiText(index: number): string {
  return `${DAQI_LABELS[daqiLevel(index)]} · ${index}`;
}
