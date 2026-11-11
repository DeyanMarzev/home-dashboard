import { readFileSync } from 'node:fs';
import { ReadingInputSchema } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { parseOpenMeteo } from './parse.js';

// Recorded from Open-Meteo for central London (51.50, −0.12) at 19:00 UTC on 11 Nov 2026.
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/forecast-2026-11-11.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const iso = (d: Date | string) => new Date(d).toISOString();

describe('parseOpenMeteo', () => {
  const readings = parseOpenMeteo(fixture);
  const of = (metric: string) => readings.filter((r) => r.metric === metric);

  it('reads current conditions at the time Open-Meteo gives (unixtime → UTC)', () => {
    const current = readings.filter((r) => !r.metric.startsWith('forecast_'));
    expect(Object.fromEntries(current.map((r) => [r.metric, [r.value, r.unit]]))).toEqual({
      temperature: [9.7, '°C'],
      humidity: [80, '%'],
      apparent_temperature: [7.7, '°C'],
      precipitation: [0, 'mm'],
      weather_code: [3, 'wmo'],
      cloud_cover: [99, '%'],
      pressure: [1004.4, 'hPa'],
      wind_speed: [6.8, 'km/h'],
      wind_direction: [22, '°'],
      wind_gust: [14.8, 'km/h'],
      is_day: [0, 'flag'],
    });
    for (const r of current) {
      expect(iso(r.ts)).toBe('2026-11-11T19:00:00.000Z');
      expect(r.entity).toBe('outdoor');
    }
    expect(of('weather_code')[0]?.valueType).toBe('state');
  });

  it('stores the next 24 hours as hourly forecast_* series', () => {
    for (const metric of [
      'forecast_temperature',
      'forecast_precipitation_probability',
      'forecast_weather_code',
      'forecast_wind_speed',
      'forecast_wind_gust',
      'forecast_is_day',
    ]) {
      const series = of(metric);
      expect(series, metric).toHaveLength(24);
      const times = series.map((r) => new Date(r.ts).getTime());
      expect(times.every((t, i) => i === 0 || t - times[i - 1]! === 3600_000)).toBe(true);
    }
  });

  it('stores 7 daily forecasts at London midnight, sunrise and sunset as seconds after it', () => {
    const highs = of('forecast_day_temperature_max');
    expect(highs.map((r) => iso(r.ts).slice(0, 10))).toEqual([
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
    ]);
    expect(iso(highs[0]!.ts)).toBe('2026-11-11T00:00:00.000Z'); // GMT in November
    expect(highs[0]?.value).toBe(10.2);
    expect(of('forecast_day_temperature_min')[0]?.value).toBe(8.3);
    expect(of('forecast_day_weather_code')[0]?.value).toBe(53);
    expect(of('forecast_day_precipitation_probability')[0]?.value).toBe(99);
    expect(of('forecast_day_wind_gust_max')[1]?.value).toBe(37.4);
    expect(of('forecast_day_sunrise')[0]?.value).toBe(25_895); // 07:11:35
    expect(of('forecast_day_sunset')[0]?.value).toBe(58_617); // 16:16:57
  });

  it('produces readings that pass validation', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('refuses a response in other units', () => {
    const changed = structuredClone(fixture) as {
      current_units: Record<string, string>;
      daily_units: Record<string, string>;
    };
    changed.current_units.temperature_2m = '°F';
    expect(() => parseOpenMeteo(changed)).toThrow(/current temperature_2m in "°F"/);
    const iso8601 = structuredClone(fixture) as { daily_units: Record<string, string> };
    iso8601.daily_units.sunrise = 'iso8601';
    expect(() => parseOpenMeteo(iso8601)).toThrow(/daily sunrise in "iso8601"/);
  });

  it('refuses a response missing fields', () => {
    const broken = structuredClone(fixture) as { current: Record<string, unknown> };
    delete broken.current.pressure_msl;
    expect(() => parseOpenMeteo(broken)).toThrow(/no current pressure_msl/);
  });
});
