import { londonParts } from '@home/shared';

export const FAKE_ROOMS = ['living_room', 'kitchen', 'bedroom'] as const;
type Room = (typeof FAKE_ROOMS)[number];

const PROFILE: Record<
  Room,
  { baseTemp: number; humidity: number; rssi: number; occupied: (hour: number) => boolean }
> = {
  living_room: { baseTemp: 20.5, humidity: 48, rssi: -48, occupied: (h) => h >= 18 && h < 23 },
  kitchen: {
    baseTemp: 19.5,
    humidity: 55,
    rssi: -58,
    occupied: (h) => (h >= 7 && h < 9) || (h >= 17 && h < 20),
  },
  bedroom: { baseTemp: 18.2, humidity: 52, rssi: -67, occupied: (h) => h >= 23 || h < 7 },
};

export interface FakeMessage {
  topic: string;
  payload: { value: number; ts: string; rssi: number };
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

/**
 * One round of readings for every room at `now`: temperature follows the heating day,
 * CO₂ rises while a room is occupied, pressure drifts slowly. `noise` is injectable for tests.
 */
export function fakeRoomReadings(
  now: Date,
  noise: () => number = () => Math.random() - 0.5,
): FakeMessage[] {
  const { hour, minute } = londonParts(now);
  const dayFraction = (hour + minute / 60) / 24;
  const heatingCurve = Math.sin((dayFraction - 0.3) * 2 * Math.PI); // warmest around early evening
  const pressure = 1013 + 6 * Math.sin((now.getTime() / 86400_000 / 3) * 2 * Math.PI); // ~3-day swell
  const ts = now.toISOString();

  return FAKE_ROOMS.flatMap((room) => {
    const p = PROFILE[room];
    const occupied = p.occupied(hour);
    const values: Record<string, number> = {
      temperature: round(p.baseTemp + 1.2 * heatingCurve + (occupied ? 0.4 : 0) + 0.2 * noise(), 1),
      humidity: round(p.humidity + (occupied ? 4 : 0) + 2 * noise(), 1),
      co2: Math.round((occupied ? 950 : 480) + 120 * noise()),
      pressure: round(pressure + 0.3 * noise(), 1),
    };
    const rssi = Math.round(p.rssi + 4 * noise());
    return Object.entries(values).map(([metric, value]) => ({
      topic: `home/sensors/${room}/${metric}`,
      payload: { value, ts, rssi },
    }));
  });
}
