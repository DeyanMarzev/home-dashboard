import { freshness, type LatestItem } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { qualitySummary, radioSignals } from './wifi.js';

const f = freshness(
  { expectedDelaySeconds: 0, cadenceSeconds: 30, graceSeconds: null },
  { ts: '2026-11-07T12:00:00Z' },
  new Date('2026-11-07T12:00:10Z'),
);
let id = 1;
const item = (
  sourceId: string,
  metric: string,
  entity: string,
  value: number | null,
): LatestItem => ({
  series: { id: id++, sourceId, metric, entity, unit: 'dBm', valueType: 'gauge' },
  ts: '2026-11-07T12:00:00Z',
  value,
  freshness: f,
});

describe('radioSignals', () => {
  it('lists room sensors and the Pi, weakest first, ignoring other metrics', () => {
    const rows = radioSignals(
      [
        item('room_sensors', 'wifi_rssi', 'living_room', -48),
        item('room_sensors', 'wifi_rssi', 'bedroom', -72),
        item('room_sensors', 'temperature', 'kitchen', 20),
      ],
      [item('wifi', 'wifi_rssi', 'pi', -58), item('wifi', 'latency', 'router', 3)],
    );
    expect(rows.map((r) => [r.name, r.dBm, r.quality])).toEqual([
      ['Bedroom', -72, 'fair'],
      ['Raspberry Pi', -58, 'good'],
      ['Living room', -48, 'excellent'],
    ]);
  });
});

describe('qualitySummary', () => {
  it('counts bands and picks an overall word', () => {
    const rows = radioSignals(
      [
        item('room_sensors', 'wifi_rssi', 'a', -48),
        item('room_sensors', 'wifi_rssi', 'b', -60),
        item('room_sensors', 'wifi_rssi', 'c', -72),
      ],
      [],
    );
    expect(qualitySummary(rows)).toEqual({ goodOrBetter: 2, fair: 1, poor: 0, overall: 'good' });
    expect(qualitySummary([]).overall).toBeNull();
  });
});
