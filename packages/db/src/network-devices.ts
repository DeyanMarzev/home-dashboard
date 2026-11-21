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
}

const COLUMNS = (sql: Sql) => sql`
  d.mac, d.first_seen as "firstSeen", d.last_seen as "lastSeen", host(d.last_ip) as "lastIp",
  d.hostname, d.vendor, d.randomised, d.wired, d.label, d.known,
  coalesce(u.name, u.email) as "markedKnownBy", d.marked_known_at as "markedKnownAt"`;

/**
 * Records one scan. The very first scan (empty table) is the baseline: everything is known
 * and nothing is new. After that, a MAC never seen before is stored as unknown and returned,
 * once: the next scans only refresh it. Returns the new devices.
 */
export async function recordNetworkScan(
  sql: Sql,
  devices: readonly SeenNetworkDevice[],
): Promise<SeenNetworkDevice[]> {
  if (devices.length === 0) return [];
  return sql.begin(async (tx) => {
    // One scan at a time, so two can't both see an empty table.
    await tx`select pg_advisory_xact_lock(hashtext('network_devices'))`;
    const [state] = await tx<{ empty: boolean }[]>`
      select not exists (select 1 from network_devices) as empty`;
    const empty = state?.empty ?? true;
    const rows = await tx<{ mac: string; inserted: boolean }[]>`
      insert into network_devices (mac, last_ip, hostname, vendor, randomised, wired, known)
      select mac, ip::inet, hostname, vendor, randomised, wired, ${empty}
      from unnest(${devices.map((d) => d.mac)}::text[], ${devices.map((d) => d.ip)}::text[],
                  ${devices.map((d) => d.hostname)}::text[], ${devices.map((d) => d.vendor)}::text[],
                  ${devices.map((d) => d.randomised)}::boolean[], ${devices.map((d) => d.wired)}::boolean[])
        as t(mac, ip, hostname, vendor, randomised, wired)
      on conflict (mac) do update set
        last_seen = now(),
        last_ip = coalesce(excluded.last_ip, network_devices.last_ip),
        hostname = coalesce(excluded.hostname, network_devices.hostname),
        vendor = coalesce(network_devices.vendor, excluded.vendor),
        wired = coalesce(excluded.wired, network_devices.wired)
      returning mac, (xmax = 0) as inserted`;
    if (empty) return [];
    const added = new Set(rows.filter((r) => r.inserted).map((r) => r.mac));
    return devices.filter((d) => added.has(d.mac));
  });
}

export async function listNetworkDevices(sql: Sql, known?: boolean): Promise<NetworkDeviceRow[]> {
  return sql<NetworkDeviceRow[]>`
    select ${COLUMNS(sql)} from network_devices d left join users u on u.id = d.marked_known_by
    ${known === undefined ? sql`` : sql`where d.known = ${known}`}
    order by d.known, d.last_seen desc`;
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
  const [full] = await sql<NetworkDeviceRow[]>`
    select ${COLUMNS(sql)} from network_devices d left join users u on u.id = d.marked_known_by
    where d.mac = ${mac}`;
  return full ?? null;
}

/** Admin "Forget": it alerts again the next time it's seen. */
export async function forgetNetworkDevice(sql: Sql, mac: string): Promise<boolean> {
  const rows = await sql`delete from network_devices where mac = ${mac}`;
  return rows.count > 0;
}
