import type { Freshness, LatestPoint, SourceConfig } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { checkLateSources, lateMessage, type LateStore } from './late-check.js';
import { silentLog, source } from './test-helpers.js';

const now = new Date('2026-11-07T12:00:00Z');
const roomSensors = source('room_sensors', {
  name: 'Room sensors',
  kind: 'sensor',
  push_interval: '30s',
});
const piStats = source('pi_stats', { kind: 'local', poll: '1m' });
const smartMeters = source('smart_meters', {
  kind: 'api',
  poll: '6h',
  expected_delay: '1d',
  grace: '12h',
});
const disabled = source('nest', { kind: 'api', poll: '2m', enabled: false });

function memoryStore(latest: Record<string, LatestPoint>, alreadyOpen: string[] = []) {
  const open = new Set(alreadyOpen);
  const messages = new Map<string, string>();
  const store: LateStore = {
    latestBySource: () => Promise.resolve(new Map(Object.entries(latest))),
    openLate: (src: SourceConfig, f: Freshness) => {
      if (open.has(src.id)) return Promise.resolve(false);
      open.add(src.id);
      messages.set(src.id, lateMessage(src, f));
      return Promise.resolve(true);
    },
    resolveLate: (id) => Promise.resolve(open.delete(id)),
  };
  return { store, open, messages };
}

describe('checkLateSources', () => {
  it('opens one event for a late source, with a readable message', async () => {
    const { store, open, messages } = memoryStore({
      room_sensors: { ts: '2026-11-07T11:50:00Z' },
      pi_stats: { ts: '2026-11-07T11:59:30Z' },
    });
    expect(await checkLateSources([roomSensors, piStats], store, silentLog, now)).toEqual({
      opened: ['room_sensors'],
      resolved: [],
    });
    expect([...open]).toEqual(['room_sensors']);
    expect(messages.get('room_sensors')).toBe('Room sensors: no data since 11:50');
  });

  it('does not open a second event while one is open', async () => {
    const { store } = memoryStore({ room_sensors: { ts: '2026-11-07T11:50:00Z' } }, [
      'room_sensors',
    ]);
    expect(await checkLateSources([roomSensors], store, silentLog, now)).toEqual({
      opened: [],
      resolved: [],
    });
  });

  it('resolves the event when data flows again', async () => {
    const { store, open } = memoryStore({ room_sensors: { ts: '2026-11-07T11:59:45Z' } }, [
      'room_sensors',
    ]);
    expect(await checkLateSources([roomSensors], store, silentLog, now)).toEqual({
      opened: [],
      resolved: ['room_sensors'],
    });
    expect(open.size).toBe(0);
  });

  it('treats a source that never reported as late', async () => {
    const { store, messages } = memoryStore({});
    await checkLateSources([piStats], store, silentLog, now);
    expect(messages.get('pi_stats')).toBe('pi_stats: no data yet');
  });

  it('leaves a delayed source alone while it is within its grace', async () => {
    const { store } = memoryStore({
      smart_meters: { ts: '2026-11-05T23:30:00Z', intervalSeconds: 1800 },
    });
    expect(await checkLateSources([smartMeters], store, silentLog, now)).toEqual({
      opened: [],
      resolved: [],
    });
  });

  it('never keeps a disabled source late', async () => {
    const { store, open } = memoryStore({}, ['nest']);
    expect(await checkLateSources([disabled], store, silentLog, now)).toEqual({
      opened: [],
      resolved: ['nest'],
    });
    expect(open.size).toBe(0);
  });
});
