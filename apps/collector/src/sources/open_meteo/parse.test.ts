import { readFileSync } from 'node:fs';
import { ReadingInputSchema } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { parseOpenMeteo } from './parse.js';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/forecast-2026-11-07.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('parseOpenMeteo', () => {
  const readings = parseOpenMeteo(fixture);

  it('reads current conditions at the time Open-Meteo gives (unixtime → UTC)', () => {
    const current = readings.filter((r) => !r.metric.startsWith('forecast_'));
    expect(current).toEqual([
      {
        metric: 'temperature',
        entity: 'outdoor',
        unit: '°C',
        valueType: 'gauge',
        ts: new Date('2026-11-07T12:00:00Z'),
        value: 9.1,
      },
      {
        metric: 'humidity',
        entity: 'outdoor',
        unit: '%',
        valueType: 'gauge',
        ts: new Date('2026-11-07T12:00:00Z'),
        value: 79,
      },
      {
        metric: 'precipitation',
        entity: 'outdoor',
        unit: 'mm',
        valueType: 'gauge',
        ts: new Date('2026-11-07T12:00:00Z'),
        value: 0,
      },
      {
        metric: 'weather_code',
        entity: 'outdoor',
        unit: 'wmo',
        valueType: 'state',
        ts: new Date('2026-11-07T12:00:00Z'),
        value: 3,
      },
      {
        metric: 'wind_speed',
        entity: 'outdoor',
        unit: 'km/h',
        valueType: 'gauge',
        ts: new Date('2026-11-07T12:00:00Z'),
        value: 2.2,
      },
    ]);
  });

  it('stores the 24 h forecast as forecast_temperature, hourly', () => {
    const forecast = readings.filter((r) => r.metric === 'forecast_temperature');
    expect(forecast).toHaveLength(24);
    const times = forecast.map((r) => (r.ts as Date).getTime());
    expect(times.every((t, i) => i === 0 || t - times[i - 1]! === 3600_000)).toBe(true);
  });

  it('produces readings that pass validation', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('refuses a response in other units', () => {
    const fahrenheit = structuredClone(fixture) as { current_units: Record<string, string> };
    fahrenheit.current_units.temperature_2m = '°F';
    expect(() => parseOpenMeteo(fahrenheit)).toThrow(/temperature_2m in "°F"/);
  });

  it('refuses a response missing fields', () => {
    const broken = structuredClone(fixture) as { current: Record<string, unknown> };
    delete broken.current.temperature_2m;
    expect(() => parseOpenMeteo(broken)).toThrow();
  });

  it('skips null forecast hours', () => {
    const gaps = structuredClone(fixture) as { hourly: { temperature_2m: (number | null)[] } };
    gaps.hourly.temperature_2m[3] = null;
    expect(parseOpenMeteo(gaps).filter((r) => r.metric === 'forecast_temperature')).toHaveLength(
      23,
    );
  });
});
