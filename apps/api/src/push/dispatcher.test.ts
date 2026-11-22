import {
  loadAlertRules,
  loadAlertsFile,
  loadRegistryFile,
  migrate,
  openEvent,
  resolveEvent,
  signInUser,
  syncSources,
  upsertDevice,
} from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { formatLondonTime, type AlertRules } from '@home/shared';
import type { FastifyBaseLogger } from 'fastify';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeChannel } from './channel.js';
import { Dispatcher } from './dispatcher.js';

const ALERTS_FILE = fileURLToPath(new URL('../../../../config/alerts.yaml', import.meta.url));
const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

let db: TestDatabase;
let rules: AlertRules;
let channel: FakeChannel;
const ids: Record<string, number> = {};
const phone = (who: string) => `https://push.example/${who}`;

const dispatcher = () =>
  new Dispatcher({ db: db.sql, channel, rules: () => rules, log, retryDelaysMs: [1, 1, 1] });

const logFor = async (eventId: number) =>
  db.sql<{ email: string; phase: string; status: string }[]>`
    select u.email, l.phase, l.status from notification_log l join users u on u.id = l.user_id
    where l.event_id = ${eventId} order by u.email, l.id`;

const kitchenCo2 = (level: 'warning' | 'alert', entity = 'kitchen') =>
  openEvent(db.sql, {
    level,
    sourceId: 'room_sensors',
    kind: 'co2_high',
    entity,
    ruleId: 'co2_high',
    message: `CO₂ high · ${entity} 1,300 ppm`,
    data: {
      value: level === 'alert' ? 1600 : 1300,
      unit: 'ppm',
      label: 'Kitchen',
      since: new Date(Date.now() - 15 * 60_000).toISOString(),
    },
  });

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  rules = await loadAlertRules(db.sql, await loadAlertsFile(ALERTS_FILE));

  for (const [who, admin] of [
    ['owner', true],
    ['anna', false],
    ['ben', false],
  ] as const) {
    const u = await signInUser(db.sql, `${who}@example.com`, { admin });
    ids[who] = u.id;
    await upsertDevice(db.sql, {
      userId: u.id,
      endpoint: phone(who),
      p256dh: 'p',
      auth: 'a',
      label: `${who}'s phone`,
      userAgent: null,
    });
  }
  // Anna: CO₂ warnings too, kitchen only, and back-to-normal. Ben: warnings too, but it's
  // his quiet time now (urgent still gets through).
  await db.sql`insert into user_alert_prefs (user_id, rule_id, enabled, min_level, entities, notify_resolved)
    values (${ids.anna!}, 'co2_high', true, 'warning', ${['kitchen']}, true),
           (${ids.ben!}, 'co2_high', true, 'warning', null, false)`;
  const t = Date.now();
  await db.sql`update users set
      quiet_start = ${formatLondonTime(new Date(t - 3600_000))}::time,
      quiet_end = ${formatLondonTime(new Date(t + 3600_000))}::time
    where id = ${ids.ben!}`;
});

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  channel = new FakeChannel();
});

