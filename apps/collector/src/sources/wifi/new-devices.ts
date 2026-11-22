import {
  deviceWatchers,
  getNetworkDevice,
  markDepartures,
  openEvent,
  recordNetworkScan,
  resolveEvent,
  type NetworkDeviceRow,
  type SeenNetworkDevice,
  type Sql,
} from '@home/db';
import { formatLondonTime } from '@home/shared';
import type { Logger } from 'pino';
import { z } from 'zod';
import { currentAlertRules } from '../../alerts/engine.js';
import { isRandomised, SeenDeviceSchema, type SeenDevice } from '../../netprobe/devices.js';

export const NEW_DEVICE = 'network_new_device';
export const CONNECTED = 'network_device_connected';
export const LEFT = 'network_device_left';
/** Not seen for this long = away (rule option `awayMinutes` on network_device_connected). */
const DEFAULT_AWAY_MINUTES = 60;
/** Unacknowledged new-device alerts close by themselves after a day (docs/10 §5). */
const AUTO_RESOLVE = '24 hours';

const DevicesSchema = z.array(SeenDeviceSchema);

/** "Samsung device · 192.168.1.47 · wired" (docs/10 §2 Messages). */
export function describeDevice(d: SeenNetworkDevice): string {
  const what = d.hostname
    ? `${d.hostname}${d.vendor ? ` (${d.vendor})` : ''}`
    : d.vendor
      ? `${d.vendor} device`
      : d.randomised
        ? 'Unknown device (private address)'
        : 'Unknown device';
  return [what, d.ip, d.wired === true ? 'wired' : null].filter(Boolean).join(' · ');
}

function awayMinutes(): number {
  const rule = currentAlertRules()?.rules.find((r) => r.id === CONNECTED);
  const value = rule?.type === 'event' ? rule.options?.awayMinutes : undefined;
  return typeof value === 'number' && value >= 10 && value <= 1440 ? value : DEFAULT_AWAY_MINUTES;
}

/** What the reminders call it: the admin's label, the router's name, else the maker. */
export function deviceName(d: Pick<NetworkDeviceRow, 'label' | 'hostname' | 'vendor'>): string {
  return d.label ?? d.hostname ?? (d.vendor ? `${d.vendor} device` : 'Unknown device');
}

/**
 * "Tell me when it connects / leaves" (per person): an event naming only the people who
 * asked (`data.recipients`), kept open while that state lasts, so it fires once per change.
 * Nobody watching = no event at all.
 */
async function remind(db: Sql, mac: string, kind: typeof CONNECTED | typeof LEFT, now: Date) {
  const other = kind === CONNECTED ? LEFT : CONNECTED;
  await resolveEvent(db, 'wifi', other, mac);
  const recipients = await deviceWatchers(db, mac, kind === CONNECTED ? 'connect' : 'leave');
  if (recipients.length === 0) return;
  const d = await getNetworkDevice(db, mac);
  if (!d) return;
  const name = deviceName(d);
  const detail =
    kind === CONNECTED
      ? [d.lastIp, d.wired === true ? 'wired' : d.wired === false ? 'Wi-Fi' : null]
          .filter(Boolean)
          .join(' · ')
      : `last seen ${formatLondonTime(d.lastSeen)}`;
  await openEvent(db, {
    level: 'warning',
    sourceId: 'wifi',
    kind,
    entity: mac,
    message: `${name} ${kind === CONNECTED ? 'connected' : 'left the network'}${detail ? ` · ${detail}` : ''}`,
    // A reminder, not a problem: the Overview's alerts strip leaves these out.
    data: { recipients, reminder: true, at: now.toISOString() },
  });
}

/** The rule's `ignoreRandomised` switch (admin override), default off: guests' phones alert. */
function ignoreRandomised(): boolean {
  const rule = currentAlertRules()?.rules.find((r) => r.id === NEW_DEVICE);
  return rule?.type === 'event' && rule.options?.ignoreRandomised === true;
}

/**
 * The device list in a netprobe message: records the scan and raises one
 * `network_new_device` event per device never seen before (docs/10 §5).
 */
export async function handleDeviceList(
  raw: unknown,
  db: Sql,
  log: Logger,
  now: Date = new Date(),
): Promise<{ seen: number; fresh: number; arrived: number; left: number } | null> {
  if (raw === undefined) return null; // ARP failed this round: nothing to compare
  const devices: SeenDevice[] = DevicesSchema.parse(raw);
  const { fresh, arrived } = await recordNetworkScan(
    db,
    devices.map((d) => ({ ...d, randomised: isRandomised(d.mac) })),
  );
  const skipRandomised = ignoreRandomised();
  for (const d of fresh) {
    if (d.randomised && skipRandomised) continue;
    await openEvent(db, {
      level: 'warning',
      sourceId: 'wifi',
      kind: NEW_DEVICE,
      entity: d.mac,
      message: `New device on the network · ${describeDevice(d)}. Open Wi-Fi to name it or mark it as yours`,
      data: {
        ip: d.ip,
        vendor: d.vendor,
        hostname: d.hostname,
        randomised: d.randomised,
        wired: d.wired,
      },
    });
  }
  // After this scan, so a gap in scanning itself never looks like everyone leaving.
  const left = await markDepartures(db, awayMinutes());
  for (const mac of arrived) await remind(db, mac, CONNECTED, now);
  for (const mac of left) await remind(db, mac, LEFT, now);
  await db`
    update events set resolved_at = now()
    where kind = ${NEW_DEVICE} and resolved_at is null and ts < now() - ${AUTO_RESOLVE}::interval`;
  // Counts only: MAC lists stay out of the logs at info level (docs/10 §5).
  if (fresh.length > 0) log.info({ fresh: fresh.length }, 'new devices on the network');
  return { seen: devices.length, fresh: fresh.length, arrived: arrived.length, left: left.length };
}
