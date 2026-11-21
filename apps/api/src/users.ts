import { signInUser, type Sql, type UserRow } from '@home/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UsersConfig } from './config.js';
import { HttpError } from './errors.js';

/** Who is calling (docs/09 §2): a person from the Access email, or a service token. */
export type RequestUser =
  { kind: 'person'; user: UserRow; roleLocked: boolean } | { kind: 'service' };

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

/** Users are re-read at most this often per person (role or enabled changes apply within it). */
const CACHE_MS = 60_000;

export interface UserDirectory {
  isRoleLocked(email: string): boolean;
  /** Drop a cached user after a change, so the next request sees it. */
  forget(email: string): void;
}

/**
 * Turns the verified Access identity into a `users` row on every /api request (except
 * /api/health), creating it on first visit. A disabled user gets 403 USER_DISABLED. The web
 * app's own files stay reachable: they hold no data.
 */
export function registerUsers(
  app: FastifyInstance,
  opts: { db: Sql; users: UsersConfig; authDisabled: boolean },
): UserDirectory {
  const admins = new Set(opts.users.adminEmails);
  const cache = new Map<string, { row: UserRow; at: number }>();
  const isRoleLocked = (email: string) =>
    admins.has(email) || (opts.authDisabled && email === opts.users.devUserEmail);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || path === '/api/health') return;

    const email = opts.authDisabled ? opts.users.devUserEmail : request.identity?.email;
    if (!email) {
      if (request.identity) request.user = { kind: 'service' };
      return;
    }
    const key = email.trim().toLowerCase();
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { row: await signInUser(opts.db, key, { admin: isRoleLocked(key) }), at: Date.now() };
      cache.set(key, hit);
    }
    if (!hit.row.enabled) {
      throw new HttpError(403, 'USER_DISABLED', 'Your access to the dashboard is turned off');
    }
    request.user = { kind: 'person', user: hit.row, roleLocked: isRoleLocked(key) };
  });

  return { isRoleLocked, forget: (email) => cache.delete(email) };
}

/** The signed-in person; 403 for a service token (docs/09 §2). */
export function requirePerson(request: FastifyRequest): { user: UserRow; roleLocked: boolean } {
  const u = request.user;
  if (u?.kind !== 'person') throw new HttpError(403, 'FORBIDDEN', 'Only for people signed in');
  return u;
}

/** An admin, or 403 (permissions are enforced here, not just hidden in the UI). */
export function requireAdmin(request: FastifyRequest): UserRow {
  const { user } = requirePerson(request);
  if (user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Only admins can do this');
  return user;
}
