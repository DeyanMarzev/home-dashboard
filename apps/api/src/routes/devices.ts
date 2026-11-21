import {
  deleteDevice,
  listDevices,
  pushTarget,
  renameDevice,
  upsertDevice,
  type DeviceRow,
  type Sql,
} from '@home/db';
import { DevicePatchSchema, DeviceRegisterSchema, type DeviceItem } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { Dispatcher } from '../push/dispatcher.js';
import { requirePerson } from '../users.js';
import { parseInput } from '../validate.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

const toItem = (d: DeviceRow): DeviceItem => ({
  id: d.id,
  label: d.label,
  createdAt: d.createdAt.toISOString(),
  lastSeenAt: d.lastSeenAt.toISOString(),
  lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
  failureCount: d.failureCount,
});

/** "Chrome on Android", from the User-Agent, until the person renames it. */
export function defaultDeviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iPhone'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/** This person's devices for push (docs/04 § Me; docs/09 §7 This device). */
export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: { db: Sql; dispatcher: Dispatcher | null },
): void {
  const { db, dispatcher } = deps;

  app.get('/api/me/devices', async (request) => {
    const { user } = requirePerson(request);
    return { items: (await listDevices(db, user.id)).map(toItem) };
  });

  // Turning notifications on, and the re-sync on every app start (an upsert).
  app.post('/api/me/devices', async (request) => {
    const { user } = requirePerson(request);
    const { subscription, label } = parseInput(DeviceRegisterSchema, request.body);
    const ua = request.headers['user-agent'];
    const device = await upsertDevice(db, {
      userId: user.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      label: label ?? defaultDeviceLabel(ua),
      userAgent: ua?.slice(0, 300) ?? null,
    });
    return toItem(device);
  });

  app.patch('/api/me/devices/:id', async (request) => {
    const { user } = requirePerson(request);
    const { id } = parseInput(IdParams, request.params);
    const { label } = parseInput(DevicePatchSchema, request.body);
    const device = await renameDevice(db, user.id, id, label);
    if (!device) throw new HttpError(404, 'NOT_FOUND', 'No such device');
    return toItem(device);
  });

  app.delete('/api/me/devices/:id', async (request, reply) => {
    const { user } = requirePerson(request);
    const { id } = parseInput(IdParams, request.params);
    if (!(await deleteDevice(db, user.id, id)))
      throw new HttpError(404, 'NOT_FOUND', 'No such device');
    return reply.code(204).send();
  });

  app.post('/api/me/devices/:id/test', async (request, reply) => {
    const { user } = requirePerson(request);
    const { id } = parseInput(IdParams, request.params);
    const target = await pushTarget(db, user.id, id);
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'No such device');
    if (!dispatcher) throw new HttpError(503, 'PUSH_OFF', 'Notifications are not set up on the Pi');
    dispatcher.sendTest(target);
    return reply.code(202).send({ ok: true });
  });
}
