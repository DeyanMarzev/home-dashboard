import { createReadingWriter, loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { HeatingSummarySchema, type ReadingInput } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';

/** 6 Nov 2026, 14:00 GMT (London = UTC in November). */
const NOW = new Date('2026-11-06T14:00:00Z');
const config: Config = {
  env: 'test',
  port: 0,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: { disabled: true },
};
const MIN = 60_000;

let db: TestDatabase;
let app: FastifyInstance;

/** Every 2 minutes from `from` until NOW. */
function every2min(
  from: string,
  value: (t: Date) => number,
  metric: string,
  entity: string,
  unit = '°C',
  valueType: 'gauge' | 'state' = 'gauge',
): ReadingInput[] {
  const out: ReadingInput[] = [];
  for (let t = Date.parse(from); t < NOW.getTime(); t += 2 * MIN) {
    out.push({ metric, entity, unit, valueType, ts: new Date(t), value: value(new Date(t)) });
  }
  return out;
}

const minuteOfDay = (t: Date) => t.getUTCHours() * 60 + t.getUTCMinutes();
const isToday = (t: Date) => t.getUTCDate() === 6;
// Every day the boiler fires 06:00–07:30; before today also 17:00–17:10 (a short cycle).
const firing = (t: Date) => {
  const m = minuteOfDay(t);
  return (m >= 360 && m < 450) || (!isToday(t) && m >= 1020 && m < 1030);
};

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  const w = createReadingWriter(db.sql);

  await w.write(
    'nest',
    every2min(
      '2026-10-31T00:00:00Z',
      (t) => (firing(t) ? 1 : 0),
      'hvac_heating',
      'boiler',
      'state',
      'state',
    ),
  );
  // Hallway 16 °C overnight, +2 °C an hour while warming 06:00–07:30, then 19 °C.
  await w.write(
    'nest',
    every2min(
      '2026-11-06T04:00:00Z',
      (t) => {
        const m = minuteOfDay(t);
        return m < 360 ? 16 : m < 450 ? 16 + (2 * (m - 360)) / 60 : 19;
      },
      'temperature',
      'hallway',
    ),
  );
  await w.write(
    'nest',
    every2min(
      '2026-11-06T00:00:00Z',
      (t) => (minuteOfDay(t) < 360 ? 16 : 20.5),
      'target_temperature',
      'hallway',
    ),
  );
  // Probes all day: flow 66 °C then 58 °C while firing; return below 55 °C for the first 45 min.
  await w.write(
    'boiler_probes',
    every2min(
      '2026-11-06T00:00:00Z',
      (t) => {
        const m = minuteOfDay(t);
        return firing(t) ? (m < 405 ? 66 : 58) : 30;
      },
      'temperature',
      'boiler_flow',
    ),
  );
  await w.write(
    'boiler_probes',
    every2min(
      '2026-11-06T00:00:00Z',
      (t) => {
        const m = minuteOfDay(t);
        return firing(t) ? (m < 405 ? 48 : 56) : 28;
      },
      'temperature',
      'boiler_return',
    ),
  );

  app = await buildServer(config, {
    db: db.sql,
    registry,
    now: () => NOW,
    notifications: { listen: () => Promise.resolve(() => Promise.resolve()) },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const summary = async (query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/summary/heating${query}` });
  return { status: res.statusCode, body: res.json<unknown>() };
};

describe('GET /api/summary/heating', () => {
  it('summarises today: runtime, cycles, firing runs and freshness', async () => {
    const { status, body } = await summary();
    expect(status).toBe(200);
    const s = HeatingSummarySchema.parse(body);
    expect(s.date).toBe('2026-11-06');
    expect(s.boiler).toEqual({
      heatingNow: false,
      minutesOn: 90,
      cycles: 1,
      shortCycles: 0,
      runs: [{ from: '2026-11-06T06:00:00.000Z', to: '2026-11-06T07:30:00.000Z' }],
    });
    expect(s.freshness?.state).toBe('live');
  });

  it('measures condensing from the return probe while firing', async () => {
    const s = HeatingSummarySchema.parse((await summary()).body);
    // 45 readings while firing; return < 55 °C for the first 23 of them.
    expect(s.condensingShare).toBeCloseTo(23 / 45, 5);
    expect(s.flowPeakC).toBe(66);
  });

  it('measures the warm-up rate from the thermostat temperature', async () => {
    const s = HeatingSummarySchema.parse((await summary()).body);
    expect(s.warmUp?.ratePerHour).toBeCloseTo(2, 1);
    expect(s.warmUp?.longest).toMatchObject({
      from: '2026-11-06T06:00:00.000Z',
      to: '2026-11-06T07:30:00.000Z',
      startC: 16,
    });
  });

  it('gives the last 7 days of runtime, oldest first', async () => {
    const s = HeatingSummarySchema.parse((await summary()).body);
    expect(s.days.map((d) => d.date)).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(s.days.slice(0, 6).every((d) => d.minutesOn === 100 && d.cycles === 2)).toBe(true);
    expect(s.days[6]).toEqual({ date: '2026-11-06', minutesOn: 90, cycles: 1 });
  });

  it('counts short cycles on a past day, and has no "now" for it', async () => {
    const s = HeatingSummarySchema.parse((await summary('?date=2026-11-05')).body);
    expect(s.boiler).toMatchObject({ minutesOn: 100, cycles: 2, shortCycles: 1, heatingNow: null });
  });

  it('lists the observed setpoints and rule-based tips', async () => {
    const s = HeatingSummarySchema.parse((await summary()).body);
    expect(s.setpoints[0]).toEqual(['2026-11-06T00:00:00.000Z', 16]);
    expect(s.setpoints.find(([t]) => t === '2026-11-06T06:00:00.000Z')?.[1]).toBe(20.5);
    expect(s.tips.map((t) => t.title)).toEqual([
      'Lower the boiler flow temperature',
      'Longest warm-up took 1 h 30 min',
    ]);
  });

  it('answers with nulls when there is no data for the day', async () => {
    const s = HeatingSummarySchema.parse((await summary('?date=2026-01-01')).body);
    expect(s.boiler).toMatchObject({ minutesOn: 0, cycles: 0, runs: [] });
    expect(s.condensingShare).toBeNull();
    expect(s.warmUp).toBeNull();
  });

  it('validates the date', async () => {
    expect((await summary('?date=6-11-2026')).status).toBe(400);
    expect((await summary('?day=2026-11-06')).status).toBe(400);
  });
});
