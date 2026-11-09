import { z } from 'zod';

/**
 * Linksys Velop (MX4200) local JNAP API: POST http://<router>/JNAP/ with the action in
 * X-JNAP-Action and the admin password in X-JNAP-Authorization (basic, user "admin").
 * The response format isn't officially documented: parsing is lenient. Shapes confirmed with a
 * capture from the owner's MX4200 (router-capture.ts, 2026-11-09): GetDevices3 for who is
 * connected and through which mesh node, GetNetworkConnections2 for band, signal and link speed
 * of the main router's Wi-Fi clients (and the satellites' own backhaul links).
 */

const JNAP = 'http://linksys.com/jnap/';

export class RouterAuthError extends Error {
  override name = 'RouterAuthError';
}

export async function jnap(
  baseUrl: string,
  password: string,
  action: string,
  signal: AbortSignal,
  body: unknown = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(new URL('/JNAP/', baseUrl), {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-jnap-action': JNAP + action,
      'x-jnap-authorization': `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`router answered HTTP ${res.status} to ${action}`);
  const json = (await res.json()) as { result?: string; output?: unknown };
  if (json.result === '_ErrorUnauthorized')
    throw new RouterAuthError('the router refused the admin password (ROUTER_PASSWORD)');
  if (json.result !== 'OK')
    throw new Error(`router answered ${json.result ?? 'nothing'} to ${action}`);
  return json.output;
}

const DevicesSchema = z.object({
  devices: z.array(
    z
      .object({
        deviceID: z.string().optional(),
        friendlyName: z.string().optional(),
        isAuthority: z.boolean().optional(),
        nodeType: z.string().optional(),
        model: z
          .object({ deviceType: z.string().optional(), manufacturer: z.string().optional() })
          .loose()
          .optional(),
        properties: z
          .array(z.object({ name: z.string(), value: z.string().optional() }).loose())
          .default([]),
        knownInterfaces: z
          .array(
            z
              .object({
                macAddress: z.string().optional(),
                interfaceType: z.string().optional(),
                band: z.string().optional(),
              })
              .loose(),
          )
          .default([]),
        connections: z
          .array(
            z
              .object({ macAddress: z.string().optional(), parentDeviceID: z.string().optional() })
              .loose(),
          )
          .default([]),
      })
      .loose(),
  ),
});

export interface RouterDevices {
  total: number;
  wifi: number;
  wired: number;
}

/**
 * Clients connected now, from devicelist/GetDevices3: devices with an active connection,
 * excluding the router and its mesh nodes; Wi-Fi vs wired from the connected interface.
 */
export function parseDevices(output: unknown): RouterDevices {
  const { devices } = DevicesSchema.parse(output);
  const clients = devices.filter((d) => d.connections.length > 0 && !d.isAuthority && !d.nodeType);
  let wifi = 0;
  let wired = 0;
  for (const d of clients) {
    const mac = d.connections[0]?.macAddress?.toLowerCase();
    const iface =
      d.knownInterfaces.find((i) => i.macAddress?.toLowerCase() === mac) ?? d.knownInterfaces[0];
    if (iface?.interfaceType === 'Wired') wired++;
    else if (iface?.interfaceType === 'Wireless') wifi++;
  }
  return { total: clients.length, wifi, wired };
}

const ConnectionsSchema = z.object({
  connections: z.array(
    z
      .object({
        macAddress: z.string(),
        negotiatedMbps: z.number().optional(),
        wireless: z
          .object({ band: z.string().optional(), signalDecibels: z.number().optional() })
          .loose()
          .optional(),
      })
      .loose(),
  ),
});

export type Band = '2.4' | '5' | '6' | 'wired';

export interface RouterLink {
  /** Stable snake_case key from the router's device id: `device_…` or `node_…`. */
  key: string;
  name: string;
  band: Band | null;
  signalDbm: number | null;
  linkMbps: number | null;
}

export interface RouterClient extends RouterLink {
  /** Connected through a satellite node (its signal isn't in the main router's list). */
  viaSatellite: boolean;
}

export interface RouterSnapshot {
  counts: RouterDevices;
  clients: RouterClient[];
  /** Satellite mesh nodes and their own link to the main router. */
  satellites: RouterLink[];
}

/** "2.4GHz" → "2.4", "5GHz" → "5". */
function bandOf(text: string | undefined): Band | null {
  const m = /^(2\.4|5|6)\s*GHz$/i.exec(text?.trim() ?? '');
  return m ? (m[1] as Band) : null;
}

function keyOf(prefix: string, deviceId: string | undefined, fallback: string): string {
  // Router ids are UUIDs: 32 hex digits once the dashes go, which keeps them snake_case.
  const id = (deviceId ?? fallback).toLowerCase().replace(/[^0-9a-z]/g, '');
  return `${prefix}_${id || 'unknown'}`;
}

type Device = z.infer<typeof DevicesSchema>['devices'][number];

/** The name given in the Linksys app, else the one the router detected, else the maker. */
function nameOf(d: Device): string {
  const given = d.properties.find((p) => p.name === 'userDeviceName')?.value?.trim();
  if (given) return given;
  if (d.friendlyName?.trim()) return d.friendlyName.trim();
  if (d.model?.manufacturer?.trim()) return `Unknown (${d.model.manufacturer.trim()})`;
  return 'Unknown device';
}

/**
 * Who is connected and how: GetDevices3 (connected now, mesh node, names) joined by MAC with
 * GetNetworkConnections2 (band, signal, link speed). Clients of a satellite node aren't in the
 * main router's connection list, so they get the band they last used and no signal.
 */
export function parseRouterSnapshot(
  devicesOutput: unknown,
  connectionsOutput: unknown,
): RouterSnapshot {
  const { devices } = DevicesSchema.parse(devicesOutput);
  const { connections } = ConnectionsSchema.parse(connectionsOutput ?? { connections: [] });
  const byMac = new Map(connections.map((c) => [c.macAddress.toLowerCase(), c]));
  const satellites = devices.filter((d) => d.nodeType && !d.isAuthority);
  const satelliteIds = new Set(satellites.map((d) => d.deviceID).filter(Boolean));

  const link = (d: Device, mac: string | undefined) => {
    const conn = mac ? byMac.get(mac) : undefined;
    const iface =
      d.knownInterfaces.find((i) => i.macAddress?.toLowerCase() === mac) ?? d.knownInterfaces[0];
    return {
      band:
        bandOf(conn?.wireless?.band) ??
        (iface?.interfaceType === 'Wired' ? 'wired' : bandOf(iface?.band)),
      signalDbm: conn?.wireless?.signalDecibels ?? null,
      linkMbps: conn?.negotiatedMbps ?? null,
    } satisfies Pick<RouterLink, 'band' | 'signalDbm' | 'linkMbps'>;
  };

  const clients = devices
    .filter((d) => d.connections.length > 0 && !d.isAuthority && !d.nodeType)
    .map((d): RouterClient => {
      const connection = d.connections[0]!;
      return {
        key: keyOf('device', d.deviceID, connection.macAddress ?? ''),
        name: nameOf(d),
        ...link(d, connection.macAddress?.toLowerCase()),
        viaSatellite: satelliteIds.has(connection.parentDeviceID),
      };
    });

  return {
    counts: parseDevices(devicesOutput),
    clients,
    satellites: satellites.map((d) => {
      // A satellite's backhaul shows up in the main router's list under one of its own MACs.
      const mac = d.knownInterfaces
        .map((i) => i.macAddress?.toLowerCase())
        .find((m) => m !== undefined && byMac.has(m));
      return {
        key: keyOf('node', d.deviceID, mac ?? ''),
        name: nameOf(d),
        ...link(d, mac),
      };
    }),
  };
}
