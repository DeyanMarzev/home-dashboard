import type { Sql } from 'postgres';

/** Postgres NOTIFY channel; payload is the event id (the API pushes it over SSE). */
export const EVENTS_CHANNEL = 'events';

export type EventLevel = 'info' | 'warning' | 'alert';

export interface NewEvent {
  level: EventLevel;
  sourceId: string | null;
  kind: string;
  message: string;
  data?: unknown;
}

/**
 * Opens an event unless one of the same kind is already open for the source (at most one
 * open per source + kind, enforced by a unique index). Returns the new id, or null if one
 * was already open.
 */
export async function openEvent(sql: Sql, event: NewEvent): Promise<number | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into events (level, source_id, kind, message, data)
      values (${event.level}, ${event.sourceId}, ${event.kind}, ${event.message},
              ${event.data === undefined ? null : JSON.stringify(event.data)}::jsonb)
      on conflict (source_id, kind) where resolved_at is null do nothing
      returning id`;
    if (!row) return null;
    await tx`select pg_notify(${EVENTS_CHANNEL}, ${row.id})`;
    return Number(row.id);
  });
}

/** Resolves the open event of this kind for the source, if any. Returns its id or null. */
export async function resolveEvent(
  sql: Sql,
  sourceId: string,
  kind: string,
): Promise<number | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      update events set resolved_at = now()
      where source_id = ${sourceId} and kind = ${kind} and resolved_at is null
      returning id`;
    if (!row) return null;
    await tx`select pg_notify(${EVENTS_CHANNEL}, ${row.id})`;
    return Number(row.id);
  });
}
