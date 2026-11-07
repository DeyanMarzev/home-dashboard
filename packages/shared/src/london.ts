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
