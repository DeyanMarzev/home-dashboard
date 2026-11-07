import { describe, expect, it } from 'vitest';
import { averageLitres, peakHour } from './water.js';

describe('water view helpers', () => {
  it('averages complete days only', () => {
    expect(
      averageLitres([
        { date: '2026-11-01', litres: 300, costPence: null, complete: true },
        { date: '2026-11-02', litres: 320, costPence: null, complete: true },
        { date: '2026-11-03', litres: 40, costPence: null, complete: false },
      ]),
    ).toBe(310);
    expect(averageLitres([])).toBeNull();
  });

  it('finds the peak hour in London time', () => {
    expect(
      peakHour([
        ['2026-11-03T06:00:00.000Z', 20],
        ['2026-11-03T07:00:00.000Z', 52],
        ['2026-11-03T08:00:00.000Z', 30],
      ]),
    ).toEqual({ litres: 52, at: '07:00' });
    expect(peakHour([])).toBeNull();
  });
});
