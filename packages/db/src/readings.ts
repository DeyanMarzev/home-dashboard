import type { ReadingInput, ValueType } from '@home/shared';
import type { Sql, TransactionSql } from 'postgres';
import {
  chunk,
  latestPerSeries,
  prepareBatch,
  ReadingBatchError,
  seriesKey,
  specConflict,
  type SeriesSpec,
} from './batch.js';

/** Postgres NOTIFY channel; payload `{ seriesId, ts, value }` of each series' newest row. */
export const READINGS_CHANNEL = 'readings';

const ROWS_PER_STATEMENT = 5000;

interface SeriesRow {
  id: number;
  metric: string;
  entity: string;
  unit: string;
  value_type: ValueType;
  interval_seconds: number | null;
}

export interface ReadingWriter {
  /**
   * Validates and upserts readings for one source: creates missing series, upserts on
   * (series_id, ts) so re-sent windows never duplicate, and NOTIFYs each series' newest point.
   * All in one transaction. Returns the number of rows written.
   */
  write(sourceId: string, inputs: readonly ReadingInput[]): Promise<number>;
}

export function createReadingWriter(sql: Sql): ReadingWriter {
  // Series ids by `${sourceId}|${metric}|${entity}`. Only filled after a commit.
  const cache = new Map<string, SeriesRow>();

  return {
    async write(sourceId, inputs) {
      if (inputs.length === 0) return 0;
      const batch = prepareBatch(inputs);

      const resolved = await sql.begin(async (tx) => {
        const ids = await resolveSeries(tx, sourceId, batch.series, cache);

        for (const part of chunk(batch.rows, ROWS_PER_STATEMENT)) {
          await tx`
            insert into readings (series_id, ts, value)
            select * from unnest(
              ${part.map((r) => ids.get(r.key)!.id)}::int[],
              ${part.map((r) => r.ts.toISOString())}::timestamptz[],
              ${part.map((r) => r.value)}::float8[]
            )
            on conflict (series_id, ts) do update
              set value = excluded.value, received_at = now()`;
        }

        // Delivered when the transaction commits, so listeners never see uncommitted data.
        const payloads = latestPerSeries(batch.rows).map((r) =>
          JSON.stringify({ seriesId: ids.get(r.key)!.id, ts: r.ts.toISOString(), value: r.value }),
        );
        await tx`select pg_notify(${READINGS_CHANNEL}, p) from unnest(${payloads}::text[]) as p`;
        return ids;
      });

      for (const [key, row] of resolved) cache.set(`${sourceId}|${key}`, row);
      return batch.rows.length;
    },
  };
}

/** Finds or creates every series in the batch; throws if one exists with a different shape. */
async function resolveSeries(
  tx: TransactionSql,
  sourceId: string,
  specs: SeriesSpec[],
  cache: Map<string, SeriesRow>,
): Promise<Map<string, SeriesRow>> {
  const ids = new Map<string, SeriesRow>();
  const missing: SeriesSpec[] = [];
  for (const spec of specs) {
    const hit = cache.get(`${sourceId}|${spec.key}`);
    if (hit) ids.set(spec.key, hit);
    else missing.push(spec);
  }

  if (missing.length > 0) {
    // `do update` (a no-op on label unless given) so existing rows come back in `returning`.
    const rows = await tx<SeriesRow[]>`
      insert into series as cur (source_id, metric, entity, unit, value_type, interval, label)
      select ${sourceId}, metric, entity, unit, value_type,
             case when secs is null then null else make_interval(secs => secs) end, label
      from unnest(
        ${missing.map((s) => s.metric)}::text[],
        ${missing.map((s) => s.entity)}::text[],
        ${missing.map((s) => s.unit)}::text[],
        ${missing.map((s) => s.valueType)}::text[],
        ${missing.map((s) => s.intervalSeconds)}::int[],
        ${missing.map((s) => s.label)}::text[]
      ) as t(metric, entity, unit, value_type, secs, label)
      on conflict (source_id, metric, entity) do update
        set label = coalesce(excluded.label, cur.label)
      returning id, metric, entity, unit, value_type,
                extract(epoch from interval)::int as interval_seconds`;
    for (const row of rows) ids.set(seriesKey(row.metric, row.entity), row);
  }

  for (const spec of specs) {
    const row = ids.get(spec.key);
    if (!row) throw new ReadingBatchError(`Series ${sourceId}/${spec.key} could not be created`);
    const conflict = specConflict(
      { unit: row.unit, valueType: row.value_type, intervalSeconds: row.interval_seconds },
      spec,
    );
    // The transaction rolls back, so nothing from this batch is written.
    if (conflict) throw new ReadingBatchError(`Series ${sourceId}/${spec.key}: ${conflict}`);
  }
  return ids;
}

/**
 * The newest instant a series' data covers (latest ts, plus the interval for interval_total),
 * or null if it has no readings. Collectors use it to resume where they left off.
 */
export async function lastDataTo(
  sql: Sql,
  sourceId: string,
  metric: string,
  entity = '',
): Promise<Date | null> {
  const [row] = await sql<{ data_to: Date | null }[]>`
    select l.ts + coalesce(s.interval, interval '0') as data_to
    from series s
    join lateral (
      select ts from readings r where r.series_id = s.id order by ts desc limit 1
    ) l on true
    where s.source_id = ${sourceId} and s.metric = ${metric} and s.entity = ${entity}`;
  return row?.data_to ?? null;
}
