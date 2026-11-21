import { addLondonDays, londonDateString, londonLocalTime, type ReadingInput } from '@home/shared';

/**
 * Met Office severe weather warnings RSS (docs/10 §4). The format is treated as fragile:
 * anything unexpected throws, so the run fails, the source turns Late and admins hear about
 * it, rather than a warning being silently dropped.
 */

export class WarningsFeedError extends Error {
  override name = 'WarningsFeedError';
}

export const COLOURS = ['yellow', 'amber', 'red'] as const;
export type WarningColour = (typeof COLOURS)[number];

export interface Warning {
  /** The warning's id from its link (`id=`), as `w_<uuid with underscores>`: the event entity. */
  id: string;
  colour: WarningColour;
  /** "rain", "wind", "snow, ice", … as the Met Office words it. */
  type: string;
  region: string;
  /** Local authorities named, e.g. ["Barnet", "Waltham Forest"]. */
  areas: string[];
  validFrom: Date;
  validTo: Date;
  /** The Met Office page for the warning (must be shown with its text: website terms). */
  url: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text: string): string {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith('#x') || name.startsWith('#X'))
        return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}

function tag(block: string, name: string, where: string): string {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  if (!match) throw new WarningsFeedError(`${where}: no <${name}>`);
  return decode(match[1]!);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Warnings are issued a few days ahead and dropped soon after they end. */
const MAX_DAYS_FROM_NOW = 60;

/**
 * "0600 Sun 22 Nov" (London time, no year) → the instant. The year is the one, around `now`,
 * where that date falls on that weekday; a date more than 60 days from now is refused.
 */
function parseWhen(hhmm: string, weekday: string, day: string, month: string, now: Date): Date {
  const m = MONTHS.indexOf(month);
  const wd = WEEKDAYS.indexOf(weekday);
  if (m < 0 || wd < 0) throw new WarningsFeedError(`unknown date "${weekday} ${day} ${month}"`);
  const year = Number(londonDateString(now).slice(0, 4));
  for (const y of [year, year + 1, year - 1]) {
    const date = `${y}-${String(m + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
    const noon = new Date(`${date}T12:00:00Z`);
    if (noon.getUTCDay() !== wd) continue;
    if (Math.abs(noon.getTime() - now.getTime()) > MAX_DAYS_FROM_NOW * 86_400_000) continue;
    // "2400" isn't used by the Met Office, but be safe: midnight at the end of the day.
    const hour = Number(hhmm.slice(0, 2));
    const minute = Number(hhmm.slice(2));
    return hour === 24
      ? londonLocalTime(addLondonDays(date, 1), 0, minute)
      : londonLocalTime(date, hour, minute);
  }
  throw new WarningsFeedError(`"${weekday} ${day} ${month}" isn't a ${weekday} near now`);
}

const TITLE = /^(Yellow|Amber|Red) warning of (.+?) affecting (.+)$/;
const WHEN = String.raw`(\d{4}) (\w{3}) (\d{1,2}) (\w{3})`;
const DESCRIPTION = new RegExp(String.raw`^(.+?): (.*?) ?valid from ${WHEN} to ${WHEN}\s*$`);

export function parseWarningsFeed(xml: string, now: Date): Warning[] {
  if (!/<rss[\s>]/.test(xml) || !/<channel>[\s\S]*<\/channel>/.test(xml)) {
    throw new WarningsFeedError('not an RSS feed (no <rss>/<channel>)');
  }
  const warnings: Warning[] = [];
  for (const [i, match] of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].entries()) {
    const block = match[1]!;
    const where = `item ${i + 1}`;
    const title = tag(block, 'title', where);
    const t = TITLE.exec(title);
    if (!t) throw new WarningsFeedError(`${where}: title not understood`);
    const description = tag(block, 'description', where);
    const d = DESCRIPTION.exec(description);
    if (!d) throw new WarningsFeedError(`${where}: description not understood`);
    const link = tag(block, 'link', where);
    const id = /[?&]id=([0-9a-f-]{8,64})/i.exec(link)?.[1];
    if (!id) throw new WarningsFeedError(`${where}: link has no warning id`);
    warnings.push({
      id: `w_${id.toLowerCase().replace(/-/g, '_')}`,
      colour: t[1]!.toLowerCase() as WarningColour,
      type: t[2]!.toLowerCase(),
      region: t[3]!,
      areas: d[2]!
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== ''),
      validFrom: parseWhen(d[3]!, d[4]!, d[5]!, d[6]!, now),
      validTo: parseWhen(d[7]!, d[8]!, d[9]!, d[10]!, now),
      url: link,
    });
  }
  return warnings;
}

/**
 * Does a warning cover the home (docs/10 § Area matching)? Yes if it names one of `homeAreas`,
 * or London as a whole. With no areas configured, or none named in the warning (the filter
 * can't apply), every warning counts: never silently drop one.
 */
export function coversHome(warning: Warning, homeAreas: readonly string[]): boolean {
  if (homeAreas.length === 0 || warning.areas.length === 0) return true;
  const wanted = new Set([...homeAreas, 'London', 'Greater London'].map((a) => a.toLowerCase()));
  return warning.areas.some((a) => wanted.has(a.toLowerCase()));
}

export const LEVEL_OF: Record<WarningColour, 'warning' | 'alert'> = {
  yellow: 'warning',
  amber: 'alert',
  red: 'alert',
};

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "Tue 25 Nov 06:00 – 21:00", or "Mon 24 Nov 18:00 – Wed 26 Nov 06:00". */
export function formatValidity(from: Date, to: Date): string {
  const day = (d: Date) => dayFormat.format(d).replace(',', '');
  const fromDay = day(from);
  const toDay = day(to);
  return `${fromDay} ${timeFormat.format(from)} – ${toDay === fromDay ? '' : `${toDay} `}${timeFormat.format(to)}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The event for one warning: title "Amber warning · Rain", strip text "Amber warning of rain · <validity>". */
export function warningEvent(w: Warning) {
  return {
    level: LEVEL_OF[w.colour],
    title: `${capital(w.colour)} warning · ${capital(w.type)}`,
    message: `${capital(w.colour)} warning of ${w.type} · ${formatValidity(w.validFrom, w.validTo)}`,
    data: {
      colour: w.colour,
      type: w.type,
      validFrom: w.validFrom.toISOString(),
      validTo: w.validTo.toISOString(),
      url: w.url,
      areas: w.areas,
    },
  };
}

export const HOME_AREA = 'home_area';
const LEVEL_NUMBER: Record<WarningColour, number> = { yellow: 1, amber: 2, red: 3 };

/** Readings so the source has freshness even with no warnings (docs/10 §4 step 5). */
export function warningReadings(kept: readonly Warning[], now: Date): ReadingInput[] {
  return [
    {
      metric: 'active_warnings',
      entity: HOME_AREA,
      unit: 'warnings',
      valueType: 'gauge',
      ts: now,
      value: kept.length,
    },
    {
      metric: 'warning_level',
      entity: HOME_AREA,
      unit: 'level',
      valueType: 'state',
      ts: now,
      value: Math.max(0, ...kept.map((w) => LEVEL_NUMBER[w.colour])),
      label: '0 = none, 1 = yellow, 2 = amber, 3 = red',
    },
  ];
}
