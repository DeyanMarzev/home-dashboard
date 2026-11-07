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
