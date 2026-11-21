import {
  getUser,
  listUsers,
  updateProfile,
  updateUserAccess,
  type Sql,
  type UserRow,
} from '@home/db';
import {
  MePatchSchema,
  UserPatchSchema,
  type Me,
  type UserItem,
  type UsersResponse,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { requireAdmin, requirePerson, type UserDirectory } from '../users.js';
import { parseInput } from '../validate.js';

const IdParams = z.object({ id: z.coerce.number().int().positive() });

function toMe(user: UserRow, roleLocked: boolean): Me {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLocked,
    tz: user.tz,
    quietStart: user.quietStart,
    quietEnd: user.quietEnd,
    urgentIgnoresQuiet: user.urgentIgnoresQuiet,
    pausedUntil: user.pausedUntil?.toISOString() ?? null,
    vapidPublicKey: null, // push comes in M11 step 4
  };
}

/** /api/me and the admin /api/users routes (docs/04 § Users and notifications). */
export function registerUserRoutes(
  app: FastifyInstance,
  deps: { db: Sql; directory: UserDirectory },
): void {
  const { db, directory } = deps;

  app.get('/api/me', (request) => {
    const { user, roleLocked } = requirePerson(request);
    return toMe(user, roleLocked);
  });

  app.patch('/api/me', async (request) => {
    const { user, roleLocked } = requirePerson(request);
    const p = parseInput(MePatchSchema, request.body);
    const updated = await updateProfile(db, user.id, {
      ...(p.name !== undefined && { name: p.name }),
      ...(p.quietStart !== undefined && {
        quiet: p.quietStart === null ? null : { start: p.quietStart, end: p.quietEnd! },
      }),
      ...(p.urgentIgnoresQuiet !== undefined && { urgentIgnoresQuiet: p.urgentIgnoresQuiet }),
      ...(p.pausedUntil !== undefined && {
        pausedUntil: p.pausedUntil === null ? null : new Date(p.pausedUntil),
      }),
    });
    directory.forget(user.email);
    return toMe(updated, roleLocked);
  });

  const toItem = (u: UserRow & { devices: number }): UserItem => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    roleLocked: directory.isRoleLocked(u.email),
    enabled: u.enabled,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
    devices: u.devices,
  });

  app.get('/api/users', async (request): Promise<UsersResponse> => {
    requireAdmin(request);
    return { items: (await listUsers(db)).map(toItem) };
  });

  app.patch('/api/users/:id', async (request) => {
    const me = requireAdmin(request);
    const { id } = parseInput(IdParams, request.params);
    const patch = parseInput(UserPatchSchema, request.body);
    const target = await getUser(db, id);
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'No such user');
    if (target.id === me.id)
      throw new HttpError(409, 'CONFLICT', "You can't change your own role or access");
    if (directory.isRoleLocked(target.email))
      throw new HttpError(409, 'CONFLICT', 'This person is an admin from ADMIN_EMAILS');
    await updateUserAccess(db, id, patch);
    directory.forget(target.email);
    request.log.info({ userId: id, ...patch }, 'user access changed');
    const updated = (await listUsers(db)).find((u) => u.id === id)!;
    return toItem(updated);
  });
}
