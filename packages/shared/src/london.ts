/**
 * Europe/London calendar helpers (CLAUDE.md rule 4: store UTC, display Europe/London).
 * Built on Intl so it works the same in Node, browsers and the Android WebView, and is
 * correct across the clock changes in March and October.
 */
export const HOME_TIME_ZONE = 'Europe/London';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: HOME_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

export function londonParts(date: Date): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? NaN,
    month: parts.month ?? NaN,
    day: parts.day ?? NaN,
    hour: parts.hour ?? NaN,
    minute: parts.minute ?? NaN,
  };
}

/** Day number of the London calendar date (days since 1970-01-01), for day arithmetic. */
export function londonDayNumber(date: Date): number {
  const { year, month, day } = londonParts(date);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** Whole London calendar days from `from` to `to` (0 if the same London date). */
export function londonCalendarDaysBetween(from: Date, to: Date): number {
  return londonDayNumber(to) - londonDayNumber(from);
}

// Fixed English month names: ICU versions disagree on some (e.g. "Sep" vs "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `5 Nov` in London time. */
export function formatLondonDayMonth(date: Date): string {
  const { day, month } = londonParts(date);
  return `${day} ${MONTHS[month - 1]}`;
}

/** `13:10` in London time. */
export function formatLondonTime(date: Date): string {
  const { hour, minute } = londonParts(date);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "2026-11-06": the London calendar date of an instant. */
export function londonDateString(date: Date): string {
  const { year, month, day } = londonParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The instant London's day `YYYY-MM-DD` starts: 00:00 UTC in winter, 23:00 UTC the day before in summer. */
export function londonMidnight(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const utcMidnight = new Date(Date.UTC(y, m - 1, d));
  return londonParts(utcMidnight).hour === 0
    ? utcMidnight
    : new Date(utcMidnight.getTime() - 3600_000);
}

/** [start, end) of a London calendar day: 24 h, or 23 h / 25 h when the clocks change. */
export function londonDayBounds(date: string): { from: Date; to: Date } {
  const from = londonMidnight(date);
  const next = new Date(from.getTime() + 26 * 3600_000); // always lands in the following day
  return { from, to: londonMidnight(londonDateString(next)) };
}

/** The London date `days` before/after `date` (calendar arithmetic, safe across clock changes). */
export function addLondonDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}
