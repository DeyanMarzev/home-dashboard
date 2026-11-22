import type { Sql } from 'postgres';

/** One device in a network scan (docs/10 §5). */
export interface SeenNetworkDevice {
  mac: string;
  ip: string | null;
  vendor: string | null;
  hostname: string | null;
  wired: boolean | null;
  randomised: boolean;
}

export interface NetworkDeviceRow {
  mac: string;
  firstSeen: Date;
  lastSeen: Date;
  lastIp: string | null;
  hostname: string | null;
  vendor: string | null;
  randomised: boolean;
  wired: boolean | null;
  label: string | null;
  known: boolean;
  markedKnownBy: string | null;
  markedKnownAt: Date | null;
  /** On the network now (seen within the away time). */
  present: boolean;
  /** The asking user's reminders for this device (false when listed without a user). */
  watchConnect: boolean;
  watchLeave: boolean;
}

export interface ScanResult {
  /** Never seen before (alert: new device). */
  fresh: SeenNetworkDevice[];
  /** Back after being away (marked absent by `markDepartures`). */
  arrived: string[];
}

const COLUMNS = (sql: Sql) => sql`
  d.mac, d.first_seen as "firstSeen", d.last_seen as "lastSeen", host(d.last_ip) as "lastIp",
  d.hostname, d.vendor, d.randomised, d.wired, d.label, d.known,
  coalesce(u.name, u.email) as "markedKnownBy", d.marked_known_at as "markedKnownAt", d.present`;

/**
 * Records one scan. The very first scan (empty table) is the baseline: everything is known
 * and nothing is new. After that, a MAC never seen before is stored as unknown and returned,
 * once: the next scans only refresh it. Devices that had been marked away are back.
 */
export async function recordNetworkScan(
  sql: Sql,
  devices: readonly SeenNetworkDevice[],
): Promise<ScanResult> {
  if (devices.length === 0) return { fresh: [], arrived: [] };
  return sql.begin(async (tx) => {
    // One scan at a time, so two can't both see an empty table.
    await tx`select pg_advisory_xact_lock(hashtext('network_devices'))`;
    const [state] = await tx<{ empty: boolean }[]>`
      select not exists (select 1 from network_devices) as empty`;
    const empty = state?.empty ?? true;
    const away = await tx<{ mac: string }[]>`
      select mac from network_devices
      where not present and mac = any(${devices.map((d) => d.mac)}::text[])`;
    const rows = await tx<{ mac: string; inserted: boolean }[]>`
      insert into network_devices (mac, last_ip, hostname, vendor, randomised, wired, known)
      select mac, ip::inet, hostname, vendor, randomised, wired, ${empty}
      from unnest(${devices.map((d) => d.mac)}::text[], ${devices.map((d) => d.ip)}::text[],
                  ${devices.map((d) => d.hostname)}::text[], ${devices.map((d) => d.vendor)}::text[],
                  ${devices.map((d) => d.randomised)}::boolean[], ${devices.map((d) => d.wired)}::boolean[])
        as t(mac, ip, hostname, vendor, randomised, wired)
      on conflict (mac) do update set
        last_seen = now(),
        present = true,
        last_ip = coalesce(excluded.last_ip, network_devices.last_ip),
        hostname = coalesce(excluded.hostname, network_devices.hostname),
        vendor = coalesce(network_devices.vendor, excluded.vendor),
        wired = coalesce(excluded.wired, network_devices.wired)
      returning mac, (xmax = 0) as inserted`;
    if (empty) return { fresh: [], arrived: [] };
    const added = new Set(rows.filter((r) => r.inserted).map((r) => r.mac));
    return { fresh: devices.filter((d) => added.has(d.mac)), arrived: away.map((r) => r.mac) };
  });
}

/**
 * Devices not seen for `awayMinutes` are now away. Call right after recording a scan, so
 * an outage of the scanner itself never counts as everyone leaving. Returns them.
 */