describe('Dispatcher (docs/09 §9 integration)', () => {
  let eventId: number;

  it('sends a warning only to people whose preferences allow it, and logs every decision', async () => {
    eventId = (await kitchenCo2('warning'))!;
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => s.endpoint)).toEqual([phone('anna')]);
    expect(channel.sent[0]!.payload).toMatchObject({
      phase: 'opened',
      title: 'CO₂ high · Kitchen',
      body: '1,300 ppm for 15 min. Open a window or turn on ventilation.',
      tag: 'co2_high:kitchen',
      url: '/rooms#kitchen',
      level: 'warning',
    });
    expect(await logFor(eventId)).toEqual([
      { email: 'anna@example.com', phase: 'opened', status: 'sent' },
      { email: 'ben@example.com', phase: 'opened', status: 'skipped_quiet' },
      { email: 'owner@example.com', phase: 'opened', status: 'skipped_level' },
    ]);
  });

  it('pushes an escalation with the same tag, through quiet hours', async () => {
    await kitchenCo2('alert');
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => s.endpoint).sort()).toEqual(
      [phone('anna'), phone('ben'), phone('owner')].sort(),
    );
    expect(new Set(channel.sent.map((s) => s.payload.tag))).toEqual(new Set(['co2_high:kitchen']));
    expect(channel.sent[0]!.payload.title).toBe('Urgent: CO₂ high · Kitchen');
  });

  it('sends "back to normal" only to people who asked for it', async () => {
    await resolveEvent(db.sql, 'room_sensors', 'co2_high', 'kitchen');
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => [s.endpoint, s.payload.phase, s.payload.title])).toEqual([
      [phone('anna'), 'resolved', 'CO₂ back to normal · Kitchen'],
    ]);
  });

  it('sends each event once, even across a restart', async () => {
    const id = (await kitchenCo2('alert', 'bedroom'))!;
    await dispatcher().runOnce(); // a fresh instance, as after a restart
    await dispatcher().runOnce();
    expect(channel.sent).toHaveLength(2); // owner and ben (anna: kitchen only)
    expect((await logFor(id)).filter((l) => l.status === 'sent')).toHaveLength(2);
    await resolveEvent(db.sql, 'room_sensors', 'co2_high', 'bedroom');
    await dispatcher().runOnce();
  });

  it('marks events older than an hour as handled without pushing them', async () => {
    await db.sql`insert into events (ts, level, source_id, kind, entity, message, rule_id)
      values (now() - interval '2 hours', 'alert', 'room_sensors', 'co2_high', 'office', 'old', 'co2_high')`;
    await dispatcher().runOnce();
    expect(channel.sent).toEqual([]);
    const [row] = await db.sql<{ dispatched_at: Date | null }[]>`
      select dispatched_at from events where entity = 'office'`;
    expect(row?.dispatched_at).toBeInstanceOf(Date);
    await resolveEvent(db.sql, 'room_sensors', 'co2_high', 'office');
    await dispatcher().runOnce();
    expect(channel.sent).toEqual([]);
  });

  it('retries a busy push service, and removes a subscription that is gone', async () => {
    let busy = 1;
    channel.respond = (endpoint) => {
      if (endpoint === phone('owner'))
        return { ok: false, gone: true, retry: false, error: 'HTTP 410' };
      if (endpoint === phone('ben') && busy-- > 0)
        return { ok: false, gone: false, retry: true, error: 'HTTP 503' };
      return { ok: true };
    };
    const id = (await kitchenCo2('alert', 'hall'))!;
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => s.endpoint)).toEqual([phone('ben')]);
    expect(await logFor(id)).toEqual(
      [
        { email: 'ben@example.com', phase: 'opened', status: 'sent' },
        { email: 'owner@example.com', phase: 'opened', status: 'gone' },
        { email: 'anna@example.com', phase: 'opened', status: 'skipped_entity' },
      ].sort((a, b) => a.email.localeCompare(b.email)),
    );
    const [gone] =
      await db.sql`select 1 from push_subscriptions where endpoint = ${phone('owner')}`;
    expect(gone).toBeUndefined();
    await resolveEvent(db.sql, 'room_sensors', 'co2_high', 'hall');
    await dispatcher().runOnce();
  });

  it('stops at 20 pushes an hour, with one "Too many alerts" push instead', async () => {
    await db.sql`insert into notification_log (user_id, phase, status)
      select ${ids.ben!}, 'opened', 'sent' from generate_series(1, 20)`;
    const first = (await kitchenCo2('alert', 'loft'))!;
    const second = (await kitchenCo2('alert', 'garage'))!;
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => [s.endpoint, s.payload.title])).toEqual([
      [phone('ben'), 'Too many alerts'],
    ]);
    for (const id of [first, second]) {
      expect((await logFor(id)).find((l) => l.email === 'ben@example.com')?.status).toBe(
        'skipped_rate_limited',
      );
    }
  });

  it('says nothing when an event ends before it was ever announced', async () => {
    await db.sql`delete from notification_log`;
    const id = (await kitchenCo2('alert', 'porch'))!;
    await resolveEvent(db.sql, 'room_sensors', 'co2_high', 'porch');
    await dispatcher().runOnce();
    expect(channel.sent).toEqual([]);
    expect(await logFor(id)).toEqual([]);
  });

  it('pushes adopted events of event rules, e.g. the vacuum', async () => {
    const id = (await openEvent(db.sql, {
      level: 'warning',
      sourceId: 'roborock',
      kind: 'vacuum_not_charging',
      message: "Vacuum isn't charging · Idle at 14:02, battery 63%. Check it's on its dock",
    }))!;
    await db.sql`update events set rule_id = kind where id = ${id}`; // the collector's engine does this
    await dispatcher().runOnce();
    // Everyone by default; Ben is in his quiet hours (a warning waits), the owner's phone is gone.
    expect(channel.sent.map((s) => [s.endpoint, s.payload.title, s.payload.body])).toEqual([
      [
        phone('anna'),
        "Vacuum isn't charging",
        "Idle at 14:02, battery 63%. Check it's on its dock.",
      ],
    ]);
    expect((await logFor(id)).map((l) => l.status)).toEqual(['sent', 'skipped_quiet']);
  });

  it('sends a personal reminder only to the people it names', async () => {
    await db.sql`delete from notification_log`;
    const id = (await openEvent(db.sql, {
      level: 'warning',
      sourceId: 'wifi',
      kind: 'network_device_connected',
      entity: 'b8:27:eb:00:00:01',
      ruleId: 'network_device_connected',
      message: "Deyan's laptop connected · 192.168.1.20",
      data: { recipients: [ids.anna!], reminder: true },
    }))!;
    await dispatcher().runOnce();
    expect(channel.sent.map((s) => [s.endpoint, s.payload.title, s.payload.url])).toEqual([
      [phone('anna'), "Deyan's laptop connected", '/wifi#b8:27:eb:00:00:01'],
    ]);
    // Nobody else is even considered: no "skipped" rows for them.
    expect(await logFor(id)).toEqual([
      { email: 'anna@example.com', phase: 'opened', status: 'sent' },
    ]);
  });
});
