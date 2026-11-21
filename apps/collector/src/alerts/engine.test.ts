import { buildAlertRules, type AlertsFile, type ReadingInput, type Registry } from '@home/shared';
import {
  createReadingWriter,
  loadAlertsFile,
  loadRegistryFile,
  migrate,
  openEvent,
  syncSources,
} from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertEngine } from './engine.js';

const ALERTS_FILE = fileURLToPath(new URL('../../../../config/alerts.yaml', import.meta.url));
const MIN = 60_000;
/** Runs of readings are written ending at `now`, one every 30 s like the room sensors. */
let now = new Date('2026-11-06T14:00:00Z');

let db: TestDatabase;
let registry: Registry;
let file: AlertsFile;
let engine: AlertEngine;

const co2 = (values: number[], from: Date): ReadingInput[] =>
  values.map((value, i) => ({
    metric: 'co2',
    entity: 'kitchen',
    unit: 'ppm',
    valueType: 'gauge',
    ts: new Date(from.getTime() + i * 30_000),
    value,
  }));

/** `minutes` of CO₂ at `value`, ending at the current `now`, then the clock moves on. */
async function hold(value: number, minutes: number) {
  const from = new Date(now.getTime() + 30_000);
  const count = minutes * 2;
  await createReadingWriter(db.sql).write(
    'room_sensors',
    co2(
      Array.from({ length: count }, () => value),
      from,
    ),
  );
  now = new Date(from.getTime() + (count - 1) * 30_000);
}

const kitchen = async () =>
  db.sql<
    {
      level: string;
      rule_id: string;
      message: string;
      escalated_at: Date | null;
      resolved_at: Date | null;
      data: { reason?: string };
    }[]
  >`
    select level, rule_id, message, escalated_at, resolved_at, data from events
    where kind = 'co2_high' and entity = 'kitchen' order by id`;

beforeAll(async () => {
  db = await startPglite();
  registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  file = await loadAlertsFile(ALERTS_FILE);
  engine = new AlertEngine({ db: db.sql, registry, file, log: pino({ level: 'silent' }) });
});

afterAll(async () => {
  await db?.close();
});

describe('config/alerts.yaml', () => {
  it('is valid: every rule loads, with no problems', () => {
    const built = buildAlertRules(file, new Map());
    expect(built.problems).toEqual([]);
    expect(built.rules.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'co2_high',
        'room_cold',
        'vacuum_not_charging',
        'vacuum_battery_low',
        'roborock_auth',
        'nest_auth',
        'water_leak',
        'backup',
        'source_late',
        'pi_undervoltage',
        'weather_warning',
        'network_new_device',
      ]),
    );
  });
});

describe('AlertEngine', () => {
  it('opens a warning once CO₂ has stayed high long enough, with its rule', async () => {
    await hold(1100, 14);
    await engine.tick(now);
    expect(await kitchen()).toEqual([]);
    await hold(1100, 2);
    await engine.tick(now);
    expect(await kitchen()).toEqual([
      expect.objectContaining({
        level: 'warning',
        rule_id: 'co2_high',
        message: 'CO₂ high · Kitchen 1,100 ppm',
        resolved_at: null,
      }),
    ]);
  });

  it('escalates the same event to urgent', async () => {
    await hold(1600, 11);
    await engine.tick(now);
    const events = await kitchen();
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('alert');
    expect(events[0]?.escalated_at).toBeInstanceOf(Date);
  });

  it('resolves it once CO₂ has been back under 900 for 5 minutes', async () => {
    await hold(950, 10); // between clear and warning: stays open
    await engine.tick(now);
    expect((await kitchen())[0]?.resolved_at).toBeNull();
    await hold(850, 6);
    await engine.tick(now);
    expect((await kitchen())[0]?.resolved_at).toEqual(expect.any(Date));
  });

  it("doesn't act on a source that has gone Late", async () => {
    now = new Date(now.getTime() + 60 * MIN); // the sensor stopped an hour ago
    await engine.tick(now);
    expect(await kitchen()).toHaveLength(1);
  });

  it('adopts recent events of event and freshness rules, but not info or old ones', async () => {
    const t = new Date();
    await openEvent(db.sql, {
      level: 'warning',
      sourceId: 'roborock',
      kind: 'vacuum_not_charging',
      message: "Vacuum isn't charging · Idle at 14:02",
    });
    await openEvent(db.sql, {
      level: 'warning',
      sourceId: 'nest',
      kind: 'source_late',
      message: 'Nest: no data since 13:00',
    });
    await db.sql`insert into events (level, kind, message) values ('info', 'backup', 'Backup finished')`;
    await db.sql`insert into events (ts, level, source_id, kind, message)
                 values (${new Date(t.getTime() - 2 * 60 * MIN)}, 'alert', 'thames_water', 'water_leak', 'old')`;
    await engine.tick(t);
    const rows = await db.sql<{ kind: string; rule_id: string | null }[]>`
      select kind, rule_id from events
      where kind in ('vacuum_not_charging', 'source_late', 'backup', 'water_leak') order by id`;
    expect(rows).toEqual([
      { kind: 'vacuum_not_charging', rule_id: 'vacuum_not_charging' },
      { kind: 'source_late', rule_id: 'source_late' },
      { kind: 'backup', rule_id: null },
      { kind: 'water_leak', rule_id: null },
    ]);
  });

  it('resolves open alerts of a rule an admin switched off, and reloads when told', async () => {
    await hold(1600, 12);
    await engine.tick(now);
    expect((await kitchen()).at(-1)).toMatchObject({ level: 'alert', resolved_at: null });
    await db.sql`insert into alert_rule_overrides (rule_id, params) values ('co2_high', '{"enabled": false}')`;
    engine.markDirty();
    await engine.tick(now);
    const off = (await kitchen()).at(-1);
    expect(off?.resolved_at).toBeInstanceOf(Date);
    expect(off?.data.reason).toBe('rule_disabled');
  });
});
