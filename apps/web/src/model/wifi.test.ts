import { freshness, type LatestItem } from '@home/shared';
import { describe, expect, it } from 'vitest';
import {
  bandLabel,
  connectedDevices,
  connectedSince,
  meshLinks,
  qualitySummary,
  radioSignals,
} from './wifi.js';

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

describe('connected devices (router readings)', () => {
  const ROUND = '2026-11-09T12:00:00Z';
  const EARLIER = '2026-11-09T11:00:00Z';
  const dev = (
    metric: string,
    entity: string,
    value: number,
    label: string,
    ts = ROUND,
  ): LatestItem => ({
    series: { id: id++, sourceId: 'wifi', metric, entity, unit: '', valueType: 'state', label },
    ts,
    value,
    freshness: f,
  });
  const items: LatestItem[] = [
    { ...item('wifi', 'devices_connected', 'network', 4), ts: ROUND },
    dev('device_band', 'device_a', 5, 'Laptop'),
    dev('device_signal', 'device_a', -51, 'Laptop'),
    dev('device_link_speed', 'device_a', 866, 'Laptop'),
    dev('device_via_satellite', 'device_a', 0, 'Laptop'),
    dev('device_band', 'device_b', 2.4, 'Bedroom TV'),
    dev('device_signal', 'device_b', -74, 'Bedroom TV'),
    dev('device_band', 'device_c', 0, 'Desktop PC'),
    dev('device_band', 'device_d', 2.4, 'Phone'),
    dev('device_via_satellite', 'device_d', 1, 'Phone'),
    // Left an hour ago: not connected now.
    dev('device_band', 'device_e', 5, 'Old tablet', EARLIER),
    dev('device_signal', 'device_e', -40, 'Old tablet', EARLIER),
    dev('backhaul_band', 'node_x', 5, 'Upstairs'),
    dev('backhaul_signal', 'node_x', -62, 'Upstairs'),
    dev('backhaul_link_speed', 'node_x', 960, 'Upstairs'),
  ];

  it('lists devices from the newest round: weakest first, then via satellite, then wired', () => {
    const rows = connectedDevices(items);
    expect(rows.map((r) => r.name)).toEqual(['Bedroom TV', 'Laptop', 'Phone', 'Desktop PC']);
    expect(rows[0]).toMatchObject({ band: 2.4, signalDbm: -74, quality: 'fair', linkMbps: null });
    expect(rows[1]).toMatchObject({ quality: 'excellent', linkMbps: 866, viaSatellite: false });
    expect(rows[2]).toMatchObject({ signalDbm: null, quality: null, viaSatellite: true });
    expect(rows[3]?.band).toBe(0);
  });

  it('reads the satellite’s link to the main router', () => {
    expect(meshLinks(items)).toEqual([
      {
        entity: 'node_x',
        name: 'Upstairs',
        band: 5,
        signalDbm: -62,
        quality: 'good',
        linkMbps: 960,
      },
    ]);
  });

  it('is empty without router readings', () => {
    expect(connectedDevices([item('wifi', 'devices_connected', 'network', 9)])).toEqual([]);
  });

  it('labels bands', () => {
    expect([bandLabel(2.4), bandLabel(5), bandLabel(0), bandLabel(null)]).toEqual([
      '2.4 GHz',
      '5 GHz',
      'Wired',
      '—',
    ]);
  });
});

describe('connectedSince', () => {
  const windowStart = new Date('2026-11-07T12:00:00Z');
  const run = (from: string, count: number) =>
    Array.from({ length: count }, (_, i): [string, number] => [
      new Date(Date.parse(from) + i * 15 * 60_000).toISOString(),
      5,
    ]);

  it('finds the start of the current unbroken run', () => {
    const points = [...run('2026-11-08T08:00:00Z', 8), ...run('2026-11-09T09:15:00Z', 12)];
    expect(connectedSince(points, windowStart)?.toISOString()).toBe('2026-11-09T09:15:00.000Z');
  });

  it('tolerates one missed bucket', () => {
    const points = [...run('2026-11-09T08:00:00Z', 4), ...run('2026-11-09T09:15:00Z', 4)];
    expect(connectedSince(points, windowStart)?.toISOString()).toBe('2026-11-09T08:00:00.000Z');
  });

  it('is null when connected for the whole window', () => {
    expect(connectedSince(run('2026-11-07T12:00:00Z', 192), windowStart)).toBeNull();
    expect(connectedSince([], windowStart)).toBeNull();
  });
});
