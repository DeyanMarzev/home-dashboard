import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { floorFor, notChargingMessage, parseRoborockSnapshot } from './parse.js';

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

  it('reports the state code now, next to the battery', () => {
    expect(readings.find((r) => r.metric === 'state')).toMatchObject({
      entity: 'vacuum',
      valueType: 'state',
      value: 8,
      ts: now,
    });
  });

  it('gives only valid readings', () => {
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('treats map_flag -1, null or missing as no map, and a missing area as unknown', () => {
    const run = { begin: 1792540000, duration: 600 };
    const parsed = parseRoborockSnapshot(
      {
        records: [
          { ...run, area: 5_000_000, map_flag: -1 },
          { ...run, begin: run.begin + 1000, map_flag: null },
          { ...run, begin: run.begin + 2000, area: null },
        ],
      },
      now,
    );
    expect(parsed.skipped).toBe(0);
    expect(parsed.readings.map((r) => [r.metric, r.entity])).toEqual([
      ['clean_minutes', 'no_map'],
      ['clean_area', 'no_map'],
      ['clean_minutes', 'no_map'],
      ['clean_minutes', 'no_map'],
    ]);
  });

  it('skips records in another shape instead of failing the run, saying which field', () => {
    const odd = parseRoborockSnapshot({ ...snapshot, records: [[1, 2, 3], { begin: 'x' }] }, now);
    expect(odd.skipped).toBe(2);
    expect(odd.problems).toContain('begin: Invalid input: expected number, received string');
    expect(odd.readings.map((r) => r.metric)).toEqual(['battery', 'state']);
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

describe('notChargingMessage', () => {
  const withStatus = (status: Record<string, number>) =>
    parseRoborockSnapshot({ ...snapshot, status }, now).readings;

  it('is quiet while the robot charges, is full or is cleaning', () => {
    expect(notChargingMessage(withStatus({ state: 8, battery: 40 }), now)).toBeNull();
    expect(notChargingMessage(withStatus({ state: 100, battery: 100 }), now)).toBeNull();
    expect(notChargingMessage(withStatus({ state: 5, battery: 60 }), now)).toBeNull();
  });

  it('warns when the robot sits off its dock, with its state, the time and the battery', () => {
    expect(notChargingMessage(withStatus({ state: 3, battery: 63 }), now)).toBe(
      "Vacuum isn't charging · Idle at 12:00, battery 63%. Check it's on its dock",
    );
    expect(notChargingMessage(withStatus({ state: 9 }), now)).toBe(
      "Vacuum isn't charging · Charging problem at 12:00. Check it's on its dock",
    );
  });

  it("doesn't decide when the robot gave no state or an unknown one", () => {
    expect(notChargingMessage(withStatus({ battery: 50 }), now)).toBeUndefined();
    expect(notChargingMessage(withStatus({ state: 77 }), now)).toBeNull();
  });
});
