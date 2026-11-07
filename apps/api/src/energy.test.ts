import { createReadingWriter, loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { EnergySummarySchema, type ReadingInput } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';

const NOW = new Date('2026-11-06T14:00:00Z');
const config: Config = {
  env: 'test',
  port: 0,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: { disabled: true },
};
const HALF = 1800_000;

let db: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  const w = createReadingWriter(db.sql);

  // Half-hourly from 1 Oct to the end of 5 Nov (the meter is a day behind on 6 Nov).
  // Electricity 0.1 kWh each, except 0.084 at 03:00 UTC (the baseload); gas 0.5 kWh each.
  // One gas half-hour on 3 Nov is missing, so that day is incomplete.
  const meter: ReadingInput[] = [];
  const grid: ReadingInput[] = [];
  for (
    let t = Date.parse('2026-10-01T00:00:00Z');
    t < Date.parse('2026-11-06T00:00:00Z');
    t += HALF
  ) {
    const ts = new Date(t);
    const common = {
      metric: 'energy_import',
      unit: 'kWh',
      valueType: 'interval_total' as const,
      interval: '30m',
      ts,
    };
    meter.push({
      ...common,
      entity: 'electricity',
      value: ts.getUTCHours() === 3 && ts.getUTCMinutes() === 0 ? 0.084 : 0.1,
    });
    if (ts.toISOString() !== '2026-11-03T12:00:00.000Z')
      meter.push({ ...common, entity: 'gas', value: 0.5 });
    grid.push({
      metric: 'intensity',
      entity: 'grid',
      unit: 'gCO₂/kWh',
      valueType: 'gauge',
      ts,
      value: 200,
    });
  }
  await w.write('smart_meters', meter);
  await w.write('carbon_intensity', grid);
  const outdoor: ReadingInput[] = [];
  for (
    let t = Date.parse('2026-10-20T00:00:00Z');
    t < Date.parse('2026-11-06T00:00:00Z');
    t += 3600_000
  ) {
    outdoor.push({
      metric: 'temperature',
      entity: 'outdoor',
      unit: '°C',
      valueType: 'gauge',
      ts: new Date(t),
      value: 10,
    });
  }
  await w.write('open_meteo', outdoor);
  await db.sql`
    insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from) values
      ('electricity', 24.5, 60.97, '2026-10-01'), ('gas', 6.3, 31.65, '2026-10-01')`;

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

const get = async (query = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/summary/energy${query}` });
  return { status: res.statusCode, body: res.json<unknown>() };
};

describe('GET /api/summary/energy', () => {
  it('defaults to the 14 days ending the last day the meter covers', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    expect([s.from, s.to, s.latestDay]).toEqual(['2026-10-23', '2026-11-05', '2026-11-05']);
    expect(s.days).toHaveLength(14);
    expect(s.freshness).toMatchObject({ state: 'delayed', label: 'Data to 5 Nov · 1 day behind' });
  });

  it('totals each fuel per London day and prices it with the tariff', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    const day = s.days.find((d) => d.date === '2026-11-05')!;
    expect(day.electricity?.kwh).toBeCloseTo(4.784); // 47 × 0.1 + 0.084
    expect(day.electricity).toMatchObject({ energyPence: 117, standingPence: 61 });
    expect(day.gas).toMatchObject({ kwh: 24, energyPence: 151, standingPence: 32 });
    expect(day).toMatchObject({ complete: true, outdoorC: 10, degreeDays: 5.5 });
  });

  it('counts the 25-hour day when the clocks go back, and flags an incomplete day', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    const longDay = s.days.find((d) => d.date === '2026-10-25')!;
    expect(longDay.gas?.kwh).toBe(25); // 50 half-hours
    expect(longDay.complete).toBe(true);
    expect(s.days.find((d) => d.date === '2026-11-03')?.complete).toBe(false);
  });

  it('adds up the month so far and projects the whole month', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    // 1–5 Nov: 117 + 61 + 151 + 32 = 361 p a day, except 3 Nov (gas 23.5 kWh → 148 p).
    expect(s.month).toEqual({
      from: '2026-11-01',
      to: '2026-11-05',
      costPence: 361 * 5 - 3,
      projectedPence: Math.round(((361 * 5 - 3) / 5) * 30),
    });
  });

  it('measures baseload overnight and compares it with four weeks earlier', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    expect(s.baseload).toEqual({
      watts: 168,
      night: '2026-11-05',
      yearlyPence: 36056,
      previousWatts: 168,
    });
  });

  it('computes carbon from the recorded grid intensity and the gas factor', async () => {
    const s = EnergySummarySchema.parse((await get()).body);
    const elecKwh = s.days.reduce((t, d) => t + (d.electricity?.kwh ?? 0), 0);
    expect(s.carbon.electricityKg).toBeCloseTo(elecKwh * 0.2, 5);
    expect(s.carbon.gasKg).toBeCloseTo((14 * 24 + 1 - 0.5) * 0.183, 5); // 25 Oct has 50 half-hours
  });

  it('honours an explicit range', async () => {
    const s = EnergySummarySchema.parse((await get('?from=2026-11-01&to=2026-11-02')).body);
    expect(s.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
    expect(s.month.to).toBe('2026-11-02');
  });

  it('takes a number of days ending the latest day', async () => {
    const s = EnergySummarySchema.parse((await get('?days=30')).body);
    expect([s.from, s.to, s.days.length]).toEqual(['2026-10-07', '2026-11-05', 30]);
  });

  it('validates the range', async () => {
    expect((await get('?from=2026-11-05&to=2026-11-01')).status).toBe(400);
    expect((await get('?from=2020-01-01&to=2026-11-01')).status).toBe(400);
  });
});
