import { latestBySource, type Sql } from '@home/db';
import {
  EventsQuerySchema,
  formatDuration,
  freshnessPolicy,
  LatestQuerySchema,
  MAX_POINTS,
  ReadingsQuerySchema,
  SeriesQuerySchema,
  TariffsPutSchema,
  type EventItem,
  type LatestResponse,
  type ReadingsResponse,
  type Registry,
  type SourceInfo,
  type Tariff,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../errors.js';
import type { FreshnessService } from '../freshness.js';
import {
  bucketsFromHourly,
  bucketsFromRaw,
  countReadings,
  findSeries,
  latestOf,
  rawReadings,
  type BucketRow,
} from '../queries.js';
import {
  BUCKET_SECONDS,
  chooseAggregate,
  chooseBucket,
  MAX_RANGE_SECONDS,
  smallestFitting,
} from '../readings-plan.js';
import { parseInput } from '../validate.js';

export interface DataDeps {
  db: Sql;
  registry: Registry;
  freshness: FreshnessService;
  now: () => Date;
}

/** Cache for GET /api/sources (docs/04 § Performance). */
const SOURCES_CACHE_MS = 30_000;
const DEFAULT_RANGE_MS = 24 * 3600_000;

interface EventRow {
  id: string;
  ts: Date;
  level: EventItem['level'];
  source_id: string | null;
  kind: string;
  message: string;
  data: unknown;
  resolved_at: Date | null;
}

export const toEventItem = (r: EventRow): EventItem => ({
  id: Number(r.id),
  ts: r.ts.toISOString(),
  level: r.level,
  sourceId: r.source_id,
  kind: r.kind,
  message: r.message,
  data: r.data,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
});

export async function findEvent(sql: Sql, id: number): Promise<EventItem | null> {
  const [row] = await sql<EventRow[]>`
    select id, ts, level, source_id, kind, message, data, resolved_at from events where id = ${id}`;
  return row ? toEventItem(row) : null;
}

export function registerDataRoutes(
  app: FastifyInstance,
  { db, registry, freshness, now }: DataDeps,
): void {
  // --- GET /api/sources ----------------------------------------------------------------
  let sourcesCache: { at: number; body: SourceInfo[] } | null = null;

  app.get('/api/sources', async () => {
    const t = now().getTime();
    if (sourcesCache && t - sourcesCache.at < SOURCES_CACHE_MS) return sourcesCache.body;

    const [latest, runs, errors] = await Promise.all([
      latestBySource(db),
      db<
        {
          source_id: string;
          started_at: Date;
          finished_at: Date | null;
          ok: boolean | null;
          rows_written: number | null;
          error: string | null;
        }[]
      >`
        select distinct on (source_id) source_id, started_at, finished_at, ok, rows_written, error
        from collector_runs order by source_id, started_at desc`,
      db<{ source_id: string; n: number }[]>`
        select source_id, count(*)::int as n from collector_runs
        where ok = false and started_at > ${new Date(t - 86400_000).toISOString()}::timestamptz group by source_id`,
    ]);
    const lastRun = new Map(runs.map((r) => [r.source_id, r]));
    const errorCount = new Map(errors.map((r) => [r.source_id, r.n]));

    const body = registry.sources.map((s): SourceInfo => {
      const run = lastRun.get(s.id);
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        kind: s.kind,
        poll:
          s.poll === null
            ? null
            : s.poll.type === 'every'
              ? formatDuration(s.poll.seconds)
              : `cron: ${s.poll.expression}`,
        pushInterval: s.pushIntervalSeconds === null ? null : formatDuration(s.pushIntervalSeconds),
        expectedDelay: formatDuration(s.expectedDelaySeconds),
        enabled: s.enabled,
        policy: freshnessPolicy(s),
        freshness: freshness.of(s.id, latest.get(s.id) ?? null),
        lastRun: run
          ? {
              startedAt: run.started_at.toISOString(),
              finishedAt: run.finished_at?.toISOString() ?? null,
              ok: run.ok,
              rowsWritten: run.rows_written,
              durationMs: run.finished_at
                ? run.finished_at.getTime() - run.started_at.getTime()
                : null,
              error: run.error,
            }
          : null,
        errors24h: errorCount.get(s.id) ?? 0,
      };
    });
    sourcesCache = { at: t, body };
    return body;
  });

  // --- GET /api/series -----------------------------------------------------------------
  app.get('/api/series', async (request) => {
    const q = parseInput(SeriesQuerySchema, request.query);
    return (await findSeries(db, q)).map((s) => s.meta);
  });

  // --- GET /api/latest -----------------------------------------------------------------
  app.get('/api/latest', async (request): Promise<LatestResponse> => {
    const q = parseInput(LatestQuerySchema, request.query);
    const series = await findSeries(db, {
      ids: q.series,
      source: q.source,
      metric: q.metric,
      entity: q.entity,
    });
    const latest = await latestOf(
      db,
      series.map((s) => s.meta.id),
    );
    const items = series.map(({ meta, intervalSeconds }) => {
      const point = latest.get(meta.id);
      return {
        series: meta,
        ts: point?.ts.toISOString() ?? null,
        value: point?.value ?? null,
        freshness: freshness.of(meta.sourceId, point ? { ts: point.ts, intervalSeconds } : null),
      };
    });
    return { items, freshness: freshness.combine(items.map((i) => i.freshness)) };
  });

  // --- GET /api/readings ---------------------------------------------------------------
  app.get('/api/readings', async (request): Promise<ReadingsResponse> => {
    const q = parseInput(ReadingsQuerySchema, request.query);
    const to = q.to ? new Date(q.to) : now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
    if (from >= to) throw new HttpError(400, 'BAD_REQUEST', 'from must be before to');
    const rangeSeconds = (to.getTime() - from.getTime()) / 1000;
    if (rangeSeconds > MAX_RANGE_SECONDS) {
      throw new HttpError(
        400,
        'BAD_REQUEST',
        `range is longer than ${MAX_RANGE_SECONDS / 86400} days`,
      );
    }

    const found = await findSeries(db, { ids: q.series });
    const missing = q.series.filter((id) => !found.some((s) => s.meta.id === id));
    if (missing.length)
      throw new HttpError(404, 'NOT_FOUND', `Unknown series: ${missing.join(', ')}`);
    const ordered = q.series.map((id) => found.find((s) => s.meta.id === id)!);
    const ids = q.series;

    let bucket = chooseBucket(q.bucket, rangeSeconds);
    if (bucket === 'raw' && (await countReadings(db, ids, from, to)) > MAX_POINTS)
      bucket = smallestFitting(rangeSeconds);

    const points = new Map<number, [string, number][]>(ids.map((id) => [id, []]));
    if (bucket === 'raw') {
      for (const r of await rawReadings(db, ids, from, to))
        points.get(r.series_id)!.push([r.ts.toISOString(), r.value]);
    } else {
      const rows: BucketRow[] =
        bucket === '1h' || bucket === '1d'
          ? await bucketsFromHourly(db, ids, from, to, bucket, q.tz)
          : await bucketsFromRaw(db, ids, from, to, BUCKET_SECONDS[bucket]);
      const aggOf = new Map(
        ordered.map((s) => [s.meta.id, chooseAggregate(q.agg, s.meta.valueType)]),
      );
      for (const r of rows)
        points.get(r.series_id)!.push([r.t.toISOString(), r[aggOf.get(r.series_id)!]]);
    }

    const latest = await latestOf(db, ids);
    const series = ordered.map(({ meta, intervalSeconds }) => {
      const point = latest.get(meta.id);
      return {
        meta,
        points: points.get(meta.id)!,
        freshness: freshness.of(meta.sourceId, point ? { ts: point.ts, intervalSeconds } : null),
      };
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      series,
      freshness: freshness.combine(series.map((s) => s.freshness)),
    };
  });

  // --- GET /api/events -----------------------------------------------------------------
  app.get('/api/events', async (request) => {
    const q = parseInput(EventsQuerySchema, request.query);
    const rows = await db<EventRow[]>`
      select id, ts, level, source_id, kind, message, data, resolved_at from events
      ${q.level ? db`where level = ${q.level}` : db``}
      order by ts desc, id desc limit ${q.limit}`;
    return { items: rows.map(toEventItem) };
  });

  // --- GET / PUT /api/tariffs ----------------------------------------------------------
  const listTariffs = async (sql: Sql = db): Promise<{ items: Tariff[] }> => {
    const rows = await sql<
      {
        id: number;
        fuel: Tariff['fuel'];
        unit_rate: number;
        standing: number;
        valid_from: string;
        valid_to: string | null;
      }[]
    >`
      select id, fuel, unit_rate_pence::float8 as unit_rate, standing_pence::float8 as standing,
             valid_from::text as valid_from, valid_to::text as valid_to
      from tariffs order by fuel, valid_from`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        fuel: r.fuel,
        unitRatePence: r.unit_rate,
        standingPence: r.standing,
        validFrom: r.valid_from,
        validTo: r.valid_to,
      })),
    };
  };

  app.get('/api/tariffs', () => listTariffs());

  app.put('/api/tariffs', async (request) => {
    const { items } = parseInput(TariffsPutSchema, request.body);
    await db.begin(async (tx) => {
      await tx`delete from tariffs`;
      if (items.length > 0) {
        await tx`
          insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from, valid_to)
          select * from unnest(
            ${items.map((t) => t.fuel)}::text[], ${items.map((t) => t.unitRatePence)}::numeric[],
            ${items.map((t) => t.standingPence)}::numeric[], ${items.map((t) => t.validFrom)}::date[],
            ${items.map((t) => t.validTo)}::date[])`;
      }
    });
    request.log.info({ count: items.length }, 'tariffs replaced');
    return listTariffs();
  });
}
