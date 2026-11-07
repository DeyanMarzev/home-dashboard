import { describe, expect, it } from 'vitest';
import {
  dayCost,
  formatPounds,
  gasKwhFromM3,
  halfHourKwhToWatts,
  heatingDegreeDays,
  linearFit,
  projectMonth,
  relativeChange,
  tariffOn,
  yearlyPenceForWatts,
} from './energy.js';

const tariffs = [
  {
    fuel: 'electricity' as const,
    unitRatePence: 24.5,
    standingPence: 60.97,
    validFrom: '2026-04-01',
    validTo: '2026-09-30',
  },
  {
    fuel: 'electricity' as const,
    unitRatePence: 26.1,
    standingPence: 51.2,
    validFrom: '2026-10-01',
    validTo: null,
  },
  {
    fuel: 'gas' as const,
    unitRatePence: 6.3,
    standingPence: 31.65,
    validFrom: '2026-10-01',
    validTo: null,
  },
];

describe('tariffOn', () => {
  it('finds the period covering a date, inclusive at both ends', () => {
    expect(tariffOn(tariffs, 'electricity', '2026-09-30')?.unitRatePence).toBe(24.5);
    expect(tariffOn(tariffs, 'electricity', '2026-10-01')?.unitRatePence).toBe(26.1);
    expect(tariffOn(tariffs, 'electricity', '2030-01-01')?.unitRatePence).toBe(26.1);
  });

  it('is null when no period covers it', () => {
    expect(tariffOn(tariffs, 'gas', '2026-09-30')).toBeNull();
    expect(tariffOn(tariffs, 'water', '2026-11-01')).toBeNull();
  });
});

describe('dayCost', () => {
  it('rounds energy and standing charge to whole pence', () => {
    expect(dayCost(9.7, { unitRatePence: 24.5, standingPence: 60.97 })).toEqual({
      energyPence: 238,
      standingPence: 61,
    });
  });
});

describe('conversions', () => {
  it('converts gas m³ to kWh with the volume correction and calorific value', () => {
    expect(gasKwhFromM3(1)).toBeCloseTo(11.22, 2);
    expect(gasKwhFromM3(3, 40)).toBeCloseTo(34.09, 2);
  });

  it('turns the lowest half-hour into watts and a yearly cost', () => {
    expect(halfHourKwhToWatts(0.084)).toBe(168);
    expect(yearlyPenceForWatts(168, 24.5)).toBe(36056); // ≈ £360 a year, as in the mockup
  });

  it('counts heating degree-days from 15.5 °C', () => {
    expect(heatingDegreeDays(5.5)).toBe(10);
    expect(heatingDegreeDays(18)).toBe(0);
  });
});

describe('linearFit', () => {
  it('fits gas use against outdoor temperature', () => {
    const fit = linearFit([
      [4, 38],
      [6, 33.6],
      [8, 29.2],
      [10, 24.8],
    ]);
    expect(fit?.slope).toBeCloseTo(-2.2);
    expect(fit?.intercept).toBeCloseTo(46.8);
    expect(fit?.r2).toBeCloseTo(1);
  });

  it('needs at least 3 points with some spread', () => {
    expect(
      linearFit([
        [1, 1],
        [2, 2],
      ]),
    ).toBeNull();
    expect(
      linearFit([
        [5, 1],
        [5, 2],
        [5, 3],
      ]),
    ).toBeNull();
  });
});

describe('other helpers', () => {
  it('computes relative change and month projections', () => {
    expect(relativeChange(71.3, 72.7)).toBeCloseTo(0.0196, 3);
    expect(relativeChange(0, 5)).toBeNull();
    expect(projectMonth(2332, 5, 30)).toBeCloseTo(13992);
    expect(projectMonth(0, 0, 30)).toBeNull();
  });

  it('formats pounds', () => {
    expect(formatPounds(439)).toBe('£4.39');
    expect(formatPounds(1399200, 0)).toBe('£13,992');
  });
});
