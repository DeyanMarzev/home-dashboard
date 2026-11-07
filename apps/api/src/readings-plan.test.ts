import { MAX_POINTS } from '@home/shared';
import { describe, expect, it } from 'vitest';
import {
  chooseAggregate,
  chooseBucket,
  MAX_RANGE_SECONDS,
  smallestFitting,
} from './readings-plan.js';

const H = 3600;
const D = 86400;

describe('chooseBucket', () => {
  it.each([
    [1 * H, 'raw'],
    [2 * H, 'raw'],
    [3 * H, '5m'],
    [24 * H, '5m'], // 288 points
    [50 * H, '5m'], // 600 points exactly
    [51 * H, '15m'],
    [7 * D, '1h'], // 168 points
    [25 * D, '1h'], // 600 points exactly
    [30 * D, '1d'],
    [365 * D, '1d'],
  ])('defaults a %i s range to %s', (range, bucket) => {
    expect(chooseBucket(undefined, range)).toBe(bucket);
  });

  it('honours a request that fits', () => {
    expect(chooseBucket('raw', 48 * H)).toBe('raw');
    expect(chooseBucket('1h', 1 * H)).toBe('1h');
    expect(chooseBucket('1d', 7 * D)).toBe('1d');
  });

  it('coarsens a request that would exceed the point limit, never finer than asked', () => {
    expect(chooseBucket('raw', 49 * H)).toBe('5m');
    expect(chooseBucket('raw', 7 * D)).toBe('1h');
    expect(chooseBucket('5m', 7 * D)).toBe('1h');
    expect(chooseBucket('15m', 30 * D)).toBe('1d');
  });

  it('keeps every choice within MAX_POINTS up to the longest range', () => {
    for (const range of [H, 13 * H, 3 * D, 20 * D, 100 * D, MAX_RANGE_SECONDS]) {
      const b = chooseBucket(undefined, range);
      if (b !== 'raw')
        expect(range / { '5m': 300, '15m': 900, '1h': H, '1d': D }[b]).toBeLessThanOrEqual(
          MAX_POINTS,
        );
    }
  });
});

describe('smallestFitting', () => {
  it('finds the finest bucket within the limit', () => {
    expect(smallestFitting(24 * H)).toBe('5m');
    expect(smallestFitting(24 * H, '1h')).toBe('1h');
  });
});

describe('chooseAggregate', () => {
  it('sums interval totals and averages the rest on auto', () => {
    expect(chooseAggregate('auto', 'interval_total')).toBe('sum');
    expect(chooseAggregate('auto', 'gauge')).toBe('avg');
    expect(chooseAggregate('auto', 'state')).toBe('avg');
  });

  it('respects an explicit choice', () => {
    expect(chooseAggregate('max', 'gauge')).toBe('max');
  });
});
