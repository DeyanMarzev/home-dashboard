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
  /** The alert rule it belongs to, when the caller knows (threshold rules). Event rules get
   * theirs from the alert engine, which adopts open events whose kind is a rule id. */
  ruleId?: string;
  /** Custom notification title (docs/10 §1.3), stored as `data.title`. */
  title?: string;
}

/**
 * Opens an event, or updates the one already open for the same source + kind + entity (at
 * most one, enforced by a unique index; docs/10 §1.2):
 * - a higher level escalates it: `level`, `escalated_at = now()`, `dispatched_at = NULL`
 *   (the dispatcher then sends an "escalated" push);
 * - the same or a lower level only refreshes `message` and `data` (never de-escalates).
 * Returns the new id, or null if one was already open. A trigger NOTIFYs `events`.
 */
export async function openEvent(sql: Sql, event: NewEvent): Promise<number | null> {
  const data =
    event.title === undefined
      ? event.data
      : {
          ...(typeof event.data === 'object' && event.data !== null ? event.data : {}),
          title: event.title,
        };
  const json = data === undefined ? null : JSON.stringify(data);
  const [row] = await sql<{ id: string }[]>`
    insert into events (level, source_id, kind, entity, message, data, rule_id)
    values (${event.level}, ${event.sourceId}, ${event.kind}, ${event.entity ?? ''}, ${event.message},
            ${json}::text::jsonb, ${event.ruleId ?? null})
    on conflict (source_id, kind, entity) where resolved_at is null do nothing
    returning id`;
  if (row) return Number(row.id);
  const rank = event.level === 'alert' ? 2 : event.level === 'warning' ? 1 : 0;
  const higher = sql`${rank}::int > case level when 'alert' then 2 when 'warning' then 1 else 0 end`;
  await sql`
    update events set
      level = case when ${higher} then ${event.level} else level end,
      escalated_at = case when ${higher} then now() else escalated_at end,
      dispatched_at = case when ${higher} then null else dispatched_at end,
      message = ${event.message},
      data = ${json}::text::jsonb,
      rule_id = coalesce(${event.ruleId ?? null}, rule_id)
    where source_id = ${event.sourceId} and kind = ${event.kind} and entity = ${event.entity ?? ''}
      and resolved_at is null`;
  return null;
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
