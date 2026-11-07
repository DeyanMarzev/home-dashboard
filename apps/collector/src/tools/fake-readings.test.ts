import { describe, expect, it } from 'vitest';
import { parseSensorMessage } from '../sources/room_sensors/parse.js';
import { fakeRoomReadings } from './fake-readings.js';

describe('fakeRoomReadings', () => {
  const evening = new Date('2026-11-07T19:30:00Z');

  it('publishes 4 metrics for each of 3 rooms', () => {
    expect(fakeRoomReadings(evening)).toHaveLength(12);
  });

  it('is accepted by the real room_sensors parser (same topic contract as real sensors)', () => {
    for (const m of fakeRoomReadings(evening)) {
      const readings = parseSensorMessage(m.topic, JSON.stringify(m.payload), evening);
      expect(readings.map((r) => r.metric)).toContain('wifi_rssi');
    }
  });

  it.each([0, 3, 7, 12, 19, 23])(
    'stays in realistic ranges at %i:00 with extreme noise',
    (hour) => {
      const now = new Date(Date.UTC(2026, 10, 7, hour));
      for (const noise of [() => -0.5, () => 0.5]) {
        for (const { topic, payload } of fakeRoomReadings(now, noise)) {
          const metric = topic.split('/')[3];
          const range = {
            temperature: [15, 24],
            humidity: [40, 65],
            co2: [400, 1100],
            pressure: [1000, 1025],
          }[metric!]!;
          expect(payload.value, topic).toBeGreaterThanOrEqual(range[0]!);
          expect(payload.value, topic).toBeLessThanOrEqual(range[1]!);
          expect(payload.rssi).toBeLessThan(-40);
        }
      }
    },
  );

  it('raises CO₂ in the living room in the evening, not at night', () => {
    const co2 = (iso: string) =>
      fakeRoomReadings(new Date(iso), () => 0).find(
        (m) => m.topic === 'home/sensors/living_room/co2',
      )!.payload.value;
    expect(co2('2026-11-07T20:00:00Z')).toBeGreaterThan(900);
    expect(co2('2026-11-07T03:00:00Z')).toBeLessThan(600);
  });
});
