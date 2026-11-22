import {
  forgetNetworkDevice,
  getNetworkDevice,
  listNetworkDevices,
  resolveEvent,
  setDeviceWatch,
  updateNetworkDevice,
  type NetworkDeviceRow,
  type Sql,
} from '@home/db';
import {
  NetworkDevicePatchSchema,
  NetworkDeviceWatchSchema,
  type NetworkDevice,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { RulesStore } from '../push/rules.js';
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
  markedKnownAt: d.markedKnownAt?.toISOString() ?? null,
  present: d.present,
  watchConnect: d.watchConnect,
  watchLeave: d.watchLeave,
});

/**
 * Devices seen on the home network (docs/10 §5). Admins only: device lists, names and MACs
 * are household privacy.
 */
export function registerNetworkRoutes(
  app: FastifyInstance,
  deps: { db: Sql; rules: RulesStore | null },
): void {
  const { db } = deps;
  /** The collector's away time, from the same rule option (default 60 min). */
  const awayMinutes = () => {
    const rule = deps.rules?.get()?.rules.find((r) => r.id === 'network_device_connected');
    const v = rule?.type === 'event' ? rule.options?.awayMinutes : undefined;
    return typeof v === 'number' && v >= 10 && v <= 1440 ? v : 60;
  };

  app.get('/api/network/devices', async (request) => {
    const me = requireAdmin(request);
    const { known } = parseInput(ListQuery, request.query);
    const rows = await listNetworkDevices(db, {
      ...(known !== undefined && { known: known === 'true' }),
      userId: me.id,
    });
    return { items: rows.map(toItem), awayMinutes: awayMinutes() };
  });

  // "Tell me when it connects / leaves": your own reminders for this device.
  app.put('/api/network/devices/:mac/watch', async (request) => {
    const me = requireAdmin(request);
    const { mac } = parseInput(MacParams, request.params);
    const watch = parseInput(NetworkDeviceWatchSchema, request.body);
    if (!(await setDeviceWatch(db, me.id, mac, watch)))
      throw new HttpError(404, 'NOT_FOUND', 'No such device');
    return toItem((await getNetworkDevice(db, mac, me.id))!);
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
