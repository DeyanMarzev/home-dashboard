import { createReadingWriter, loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { WaterSummarySchema, type ReadingInput } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';

/** 6 Nov 14:00: Thames data runs to the end of 3 Nov (3 days behind). */
const NOW = new Date('2026-11-06T14:00:00Z');
const config: Config = {
  env: 'test',
  port: 0,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: { disabled: true },
};

let db: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  // Hourly from 1 Oct to the end of 3 Nov: 10 L every hour 06:00–23:00 (180 L a day),
  // nothing at night, except 2 L an hour at night from 1 Nov (a leak, 3 nights).
  const readings: ReadingInput[] = [];
  for (
    let t = Date.parse('2026-10-01T00:00:00Z');
    t < Date.parse('2026-11-04T00:00:00Z');
    t += 3600_000
  ) {
    const ts = new Date(t);
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(ts),
    );
    const value = hour >= 6 ? 10 : ts >= new Date('2026-11-01T00:00:00Z') ? 2 : 0;
    readings.push({
      metric: 'volume',
      entity: 'mains',
      unit: 'L',
      valueType: 'interval_total',
      interval: '1h',
      ts,
      value,
    });
  }
  readings.push({
    metric: 'meter_reading',
    entity: 'mains',
    unit: 'm³',
    valueType: 'gauge',
    ts: new Date('2026-11-04T00:00:00Z'),
    value: 1284.6,
  });
  await createReadingWriter(db.sql).write('thames_water', readings);
  await db.sql`insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from) values ('water', 400, 30, '2026-04-01')`;

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
  const res = await app.inject({ method: 'GET', url: `/api/summary/water${query}` });
  return { status: res.statusCode, body: res.json<unknown>() };
};

describe('GET /api/summary/water', () => {
  it('defaults to the 28 days ending the last day covered, 3 days behind', async () => {
    const s = WaterSummarySchema.parse((await get()).body);
    expect([s.from, s.to, s.latestDay, s.days.length]).toEqual([
      '2026-10-07',
      '2026-11-03',
      '2026-11-03',
      28,
    ]);
    expect(s.freshness).toMatchObject({ state: 'delayed', label: 'Data to 3 Nov · 3 days behind' });
    expect(s.meterReadingM3).toBe(1284.6);
  });

  it('totals litres per London day and prices them per m³ with the standing charge', async () => {
    const s = WaterSummarySchema.parse((await get()).body);
    expect(s.days.find((d) => d.date === '2026-10-20')).toEqual({
      date: '2026-10-20',
      litres: 180,
      costPence: 102,
      complete: true,
    }); // 0.18 m³ × 400 + 30
    expect(s.days.find((d) => d.date === '2026-11-03')).toMatchObject({
      litres: 192, // + 6 night hours (00–05) × 2 L
      complete: true,
    });
    expect(s.days.find((d) => d.date === '2026-10-25')?.complete).toBe(true); // 25-hour day
  });

  it('gives the latest day hour by hour', async () => {
    const s = WaterSummarySchema.parse((await get()).body);
    expect(s.hourly).toHaveLength(24);
    expect(s.hourly[0]).toEqual(['2026-11-03T00:00:00.000Z', 2]);
  });

  it('flags 3 nights in a row with flow as a leak', async () => {
    const s = WaterSummarySchema.parse((await get()).body);
    expect(s.nights.slice(-4).map((n) => [n.night, n.minLitres])).toEqual([
      ['2026-10-31', 0],
      ['2026-11-01', 2],
      ['2026-11-02', 2],
      ['2026-11-03', 2],
    ]);
    expect(s.leak).toEqual({ state: 'leak', consecutive: 3, nightsChecked: 28 });
  });

  it('passes the leak check for a range that ends before it started', async () => {
    const s = WaterSummarySchema.parse((await get('?from=2026-10-20&to=2026-10-31')).body);
    expect(s.leak.state).toBe('ok');
  });

  it('validates the query', async () => {
    expect((await get('?from=2026-11-05&to=2026-11-01')).status).toBe(400);
    expect((await get('?days=0')).status).toBe(400);
  });
});
