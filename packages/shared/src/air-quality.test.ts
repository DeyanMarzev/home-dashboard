import { describe, expect, it } from 'vitest';
import {
  daqiBand,
  daqiByHour,
  daqiLevel,
  daqiPollutantFromCode,
  type PollutantHour,
} from './air-quality.js';

describe('daqiBand (DEFRA bands)', () => {
  it.each([
    ['o3', 33, 1],
    ['o3', 34, 2],
    ['o3', 241, 10],
    ['no2', 67, 1],
    ['no2', 68, 2],
    ['no2', 601, 10],
    ['so2', 266, 3],
    ['so2', 267, 4],
    ['pm2_5', 11, 1],
    ['pm2_5', 11.4, 1], // rounded, as the bands are whole µg/m³
    ['pm2_5', 11.6, 2],
    ['pm2_5', 36, 4],
    ['pm2_5', 71, 10],
    ['pm10', 50, 3],
    ['pm10', 101, 10],
  ] as const)('%s %s µg/m³ → band %s', (pollutant, value, band) => {
    expect(daqiBand(pollutant, value)).toBe(band);
  });
});

describe('daqiLevel', () => {
  it('groups bands as DEFRA does', () => {
    expect([1, 3, 4, 6, 7, 9, 10].map(daqiLevel)).toEqual([
      'low',
      'low',
      'moderate',
      'moderate',
      'high',
      'high',
      'very_high',
    ]);
  });
});

describe('daqiByHour', () => {
  const hour = (i: number, values: Partial<PollutantHour['values']> = {}): PollutantHour => ({
    ts: new Date(Date.UTC(2026, 10, 11, 0) + i * 3600_000),
    values: { o3: 40, no2: 20, so2: 3, pm2_5: 8, pm10: 12, ...values },
  });

  it('needs 24 hours of history (the particle means) before the first index', () => {
    const hours = Array.from({ length: 30 }, (_, i) => hour(i));
    const out = daqiByHour(hours);
    expect(out).toHaveLength(7);
    expect(out[0]?.ts.toISOString()).toBe('2026-11-11T23:00:00.000Z');
    expect(out[0]).toMatchObject({ index: 2, pollutant: 'o3' }); // ozone 40 → band 2
  });

  it('uses the running means: one high particle hour hardly moves a 24-hour mean', () => {
    const hours = Array.from({ length: 24 }, (_, i) => hour(i, i === 23 ? { pm2_5: 80 } : {}));
    // (23 × 8 + 80) / 24 = 11 → band 1; ozone 40 → band 2 still sets the index.
    expect(daqiByHour(hours).at(-1)).toMatchObject({ index: 2, pollutant: 'o3' });
  });

  it('takes the worst pollutant, and an hourly one reacts at once', () => {
    const hours = Array.from({ length: 24 }, (_, i) => hour(i, i === 23 ? { no2: 300 } : {}));
    expect(daqiByHour(hours).at(-1)).toMatchObject({ index: 5, pollutant: 'no2' });
  });

  it('skips hours with a missing value in any averaging window', () => {
    const hours = Array.from({ length: 26 }, (_, i) => hour(i, i === 10 ? { pm10: null } : {}));
    expect(daqiByHour(hours)).toEqual([]);
  });
});

describe('daqiPollutantFromCode', () => {
  it('maps the stored codes back', () => {
    expect([1, 4, 5, 9].map(daqiPollutantFromCode)).toEqual(['o3', 'pm2_5', 'pm10', null]);
  });
});
