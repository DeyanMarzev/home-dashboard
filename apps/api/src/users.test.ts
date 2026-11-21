import { loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { MeSchema, UsersResponseSchema } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import { AUDIENCE, fakeAccess, ISSUER, TEAM } from './test/access-token.js';

const config: Config = {
  env: 'test',
  port: 3000,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: {
    disabled: false,
    team: TEAM,
    audience: AUDIENCE,
    issuer: ISSUER,
    certsUrl: `${ISSUER}/cdn-cgi/access/certs`,
  },
  users: {
    adminEmails: ['owner@example.com', 'partner@example.com'],
    devUserEmail: 'dev@localhost',
  },
};

let db: TestDatabase;
let app: FastifyInstance;
let access: Awaited<ReturnType<typeof fakeAccess>>;
const tokens: Record<string, string> = {};

const call = async (method: 'GET' | 'PATCH' | 'PUT', url: string, who: string, body?: unknown) => {
  const res = await app.inject({
    method,
    url,
    headers: { 'cf-access-jwt-assertion': tokens[who]! },
    ...(body !== undefined && { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
};

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  access = await fakeAccess();
  tokens.owner = await access.sign({ email: 'Owner@Example.com' });
  tokens.partner = await access.sign({ email: 'partner@example.com' });
  tokens.anna = await access.sign({ email: 'anna@example.com' });
  tokens.ben = await access.sign({ email: 'ben@example.com' });
  tokens.service = await access.sign({ common_name: 'backup-script.access' });
  app = await buildServer(config, { db: db.sql, registry, accessKeys: access.keys });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('users and roles (docs/09 §2)', () => {
  it('makes ADMIN_EMAILS admins on first visit, with the email lowercased', async () => {
    const me = await call('GET', '/api/me', 'owner');
    expect(me.status).toBe(200);
    expect(MeSchema.parse(me.body)).toMatchObject({
      email: 'owner@example.com',
      role: 'admin',
      roleLocked: true,
      tz: 'Europe/London',
      quietStart: null,
      urgentIgnoresQuiet: true,
      vapidPublicKey: null,
    });
  });

  it('makes everyone else a member, who can read but not change shared settings', async () => {
    expect((await call('GET', '/api/me', 'anna')).body).toMatchObject({
      role: 'member',
      roleLocked: false,
    });
    expect((await call('GET', '/api/sources', 'anna')).status).toBe(200);
    expect((await call('GET', '/api/users', 'anna')).status).toBe(403);
    const put = await call('PUT', '/api/tariffs', 'anna', { items: [] });
    expect(put).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    expect((await call('PUT', '/api/tariffs', 'owner', { items: [] })).status).toBe(200);
  });

  it('gives a service token read access but no /api/me', async () => {
    expect((await call('GET', '/api/sources', 'service')).status).toBe(200);
    expect((await call('GET', '/api/me', 'service')).status).toBe(403);
    expect((await call('GET', '/api/users', 'service')).status).toBe(403);
  });

  it('lists users for admins, and lets them promote a member', async () => {
    const list = UsersResponseSchema.parse((await call('GET', '/api/users', 'owner')).body);
    const anna = list.items.find((u) => u.email === 'anna@example.com')!;
    expect(anna).toMatchObject({ role: 'member', enabled: true, devices: 0, roleLocked: false });
    const promoted = await call('PATCH', `/api/users/${anna.id}`, 'owner', { role: 'admin' });
    expect(promoted).toMatchObject({ status: 200, body: { role: 'admin' } });
    // Applies straight away, not after the user cache expires.
    expect((await call('GET', '/api/users', 'anna')).status).toBe(200);
    await call('PATCH', `/api/users/${anna.id}`, 'owner', { role: 'member' });
    expect((await call('GET', '/api/users', 'anna')).status).toBe(403);
  });

  it("won't change yourself or an ADMIN_EMAILS admin, and checks the input", async () => {
    const owner = MeSchema.parse((await call('GET', '/api/me', 'owner')).body);
    const partner = MeSchema.parse((await call('GET', '/api/me', 'partner')).body);
    expect(
      (await call('PATCH', `/api/users/${owner.id}`, 'owner', { enabled: false })).status,
    ).toBe(409);
    expect(
      (await call('PATCH', `/api/users/${partner.id}`, 'owner', { role: 'member' })).status,
    ).toBe(409);
    expect((await call('PATCH', '/api/users/99999', 'owner', { enabled: false })).status).toBe(404);
    expect(
      (await call('PATCH', `/api/users/${partner.id}`, 'owner', { role: 'boss' })).status,
    ).toBe(400);
  });

  it('shuts a disabled user out of the API (health stays open)', async () => {
    const ben = MeSchema.parse((await call('GET', '/api/me', 'ben')).body);
    expect((await call('PATCH', `/api/users/${ben.id}`, 'owner', { enabled: false })).status).toBe(
      200,
    );
    expect(await call('GET', '/api/sources', 'ben')).toMatchObject({
      status: 403,
      body: { error: { code: 'USER_DISABLED' } },
    });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    await call('PATCH', `/api/users/${ben.id}`, 'owner', { enabled: true });
    expect((await call('GET', '/api/sources', 'ben')).status).toBe(200);
  });

  it('lets people change their own name, quiet hours and pause', async () => {
    const res = await call('PATCH', '/api/me', 'anna', {
      name: 'Anna',
      quietStart: '23:00',
      quietEnd: '07:00',
      pausedUntil: '2026-11-22T07:00:00.000Z',
    });
    expect(res).toMatchObject({
      status: 200,
      body: {
        name: 'Anna',
        quietStart: '23:00',
        quietEnd: '07:00',
        pausedUntil: '2026-11-22T07:00:00.000Z',
      },
    });
    expect((await call('GET', '/api/me', 'anna')).body).toMatchObject({ quietStart: '23:00' });
    expect((await call('PATCH', '/api/me', 'anna', { quietStart: '22:00' })).status).toBe(400);
    expect((await call('PATCH', '/api/me', 'anna', { role: 'admin' })).status).toBe(400);
    expect(
      (await call('PATCH', '/api/me', 'anna', { quietStart: null, quietEnd: null })).body,
    ).toMatchObject({ quietStart: null, quietEnd: null, name: 'Anna' });
  });
});
