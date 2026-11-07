import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCurrent, parseForecast } from './parse.js';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as unknown;
const current = load('regional-postcode-2026-11-07.json');
const forecast = load('regional-fw48h-2026-11-07.json');

describe('parseCurrent', () => {
  const readings = parseCurrent(current);
  const ts = new Date('2026-11-07T11:30:00Z');

  it('reads intensity and its index band for the current half-hour', () => {
    expect(readings.slice(0, 2)).toEqual([
      { metric: 'intensity', entity: 'grid', unit: 'gCO₂/kWh', valueType: 'gauge', ts, value: 261 },
      expect.objectContaining({
        metric: 'intensity_index',
        entity: 'grid',
        valueType: 'state',
        ts,
        value: 4,
      }),
    ]);
  });

  it('reads the generation mix as one series per fuel', () => {
    const mix = readings.filter((r) => r.metric === 'generation_share');
    expect(mix.map((r) => r.entity)).toEqual([
      'biomass',
      'coal',
      'imports',
      'gas',
      'nuclear',
      'other',
      'hydro',
      'solar',
      'wind',
    ]);
    expect(mix.find((r) => r.entity === 'gas')?.value).toBe(62.9);
    expect(mix.reduce((sum, r) => sum + r.value, 0)).toBeCloseTo(100, 0);
  });

  it('produces readings that pass validation', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('refuses an empty response', () => {
    expect(() => parseCurrent({ data: [] })).toThrow();
    expect(() => parseCurrent({ data: [{ regionid: 13, shortname: 'London', data: [] }] })).toThrow(
      /no current period/,
    );
  });

  it('refuses an unknown index band', () => {
    const odd = structuredClone(current) as {
      data: { data: { intensity: { index: string } }[] }[];
    };
    odd.data[0]!.data[0]!.intensity.index = 'extreme';
    expect(() => parseCurrent(odd)).toThrow();
  });
});

describe('parseForecast', () => {
  const readings = parseForecast(forecast);

  it('reads 48 h of half-hourly forecasts', () => {
    expect(readings).toHaveLength(96);
    expect(readings[0]).toEqual({
      metric: 'forecast_intensity',
      entity: 'grid',
      unit: 'gCO₂/kWh',
      valueType: 'gauge',
      ts: new Date('2026-11-07T12:00:00Z'),
      value: 258,
    });
    const gaps = readings
      .slice(1)
      .map((r, i) => (r.ts as Date).getTime() - (readings[i]!.ts as Date).getTime());
    expect(new Set(gaps)).toEqual(new Set([1800_000]));
  });

  it('produces readings that pass validation', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });
});
