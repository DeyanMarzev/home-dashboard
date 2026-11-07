import type { EnergyDay } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { dayLabel, dayPence, sumDays, weekdayLabel } from './energy.js';

const day = (e: number | null, g: number | null): EnergyDay => ({
  date: '2026-11-05',
  electricity: { kwh: 9.7, energyPence: e, standingPence: 61 },
  gas: g === null ? null : { kwh: 32, energyPence: g, standingPence: 32 },
  complete: true,
  outdoorC: 9,
  degreeDays: 6.5,
});

describe('energy view helpers', () => {
  it('adds up a day with or without standing charges', () => {
    expect(dayPence(day(238, 202), true)).toBe(238 + 61 + 202 + 32);
    expect(dayPence(day(238, 202), false)).toBe(440);
    expect(dayPence(day(238, null), false)).toBe(238); // no gas data that day
  });

  it('has no cost when a fuel with data has no tariff', () => {
    expect(dayPence(day(null, 202), true)).toBeNull();
  });

  it('labels dates and sums days', () => {
    expect(dayLabel('2026-11-05')).toBe('5 Nov');
    expect(weekdayLabel('2026-11-05')).toBe('Thu 5 Nov');
    expect(sumDays([day(1, 2), day(3, null)], (d) => d.gas?.kwh)).toBe(32);
  });
});
