import type { Sql } from '@home/db';
import {
  addLondonDays,
  dayCost,
  EnergySummaryQuerySchema,
  GAS_KG_CO2_PER_KWH,
  halfHourKwhToWatts,
  heatingDegreeDays,
  londonDateString,
  londonDayBounds,
  projectMonth,
  tariffOn,
  yearlyPenceForWatts,
  type EnergyDay,
  type EnergySummary,
  type TariffRow,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import type { FreshnessService } from '../freshness.js';
import { findSeries, latestOf, rawReadings } from '../queries.js';
import { parseInput } from '../validate.js';

const CACHE_MS = 30_000;
const TZ = 'Europe/London';
const DEFAULT_DAYS = 14;
const FUELS = ['electricity', 'gas'] as const;
/** Report electricity carbon only when this share of half-hours has a recorded grid intensity. */
const MIN_CARBON_COVERAGE = 0.9;

export function registerEnergyRoutes(
  app: FastifyInstance,
  { db, freshness, now }: { db: Sql; freshness: FreshnessService; now: () => Date },
): void {
  const cache = new Map<string, { at: number; body: EnergySummary }>();
  app.get('/api/summary/energy', async (request) => {
    const q = parseInput(EnergySummaryQuerySchema, request.query);
    const key = `${q.from ?? ''}|${q.to ?? ''}|${q.days ?? ''}`;
    const t = now().getTime();
    const hit = cache.get(key);
    if (hit && t - hit.at < CACHE_MS) return hit.body;
    const body = await energySummary(db, freshness, q, now());
    cache.set(key, { at: t, body });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
    return body;
  });
}

interface DayRow {
  series_id: number;
  day: string;
  value: number;
  n: number;
}

/** Daily totals (sum) or averages (avg) per London day, from the hourly rollup. */
function daily(db: Sql, ids: number[], from: Date, to: Date, agg: 'sum' | 'avg') {
  const value = agg === 'sum' ? db`sum(sum)` : db`sum(avg * n) / sum(n)`;
  return db<DayRow[]>`
    select series_id, (bucket at time zone ${TZ})::date::text as day, (${value})::float8 as value, sum(n)::int as n
    from readings_hourly
    where series_id = any(${ids}::int[]) and bucket >= ${from.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz
    group by 1, 2 order by 2`;
}

export async function energySummary(
  db: Sql,
  freshness: FreshnessService,
  q: { from?: string; to?: string; days?: number },
  nowAt: Date,
): Promise<EnergySummary> {
  const [meters, weather] = await Promise.all([
    findSeries(db, { source: 'smart_meters', metric: 'energy_import' }),
    findSeries(db, { source: 'open_meteo', metric: 'temperature', entity: 'outdoor' }),
  ]);
  const fuelSeries = Object.fromEntries(
    FUELS.map((f) => [f, meters.find((s) => s.meta.entity === f)]),
  ) as Record<(typeof FUELS)[number], (typeof meters)[number] | undefined>;
  const fuelIds = FUELS.flatMap((f) => (fuelSeries[f] ? [fuelSeries[f].meta.id] : []));
  const latest = await latestOf(db, fuelIds);

  // Default range: the 14 days ending the last day the meters cover.
  const coveredUntil = Math.min(
    ...fuelIds.map((id) => {
      const p = latest.get(id);
      const s = meters.find((m) => m.meta.id === id)!;
      return p ? p.ts.getTime() + (s.intervalSeconds ?? 0) * 1000 - 1 : -Infinity;
    }),
  );
  const to =
    q.to ??
    (Number.isFinite(coveredUntil)
      ? londonDateString(new Date(coveredUntil))
      : addLondonDays(londonDateString(nowAt), -1));
  const from = q.from ?? addLondonDays(to, -((q.days ?? DEFAULT_DAYS) - 1));
  const monthFrom = `${to.slice(0, 8)}01`;
  const queryFrom = monthFrom < from ? monthFrom : from;
  const start = londonDayBounds(queryFrom).from;
  const end = londonDayBounds(to).to;

  const [fuelRows, outdoorRows, tariffs] = await Promise.all([
    fuelIds.length ? daily(db, fuelIds, start, end, 'sum') : Promise.resolve([]),
    weather[0] ? daily(db, [weather[0].meta.id], start, end, 'avg') : Promise.resolve([]),
    db<TariffRow[]>`
      select fuel, unit_rate_pence::float8 as "unitRatePence", standing_pence::float8 as "standingPence",
             valid_from::text as "validFrom", valid_to::text as "validTo"
      from tariffs order by fuel, valid_from`,
  ]);

  const allDays: EnergyDay[] = [];
  for (let d = queryFrom; d <= to; d = addLondonDays(d, 1)) {
    const bounds = londonDayBounds(d);
    const slots = (bounds.to.getTime() - bounds.from.getTime()) / 1800_000;
    const fuel = (f: (typeof FUELS)[number]) => {
      const id = fuelSeries[f]?.meta.id;
      const row = fuelRows.find((r) => r.series_id === id && r.day === d);
      if (!row) return null;
      const tariff = tariffOn(tariffs, f, d);
      const cost = tariff ? dayCost(row.value, tariff) : null;
      return {
        kwh: row.value,
        energyPence: cost?.energyPence ?? null,
        standingPence: cost?.standingPence ?? null,
        n: row.n,
      };
    };
    const electricity = fuel('electricity');
    const gas = fuel('gas');
    const outdoor = outdoorRows.find((r) => r.day === d)?.value ?? null;
    const present = FUELS.filter((f) => fuelSeries[f]);
    allDays.push({
      date: d,
      electricity: electricity && {
        kwh: electricity.kwh,
        energyPence: electricity.energyPence,
        standingPence: electricity.standingPence,
      },
      gas: gas && { kwh: gas.kwh, energyPence: gas.energyPence, standingPence: gas.standingPence },
      complete: present.length > 0 && present.every((f) => ({ electricity, gas })[f]?.n === slots),
      outdoorC: outdoor,
      degreeDays: outdoor === null ? null : heatingDegreeDays(outdoor),
    });
  }

  const days = allDays.filter((d) => d.date >= from);
  const latestDay = [...days].reverse().find((d) => d.complete)?.date ?? null;
  const dayPence = (d: EnergyDay) =>
    FUELS.reduce((s, f) => s + (d[f]?.energyPence ?? 0) + (d[f]?.standingPence ?? 0), 0);
  const monthDays = allDays.filter((d) => d.date >= monthFrom);
  const monthPence = monthDays.reduce((s, d) => s + dayPence(d), 0);
  const counted = monthDays.filter((d) => d.electricity || d.gas).length;
  const [y, m] = to.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const projected = projectMonth(monthPence, counted, daysInMonth);

  // Baseload: the lowest half-hour overnight (00:00–05:00) on the latest complete day.
  const elec = fuelSeries.electricity;
  const nightMin = async (date: string) => {
    if (!elec) return null;
    const night = londonDayBounds(date).from;
    const rows = await rawReadings(
      db,
      [elec.meta.id],
      night,
      new Date(night.getTime() + 5 * 3600_000),
    );
    return rows.length ? Math.min(...rows.map((r) => r.value)) : null;
  };
  let baseload: EnergySummary['baseload'] = null;
  if (latestDay) {
    const [nowMin, prevMin] = await Promise.all([
      nightMin(latestDay),
      nightMin(addLondonDays(latestDay, -28)),
    ]);
    if (nowMin !== null) {
      const watts = halfHourKwhToWatts(nowMin);
      const tariff = tariffOn(tariffs, 'electricity', latestDay);
      baseload = {
        watts,
        night: latestDay,
        yearlyPence: tariff ? yearlyPenceForWatts(watts, tariff.unitRatePence) : null,
        previousWatts: prevMin === null ? null : halfHourKwhToWatts(prevMin),
      };
    }
  }

  // Carbon for the requested range: electricity × the grid intensity recorded for each half-hour.
  const rangeStart = londonDayBounds(from).from;
  const [intensity] = await findSeries(db, {
    source: 'carbon_intensity',
    metric: 'intensity',
    entity: 'grid',
  });
  let electricityKg: number | null = null;
  if (elec && intensity) {
    const [row] = await db<{ kg: number; matched: number; total: number }[]>`
      select coalesce(sum(e.value * i.value), 0)::float8 / 1000 as kg, count(i.value)::int as matched, count(*)::int as total
      from readings e
      left join readings i on i.series_id = ${intensity.meta.id} and i.ts = e.ts
      where e.series_id = ${elec.meta.id} and e.ts >= ${rangeStart.toISOString()}::timestamptz and e.ts < ${end.toISOString()}::timestamptz`;
    if (row && row.total > 0 && row.matched / row.total >= MIN_CARBON_COVERAGE)
      electricityKg = row.kg;
  }
  const gasKwh = days.reduce((s, d) => s + (d.gas?.kwh ?? 0), 0);

  const fuelFreshness = FUELS.flatMap((f) => {
    const s = fuelSeries[f];
    if (!s) return [];
    const p = latest.get(s.meta.id);
    return [
      freshness.of('smart_meters', p ? { ts: p.ts, intervalSeconds: s.intervalSeconds } : null),
    ];
  });

  return {
    from,
    to,
    latestDay,
    days,
    month: {
      from: monthFrom,
      to,
      costPence: monthPence,
      projectedPence: projected === null ? null : Math.round(projected),
    },
    baseload,
    carbon: { electricityKg, gasKg: fuelSeries.gas ? gasKwh * GAS_KG_CO2_PER_KWH : null },
    freshness: freshness.combine(fuelFreshness),
  };
}
