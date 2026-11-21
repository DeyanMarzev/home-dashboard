import { createReadingWriter, loadRegistryFile, migrate, openEvent, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import {
  AdminRulesResponseSchema,
  MyAlertsResponseSchema,
  NotificationLogResponseSchema,
  type MyAlertRule,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
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
    certsUrl: `${ISSUER}/x`,
  },
  users: { adminEmails: ['owner@example.com'], devUserEmail: 'dev@localhost' },
  push: null,
};
const ALERTS_FILE = fileURLToPath(new URL('../../../config/alerts.yaml', import.meta.url));

let db: TestDatabase;
let app: FastifyInstance;
const tokens: Record<string, string> = {};

const call = async (
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  body?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    headers: { 'cf-access-jwt-assertion': tokens[who]! },
    ...(body !== undefined && { payload: body as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body ? res.json<unknown>() : null };
};
const myRule = async (who: string, id: string): Promise<MyAlertRule> => {
  const { groups } = MyAlertsResponseSchema.parse((await call('GET', '/api/me/alerts', who)).body);
  return groups.flatMap((g) => g.rules).find((r) => r.id === id)!;
};

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  const now = Date.now();
  await createReadingWriter(db.sql).write(
    'room_sensors',
    ['kitchen', 'bedroom'].map((entity) => ({
      metric: 'co2',
      entity,
      unit: 'ppm',
      valueType: 'gauge' as const,
      ts: new Date(now - 60_000),
      value: 800,
    })),
  );
  await openEvent(db.sql, {
    level: 'warning',
    sourceId: 'room_sensors',
    kind: 'co2_high',
    entity: 'kitchen',
    ruleId: 'co2_high',
    message: 'CO₂ high · Kitchen 1,100 ppm',
  });
  const access = await fakeAccess();
  tokens.owner = await access.sign({ email: 'owner@example.com' });
  tokens.anna = await access.sign({ email: 'anna@example.com' });
  app = await buildServer(config, {
    db: db.sql,
    registry,
    accessKeys: access.keys,
    alertsFile: ALERTS_FILE,
    notifications: { listen: () => Promise.resolve(() => Promise.resolve()) },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('My alerts (docs/09 §7)', () => {
  it('lists rules by group with their defaults, rooms and what is open now', async () => {
    const { groups } = MyAlertsResponseSchema.parse(
      (await call('GET', '/api/me/alerts', 'anna')).body,
    );
    expect(groups.map((g) => g.id)).toEqual([
      'air',
      'heating',
      'weather',
      'home',
      'devices',
      'system',
    ]);
    const co2 = await myRule('anna', 'co2_high');
    expect(co2).toMatchObject({
      description: 'Warning above 1,000 ppm for 15 min · Urgent above 1,500 ppm for 10 min',
      levels: ['warning', 'alert'],
      entities: [
        { id: 'kitchen', label: 'Kitchen' },
        { id: 'bedroom', label: 'Bedroom' },
      ],
      enabled: true,
      minLevel: 'alert',
      entitiesSelected: null,
      notifyResolved: false,
      isDefault: true,
      ruleEnabled: true,
      open: [{ entity: 'kitchen', label: 'Kitchen', level: 'warning' }],
    });
    expect(await myRule('anna', 'vacuum_battery_low')).toMatchObject({ levels: ['warning'] });
    // Admin-only by default: off for a member, on for the owner.
    expect((await myRule('anna', 'source_late')).enabled).toBe(false);
    expect((await myRule('owner', 'source_late')).enabled).toBe(true);
    expect((await myRule('anna', 'vacuum_not_charging')).description).toMatch(/off its dock/);
  });

  it('saves a choice, refuses a level the rule does not have, and resets', async () => {
    const choice = {
      enabled: true,
      minLevel: 'warning',
      entities: ['kitchen'],
      notifyResolved: true,
    };
    expect((await call('PUT', '/api/me/alerts/co2_high', 'anna', choice)).status).toBe(204);
    expect(await myRule('anna', 'co2_high')).toMatchObject({
      minLevel: 'warning',
      entitiesSelected: ['kitchen'],
      notifyResolved: true,
      isDefault: false,
    });
    expect((await myRule('owner', 'co2_high')).isDefault).toBe(true);
    expect(
      (
        await call('PUT', '/api/me/alerts/vacuum_battery_low', 'anna', {
          ...choice,
          minLevel: 'alert',
        })
      ).status,
    ).toBe(400);
    expect((await call('PUT', '/api/me/alerts/nope', 'anna', choice)).status).toBe(404);
    expect((await call('DELETE', '/api/me/alerts/co2_high', 'anna')).status).toBe(204);
    expect((await myRule('anna', 'co2_high')).isDefault).toBe(true);
  });
});

describe('Alert thresholds (admin)', () => {
  it('is for admins only', async () => {
    expect((await call('GET', '/api/alert-rules', 'anna')).status).toBe(403);
    expect(
      (await call('PATCH', '/api/alert-rules/co2_high', 'anna', { enabled: false })).status,
    ).toBe(403);
    expect((await call('GET', '/api/notifications/log', 'anna')).status).toBe(403);
  });

  it('changes a threshold for everyone, keeps earlier changes, validates, and resets', async () => {
    const list = AdminRulesResponseSchema.parse(
      (await call('GET', '/api/alert-rules', 'owner')).body,
    );
    expect(list.items.find((r) => r.id === 'co2_high')).toMatchObject({
      unit: 'ppm',
      direction: 'above',
      effective: { enabled: true, warning: { level: 1000, for: '15m' } },
      override: null,
    });

    const first = await call('PATCH', '/api/alert-rules/co2_high', 'owner', {
      warning: { level: 1100 },
    });
    expect(first.body).toMatchObject({
      effective: { warning: { level: 1100, for: '15m' } },
      defaults: { warning: { level: 1000 } },
      override: { updatedBy: 'owner@example.com' },
    });
    const second = await call('PATCH', '/api/alert-rules/co2_high', 'owner', {
      warning: { for: '20m' },
    });
    expect(second.body).toMatchObject({ effective: { warning: { level: 1100, for: '20m' } } });
    // Members see the new levels straight away.
    expect((await myRule('anna', 'co2_high')).description).toBe(
      'Warning above 1,100 ppm for 20 min · Urgent above 1,500 ppm for 10 min',
    );

    const bad = await call('PATCH', '/api/alert-rules/co2_high', 'owner', {
      clear: { level: 1200 },
    });
    expect(bad).toMatchObject({
      status: 400,
      body: { error: { message: 'clear must be below the warning level' } },
    });
    expect(
      (
        await call('PATCH', '/api/alert-rules/vacuum_battery_low', 'owner', {
          alert: { level: 10, for: '1h' },
        })
      ).status,
    ).toBe(400);

    expect((await call('DELETE', '/api/alert-rules/co2_high/override', 'owner')).status).toBe(204);
    expect((await myRule('anna', 'co2_high')).description).toMatch(
      /^Warning above 1,000 ppm for 15 min/,
    );
  });

  it('switches a rule off for everyone, and options on', async () => {
    await call('PATCH', '/api/alert-rules/humidity_high', 'owner', { enabled: false });
    expect((await myRule('anna', 'humidity_high')).ruleEnabled).toBe(false);
    const opt = await call('PATCH', '/api/alert-rules/network_new_device', 'owner', {
      options: { ignoreRandomised: true },
    });
    expect(opt.body).toMatchObject({ effective: { options: { ignoreRandomised: true } } });
  });
});

describe('Recent notifications (admin)', () => {
  it('lists who got what, newest first', async () => {
    const [owner] = await db.sql<
      { id: number }[]
    >`select id from users where email = 'owner@example.com'`;
    const [event] = await db.sql<{ id: string }[]>`select id from events where kind = 'co2_high'`;
    await db.sql`insert into notification_log (event_id, user_id, phase, status)
                 values (${event!.id}, ${owner!.id}, 'opened', 'skipped_level')`;
    const log = NotificationLogResponseSchema.parse(
      (await call('GET', '/api/notifications/log', 'owner')).body,
    );
    expect(log.items[0]).toMatchObject({
      user: 'owner@example.com',
      ruleId: 'co2_high',
      entity: 'kitchen',
      phase: 'opened',
      status: 'skipped_level',
      device: null,
    });
  });
});
