import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { floorFor, parseRoborockSnapshot } from './parse.js';

const snapshot = JSON.parse(
  readFileSync(new URL('./__fixtures__/snapshot.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const now = new Date('2026-10-25T12:00:00Z');

describe('parseRoborockSnapshot', () => {
  const { readings, skipped } = parseRoborockSnapshot(snapshot, now);
  const minutes = readings.filter((r) => r.metric === 'clean_minutes');

  it('turns each run into minutes and area on its floor, at the run start', () => {
    expect(minutes.map((r) => [r.entity, r.label, (r.ts as Date).toISOString(), r.value])).toEqual([
      ['top_floor', 'Top floor', '2026-10-24T10:15:00.000Z', 21.7],
      ['no_map', 'No map', '2026-10-24T09:40:00.000Z', 1.6],
      ['ground_floor', 'Ground Floor', '2026-10-24T09:05:00.000Z', 30.2],
      ['no_map', 'No map', '2026-10-21T08:50:00.000Z', 27.5],
      ['top_floor', 'Top floor', '2026-10-20T23:30:00.000Z', 20.7],
      ['map_2', 'Map 3', '2026-10-17T14:00:00.000Z', 15],
    ]);
    expect(
      readings.find((r) => r.metric === 'clean_area' && r.entity === 'ground_floor'),
    ).toMatchObject({
      unit: 'm²',
      value: 33.4,
    });
    expect(skipped).toBe(0);
  });

  it('leaves out false starts (under a minute)', () => {
    expect(minutes.some((r) => (r.ts as Date).toISOString().startsWith('2026-10-22'))).toBe(false);
  });

  it('reports the battery now, so the source stays live between runs', () => {
    expect(readings.find((r) => r.metric === 'battery')).toMatchObject({
      entity: 'vacuum',
      unit: '%',
      value: 87,
      ts: now,
    });
  });

  it('gives only valid readings', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('skips records in another shape instead of failing the run', () => {
    const odd = parseRoborockSnapshot({ ...snapshot, records: [[1, 2, 3], { begin: 'x' }] }, now);
    expect(odd.skipped).toBe(2);
    expect(odd.readings.map((r) => r.metric)).toEqual(['battery']);
  });

  it('rejects something that is not a snapshot', () => {
    expect(() => parseRoborockSnapshot({ records: 'nope' }, now)).toThrow();
  });
});

describe('floorFor', () => {
  const names = new Map([
    [0, 'Top floor'],
    [1, 'Ground Floor'],
    [3, '  '],
    [4, 'No map'],
  ]);
  it('keys floors by map name', () => {
    expect(floorFor(1, names)).toEqual({ entity: 'ground_floor', label: 'Ground Floor' });
  });
  it('has its own entity for runs without a map', () => {
    expect(floorFor(undefined, names)).toEqual({ entity: 'no_map', label: 'No map' });
  });
  it('falls back to the map number for unnamed, deleted or clashing maps', () => {
    expect(floorFor(3, names).entity).toBe('map_3');
    expect(floorFor(7, names)).toEqual({ entity: 'map_7', label: 'Map 8' });
    expect(floorFor(4, names).entity).toBe('map_4');
  });
});
