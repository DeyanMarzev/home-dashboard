import {
  forgetNetworkDevice,
  listNetworkDevices,
  resolveEvent,
  updateNetworkDevice,
  type NetworkDeviceRow,
  type Sql,
} from '@home/db';
import { NetworkDevicePatchSchema, type NetworkDevice } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { requireAdmin } from '../users.js';
import { parseInput } from '../validate.js';

const MacParams = z.object({
  mac: z
    .string()
    .toLowerCase()
    .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/),
});
const ListQuery = z.object({ known: z.enum(['true', 'false']).optional() });
const NEW_DEVICE = 'network_new_device';

const toItem = (d: NetworkDeviceRow): NetworkDevice => ({
  mac: d.mac,
  label: d.label,
  vendor: d.vendor,
  hostname: d.hostname,
  lastIp: d.lastIp,
  randomised: d.randomised,
  wired: d.wired,
  known: d.known,
  firstSeen: d.firstSeen.toISOString(),
  lastSeen: d.lastSeen.toISOString(),
  markedKnownBy: d.markedKnownBy,
});

/**
 * Devices seen on the home network (docs/10 §5). Admins only: device lists, names and MACs
 * are household privacy.
 */
export function registerNetworkRoutes(app: FastifyInstance, deps: { db: Sql }): void {
  const { db } = deps;

  app.get('/api/network/devices', async (request) => {
    requireAdmin(request);
    const { known } = parseInput(ListQuery, request.query);
    const rows = await listNetworkDevices(db, known === undefined ? undefined : known === 'true');
    return { items: rows.map(toItem) };
  });

  app.patch('/api/network/devices/:mac', async (request) => {
    const me = requireAdmin(request);
    const { mac } = parseInput(MacParams, request.params);
    const patch = parseInput(NetworkDevicePatchSchema, request.body);
    const row = await updateNetworkDevice(db, mac, patch, me.id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'No such device');
    // "This is ours" closes its alert (no push: the rule has resolvedNotice false).
    if (patch.known === true) await resolveEvent(db, 'wifi', NEW_DEVICE, mac);
    return toItem(row);
  });

  app.delete('/api/network/devices/:mac', async (request, reply) => {
    requireAdmin(request);
    const { mac } = parseInput(MacParams, request.params);
    if (!(await forgetNetworkDevice(db, mac)))
      throw new HttpError(404, 'NOT_FOUND', 'No such device');
    await resolveEvent(db, 'wifi', NEW_DEVICE, mac);
    return reply.code(204).send();
  });
}
