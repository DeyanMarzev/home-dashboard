import type { Sql } from '@home/db';
import { toIsoDuration, type SeriesMeta, type ValueType } from '@home/shared';

interface SeriesRow {
  id: number;
  source_id: string;
  metric: string;
  entity: string;
  unit: string;
  value_type: ValueType;
  interval_seconds: number | null;
  label: string | null;
}

export interface SeriesWithInterval {
  meta: SeriesMeta;
  intervalSeconds: number | null;
}

const toMeta = (r: SeriesRow): SeriesWithInterval => ({
  meta: {
    id: r.id,
    sourceId: r.source_id,
    metric: r.metric,
    entity: r.entity,
    unit: r.unit,
    valueType: r.value_type,
    ...(r.interval_seconds !== null && { interval: toIsoDuration(r.interval_seconds) }),
    ...(r.label !== null && { label: r.label }),
  },
  intervalSeconds: r.interval_seconds,
});

export interface SeriesFilter {
  ids?: number[];
  source?: string;
  metric?: string;
  entity?: string;
}

/** Series matching every given filter, ordered by source, metric, entity. */
export async function findSeries(sql: Sql, f: SeriesFilter): Promise<SeriesWithInterval[]> {
  const rows = await sql<SeriesRow[]>`
    select id, source_id, metric, entity, unit, value_type,
           extract(epoch from interval)::int as interval_seconds, label
    from series
    where true
      ${f.ids ? sql`and id = any(${f.ids}::int[])` : sql``}
      ${f.source ? sql`and source_id = ${f.source}` : sql``}
      ${f.metric ? sql`and metric = ${f.metric}` : sql``}
      ${f.entity !== undefined ? sql`and entity = ${f.entity}` : sql``}
    order by source_id, metric, entity`;
  return rows.map(toMeta);
}

/** Latest reading of each series (null when it has none). */
export async function latestOf(
  sql: Sql,
  ids: number[],
): Promise<Map<number, { ts: Date; value: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ series_id: number; latest_ts: Date; value: number }[]>`
    select series_id, latest_ts, value from series_latest
    where series_id = any(${ids}::int[]) and latest_ts is not null`;
  return new Map(rows.map((r) => [r.series_id, { ts: r.latest_ts, value: r.value }]));
}

export interface BucketRow {
  series_id: number;
  t: Date;
  avg: number;
  sum: number;
  min: number;
  max: number;
}

/** Raw readings in [from, to). */
export async function rawReadings(sql: Sql, ids: number[], from: Date, to: Date) {
  return sql<{ series_id: number; ts: Date; value: number }[]>`
    select series_id, ts, value from readings
    where series_id = any(${ids}::int[]) and ts >= ${from.toISOString()}::timestamptz and ts < ${to.toISOString()}::timestamptz
    order by series_id, ts`;
}

export async function countReadings(
  sql: Sql,
  ids: number[],
  from: Date,
  to: Date,
): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select coalesce(max(n), 0)::int as n from (
      select count(*) as n from readings
      where series_id = any(${ids}::int[]) and ts >= ${from.toISOString()}::timestamptz and ts < ${to.toISOString()}::timestamptz
      group by series_id) c`;
  return row?.n ?? 0;
}

/** 5 m / 15 m buckets straight from raw readings (date_bin works with or without Timescale). */
export async function bucketsFromRaw(
  sql: Sql,
  ids: number[],
  from: Date,
  to: Date,
  seconds: number,
) {
  return sql<BucketRow[]>`
    select series_id, date_bin(make_interval(secs => ${seconds}::int), ts, timestamptz '2000-01-01') as t,
           avg(value)::float8 as avg, sum(value)::float8 as sum, min(value)::float8 as min, max(value)::float8 as max
    from readings
    where series_id = any(${ids}::int[]) and ts >= ${from.toISOString()}::timestamptz and ts < ${to.toISOString()}::timestamptz
    group by 1, 2 order by 1, 2`;
}

/**
 * 1 h buckets, or 1 d buckets on calendar days in `tz` (Europe/London: 23 h and 25 h days at
 * the clock changes), from the hourly rollup. Averages are weighted by sample count.
 */
export async function bucketsFromHourly(
  sql: Sql,
  ids: number[],
  from: Date,
  to: Date,
  bucket: '1h' | '1d',
  tz: string,
) {
  const t = bucket === '1h' ? sql`bucket` : sql`date_trunc('day', bucket, ${tz})`;
  return sql<BucketRow[]>`
    select series_id, ${t} as t,
           (sum(avg * n) / sum(n))::float8 as avg, sum(sum)::float8 as sum,
           min(min)::float8 as min, max(max)::float8 as max
    from readings_hourly
    where series_id = any(${ids}::int[]) and bucket >= ${from.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz
    group by 1, 2 order by 1, 2`;
}
