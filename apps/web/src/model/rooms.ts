import { humanise, type Freshness, type LatestItem } from '@home/shared';

export const ROOM_METRICS = [
  'temperature',
  'humidity',
  'co2',
  'pressure',
  'target_temperature',
] as const;
export type RoomMetric = (typeof ROOM_METRICS)[number];

export interface RoomValue {
  seriesId: number;
  sourceId: string;
  value: number | null;
  ts: string | null;
  freshness: Freshness;
}

export interface Room {
  entity: string;
  name: string;
  /** `thermostat` for the Nest (hallway), `sensor` for room sensors. */
  kind: 'sensor' | 'thermostat';
  metrics: Partial<Record<RoomMetric, RoomValue>>;
  /** Newest reading time across the room's metrics. */
  lastTs: string | null;
}

/**
 * Groups latest items into rooms by entity. Room sensors come first (alphabetically), then
 * thermostats. Signal strength and other non-room metrics are ignored.
 */
export function buildRooms(items: readonly LatestItem[]): Room[] {
  const rooms = new Map<string, Room>();
  for (const item of items) {
    const metric = item.series.metric as RoomMetric;
    if (!(ROOM_METRICS as readonly string[]).includes(metric) || !item.series.entity) continue;
    const kind = item.series.sourceId === 'nest' ? 'thermostat' : 'sensor';
    const key = `${kind}:${item.series.entity}`;
    const room = rooms.get(key) ?? {
      entity: item.series.entity,
      name: humanise(item.series.entity),
      kind,
      metrics: {},
      lastTs: null,
    };
    room.metrics[metric] = {
      seriesId: item.series.id,
      sourceId: item.series.sourceId,
      value: item.value,
      ts: item.ts,
      freshness: item.freshness,
    };
    if (item.ts && (!room.lastTs || item.ts > room.lastTs)) room.lastTs = item.ts;
    rooms.set(key, room);
  }
  return [...rooms.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'sensor' ? -1 : 1,
  );
}

/** Current values of one metric across rooms that have it. */
export function valuesOf(
  rooms: readonly Room[],
  metric: RoomMetric,
): { room: Room; value: number }[] {
  return rooms.flatMap((room) => {
    const v = room.metrics[metric]?.value;
    return v === null || v === undefined ? [] : [{ room, value: v }];
  });
}
