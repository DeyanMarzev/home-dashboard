import type { Sql } from '@home/db';
import {
  addLondonDays,
  clipRuns,
  condensingShare,
  heatingTips,
  HeatingSummaryQuerySchema,
  londonDateString,
  londonDayBounds,
  SHORT_CYCLE_SECONDS,
  stateRuns,
  totalSeconds,
  warmUp,
  type Freshness,
  type HeatingSummary,
  type Registry,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import type { FreshnessService } from '../freshness.js';
import { findSeries, rawReadings, type SeriesWithInterval } from '../queries.js';
import { parseInput } from '../validate.js';

const CACHE_MS = 30_000;
/** Without a known cadence, a Nest state holds for 3 × its 2-minute poll. */
const DEFAULT_HOLD_SECONDS = 360;

type Points = [string, number][];

/** GET /api/summary/heating (docs/04): boiler runtime, cycles, condensing, warm-up, tips. */
export function registerHeatingRoutes(
  app: FastifyInstance,
  {
    db,
    registry,
    freshness,
    now,
  }: { db: Sql; registry: Registry; freshness: FreshnessService; now: () => Date },
): void {
  const cache = new Map<string, { at: number; body: HeatingSummary }>();

  app.get('/api/summary/heating', async (request) => {
    const q = parseInput(HeatingSummaryQuerySchema, request.query);
    const nowAt = now();
    const date = q.date ?? londonDateString(nowAt);
    const hit = cache.get(date);
    if (hit && nowAt.getTime() - hit.at < CACHE_MS) return hit.body;
    const body = await heatingSummary(db, registry, freshness, date, nowAt);
    cache.set(date, { at: nowAt.getTime(), body });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
    return body;
  });
}

export async function heatingSummary(
  db: Sql,
  registry: Registry,
  freshness: FreshnessService,
  date: string,
  nowAt: Date,
): Promise<HeatingSummary> {
  const day = londonDayBounds(date);
  const end = new Date(Math.min(day.to.getTime(), nowAt.getTime()));
  const weekFrom = londonDayBounds(addLondonDays(date, -6)).from;
  const cadence = registry.sources.find((s) => s.id === 'nest')?.poll;
  const hold = cadence?.type === 'every' ? cadence.seconds * 3 : DEFAULT_HOLD_SECONDS;

  const [nest, probes] = await Promise.all([
    findSeries(db, { source: 'nest' }),
    findSeries(db, { source: 'boiler_probes' }),
  ]);
  const pick = (list: SeriesWithInterval[], metric: string, entity?: string) =>
    list.find(
      (s) => s.meta.metric === metric && (entity === undefined || s.meta.entity === entity),
    );
  const hvac = pick(nest, 'hvac_heating', 'boiler');
  const temperature = pick(nest, 'temperature');
  const target = pick(nest, 'target_temperature');
  const flow = pick(probes, 'temperature', 'boiler_flow');
  const ret = pick(probes, 'temperature', 'boiler_return');

  const load = async (s: SeriesWithInterval | undefined, from: Date): Promise<Points> =>
    s && from < end
      ? (await rawReadings(db, [s.meta.id], from, end)).map((r) => [r.ts.toISOString(), r.value])
      : [];
  const [hvacPoints, tempPoints, targetPoints, flowPoints, retPoints] = await Promise.all([
    load(hvac, new Date(weekFrom.getTime() - hold * 1000)),
    load(temperature, new Date(day.from.getTime() - 3600_000)),
    load(target, day.from),
    load(flow, day.from),
    load(ret, day.from),
  ]);

  const allRuns = stateRuns(hvacPoints, hold, end);
  const runs = clipRuns(allRuns, day.from, end);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addLondonDays(date, i - 6);
    const b = londonDayBounds(d);
    const clipped = clipRuns(allRuns, b.from, new Date(Math.min(b.to.getTime(), end.getTime())));
    return { date: d, minutesOn: Math.round(totalSeconds(clipped) / 60), cycles: clipped.length };
  });
  // A run still going at `end` isn't a short cycle yet.
  const shortCycles = runs.filter(
    (r) =>
      Date.parse(r.to) < end.getTime() &&
      (Date.parse(r.to) - Date.parse(r.from)) / 1000 < SHORT_CYCLE_SECONDS,
  ).length;
  const share = condensingShare(runs, retPoints);
  const flowPeakC = flowPoints.length ? Math.max(...flowPoints.map(([, v]) => v)) : null;
  const warm = warmUp(runs, tempPoints);

  const lastHvac = hvacPoints[hvacPoints.length - 1];
  const parts: Freshness[] = [];
  if (hvac) parts.push(freshness.of('nest', lastHvac ? { ts: lastHvac[0] } : null));
  const lastRet = retPoints[retPoints.length - 1];
  if (ret) parts.push(freshness.of('boiler_probes', lastRet ? { ts: lastRet[0] } : null));
  const combined = freshness.combine(parts);
  const isToday = date === londonDateString(nowAt);

  return {
    date,
    boiler: {
      heatingNow: isToday && lastHvac && combined?.state === 'live' ? lastHvac[1] === 1 : null,
      minutesOn: Math.round(totalSeconds(runs) / 60),
      cycles: runs.length,
      shortCycles,
      runs,
    },
    condensingShare: share,
    flowPeakC,
    warmUp: warm,
    days,
    setpoints: targetPoints.filter(([t]) => t >= day.from.toISOString()),
    tips: heatingTips({ flowPeakC, condensingShare: share, warmUp: warm, shortCycles }),
    freshness: combined,
  };
}
