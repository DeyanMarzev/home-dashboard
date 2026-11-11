import { freshness, type ReadingsResponse } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { dailyRows, daqiByDay, hourlyRows, pressureTrend } from './weather.js';

type Series = ReadingsResponse['series'][number];
const f = freshness(
  { expectedDelaySeconds: 0, cadenceSeconds: 900, graceSeconds: null },
  { ts: '2026-11-11T19:00:00Z' },
  new Date('2026-11-11T19:00:00Z'),
);
let id = 1;
const series = (metric: string, points: [string, number][]): Series => ({
  meta: {
    id: id++,
    sourceId: 'open_meteo',
    metric,
    entity: 'outdoor',
    unit: '',
    valueType: 'gauge',
  },
  points,
  freshness: f,
});

describe('hourlyRows', () => {
  it('joins the hourly forecast series by time, in order', () => {
    const rows = hourlyRows([
      series('forecast_temperature', [
        ['2026-11-11T21:00:00.000Z', 8.9],
        ['2026-11-11T20:00:00.000Z', 9.4],
      ]),
      series('forecast_precipitation_probability', [['2026-11-11T20:00:00.000Z', 35]]),
      series('forecast_weather_code', [['2026-11-11T20:00:00.000Z', 61]]),
      series('forecast_is_day', [['2026-11-11T20:00:00.000Z', 0]]),
      series('forecast_wind_gust', [['2026-11-11T21:00:00.000Z', 30]]),
      series('forecast_day_temperature_max', [['2026-11-11T00:00:00.000Z', 10]]), // not hourly
    ]);
    expect(rows).toEqual([
      {
        ts: '2026-11-11T20:00:00.000Z',
        temperature: 9.4,
        rainChance: 35,
        code: 61,
        isDay: false,
        wind: null,
        gust: null,
      },
      {
        ts: '2026-11-11T21:00:00.000Z',
        temperature: 8.9,
        rainChance: null,
        code: null,
        isDay: true,
        wind: null,
        gust: 30,
      },
    ]);
  });
});

describe('dailyRows', () => {
  it('gives one row per London day, with sunrise and sunset as instants', () => {
    const [today] = dailyRows([
      series('forecast_day_temperature_max', [['2026-11-11T00:00:00.000Z', 10.2]]),
      series('forecast_day_temperature_min', [['2026-11-11T00:00:00.000Z', 8.3]]),
      series('forecast_day_weather_code', [['2026-11-11T00:00:00.000Z', 53]]),
      series('forecast_day_sunrise', [['2026-11-11T00:00:00.000Z', 25_895]]),
      series('forecast_day_sunset', [['2026-11-11T00:00:00.000Z', 58_617]]),
    ]);
    expect(today).toMatchObject({
      date: '2026-11-11',
      max: 10.2,
      min: 8.3,
      code: 53,
      sunrise: '2026-11-11T07:11:35.000Z',
      sunset: '2026-11-11T16:16:57.000Z',
    });
  });

  it('dates a summer day by its London midnight (23:00 UTC the day before)', () => {
    const [day] = dailyRows([
      series('forecast_day_temperature_max', [['2026-06-30T23:00:00.000Z', 24]]),
    ]);
    expect(day?.date).toBe('2026-07-01');
  });
});

describe('daqiByDay', () => {
  it('takes the worst hour of each London day', () => {
    const days = daqiByDay([
      ['2026-11-11T20:00:00.000Z', 2],
      ['2026-11-11T23:00:00.000Z', 4],
      ['2026-11-12T08:00:00.000Z', 3],
    ]);
    expect([...days]).toEqual([
      ['2026-11-11', 4],
      ['2026-11-12', 3],
    ]);
  });
});

describe('pressureTrend', () => {
  const hours = (values: number[]): [string, number][] =>
    values.map((v, i) => [new Date(Date.UTC(2026, 10, 11, 12 + i)).toISOString(), v]);

  it('compares with 3 hours ago', () => {
    expect(pressureTrend(hours([1010, 1009.6, 1009.3, 1009.4]))).toEqual({
      trend: 'steady',
      change: -0.6,
    });
    expect(pressureTrend(hours([1010, 1009, 1008, 1007.5]))).toEqual({
      trend: 'falling',
      change: -2.5,
    });
    expect(pressureTrend(hours([1000, 1002, 1003, 1004]))?.trend).toBe('rising_fast');
  });

  it('needs at least 2½ hours of history', () => {
    expect(pressureTrend(hours([1010, 1012]))).toBeNull();
    expect(pressureTrend([])).toBeNull();
  });
});