export async function markDepartures(sql: Sql, awayMinutes: number): Promise<string[]> {
  const rows = await sql<{ mac: string }[]>`
    update network_devices set present = false
    where present and last_seen < now() - make_interval(mins => ${awayMinutes})
    returning mac`;
  return rows.map((r) => r.mac);
}

/** Who wants to hear when this device connects (or leaves). */
export async function deviceWatchers(
  sql: Sql,
  mac: string,
  on: 'connect' | 'leave',
): Promise<number[]> {
  const rows = await sql<{ user_id: number }[]>`
    select user_id from network_device_watches
    where mac = ${mac} and ${on === 'connect' ? sql`on_connect` : sql`on_leave`}`;
  return rows.map((r) => r.user_id);
}

/** One person's reminders for a device; both off removes them. False if there's no such device. */
export async function setDeviceWatch(
  sql: Sql,
  userId: number,
  mac: string,
  watch: { onConnect: boolean; onLeave: boolean },
): Promise<boolean> {
  const [device] = await sql`select 1 from network_devices where mac = ${mac}`;
  if (!device) return false;
  if (!watch.onConnect && !watch.onLeave) {
    await sql`delete from network_device_watches where user_id = ${userId} and mac = ${mac}`;
  } else {
    await sql`
      insert into network_device_watches (user_id, mac, on_connect, on_leave)
      values (${userId}, ${mac}, ${watch.onConnect}, ${watch.onLeave})
      on conflict (user_id, mac) do update set
        on_connect = excluded.on_connect, on_leave = excluded.on_leave`;
  }
  return true;
}

const WATCH = (sql: Sql, userId: number | null) => sql`
  coalesce(w.on_connect, false) as "watchConnect", coalesce(w.on_leave, false) as "watchLeave"
  from network_devices d
  left join users u on u.id = d.marked_known_by
  left join network_device_watches w on w.mac = d.mac and w.user_id = ${userId ?? -1}`;

/** Unknown devices first, then the most recently seen; with `userId`, their reminders. */
export async function listNetworkDevices(
  sql: Sql,
  opts: { known?: boolean; userId?: number } = {},
): Promise<NetworkDeviceRow[]> {
  return sql<NetworkDeviceRow[]>`
    select ${COLUMNS(sql)}, ${WATCH(sql, opts.userId ?? null)}
    ${opts.known === undefined ? sql`` : sql`where d.known = ${opts.known}`}
    order by d.known, d.last_seen desc`;
}

export async function getNetworkDevice(
  sql: Sql,
  mac: string,
  userId: number | null = null,
): Promise<NetworkDeviceRow | null> {
  const [row] = await sql<NetworkDeviceRow[]>`
    select ${COLUMNS(sql)}, ${WATCH(sql, userId)} where d.mac = ${mac}`;
  return row ?? null;
}

/** Admin: name it, or mark it as ours (or not). Null if there's no such device. */
export async function updateNetworkDevice(
  sql: Sql,
  mac: string,
  patch: { label?: string | null; known?: boolean },
  userId: number,
): Promise<NetworkDeviceRow | null> {
  const has = (k: keyof typeof patch) => Object.hasOwn(patch, k);
  const [row] = await sql<{ mac: string }[]>`
    update network_devices set
      label = case when ${has('label')} then ${patch.label ?? null} else label end,
      known = coalesce(${patch.known ?? null}::boolean, known),
      marked_known_by = case when ${patch.known === true} then ${userId}
                             when ${patch.known === false} then null else marked_known_by end,
      marked_known_at = case when ${patch.known === true} then now()
                             when ${patch.known === false} then null else marked_known_at end
    where mac = ${mac}
    returning mac`;
  if (!row) return null;
  return getNetworkDevice(sql, mac, userId);
}

/** Admin "Forget": it alerts again the next time it's seen. */
export async function forgetNetworkDevice(sql: Sql, mac: string): Promise<boolean> {
  const rows = await sql`delete from network_devices where mac = ${mac}`;
  return rows.count > 0;
}
