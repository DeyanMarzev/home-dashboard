import type { LatestPoint } from '@home/shared';
import type { Sql } from 'postgres';

/**
 * Metrics named `forecast_*` are predictions with future timestamps. They never count
 * towards freshness, or a dead weather source would look Live for the next 24 h.
 */
export const FORECAST_METRIC_PREFIX = 'forecast_';

/**
 * The newest data point of each source: from the series whose data reaches furthest
 * (latest ts, plus the interval for interval_total), forecasts excluded. Sources that never
 * reported are absent from the map.
 */
export async function latestBySource(sql: Sql): Promise<Map<string, LatestPoint>> {
  const rows = await sql<{ source_id: string; latest_ts: Date; interval_seconds: number | null }[]>`
    select distinct on (s.source_id)
           s.source_id, l.ts as latest_ts, extract(epoch from s.interval)::int as interval_seconds
    from series s
    join lateral (
      select ts from readings r where r.series_id = s.id order by ts desc limit 1
    ) l on true
    where s.metric not like ${FORECAST_METRIC_PREFIX.replace('_', '\\_') + '%'}
    order by s.source_id, l.ts + coalesce(s.interval, interval '0') desc`;
  return new Map(
    rows.map((r) => [r.source_id, { ts: r.latest_ts, intervalSeconds: r.interval_seconds }]),
  );
}
