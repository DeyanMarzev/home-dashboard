import { describe, expect, it } from 'vitest';
import {
  daysUntilFull,
  decodeThrottle,
  describeDays,
  piStatus,
  throttleSummary,
} from './pi-health.js';

describe('decodeThrottle', () => {
  it('reads nothing from 0', () => {
    expect(decodeThrottle(0).every((f) => !f.now && !f.sinceBoot)).toBe(true);
    expect(throttleSummary(0)).toBe('None');
  });

  it('reads 0x50005: under-voltage and throttled, now and since boot', () => {
    const flags = decodeThrottle(0x50005);
    expect(flags.filter((f) => f.now).map((f) => f.key)).toEqual(['under_voltage', 'throttled']);
    expect(flags.filter((f) => f.sinceBoot).map((f) => f.key)).toEqual([
      'under_voltage',
      'throttled',
    ]);
    expect(throttleSummary(0x50005)).toBe('Under-voltage, Throttled now');
  });

  it('reads past-only flags (0x10000: under-voltage occurred since boot)', () => {
    expect(throttleSummary(0x10000)).toBe('Since boot: under-voltage');
  });
});

describe('daysUntilFull', () => {
  it('projects from the growth between the first and last point', () => {
    // 0.1 GB a day, 17.4 GB free → 174 days
    expect(
      daysUntilFull(
        [
          ['2026-10-30T00:00:00Z', 11.4],
          ['2026-11-06T00:00:00Z', 12.1],
        ],
        17.4,
      ),
    ).toBeCloseTo(174, 0);
  });

  it('is null when not growing or with too little history', () => {
    expect(
      daysUntilFull(
        [
          ['2026-10-30T00:00:00Z', 12.1],
          ['2026-11-06T00:00:00Z', 12.0],
        ],
        17.4,
      ),
    ).toBeNull();
    expect(daysUntilFull([['2026-11-06T00:00:00Z', 12.1]], 17.4)).toBeNull();
    expect(
      daysUntilFull(
        [
          ['2026-11-06T00:00:00Z', 12.1],
          ['2026-11-06T01:00:00Z', 12.2],
        ],
        17.4,
      ),
    ).toBeNull();
  });
});

describe('describeDays', () => {
  it.each([
    [1900, 'about 5 years'],
    [174, 'about 6 months'],
    [12.4, 'about 12 days'],
    [0.2, 'about 1 days'],
  ])('%s → %s', (days, text) => {
    expect(describeDays(days)).toBe(text);
  });
});

describe('piStatus', () => {
  const ok = { cpuC: 52, throttleMask: 0, diskUsedPercents: [41, 12] };
  it('is healthy in normal conditions', () => {
    expect(piStatus(ok)).toBe('healthy');
  });
  it('warns on heat, past throttling or a filling disk', () => {
    expect(piStatus({ ...ok, cpuC: 72 })).toBe('warning');
    expect(piStatus({ ...ok, throttleMask: 0x10000 })).toBe('warning');
    expect(piStatus({ ...ok, diskUsedPercents: [86] })).toBe('warning');
  });
  it('is a problem when throttling now, at 80 °C or a nearly full disk', () => {
    expect(piStatus({ ...ok, throttleMask: 0x1 })).toBe('problem');
    expect(piStatus({ ...ok, cpuC: 80 })).toBe('problem');
    expect(piStatus({ ...ok, diskUsedPercents: [96] })).toBe('problem');
  });
  it('copes with missing readings (not a Pi)', () => {
    expect(piStatus({ cpuC: null, throttleMask: null, diskUsedPercents: [] })).toBe('healthy');
  });
});
