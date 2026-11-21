import { z } from 'zod';
import type { RouterClient } from './router.js';

/**
 * Devices seen on the home network in one scan (docs/10 §5): from `arp-scan --localnet`
 * (wired and Wi-Fi, guests included), plus names and wired/Wi-Fi from the router's API when
 * it's set up. The router can only add detail: it never removes a device ARP found.
 */
export const SeenDeviceSchema = z.object({
  mac: z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/),
  ip: z.string().nullable(),
  /** From the MAC prefix (arp-scan's bundled IEEE list); null when unknown or randomised. */
  vendor: z.string().nullable(),
  /** The name the router knows it by, if any. */
  hostname: z.string().nullable(),
  /** true / false when the router says; null from ARP alone. */
  wired: z.boolean().nullable(),
});
export type SeenDevice = z.infer<typeof SeenDeviceSchema>;

const LINE = /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})(?:\s+(.*))?$/i;

/**
 * `arp-scan --localnet --plain` (no --quiet, so the third column is the maker). A device
 * answering twice appears twice ("(DUP: 2)"): kept once. "(Unknown…)" makers become null.
 */
export function parseArpDevices(text: string): SeenDevice[] {
  const byMac = new Map<string, SeenDevice>();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const mac = m[2]!.toLowerCase();
    if (byMac.has(mac)) continue;
    const vendor = (m[3] ?? '').replace(/\s*\(DUP: \d+\)\s*$/, '').trim();
    byMac.set(mac, {
      mac,
      ip: m[1]!,
      vendor: vendor === '' || vendor.startsWith('(Unknown') ? null : vendor,
      hostname: null,
      wired: null,
    });
  }
  return [...byMac.values()];
}

/** Private ("randomised") Wi-Fi addresses set the locally administered bit of the first octet. */
export function isRandomised(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;
}

const isPlaceholder = (name: string) => name === 'Unknown device' || name.startsWith('Unknown (');

/** ARP's devices with the router's names and links added, plus any the router sees that ARP missed. */
export function mergeDevices(
  arp: readonly SeenDevice[],
  router: readonly RouterClient[],
): SeenDevice[] {
  const out = new Map(arp.map((d) => [d.mac, { ...d }]));
  for (const c of router) {
    if (!c.mac) continue;
    const known = out.get(c.mac);
    const detail = {
      hostname: isPlaceholder(c.name) ? null : c.name,
      wired: c.band === null ? null : c.band === 'wired',
    };
    if (known) Object.assign(known, detail, { ip: known.ip ?? c.ip });
    else out.set(c.mac, { mac: c.mac, ip: c.ip, vendor: c.manufacturer, ...detail });
  }
  return [...out.values()];
}
