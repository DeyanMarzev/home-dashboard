import { londonDateString, londonMidnight, londonParts, type ReadingInput } from '@home/shared';
import type { MeterProvider } from './types.js';

const HALF_HOUR = 1800_000;

/** Deterministic noise in [0, 1) per half-hour, so re-fetching a window gives identical values. */
function noise(slot: number, salt: number): number {
  let x = (slot * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489909) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Plausible kWh for one half-hour starting at `t` (London time drives the daily pattern). */
export function fakeHalfHour(t: Date): { electricityKwh: number; gasKwh: number } {
  const { hour, minute, month } = londonParts(t);
  const h = hour + minute / 60;
  const slot = Math.floor(t.getTime() / HALF_HOUR);
  const winter = [1, 2, 12].includes(month)
    ? 1
    : [3, 10, 11].includes(month)
      ? 0.75
      : [4, 9].includes(month)
        ? 0.4
        : 0.1;

  // ~168 W always on, a morning and a bigger evening peak, a little daytime use.
  let elec = 0.084 + 0.012 * noise(slot, 1);
  if (h >= 7 && h < 8.5) elec += 0.25 + 0.15 * noise(slot, 2);
  else if (h >= 8.5 && h < 17.5) elec += 0.06 * noise(slot, 3);
  else if (h >= 17.5 && h < 21.5) elec += 0.3 + 0.25 * noise(slot, 4);
  else if (h >= 21.5 && h < 23) elec += 0.1 * noise(slot, 5);

  // Heating mornings and evenings (more in winter), plus hot water.
  let gas = 0;
  if (h >= 6 && h < 7.5) gas = (1.6 + 0.8 * noise(slot, 6)) * winter;
  else if (h >= 17 && h < 21) gas = (1.2 + 0.7 * noise(slot, 7)) * winter;
  if (h >= 7 && h < 7.5) gas += 0.6;

  return { electricityKwh: Math.round(elec * 1000) / 1000, gasKwh: Math.round(gas * 1000) / 1000 };
}

/**
 * Sample data for development until the real provider is chosen (docs/08 question 3). Like a
 * real supplier feed it's a day behind: it only returns half-hours before London midnight today.
 */
export const fakeProvider: MeterProvider = {
  id: 'fake',
  fetch(from, to) {
    const until = Math.min(to.getTime(), londonMidnight(londonDateString(new Date())).getTime());
    const readings: ReadingInput[] = [];
    for (let t = Math.ceil(from.getTime() / HALF_HOUR) * HALF_HOUR; t < until; t += HALF_HOUR) {
      const ts = new Date(t);
      const { electricityKwh, gasKwh } = fakeHalfHour(ts);
      const common = {
        metric: 'energy_import',
        unit: 'kWh',
        valueType: 'interval_total' as const,
        interval: '30m',
        ts,
      };
      readings.push(
        { ...common, entity: 'electricity', value: electricityKwh },
        { ...common, entity: 'gas', value: gasKwh },
      );
    }
    return Promise.resolve(readings);
  },
};
