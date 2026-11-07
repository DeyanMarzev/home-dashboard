import { formatLondonDayMonth, formatLondonTime, londonDayNumber, londonParts } from './london.js';

/** Formatting for the UI: en-GB, Europe/London (CLAUDE.md rule 4). */

/** 1240 → "1,240"; 20.44 → "20.4" with digits = 1. */
export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** "30 s ago", "2 min ago", "3 h ago", then "5 Nov 23:30". */
export function formatAgo(ts: Date | string, now: Date = new Date()): string {
  const date = new Date(ts);
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return `${Math.max(seconds, 1)} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 6 * 3600) return `${Math.floor(seconds / 3600)} h ago`;
  return formatWhen(date, now);
}

/** "13:41" today, otherwise "5 Nov 13:41" (London time). */
export function formatWhen(ts: Date | string, now: Date = new Date()): string {
  const date = new Date(ts);
  return londonDayNumber(date) === londonDayNumber(now)
    ? formatLondonTime(date)
    : `${formatLondonDayMonth(date)} ${formatLondonTime(date)}`;
}

/** 5400 → "1 h 30 min"; 1800 → "30 min"; 25200 → "7 h"; 0 → "0 min". */
export function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** 1987200 s → "23 d"; 7200 → "2 h"; 300 → "5 min". */
export function formatUptime(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 60)} min`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "Friday 6 November" in London. */
export function formatLongDate(date: Date): string {
  const { year, month, day } = londonParts(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]}`;
}

/** "living_room" → "Living room". */
export function humanise(key: string): string {
  const text = key.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
