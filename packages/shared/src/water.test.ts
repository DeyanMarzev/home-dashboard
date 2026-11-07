import { describe, expect, it } from 'vitest';
import { leakStatus, nightLabel, nightMinimums, waterDayPence } from './water.js';

// Hourly points for London nights (November = GMT, so London hour = UTC hour).
const hours = (date: string, values: number[]) =>
  values.map((v, h) => [`${date}T${String(h).padStart(2, '0')}:00:00.000Z`, v] as const);

describe('nightMinimums', () => {
  it('takes the quietest hour between 00:00 and 05:00 of each night', () => {
    const nights = nightMinimums([
      ...hours('2026-11-02', [3, 0, 0, 2, 0, 9, 40]),
      ...hours('2026-11-03', [4, 2, 2, 3, 6]),
    ]);
    expect(nights).toEqual([
      { night: '2026-11-02', minLitres: 0, complete: true },
      { night: '2026-11-03', minLitres: 2, complete: true },
    ]);
  });

  it('uses London hours in summer (00:00 BST is 23:00 UTC)', () => {
    const nights = nightMinimums([
      ['2026-07-01T23:00:00.000Z', 5],
      ['2026-07-02T03:00:00.000Z', 1],
      ['2026-07-02T04:00:00.000Z', 30],
    ]);
    expect(nights).toEqual([{ night: '2026-07-02', minLitres: 1, complete: false }]);
  });
});

describe('leakStatus', () => {
  const night = (n: number, minLitres: number, complete = true) => ({
    night: `2026-11-0${n}`,
    minLitres,
    complete,
  });

  it('is ok when the latest night had no flow', () => {
    expect(leakStatus([night(1, 3), night(2, 0)])).toEqual({
      state: 'ok',
      consecutive: 0,
      nightsChecked: 2,
    });
  });

  it('watches one or two nights of flow, and alerts on three in a row', () => {
    expect(leakStatus([night(1, 0), night(2, 2), night(3, 1)])).toMatchObject({
      state: 'watch',
      consecutive: 2,
    });
    expect(leakStatus([night(1, 0), night(2, 2), night(3, 1), night(4, 4)])).toMatchObject({
      state: 'leak',
      consecutive: 3,
    });
  });

  it('ignores incomplete nights, and is unknown without any', () => {
    expect(leakStatus([night(1, 2), night(2, 2), night(3, 2), night(4, 0, false)])).toMatchObject({
      state: 'leak',
      nightsChecked: 3,
    });
    expect(leakStatus([])).toEqual({ state: 'unknown', consecutive: 0, nightsChecked: 0 });
  });
});

describe('nightLabel', () => {
  it('names the night by both dates', () => {
    expect(nightLabel('2026-11-03')).toBe('2–3 Nov');
    expect(nightLabel('2026-11-01')).toBe('31 Oct–1 Nov');
  });
});

describe('waterDayPence', () => {
  it('prices litres per m³ plus the standing charge', () => {
    // 312 L at 400 p/m³ = 124.8 p, plus 30 p a day.
    expect(waterDayPence(312, { unitRatePence: 400, standingPence: 30 })).toBe(155);
  });
});
