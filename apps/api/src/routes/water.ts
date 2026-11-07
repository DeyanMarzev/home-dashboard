import type { Sql } from '@home/db';
import {
  addLondonDays,
  leakStatus,
  londonDateString,
  londonDayBounds,
  nightMinimums,
  tariffOn,
  waterDayPence,
  WaterSummaryQuerySchema,
  type TariffRow,
  type WaterSummary,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import type { FreshnessService } from '../freshness.js';
import { findSeries, latestOf, rawReadings } from '../queries.js';
import { parseInput } from '../validate.js';

const CACHE_MS = 30_000;
const DEFAULT_DAYS = 28;
const TZ = 'Europe/London';

export function registerWaterRoutes(
  app: FastifyInstance,
  { db, freshness, now }: { db: Sql; freshness: FreshnessService; now: () => Date },
): void {
  const cache = new Map<string, { at: number; body: WaterSummary }>();
  app.get('/api/summary/water', async (request) => {
    const q = parseInput(WaterSummaryQuerySchema, request.query);
    const key = `${q.from ?? ''}|${q.to ?? ''}|${q.days ?? ''}`;
    const t = now().getTime();
    const hit = cache.get(key);
    if (hit && t - hit.at < CACHE_MS) return hit.body;
    const body = await waterSummary(db, freshness, q, now());
    cache.set(key, { at: t, body });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
    return body;
  });
}

/** Daily litres, the latest day hour by hour, night minimums and leak status (docs/04). */
export async function waterSummary(
  db: Sql,
  freshness: FreshnessService,
  q: { from?: string; to?: string; days?: number },
  nowAt: Date,
): Promise<WaterSummary> {
  const [volume] = await findSeries(db, {
    source: 'thames_water',
    metric: 'volume',
    entity: 'mains',
  });
  const [meter] = await findSeries(db, {
    source: 'thames_water',
    metric: 'meter_reading',
    entity: 'mains',
  });
  const latest = await latestOf(
    db,
    [volume?.meta.id, meter?.meta.id].filter((id): id is number => id !== undefined),
  );
  const lastVolume = volume ? latest.get(volume.meta.id) : undefined;
  const intervalMs = (volume?.intervalSeconds ?? 3600) * 1000;

  const to =
    q.to ??
    (lastVolume
      ? londonDateString(new Date(lastVolume.ts.getTime() + intervalMs - 1))
      : addLondonDays(londonDateString(nowAt), -1));
  const from = q.from ?? addLondonDays(to, -((q.days ?? DEFAULT_DAYS) - 1));
  const start = londonDayBounds(from).from;
  const end = londonDayBounds(to).to;

  const [rows, tariffs] = await Promise.all([
    volume
      ? db<{ day: string; litres: number; n: number }[]>`
          select (bucket at time zone ${TZ})::date::text as day, sum(sum)::float8 as litres, sum(n)::int as n
          from readings_hourly
          where series_id = ${volume.meta.id} and bucket >= ${start.toISOString()}::timestamptz and bucket < ${end.toISOString()}::timestamptz
          group by 1 order by 1`
      : Promise.resolve([]),
    db<TariffRow[]>`
      select fuel, unit_rate_pence::float8 as "unitRatePence", standing_pence::float8 as "standingPence",
             valid_from::text as "validFrom", valid_to::text as "validTo"
      from tariffs where fuel = 'water' order by valid_from`,
  ]);

  const days: WaterSummary['days'] = [];
  for (let d = from; d <= to; d = addLondonDays(d, 1)) {
    const bounds = londonDayBounds(d);
    const hours = (bounds.to.getTime() - bounds.from.getTime()) / 3600_000;
    const row = rows.find((r) => r.day === d);
    const tariff = tariffOn(tariffs, 'water', d);
    days.push({
      date: d,
      litres: row ? row.litres : null,
      costPence: row && tariff ? waterDayPence(row.litres, tariff) : null,
      complete: !!row && row.n === hours,
    });
  }
  const latestDay = [...days].reverse().find((d) => d.complete)?.date ?? null;

  // Hourly points for the whole range: the latest day's profile, and every night's minimum.
  const hourlyRows = volume ? await rawReadings(db, [volume.meta.id], start, end) : [];
  const hourlyAll = hourlyRows.map((r) => [r.ts.toISOString(), r.value] as [string, number]);
  const latestBounds = latestDay ? londonDayBounds(latestDay) : null;
  const nights = nightMinimums(hourlyAll);

  return {
    from,
    to,
    latestDay,
    days,
    hourly: latestBounds
      ? hourlyAll.filter(
          ([t]) => t >= latestBounds.from.toISOString() && t < latestBounds.to.toISOString(),
        )
      : [],
    nights,
    leak: leakStatus(nights),
    meterReadingM3: meter ? (latest.get(meter.meta.id)?.value ?? null) : null,
    freshness: volume
      ? freshness.of(
          'thames_water',
          lastVolume ? { ts: lastVolume.ts, intervalSeconds: volume.intervalSeconds } : null,
        )
      : null,
  };
}
