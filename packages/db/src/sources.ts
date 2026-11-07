import type { Registry } from '@home/shared';
import type { Sql } from 'postgres';
import { silentLogger, type Logger } from './logger.js';

export interface SyncResult {
  /** Sources inserted or changed. */
  changed: string[];
  /** Sources in the database but no longer in the registry, now disabled (history is kept). */
  disabled: string[];
}

/** Mirrors the registry into the `sources` table. Idempotent; only touches rows that differ. */
export async function syncSources(
  sql: Sql,
  registry: Registry,
  log: Logger = silentLogger,
): Promise<SyncResult> {
  const s = registry.sources;
  const ids = s.map((x) => x.id);

  return sql.begin(async (tx) => {
    const changed = await tx<{ id: string }[]>`
      insert into sources as cur (id, name, kind, poll_interval, expected_delay, grace, enabled, updated_at)
      select id, name, kind,
             case when poll is null then null else make_interval(secs => poll) end,
             make_interval(secs => delay),
             case when grace is null then null else make_interval(secs => grace) end,
             enabled, now()
      from unnest(
        ${ids}::text[],
        ${s.map((x) => x.name)}::text[],
        ${s.map((x) => x.kind)}::text[],
        ${s.map((x) => (x.poll?.type === 'every' ? x.poll.seconds : null))}::int[],
        ${s.map((x) => x.expectedDelaySeconds)}::int[],
        ${s.map((x) => x.graceSeconds)}::int[],
        ${s.map((x) => x.enabled)}::boolean[]
      ) as t(id, name, kind, poll, delay, grace, enabled)
      on conflict (id) do update set
        name = excluded.name, kind = excluded.kind, poll_interval = excluded.poll_interval,
        expected_delay = excluded.expected_delay, grace = excluded.grace,
        enabled = excluded.enabled, updated_at = now()
      where (cur.name, cur.kind, cur.poll_interval, cur.expected_delay, cur.grace, cur.enabled)
        is distinct from
            (excluded.name, excluded.kind, excluded.poll_interval, excluded.expected_delay, excluded.grace, excluded.enabled)
      returning id`;

    const disabled = await tx<{ id: string }[]>`
      update sources set enabled = false, updated_at = now()
      where enabled and id <> all(${ids}::text[])
      returning id`;

    const result = { changed: changed.map((r) => r.id), disabled: disabled.map((r) => r.id) };
    if (result.changed.length || result.disabled.length) {
      log.info(result, 'source registry synced to database');
    }
    return result;
  });
}
