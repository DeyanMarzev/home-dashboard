import type { Sql } from 'postgres';

/** A phone or browser that can get pushes (docs/09 §7 This device / My devices). */
export interface DeviceRow {
  id: number;
  userId: number;
  label: string;
  createdAt: Date;
  lastSeenAt: Date;
  lastSuccessAt: Date | null;
  failureCount: number;
}

/** What the dispatcher needs to send (never logged: the keys are secrets). */
export interface PushTarget {
  id: number;
  userId: number;
  label: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const COLUMNS = (sql: Sql) => sql`
  id, user_id as "userId", label, created_at as "createdAt", last_seen_at as "lastSeenAt",
  last_success_at as "lastSuccessAt", failure_count as "failureCount"`;

/**
 * Saves a browser's push subscription for the signed-in user (POST /api/me/devices). An
 * endpoint seen before is refreshed, and moves to this user if someone else signed in on
 * that phone. `label` is used for new devices only (renames go through `renameDevice`).
 */
export async function upsertDevice(
  sql: Sql,
  d: {
    userId: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    label: string;
    userAgent: string | null;
  },
): Promise<DeviceRow> {
  const [row] = await sql<DeviceRow[]>`
    insert into push_subscriptions (user_id, endpoint, p256dh, auth, label, user_agent)
    values (${d.userId}, ${d.endpoint}, ${d.p256dh}, ${d.auth}, ${d.label}, ${d.userAgent})
    on conflict (endpoint) do update set
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      last_seen_at = now(),
      failure_count = case when push_subscriptions.user_id = excluded.user_id
                           then push_subscriptions.failure_count else 0 end
    returning ${COLUMNS(sql)}`;
  return row!;
}

export async function listDevices(sql: Sql, userId: number): Promise<DeviceRow[]> {
  return sql<DeviceRow[]>`
    select ${COLUMNS(sql)} from push_subscriptions where user_id = ${userId} order by created_at`;
}

/** Null if it isn't this user's device. */
export async function renameDevice(
  sql: Sql,
  userId: number,
  id: number,
  label: string,
): Promise<DeviceRow | null> {
  const [row] = await sql<DeviceRow[]>`
    update push_subscriptions set label = ${label}
    where id = ${id} and user_id = ${userId}
    returning ${COLUMNS(sql)}`;
  return row ?? null;
}

/** True if it was this user's device. */
export async function deleteDevice(sql: Sql, userId: number, id: number): Promise<boolean> {
  const rows = await sql`delete from push_subscriptions where id = ${id} and user_id = ${userId}`;
  return rows.count > 0;
}

export async function pushTargets(sql: Sql, userIds: number[]): Promise<PushTarget[]> {
  if (userIds.length === 0) return [];
  return sql<PushTarget[]>`
    select id, user_id as "userId", label, endpoint, p256dh, auth from push_subscriptions
    where user_id = any(${userIds}::int[]) order by id`;
}

export async function pushTarget(sql: Sql, userId: number, id: number): Promise<PushTarget | null> {
  const [row] = await sql<PushTarget[]>`
    select id, user_id as "userId", label, endpoint, p256dh, auth from push_subscriptions
    where id = ${id} and user_id = ${userId}`;
  return row ?? null;
}
