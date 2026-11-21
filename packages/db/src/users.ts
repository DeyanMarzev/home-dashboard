import type { Sql } from 'postgres';

/** A person who signed in through Cloudflare Access (docs/09 §2, migration 004). */
export interface UserRow {
  id: number;
  email: string;
  name: string | null;
  role: 'member' | 'admin';
  enabled: boolean;
  tz: string;
  /** "23:00" (local time in tz), or null when there are no quiet hours. */
  quietStart: string | null;
  quietEnd: string | null;
  urgentIgnoresQuiet: boolean;
  pausedUntil: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

const COLUMNS = (sql: Sql) => sql`
  id, email, name, role, enabled, tz,
  to_char(quiet_start, 'HH24:MI') as "quietStart", to_char(quiet_end, 'HH24:MI') as "quietEnd",
  urgent_ignores_quiet as "urgentIgnoresQuiet", paused_until as "pausedUntil",
  created_at as "createdAt", last_seen_at as "lastSeenAt"`;

/**
 * Creates or refreshes the user for a verified Access email. `admin` (from ADMIN_EMAILS) makes
 * them admin every time; otherwise their stored role is kept (new users are members).
 * `last_seen_at` moves at most every 5 minutes.
 */
export async function signInUser(
  sql: Sql,
  email: string,
  opts: { admin: boolean },
): Promise<UserRow> {
  const [row] = await sql<UserRow[]>`
    insert into users (email, role, last_seen_at)
    values (${email.trim().toLowerCase()}, ${opts.admin ? 'admin' : 'member'}, now())
    on conflict (email) do update set
      role = case when ${opts.admin} then 'admin' else users.role end,
      last_seen_at = case
        when users.last_seen_at is null or users.last_seen_at < now() - interval '5 minutes'
        then now() else users.last_seen_at end
    returning ${COLUMNS(sql)}`;
  return row!;
}

export async function getUser(sql: Sql, id: number): Promise<UserRow | null> {
  const [row] = await sql<UserRow[]>`select ${COLUMNS(sql)} from users where id = ${id}`;
  return row ?? null;
}

export async function listUsers(sql: Sql): Promise<(UserRow & { devices: number })[]> {
  return sql<(UserRow & { devices: number })[]>`
    select ${COLUMNS(sql)},
      (select count(*)::int from push_subscriptions p where p.user_id = users.id) as devices
    from users order by role, email`;
}

/** Admin changes (docs/09 §7 Users). Returns the updated user, or null if there's no such id. */
export async function updateUserAccess(
  sql: Sql,
  id: number,
  patch: { role?: 'member' | 'admin'; enabled?: boolean },
): Promise<UserRow | null> {
  const [row] = await sql<UserRow[]>`
    update users set
      role = coalesce(${patch.role ?? null}, role),
      enabled = coalesce(${patch.enabled ?? null}::boolean, enabled)
    where id = ${id}
    returning ${COLUMNS(sql)}`;
  return row ?? null;
}

export interface ProfilePatch {
  name?: string | null;
  /** Both or neither: null clears quiet hours. */
  quiet?: { start: string; end: string } | null;
  urgentIgnoresQuiet?: boolean;
  pausedUntil?: Date | null;
}

/** A user's own settings (PATCH /api/me). Only the fields given change. */
export async function updateProfile(sql: Sql, id: number, patch: ProfilePatch): Promise<UserRow> {
  const has = (k: keyof ProfilePatch) => Object.hasOwn(patch, k);
  const [row] = await sql<UserRow[]>`
    update users set
      name = case when ${has('name')} then ${patch.name ?? null} else name end,
      quiet_start = case when ${has('quiet')} then ${patch.quiet?.start ?? null}::time else quiet_start end,
      quiet_end = case when ${has('quiet')} then ${patch.quiet?.end ?? null}::time else quiet_end end,
      urgent_ignores_quiet = coalesce(${patch.urgentIgnoresQuiet ?? null}::boolean, urgent_ignores_quiet),
      paused_until = case when ${has('pausedUntil')} then ${patch.pausedUntil ?? null}::timestamptz else paused_until end
    where id = ${id}
    returning ${COLUMNS(sql)}`;
  return row!;
}
