import { formatLondonDayMonth, type EnergyDay } from '@home/shared';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const noon = (date: string) => new Date(`${date}T12:00:00Z`);
/** "5 Nov" for a London date. */
export const dayLabel = (date: string) => formatLondonDayMonth(noon(date));
/** "Thu 5 Nov". */
export const weekdayLabel = (date: string) =>
  `${WEEKDAYS[noon(date).getUTCDay()]} ${dayLabel(date)}`;
export const sumDays = (days: EnergyDay[], f: (d: EnergyDay) => number | null | undefined) =>
  days.reduce((s, d) => s + (f(d) ?? 0), 0);
/** Energy cost of a day, with or without standing charges; null if a fuel with data has no tariff. */
export function dayPence(d: EnergyDay, withStanding: boolean): number | null {
  let total = 0;
  for (const fuel of [d.electricity, d.gas]) {
    if (!fuel) continue;
    if (fuel.energyPence === null) return null;
    total += fuel.energyPence + (withStanding ? (fuel.standingPence ?? 0) : 0);
  }
  return total;
}

/**
 * Average kWh a day for a fuel over the complete days that have it (a partly-received day
 * would drag the average down). Null without any.
 */
export function averageKwh(days: readonly EnergyDay[], fuel: 'electricity' | 'gas'): number | null {
  const kwh = days.flatMap((d) => (d.complete && d[fuel] ? [d[fuel].kwh] : []));
  if (kwh.length === 0) return null;
  return Math.round((kwh.reduce((a, b) => a + b, 0) / kwh.length) * 10) / 10;
}
