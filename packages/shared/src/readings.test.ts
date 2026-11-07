import { describe, expect, it } from 'vitest';
import { ReadingInputSchema } from './readings.js';

const gauge = {
  metric: 'temperature',
  entity: 'living_room',
  unit: '°C',
  valueType: 'gauge',
  ts: '2026-11-06T13:41:00Z',
  value: 20.6,
};

describe('ReadingInputSchema', () => {
  it('normalises a gauge reading', () => {
    expect(ReadingInputSchema.parse(gauge)).toEqual({
      ...gauge,
      ts: new Date('2026-11-06T13:41:00Z'),
    });
  });

  it('defaults entity to empty', () => {
    const { entity: _entity, ...rest } = gauge;
    expect(ReadingInputSchema.parse(rest).entity).toBe('');
  });

  it('accepts Date and offset timestamps', () => {
    expect(
      ReadingInputSchema.parse({ ...gauge, ts: new Date('2026-11-06T13:41:00Z') }).ts.toISOString(),
    ).toBe('2026-11-06T13:41:00.000Z');
    expect(
      ReadingInputSchema.parse({ ...gauge, ts: '2026-07-06T14:41:00+01:00' }).ts.toISOString(),
    ).toBe('2026-07-06T13:41:00.000Z');
  });

  it('rejects timestamps without a zone (ambiguous)', () => {
    expect(ReadingInputSchema.safeParse({ ...gauge, ts: '2026-11-06T13:41:00' }).success).toBe(
      false,
    );
  });

  it('rejects invalid dates and non-finite values', () => {
    expect(ReadingInputSchema.safeParse({ ...gauge, ts: new Date('nope') }).success).toBe(false);
    expect(ReadingInputSchema.safeParse({ ...gauge, value: Number.NaN }).success).toBe(false);
    expect(ReadingInputSchema.safeParse({ ...gauge, value: Infinity }).success).toBe(false);
  });

  it('requires an interval for interval_total, in seconds', () => {
    const total = {
      metric: 'energy_import',
      entity: 'electricity',
      unit: 'kWh',
      valueType: 'interval_total',
      ts: '2026-11-05T23:30:00Z',
      value: 0.17,
    };
    expect(ReadingInputSchema.safeParse(total).success).toBe(false);
    expect(ReadingInputSchema.parse({ ...total, interval: '30m' }).interval).toBe(1800);
  });

  it('rejects an interval on a gauge', () => {
    expect(ReadingInputSchema.safeParse({ ...gauge, interval: '30m' }).success).toBe(false);
  });

  it('rejects non-snake_case keys', () => {
    expect(ReadingInputSchema.safeParse({ ...gauge, metric: 'Temperature' }).success).toBe(false);
    expect(ReadingInputSchema.safeParse({ ...gauge, entity: 'living room' }).success).toBe(false);
  });
});
