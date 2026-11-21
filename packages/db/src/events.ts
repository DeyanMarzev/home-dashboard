import type { Sql } from 'postgres';

/** Postgres NOTIFY channel; payload is the event id (the API pushes it over SSE). */
export const EVENTS_CHANNEL = 'events';

export type EventLevel = 'info' | 'warning' | 'alert';

export interface NewEvent {
  level: EventLevel;
  sourceId: string | null;
  kind: string;
  /** Room, device or warning id the event is about; '' (default) = the whole source. */
  entity?: string;
  message: string;
  data?: unknown;
}

/**
 * Opens an event unless one of the same kind is already open for the source and entity (at
 * most one open per source + kind + entity, enforced by a unique index). Returns the new id,
 * or null if one was already open. A trigger NOTIFYs `events` (migration 004).
 */
export async function openEvent(sql: Sql, event: NewEvent): Promise<number | null> {
  const [row] = await sql<{ id: string }[]>`
    insert into events (level, source_id, kind, entity, message, data)
    values (${event.level}, ${event.sourceId}, ${event.kind}, ${event.entity ?? ''}, ${event.message},
            ${event.data === undefined ? null : JSON.stringify(event.data)}::jsonb)
    on conflict (source_id, kind, entity) where resolved_at is null do nothing
    returning id`;
  return row ? Number(row.id) : null;
}

/** Resolves the open event of this kind for the source (and entity), if any. Returns its id or null. */
export async function resolveEvent(
  sql: Sql,
  sourceId: string,
  kind: string,
  entity = '',
): Promise<number | null> {
  const [row] = await sql<{ id: string }[]>`
    update events set resolved_at = now()
    where source_id = ${sourceId} and kind = ${kind} and entity = ${entity} and resolved_at is null
    returning id`;
  return row ? Number(row.id) : null;
}
