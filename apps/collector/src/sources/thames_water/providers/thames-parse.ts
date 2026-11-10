import { addLondonDays, londonMidnight, londonParts, type ReadingInput } from '@home/shared';
import { z } from 'zod';

/**
 * Thames Water account site's meter data (myaccount.thameswater.co.uk/ajax/waterMeter/*).
 * Format from the MIT-licensed `thameswaterapi` client (github.com/jelmer/thameswaterapi);
 * confirm with `dist/tools/thames-capture.js`. Strict where it matters: a changed site must
 * fail loudly rather than store nonsense.
 */

const LineSchema = z
  .object({
    /** Clock time "0:00"… "23:00" (hourly), the same every day. */
    Label: z.string(),
    /** Litres used in the hour. */
    Usage: z.number(),
    /** Meter total in litres after the hour. */
    Read: z.number(),
    IsEstimated: z.boolean().optional(),
  })
  .loose();

export const MetersResponseSchema = z
  .object({
    IsError: z.boolean().optional(),
    /** Meter serial numbers on the account. */
    Meters: z.array(z.string()).default([]),
  })
  .loose();

export const ConsumptionResponseSchema = z
  .object({
    IsError: z.boolean(),
    IsDataAvailable: z.boolean(),
    Lines: z.array(LineSchema).nullable(),
  })
  .loose();

const HOUR = 3600_000;

/**
 * The UTC start of the `occurrence`th time the London clock shows `hour`:00 on `date`
 * (YYYY-MM-DD). Occurrence 1 exists only on the October day when 01:00 happens twice; on
 * the March day 01:00 doesn't happen at all (null).
 */
export function londonHourStart(date: string, hour: number, occurrence = 0): Date | null {
  const start = londonMidnight(date).getTime();
  const end = londonMidnight(addLondonDays(date, 1)).getTime();
  let seen = 0;
  for (let t = start; t < end; t += HOUR) {
    if (londonParts(new Date(t)).hour === hour && seen++ === occurrence) return new Date(t);
  }
  return null;
}

/**
 * One getSmartWaterMeterConsumptions response (hourly, starting on London date `startDate`)
 * → `volume` (L per hour, interval_total) and a daily `meter_reading` (m³, at the end of each
 * day's last hour), entity `mains`. The day advances at every "0:00" label, so a short
 * (23 h) or long (25 h) day, missing hours and a response truncated at a day boundary all
 * come out right.
 */
export function consumptionToReadings(startDate: string, body: unknown): ReadingInput[] {
  const parsed = ConsumptionResponseSchema.parse(body);
  if (parsed.IsError) throw new Error('Thames Water reported an error for the usage request');
  if (!parsed.IsDataAvailable) return [];

  const readings: ReadingInput[] = [];
  let day = startDate;
  const seen = new Map<number, number>();
  let lastOfDay: { end: Date; read: number } | null = null;
  const closeDay = () => {
    if (!lastOfDay) return;
    readings.push({
      metric: 'meter_reading',
      entity: 'mains',
      unit: 'm³',
      valueType: 'gauge',
      ts: lastOfDay.end,
      value: Math.round(lastOfDay.read) / 1000,
    });
    lastOfDay = null;
  };

  (parsed.Lines ?? []).forEach((line, index) => {
    const m = /^(\d{1,2}):00$/.exec(line.Label.trim());
    if (!m) throw new Error(`unexpected hourly label "${line.Label}" from Thames Water`);
    const hour = Number(m[1]);
    if (hour > 23) throw new Error(`unexpected hourly label "${line.Label}" from Thames Water`);
    if (index > 0 && hour === 0) {
      closeDay();
      day = addLondonDays(day, 1);
      seen.clear();
    }
    const occurrence = seen.get(hour) ?? 0;
    seen.set(hour, occurrence + 1);
    const ts = londonHourStart(day, hour, occurrence);
    if (!ts) return; // a label for an hour the clocks skipped: nothing to place it on
    if (line.Usage < 0) throw new Error('Thames Water sent a negative hourly usage');
    readings.push({
      metric: 'volume',
      entity: 'mains',
      unit: 'L',
      valueType: 'interval_total',
      interval: '1h',
      ts,
      value: line.Usage,
    });
    lastOfDay = { end: new Date(ts.getTime() + HOUR), read: line.Read };
  });
  closeDay();
  return readings;
}
