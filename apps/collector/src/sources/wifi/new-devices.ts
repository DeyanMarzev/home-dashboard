import { openEvent, recordNetworkScan, type SeenNetworkDevice, type Sql } from '@home/db';
import type { Logger } from 'pino';
import { z } from 'zod';
import { currentAlertRules } from '../../alerts/engine.js';
import { isRandomised, SeenDeviceSchema, type SeenDevice } from '../../netprobe/devices.js';

export const NEW_DEVICE = 'network_new_device';
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
): Promise<{ seen: number; fresh: number } | null> {
  if (raw === undefined) return null; // ARP failed this round: nothing to compare
  const devices: SeenDevice[] = DevicesSchema.parse(raw);
  const fresh = await recordNetworkScan(
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
  await db`
    update events set resolved_at = now()
    where kind = ${NEW_DEVICE} and resolved_at is null and ts < now() - ${AUTO_RESOLVE}::interval`;
  // Counts only: MAC lists stay out of the logs at info level (docs/10 §5).
  if (fresh.length > 0) log.info({ fresh: fresh.length }, 'new devices on the network');
  return { seen: devices.length, fresh: fresh.length };
}
