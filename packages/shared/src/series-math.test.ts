import { describe, expect, it } from 'vitest';
import {
  averageByWindow,
  averageSeries,
  lowestWindow,
  secondsAbove,
  stats,
} from './series-math.js';

const p = (minutes: number, v: number): [string, number] => [
  new Date(Date.UTC(2026, 10, 6, 0, minutes)).toISOString(),
  v,
];

describe('stats', () => {
  it('finds min, max and average', () => {
    expect(stats([p(0, 18), p(5, 21), p(10, 20)])).toEqual({ min: 18, max: 21, avg: 59 / 3 });
    expect(stats([])).toBeNull();
  });
});

describe('secondsAbove', () => {
  it('counts buckets strictly above the threshold', () => {
    expect(secondsAbove([p(0, 900), p(5, 1000), p(10, 1100), p(15, 1300)], 1000, 300)).toBe(600);
  });
});

describe('averageSeries', () => {
  it('averages aligned buckets, tolerating gaps', () => {
    expect(averageSeries([[p(0, 20), p(5, 21)], [p(0, 18)]])).toEqual([p(0, 19), p(5, 21)]);
  });
});

describe('averageByWindow', () => {
  it('averages into fixed windows', () => {
    expect(averageByWindow([p(0, 100), p(30, 200), p(120, 50)], 7200)).toEqual([
      p(0, 150),
      p(120, 50),
    ]);
  });
});

describe('lowestWindow', () => {
  it('finds the run of points with the lowest average', () => {
    const points = [300, 280, 150, 120, 110, 130, 260, 290].map((v, i) => p(i * 30, v));
    expect(lowestWindow(points, 3, 1800)).toEqual({
      from: p(90, 0)[0],
      to: p(180, 0)[0],
      avg: 120,
    });
  });

  it('needs enough points', () => {
    expect(lowestWindow([p(0, 1)], 2, 1800)).toBeNull();
  });
});
