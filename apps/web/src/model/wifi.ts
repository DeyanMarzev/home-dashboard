import { humanise, signalQuality, type LatestItem, type SignalQuality } from '@home/shared';

export interface RadioSignal {
  key: string;
  name: string;
  dBm: number;
  quality: SignalQuality;
}

/**
 * Signal by room: each room sensor's own Wi-Fi radio (room_sensors wifi_rssi) plus the Pi's
 * link (wifi wifi_rssi on entity pi). Weakest first, the way the page lists them.
 */
export function radioSignals(
  sensorItems: readonly LatestItem[],
  wifiItems: readonly LatestItem[],
): RadioSignal[] {
  const rows = [...sensorItems, ...wifiItems].flatMap((i) => {
    if (i.series.metric !== 'wifi_rssi' || i.value === null) return [];
    const isPi = i.series.sourceId === 'wifi';
    return [
      {
        key: `${i.series.sourceId}:${i.series.entity}`,
        name: isPi ? 'Raspberry Pi' : humanise(i.series.entity),
        dBm: i.value,
        quality: signalQuality(i.value),
      },
    ];
  });
  return rows.sort((a, b) => a.dBm - b.dBm);
}

/** "11 good or better · 2 fair · 0 poor" counts, and the overall word (the most common band, worst on ties). */
export function qualitySummary(signals: readonly RadioSignal[]): {
  goodOrBetter: number;
  fair: number;
  poor: number;
  overall: SignalQuality | null;
} {
  const goodOrBetter = signals.filter(
    (s) => s.quality === 'excellent' || s.quality === 'good',
  ).length;
  const fair = signals.filter((s) => s.quality === 'fair').length;
  const poor = signals.filter((s) => s.quality === 'poor').length;
  if (signals.length === 0) return { goodOrBetter, fair, poor, overall: null };
  const overall: SignalQuality =
    poor > signals.length / 2 ? 'poor' : fair + poor > signals.length / 2 ? 'fair' : 'good';
  return { goodOrBetter, fair, poor, overall };
}

/** One connected device for the Wi-Fi page's table (netprobe's router readings, docs/03 § wifi). */
export interface DeviceRow {
  entity: string;
  name: string;
  /** 2.4, 5 or 6 (GHz), 0 for wired, null if unknown. */
  band: number | null;
  signalDbm: number | null;
  quality: SignalQuality | null;
  linkMbps: number | null;
  viaSatellite: boolean;
  /** Series id of `device_band`, for working out when the connection started. */
  bandSeriesId: number | null;
}

/** A satellite mesh node's own Wi-Fi link to the main router. */
export interface MeshLink {
  entity: string;
  name: string;
  band: number | null;
  signalDbm: number | null;
  quality: SignalQuality | null;
  linkMbps: number | null;
}

/**
 * Every reading of a netprobe round shares its `ts`, so "connected now" means the device has
 * readings from the newest round (that of `devices_connected`).
 */
function latestRound(items: readonly LatestItem[]): string | null {
  const round = items.find((i) => i.series.metric === 'devices_connected')?.ts;
  if (round) return round;
  return items
    .filter((i) => i.series.metric.startsWith('device_') && i.ts !== null)
    .reduce<string | null>((max, i) => (max === null || i.ts! > max ? i.ts : max), null);
}

function groupByEntity(
  items: readonly LatestItem[],
  prefix: 'device_' | 'backhaul_',
): Map<string, Map<string, LatestItem>> {
  const round = latestRound(items);
  const groups = new Map<string, Map<string, LatestItem>>();
  if (round === null) return groups;
  for (const i of items) {
    if (!i.series.metric.startsWith(prefix) || i.ts !== round || i.value === null) continue;
    const group = groups.get(i.series.entity) ?? new Map<string, LatestItem>();
    group.set(i.series.metric.slice(prefix.length), i);
    groups.set(i.series.entity, group);
  }
  return groups;
}

const labelOf = (group: Map<string, LatestItem>) =>
  [...group.values()].find((i) => i.series.label)?.series.label ?? 'Unknown device';

/**
 * Devices connected in the newest round: weakest signal first, then the satellite's clients
 * (no signal from the main router), then wired devices.
 */
export function connectedDevices(items: readonly LatestItem[]): DeviceRow[] {
  const rows = [...groupByEntity(items, 'device_')].map(([entity, g]): DeviceRow => {
    const signalDbm = g.get('signal')?.value ?? null;
    return {
      entity,
      name: labelOf(g),
      band: g.get('band')?.value ?? null,
      signalDbm,
      quality: signalDbm === null ? null : signalQuality(signalDbm),
      linkMbps: g.get('link_speed')?.value ?? null,
      viaSatellite: g.get('via_satellite')?.value === 1,
      bandSeriesId: g.get('band')?.series.id ?? null,
    };
  });
  const rank = (r: DeviceRow) => (r.band === 0 ? 2 : r.signalDbm === null ? 1 : 0);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) || (a.signalDbm ?? 0) - (b.signalDbm ?? 0) || a.name.localeCompare(b.name),
  );
}

export function meshLinks(items: readonly LatestItem[]): MeshLink[] {
  return [...groupByEntity(items, 'backhaul_')].map(([entity, g]) => {
    const signalDbm = g.get('signal')?.value ?? null;
    return {
      entity,
      name: labelOf(g),
      band: g.get('band')?.value ?? null,
      signalDbm,
      quality: signalDbm === null ? null : signalQuality(signalDbm),
      linkMbps: g.get('link_speed')?.value ?? null,
    };
  });
}

/** "2.4 GHz", "5 GHz", "Wired". */
export function bandLabel(band: number | null): string {
  if (band === null) return '—';
  return band === 0 ? 'Wired' : `${band} GHz`;
}

/**
 * When the current connection started, from a device's `device_band` points (15-minute
 * buckets, oldest first): the start of the last unbroken run. A gap longer than `maxGapMs`
 * means it was away. `null` if the run reaches back to the start of the window (connected
 * for at least that long).
 */
export function connectedSince(
  points: readonly (readonly [string, number])[],
  windowStart: Date,
  maxGapMs = 30 * 60_000,
): Date | null {
  if (points.length === 0) return null;
  let start = Date.parse(points[points.length - 1]![0]);
  for (let i = points.length - 2; i >= 0; i--) {
    const t = Date.parse(points[i]![0]);
    if (start - t > maxGapMs) break;
    start = t;
  }
  return start - windowStart.getTime() <= maxGapMs ? null : new Date(start);
}
