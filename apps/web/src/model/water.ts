import { formatLondonTime, type WaterSummary } from '@home/shared';

type Day = WaterSummary['days'][number];

/** Average litres a day over the complete days given; null if none. */
export function averageLitres(days: readonly Day[]): number | null {
  const complete = days.filter((d) => d.complete && d.litres !== null);
  return complete.length ? complete.reduce((s, d) => s + d.litres!, 0) / complete.length : null;
}

/** The busiest hour of a day's profile: "52 L at 07:00". */
export function peakHour(hourly: WaterSummary['hourly']): { litres: number; at: string } | null {
  const peak = hourly.reduce<WaterSummary['hourly'][number] | null>(
    (a, p) => (!a || p[1] > a[1] ? p : a),
    null,
  );
  return peak ? { litres: peak[1], at: formatLondonTime(new Date(peak[0])) } : null;
}
