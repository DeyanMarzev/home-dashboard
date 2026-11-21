import { loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { DeviceItemSchema, DevicesResponseSchema } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { FakeChannel } from './push/channel.js';
import { defaultDeviceLabel } from './routes/devices.js';
import { buildServer } from './server.js';
import { AUDIENCE, fakeAccess, ISSUER, TEAM } from './test/access-token.js';

const PUBLIC_KEY = `B${'A'.repeat(86)}`;
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
    certsUrl: `${ISSUER}/x`,
  },
  users: { adminEmails: ['owner@example.com'], devUserEmail: 'dev@localhost' },
  push: { publicKey: PUBLIC_KEY, privateKey: 'a'.repeat(43), subject: 'mailto:owner@example.com' },
};
const ALERTS_FILE = fileURLToPath(new URL('../../../config/alerts.yaml', import.meta.url));
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';

let db: TestDatabase;
let app: FastifyInstance;
const channel = new FakeChannel();
const tokens: Record<string, string> = {};

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  body?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    headers: { 'cf-access-jwt-assertion': tokens[who]!, 'user-agent': ANDROID_CHROME },
    ...(body !== undefined && { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : null };
};
const subscription = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
  keys: { p256dh: 'BKey', auth: 'secret' },
});

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  const access = await fakeAccess();
  tokens.owner = await access.sign({ email: 'owner@example.com' });
  tokens.anna = await access.sign({ email: 'anna@example.com' });
  tokens.service = await access.sign({ common_name: 'script.access' });
  app = await buildServer(config, {
    db: db.sql,
    registry,
    accessKeys: access.keys,
    channel,
    alertsFile: ALERTS_FILE,
    notifications: { listen: () => Promise.resolve(() => Promise.resolve()) },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('push devices (docs/04 § Me)', () => {
  let id = 0;

  it('gives the app the VAPID public key', async () => {
    expect((await call('GET', '/api/me', 'owner')).body).toMatchObject({
      vapidPublicKey: PUBLIC_KEY,
    });
  });

  it('registers a phone with a label from its browser, and re-syncs it without duplicates', async () => {
    const first = await call('POST', '/api/me/devices', 'owner', { subscription: subscription(1) });
    expect(first.status).toBe(200);
    const device = DeviceItemSchema.parse(first.body);
    expect(device).toMatchObject({
      label: 'Chrome on Android',
      failureCount: 0,
      lastSuccessAt: null,
    });
    id = device.id;
    const again = await call('POST', '/api/me/devices', 'owner', { subscription: subscription(1) });
    expect(again.body).toMatchObject({ id });
    const list = DevicesResponseSchema.parse((await call('GET', '/api/me/devices', 'owner')).body);
    expect(list.items.map((d) => d.id)).toEqual([id]);
  });

  it('renames it, and sends a test notification to it', async () => {
    expect(
      (await call('PATCH', `/api/me/devices/${id}`, 'owner', { label: "Deyan's Pixel" })).body,
    ).toMatchObject({
      label: "Deyan's Pixel",
    });
    expect((await call('POST', `/api/me/devices/${id}/test`, 'owner')).status).toBe(202);
    for (let i = 0; i < 50 && channel.sent.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(channel.sent).toEqual([
      {
        endpoint: subscription(1).endpoint,
        payload: expect.objectContaining({
          phase: 'test',
          title: 'Test notification',
          body: "Notifications work on Deyan's Pixel.",
        }) as unknown,
      },
    ]);
  });

  it('keeps people to their own devices', async () => {
    expect((await call('PATCH', `/api/me/devices/${id}`, 'anna', { label: 'Mine' })).status).toBe(
      404,
    );
    expect((await call('POST', `/api/me/devices/${id}/test`, 'anna')).status).toBe(404);
    expect((await call('DELETE', `/api/me/devices/${id}`, 'anna')).status).toBe(404);
    expect((await call('GET', '/api/me/devices', 'anna')).body).toEqual({ items: [] });
    expect((await call('GET', '/api/me/devices', 'service')).status).toBe(403);
  });

  it('moves a phone to whoever signs in on it next', async () => {
    const moved = await call('POST', '/api/me/devices', 'anna', { subscription: subscription(1) });
    expect(moved.body).toMatchObject({ id });
    expect((await call('GET', '/api/me/devices', 'owner')).body).toEqual({ items: [] });
  });

  it('checks the subscription and removes a device', async () => {
    const bad = { subscription: { ...subscription(2), endpoint: 'http://insecure.example/x' } };
    expect((await call('POST', '/api/me/devices', 'anna', bad)).status).toBe(400);
    expect(
      (
        await call('POST', '/api/me/devices', 'anna', {
          subscription: { endpoint: 'https://x.example' },
        })
      ).status,
    ).toBe(400);
    expect((await call('DELETE', `/api/me/devices/${id}`, 'anna')).status).toBe(204);
    expect((await call('GET', '/api/me/devices', 'anna')).body).toEqual({ items: [] });
  });
});

describe('defaultDeviceLabel', () => {
  it('names the browser and system', () => {
    expect(defaultDeviceLabel(ANDROID_CHROME)).toBe('Chrome on Android');
    expect(
      defaultDeviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0',
      ),
    ).toBe('Edge on Windows');
    expect(defaultDeviceLabel(undefined)).toBe('Browser');
  });
});
