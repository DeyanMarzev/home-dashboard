import type { ReadingInput } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { chunk, latestPerSeries, prepareBatch, ReadingBatchError } from './batch.js';

const temp = (ts: string, value: number, entity = 'kitchen'): ReadingInput => ({
  metric: 'temperature',
  entity,
  unit: '°C',
  valueType: 'gauge',
  ts,
  value,
});

describe('prepareBatch', () => {
  it('groups readings into series specs and rows', () => {
    const batch = prepareBatch([
      temp('2026-11-06T13:00:00Z', 20.1),
      temp('2026-11-06T13:00:30Z', 20.2),
      temp('2026-11-06T13:00:00Z', 18.5, 'bedroom'),
      {
        metric: 'energy_import',
        entity: 'electricity',
        unit: 'kWh',
        valueType: 'interval_total',
        interval: '30m',
        ts: '2026-11-05T23:30:00Z',
        value: 0.17,
      },
    ]);
    expect(batch.series).toEqual([
      {
        key: 'temperature|kitchen',
        metric: 'temperature',
        entity: 'kitchen',
        unit: '°C',
        valueType: 'gauge',
        intervalSeconds: null,
        label: null,
      },
      {
        key: 'temperature|bedroom',
        metric: 'temperature',
        entity: 'bedroom',
        unit: '°C',
        valueType: 'gauge',
        intervalSeconds: null,
        label: null,
      },
      {
        key: 'energy_import|electricity',
        metric: 'energy_import',
        entity: 'electricity',
        unit: 'kWh',
        valueType: 'interval_total',
        intervalSeconds: 1800,
        label: null,
      },
    ]);
    expect(batch.rows).toHaveLength(4);
  });

  it('keeps the last value when a timestamp repeats', () => {
    const batch = prepareBatch([
      temp('2026-11-06T13:00:00Z', 20.1),
      temp('2026-11-06T13:00:00.000Z', 20.4),
    ]);
    expect(batch.rows).toEqual([
      { key: 'temperature|kitchen', ts: new Date('2026-11-06T13:00:00Z'), value: 20.4 },
    ]);
  });

  it('treats the same instant in different offsets as the same timestamp', () => {
    const batch = prepareBatch([
      temp('2026-07-06T13:00:00Z', 1),
      temp('2026-07-06T14:00:00+01:00', 2),
    ]);
    expect(batch.rows).toHaveLength(1);
  });

  it('rejects an invalid reading, saying which one', () => {
    expect(() =>
      prepareBatch([temp('2026-11-06T13:00:00Z', 1), temp('2026-11-06T13:00:00', 2)]),
    ).toThrow(/Reading 1 is invalid: ts/);
  });

  it('rejects one series with two units in the same batch', () => {
    expect(() =>
      prepareBatch([
        temp('2026-11-06T13:00:00Z', 1),
        { ...temp('2026-11-06T13:01:00Z', 70), unit: '°F' },
      ]),
    ).toThrow(ReadingBatchError);
  });

  it('accepts an empty batch', () => {
    expect(prepareBatch([])).toEqual({ series: [], rows: [] });
  });
});

describe('latestPerSeries', () => {
  it('picks the newest row of each series regardless of order', () => {
    const { rows } = prepareBatch([
      temp('2026-11-06T13:01:00Z', 2),
      temp('2026-11-06T13:00:00Z', 1),
      temp('2026-11-06T12:00:00Z', 9, 'bedroom'),
    ]);
    expect(latestPerSeries(rows).map((r) => r.value)).toEqual([2, 9]);
  });
});

describe('chunk', () => {
  it('splits into fixed-size parts', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
