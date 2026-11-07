import {
  addLondonDays,
  londonDateString,
  londonMidnight,
  londonParts,
  type ReadingInput,
} from '@home/shared';
import type { WaterProvider } from './types.js';

const HOUR = 3600_000;
const METER_START = { at: Date.parse('2026-01-01T00:00:00Z'), m3: 1180 };

/** Deterministic 0–1 per hour, so re-fetched windows give identical values. */
function noise(slot: number, salt: number): number {
  let x = (slot * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** Plausible litres for the hour starting `t`: nothing at night, a morning shower peak, cooking in the evening. */
export function fakeHourLitres(t: Date): number {
  const { hour } = londonParts(t);
  const slot = Math.floor(t.getTime() / HOUR);
  const n = noise(slot, 1);
  if (hour < 6) return 0;
  if (hour === 7) return Math.round(45 + 15 * n);
  if (hour === 6 || hour === 8) return Math.round(15 + 15 * n);
  if (hour >= 18 && hour <= 21) return Math.round(20 + 20 * n);
  if (hour === 22 || hour === 23) return Math.round(4 + 8 * n);
  return Math.round(4 + 10 * n);
}

/**
 * Sample data until the real Thames Water provider is built. Like the real feed it's 3 days
 * behind: hours up to the end of the day 3 days ago (London). Also reports a meter reading
 * at the end of each day.
 */
export const fakeWaterProvider: WaterProvider = {
  id: 'fake',
  fetch(from, to) {
    const until = Math.min(
      to.getTime(),
      londonMidnight(addLondonDays(londonDateString(new Date()), -2)).getTime(),
    );
    const readings: ReadingInput[] = [];
    for (let t = Math.ceil(from.getTime() / HOUR) * HOUR; t < until; t += HOUR) {
      const ts = new Date(t);
      readings.push({
        metric: 'volume',
        entity: 'mains',
        unit: 'L',
        valueType: 'interval_total',
        interval: '1h',
        ts,
        value: fakeHourLitres(ts),
      });
      if (londonParts(new Date(t + HOUR)).hour === 0) {
        // ~0.32 m³ a day since the start of the year.
        const m3 = METER_START.m3 + ((t + HOUR - METER_START.at) / 86400_000) * 0.32;
        readings.push({
          metric: 'meter_reading',
          entity: 'mains',
          unit: 'm³',
          valueType: 'gauge',
          ts: new Date(t + HOUR),
          value: Math.round(m3 * 10) / 10,
        });
      }
    }
    return Promise.resolve(readings);
  },
};
