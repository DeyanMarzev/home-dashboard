import { freshness, type LatestItem, type SourceInfo } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { applyReading } from './live-updates.js';
import { buildRooms, valuesOf } from './rooms.js';
import { collectorStatus, describePoll } from './sources.js';

const live = freshness(
  { expectedDelaySeconds: 0, cadenceSeconds: 30, graceSeconds: null },
  { ts: '2026-11-06T13:41:00Z' },
  new Date('2026-11-06T13:41:30Z'),
);

let nextId = 1;
const item = (
  sourceId: string,
  metric: string,
  entity: string,
  value: number | null,
  ts = '2026-11-06T13:41:00Z',
): LatestItem => ({
  series: { id: nextId++, sourceId, metric, entity, unit: '', valueType: 'gauge' },
  ts: value === null ? null : ts,
  value,
  freshness: live,
});

describe('buildRooms', () => {
  const rooms = buildRooms([
    item('room_sensors', 'temperature', 'living_room', 20.6),
    item('room_sensors', 'co2', 'living_room', 780),
    item('room_sensors', 'wifi_rssi', 'living_room', -48),
    item('room_sensors', 'temperature', 'bedroom', 19.1, '2026-11-06T13:40:00Z'),
    item('nest', 'temperature', 'hallway', 20.4),
    item('nest', 'target_temperature', 'hallway', 20.5),
    item('room_sensors', 'humidity', 'kitchen', null),
  ]);

  it('groups by entity, sensors alphabetically then thermostats, ignoring non-room metrics', () => {
    expect(rooms.map((r) => [r.name, r.kind, Object.keys(r.metrics).sort().join(',')])).toEqual([
      ['Bedroom', 'sensor', 'temperature'],
      ['Kitchen', 'sensor', 'humidity'],
      ['Living room', 'sensor', 'co2,temperature'],
      ['Hallway', 'thermostat', 'target_temperature,temperature'],
    ]);
  });

  it('keeps the newest reading time per room', () => {
    expect(rooms.find((r) => r.entity === 'living_room')?.lastTs).toBe('2026-11-06T13:41:00Z');
    expect(rooms.find((r) => r.entity === 'kitchen')?.lastTs).toBeNull();
  });

  it('lists values of one metric, skipping rooms without a value', () => {
    expect(valuesOf(rooms, 'temperature').map((v) => v.value)).toEqual([19.1, 20.6, 20.4]);
    expect(valuesOf(rooms, 'humidity')).toEqual([]);
  });
});

describe('describePoll', () => {
  it.each([
    [{ poll: null, pushInterval: '30s' }, '30 s'],
    [{ poll: '2m', pushInterval: null }, '2 min'],
    [{ poll: '6h', pushInterval: null }, 'Every 6 h'],
    [{ poll: '1d', pushInterval: null }, 'Daily'],
    [{ poll: 'cron: 0 6 * * *', pushInterval: null }, 'Daily 06:00'],
    [{ poll: 'cron: */5 * * * 1', pushInterval: null }, 'Scheduled'],
  ])('%j → %s', (s, text) => {
    expect(describePoll(s)).toBe(text);
  });
});

describe('collectorStatus', () => {
  const base: Pick<SourceInfo, 'enabled' | 'poll' | 'lastRun' | 'freshness'> = {
    enabled: true,
    poll: '1m',
    lastRun: {
      startedAt: '2026-11-06T13:40:00Z',
      finishedAt: '2026-11-06T13:40:01Z',
      ok: true,
      rowsWritten: 10,
      durationMs: 1000,
      error: null,
    },
    freshness: live,
  };
  it('reads each state', () => {
    expect(collectorStatus(base)).toBe('running');
    expect(collectorStatus({ ...base, poll: 'cron: 0 6 * * *' })).toBe('scheduled');
    expect(collectorStatus({ ...base, enabled: false })).toBe('not_connected');
    expect(collectorStatus({ ...base, lastRun: { ...base.lastRun!, ok: false } })).toBe('failing');
    expect(collectorStatus({ ...base, freshness: { ...live, state: 'late' } })).toBe('late');
  });
});

describe('applyReading', () => {
  const response = {
    items: [item('room_sensors', 'co2', 'kitchen', 780, '2026-11-06T13:40:00Z')],
    freshness: live,
  };
  const id = response.items[0]!.series.id;

  it('updates the matching series and moves its freshness forward', () => {
    const next = applyReading(response, {
      seriesId: id,
      ts: '2026-11-06T13:41:00.000Z',
      value: 812,
    });
    expect(next?.items[0]).toMatchObject({
      value: 812,
      ts: '2026-11-06T13:41:00.000Z',
      freshness: { dataTo: '2026-11-06T13:41:00.000Z' },
    });
  });

  it('ignores older readings and other series', () => {
    expect(
      applyReading(response, { seriesId: id, ts: '2026-11-06T13:00:00.000Z', value: 1 }),
    ).toEqual(response);
    expect(
      applyReading(response, { seriesId: 9999, ts: '2026-11-06T14:00:00.000Z', value: 1 }),
    ).toBe(response);
  });
});
