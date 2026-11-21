import type { LatestItem, ReadingsResponse, SeriesMeta } from '@home/shared';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  floorStyle,
  floorsByDay,
  formatMinutes,
  formatMonth,
  monthBounds,
  monthWeeks,
  runsOfDay,
  vacuumNow,
} from './vacuum.js';

const meta = (id: number, metric: string, entity: string, label?: string): SeriesMeta => ({
  id,
  sourceId: 'roborock',
  metric,
  entity,
  unit: metric === 'clean_area' ? 'm²' : 'min',
  valueType: 'gauge',
  ...(label ? { label } : {}),
});
const freshness = {
  state: 'live',
  dataTo: null,
  intervalSeconds: null,
  lagSeconds: null,
  daysBehind: null,
  label: '',
  compactLabel: '',
} as const;
const response = (
  series: { meta: SeriesMeta; points: [string, number][] }[],
): ReadingsResponse => ({
  from: '',
  to: '',
  bucket: '1d',
  series: series.map((s) => ({ ...s, freshness })),
  freshness,
});

describe('vacuum calendar helpers', () => {
  it('lays a month out in Monday-first weeks', () => {
    const weeks = monthWeeks('2026-11'); // 1 Nov 2026 is a Sunday
    expect(weeks[0]).toEqual([null, null, null, null, null, null, '2026-11-01']);
    expect(weeks.at(-1)).toEqual(['2026-11-30', null, null, null, null, null, null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it('steps months and gives London bounds (BST in October)', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    const { from, to } = monthBounds('2026-10');
    expect(from.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(formatMonth('2026-11')).toBe('November 2026');
  });

  it('groups daily minutes by London day, floors in a fixed order', () => {
    const days = floorsByDay(
      response([
        {
          meta: meta(3, 'clean_minutes', 'no_map', 'No map'),
          points: [['2026-10-24T23:00:00Z', 1.6]],
        },
        {
          meta: meta(1, 'clean_minutes', 'top_floor', 'Top floor'),
          points: [['2026-10-24T23:00:00Z', 21.7]],
        },
        {
          meta: meta(2, 'clean_minutes', 'ground_floor'),
          points: [
            ['2026-10-24T23:00:00Z', 30.2],
            ['2026-10-25T23:00:00Z', 0],
          ],
        },
      ]),
    );
    expect(days.get('2026-10-25')?.map((f) => [f.entity, f.label])).toEqual([
      ['ground_floor', 'Ground floor'],
      ['top_floor', 'Top floor'],
      ['no_map', 'No map'],
    ]);
    expect(days.has('2026-10-26')).toBe(false);
  });

  it('pairs each run with its area', () => {
    const runs = runsOfDay(
      response([
        { meta: meta(1, 'clean_minutes', 'top_floor'), points: [['2026-10-24T10:15:00Z', 21.7]] },
        {
          meta: meta(2, 'clean_minutes', 'ground_floor'),
          points: [['2026-10-24T09:05:00Z', 30.2]],
        },
        { meta: meta(4, 'clean_area', 'ground_floor'), points: [['2026-10-24T09:05:00Z', 33.4]] },
      ]),
    );
    expect(runs.map((r) => [r.entity, r.minutes, r.areaM2])).toEqual([
      ['ground_floor', 30.2, 33.4],
      ['top_floor', 21.7, null],
    ]);
  });

  it('colours the three floors, greys runs without a map and hatches other maps', () => {
    expect(floorStyle('ground_floor')).toEqual({ kind: 'solid', colour: 'var(--floor-ground)' });
    expect(floorStyle('no_map')).toEqual({ kind: 'solid', colour: 'var(--floor-none)' });
    expect(floorStyle('map_2')).toEqual({ kind: 'other' });
  });

  it('formats durations', () => {
    expect(formatMinutes(21.7)).toBe('22 min');
    expect(formatMinutes(65)).toBe('1 h 05 min');
  });
});

describe('vacuumNow', () => {
  const item = (
    id: number,
    metric: string,
    value: number | null,
    ts: string | null,
  ): LatestItem => ({
    series: { ...meta(id, metric, 'vacuum'), unit: metric === 'battery' ? '%' : 'code' },
    ts,
    value,
    freshness,
  });

  it("reads the robot's battery and state, as of the newer reading", () => {
    expect(
      vacuumNow([
        item(1, 'clean_minutes', 20, '2026-11-20T09:00:00Z'),
        item(2, 'battery', 63, '2026-11-21T10:00:00Z'),
        item(3, 'state', 3, '2026-11-21T10:00:01Z'),
      ]),
    ).toEqual({
      battery: 63,
      state: { label: 'Idle', place: 'stranded' },
      ts: '2026-11-21T10:00:01Z',
    });
  });

  it('copes with only one of them, and with none', () => {
    expect(vacuumNow([item(2, 'battery', 87, '2026-11-21T10:00:00Z')])).toMatchObject({
      battery: 87,
      state: null,
    });
    expect(vacuumNow([item(2, 'battery', null, null)])).toBeNull();
    expect(vacuumNow(undefined)).toBeNull();
  });
});
