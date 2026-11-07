import { z } from 'zod';

/**
 * Linksys Velop (MX4200) local JNAP API: POST http://<router>/JNAP/ with the action in
 * X-JNAP-Action and the admin password in X-JNAP-Authorization (basic, user "admin").
 * The response format isn't officially documented: parsing is lenient and the shapes should
 * be confirmed with a capture from the owner's router (router-capture.ts, docs/08 question 6).
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
        knownInterfaces: z
          .array(
            z
              .object({ macAddress: z.string().optional(), interfaceType: z.string().optional() })
              .loose(),
          )
          .default([]),
        connections: z.array(z.object({ macAddress: z.string().optional() }).loose()).default([]),
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
