import { openEvent, resolveEvent } from '@home/db';
import { readFile } from 'node:fs/promises';
import type { PullCollector } from '../../collector.js';
import { HttpError, USER_AGENT } from '../../http.js';
import {
  coversHome,
  parseWarningsFeed,
  warningEvent,
  warningReadings,
  WarningsFeedError,
  type Warning,
} from './parse.js';

const SOURCE = 'met_office_warnings';
const KIND = 'weather_warning';
const FEED_BASE = 'https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/';

/** The last feed, for conditional GETs (the feed sends ETag and Last-Modified). */
let last: { url: string; etag: string | null; modified: string | null; xml: string } | null = null;

async function fetchFeed(url: string, signal: AbortSignal): Promise<string> {
  // MET_OFFICE_FEED_URL may be a local file for testing (docs/10 §7 item 2).
  if (!/^https?:\/\//.test(url)) return readFile(url, 'utf8');
  const cached = last?.url === url ? last : null;
  const res = await fetch(url, {
    signal,
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.1',
      'user-agent': USER_AGENT,
      ...(cached?.etag && { 'if-none-match': cached.etag }),
      ...(cached?.modified && { 'if-modified-since': cached.modified }),
    },
  });
  if (res.status === 304 && cached) return cached.xml;
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, `${new URL(url).host} answered HTTP ${res.status}`);
  }
  const xml = await res.text();
  last = { url, etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), xml };
  return xml;
}

/**
 * Met Office severe weather warnings for the home area (docs/10 §4): one `weather_warning`
 * event per warning that covers the home (escalating if it turns amber), resolved when it
 * ends or is withdrawn, plus readings so the source shows as Live with no warnings.
 * Settings: `options.region` and `options.areas` in config/sources.yaml.
 */
export const metOfficeWarnings: PullCollector = {
  id: SOURCE,
  kind: 'pull',
  async run(ctx) {
    const region = typeof ctx.source.options.region === 'string' ? ctx.source.options.region : 'se';
    if (!/^[a-zA-Z]{2}$/.test(region))
      throw new Error(`options.region "${region}" is not a Met Office region code like se`);
    const areas = Array.isArray(ctx.source.options.areas)
      ? ctx.source.options.areas.filter((a): a is string => typeof a === 'string')
      : [];
    const now = new Date();
    const xml = await fetchFeed(ctx.env.MET_OFFICE_FEED_URL ?? FEED_BASE + region, ctx.signal);

    let warnings: Warning[];
    try {
      warnings = parseWarningsFeed(xml, now);
    } catch (err) {
      if (err instanceof WarningsFeedError) last = null; // don't keep serving a bad copy
      throw err;
    }
    const kept = warnings.filter((w) => w.validTo > now && coversHome(w, areas));
    if (kept.some((w) => w.areas.length === 0)) {
      ctx.log.warn('a warning names no areas: alerting for it without the area filter');
    }

    for (const w of kept) {
      await openEvent(ctx.db, { sourceId: SOURCE, kind: KIND, entity: w.id, ...warningEvent(w) });
    }
    const open = await ctx.db<{ entity: string }[]>`
      select entity from events
      where source_id = ${SOURCE} and kind = ${KIND} and resolved_at is null`;
    const keptIds = new Set(kept.map((w) => w.id));
    for (const { entity } of open) {
      if (!keptIds.has(entity)) await resolveEvent(ctx.db, SOURCE, KIND, entity);
    }
    await ctx.writeReadings(warningReadings(kept, now));
    ctx.log.debug({ inFeed: warnings.length, forHome: kept.length }, 'weather warnings checked');
  },
};
