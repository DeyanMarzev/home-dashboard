import { parseRegistry, type ReadingInput, type Registry } from '@home/shared';
import { cp, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS_CHANNEL, openEvent, resolveEvent } from './events.js';
import { latestBySource } from './latest.js';
import { migrate, MigrationError } from './migrate.js';
import { createReadingWriter, lastDataTo, READINGS_CHANNEL } from './readings.js';
import { loadRegistryFile } from './registry-file.js';
import { attemptsSince, finishRun, pruneRuns, recordRun, startRun } from './runs.js';
import { syncSources } from './sources.js';
import { addPublishedTariff } from './tariffs.js';
import { SOURCES_FILE, testBackends, type TestDatabase } from './test/database.js';
import {
  forgetNetworkDevice,
  listNetworkDevices,
  recordNetworkScan,
  updateNetworkDevice,
} from './network-devices.js';
import { listUsers, signInUser, updateProfile, updateUserAccess } from './users.js';

const kitchenTemps: ReadingInput[] = [
  {
    metric: 'temperature',
    entity: 'kitchen',
    unit: '°C',
    valueType: 'gauge',
    ts: '2026-11-06T13:00:00Z',
    value: 20.1,
  },
  {
    metric: 'temperature',
    entity: 'kitchen',
    unit: '°C',
    valueType: 'gauge',
    ts: '2026-11-06T13:00:30Z',
    value: 20.2,
  },
  {
    metric: 'co2',
    entity: 'kitchen',
    unit: 'ppm',
    valueType: 'gauge',
    ts: '2026-11-06T13:00:30Z',
    value: 780,
  },
];

const halfHourly = (day: string, n: number, kwh = 0.25): ReadingInput[] =>
  Array.from({ length: n }, (_, i) => ({
    metric: 'energy_import',
    entity: 'electricity',
    unit: 'kWh',
    valueType: 'interval_total' as const,
    interval: '30m',
    ts: new Date(Date.parse(`${day}T00:00:00Z`) + i * 1800_000),
    value: kwh,
  }));

const count = async (sql: Sql, table: string) =>
  Number((await sql.unsafe<{ n: string }[]>(`select count(*) as n from ${table}`))[0]?.n);

describe.each(testBackends)('database ($name)', ({ start }) => {
  let db: TestDatabase;
  let sql: Sql;
  let registry: Registry;

  beforeAll(async () => {
    db = await start();
    sql = db.sql;
    registry = await loadRegistryFile(SOURCES_FILE);
  });
  afterAll(async () => {
    await db?.close();
  });

  describe('migrate', () => {
    it('applies every migration once', async () => {
      const applied = await migrate(sql, db.migrationsDir);
      expect(applied.length).toBeGreaterThan(0);
      expect(await migrate(sql, db.migrationsDir)).toEqual([]);
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((t) => t.table_name)).toEqual(
        expect.arrayContaining([
          'collector_runs',
          'events',
          'readings',
          'schema_migrations',
          'series',
          'sources',
          'tariffs',
          'users',
          'push_subscriptions',
          'user_alert_prefs',
          'alert_rule_overrides',
          'alert_state',
          'notification_log',
          'network_devices',
        ]),
      );
    });

    it('is safe to run from two processes at once', async () => {
      const other = db.connect();
      try {
        const results = await Promise.all([
          migrate(sql, db.migrationsDir),
          migrate(other, db.migrationsDir),
        ]);
        expect(results).toEqual([[], []]);
      } finally {
        await other.end();
      }
    });

    it('refuses to continue if an applied migration was edited', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'home-migrations-edited-'));
      try {
        await cp(db.migrationsDir, dir, { recursive: true });
        await appendFile(join(dir, '001_init.sql'), '\n-- edited\n');
        await expect(migrate(sql, dir)).rejects.toThrow(MigrationError);
        await expect(migrate(sql, dir)).rejects.toThrow(/001_init\.sql was changed/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('syncSources', () => {
    type Row = {
      id: string;
      name: string;
      kind: string;
      poll: number | null;
      delay: number;
      grace: number | null;
      enabled: boolean;
    };
    const rows = () => sql<Row[]>`
      select id, name, kind, extract(epoch from poll_interval)::int as poll,
             extract(epoch from expected_delay)::int as delay, extract(epoch from grace)::int as grace, enabled
      from sources order by id`;

    it('makes the sources table match config/sources.yaml', async () => {
      const result = await syncSources(sql, registry);
      expect(result.changed.sort()).toEqual(registry.sources.map((s) => s.id).sort());
      expect(await rows()).toEqual(
        registry.sources
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            poll: s.poll?.type === 'every' ? s.poll.seconds : null,
            delay: s.expectedDelaySeconds,
            grace: s.graceSeconds,
            enabled: s.enabled,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      const meters = (await rows()).find((r) => r.id === 'smart_meters');
      expect(meters).toMatchObject({ poll: 21600, delay: 86400, grace: 43200 });
    });

    it('changes nothing when synced again', async () => {
      expect(await syncSources(sql, registry)).toEqual({ changed: [], disabled: [] });
    });

    it('updates changed sources and disables removed ones, keeping their rows', async () => {
      const edited = parseRegistry({
        sources: {
          room_sensors: { name: 'Room sensors (ESP32)', kind: 'sensor', push_interval: '30s' },
          pi_stats: { name: 'Raspberry Pi', kind: 'local', poll: '1m' },
        },
      });
      const result = await syncSources(sql, edited);
      expect(result.changed).toEqual(['room_sensors']);
      expect(result.disabled.sort()).toEqual(
        registry.sources
          .filter((s) => s.enabled && !['room_sensors', 'pi_stats'].includes(s.id))
          .map((s) => s.id)
          .sort(),
      );
      expect((await rows()).length).toBe(registry.sources.length);

      await syncSources(sql, registry); // back to the real registry
      expect((await rows()).find((r) => r.id === 'open_meteo')?.enabled).toBe(true);
    });
  });

  describe('writeReadings', () => {
    it('creates series on first write', async () => {
      const writer = createReadingWriter(sql);
      expect(await writer.write('room_sensors', kitchenTemps)).toBe(3);
      const series =
        await sql`select metric, entity, unit, value_type from series where source_id = 'room_sensors' order by metric`;
      expect(series).toEqual([
        { metric: 'co2', entity: 'kitchen', unit: 'ppm', value_type: 'gauge' },
        { metric: 'temperature', entity: 'kitchen', unit: '°C', value_type: 'gauge' },
      ]);
    });

    it('writing the same batch twice does not duplicate rows (fresh writer, no cache)', async () => {
      const before = await count(sql, 'readings');
      const seriesBefore = await count(sql, 'series');
      expect(await createReadingWriter(sql).write('room_sensors', kitchenTemps)).toBe(3);
      expect(await count(sql, 'readings')).toBe(before);
      expect(await count(sql, 'series')).toBe(seriesBefore);
    });

    it('re-sent values replace old ones and refresh received_at; ts is untouched', async () => {
      const writer = createReadingWriter(sql);
      const [old] = await sql<{ received_at: Date }[]>`
        select received_at from readings join series s on s.id = series_id
        where s.metric = 'co2' and ts = '2026-11-06T13:00:30Z'`;
      await new Promise((r) => setTimeout(r, 20));
      await writer.write('room_sensors', [{ ...kitchenTemps[2]!, value: 812 }]);
      const [now] = await sql<{ value: number; received_at: Date; ts: Date }[]>`
        select value, received_at, ts from readings join series s on s.id = series_id
        where s.metric = 'co2' and ts = '2026-11-06T13:00:30Z'`;
      expect(now?.value).toBe(812);
      expect(now?.ts.toISOString()).toBe('2026-11-06T13:00:30.000Z');
      expect(now!.received_at.getTime()).toBeGreaterThan(old!.received_at.getTime());
    });

    it('overlapping windows from a delayed source upsert cleanly', async () => {
      const writer = createReadingWriter(sql);
      expect(await writer.write('smart_meters', halfHourly('2026-11-04', 48))).toBe(48);
      // Next run re-fetches from 2 days back: the 4th again (revised values) plus the 5th.
      expect(
        await writer.write('smart_meters', [
          ...halfHourly('2026-11-04', 48, 0.3),
          ...halfHourly('2026-11-05', 48),
        ]),
      ).toBe(96);
      const [row] = await sql<{ n: string; total: number }[]>`
        select count(*) as n, sum(value) as total from readings r join series s on s.id = r.series_id
        where s.source_id = 'smart_meters'`;
      expect(Number(row?.n)).toBe(96);
      expect(row?.total).toBeCloseTo(48 * 0.3 + 48 * 0.25);
    });

    it('stores the interval of interval_total series', async () => {
      const [s] = await sql<{ secs: number }[]>`
        select extract(epoch from interval)::int as secs from series where source_id = 'smart_meters'`;
      expect(s?.secs).toBe(1800);
    });

    it('lastDataTo is the end of the last interval for totals, the latest ts for gauges', async () => {
      expect(
        (await lastDataTo(sql, 'smart_meters', 'energy_import', 'electricity'))?.toISOString(),
      ).toBe('2026-11-06T00:00:00.000Z');
      expect((await lastDataTo(sql, 'room_sensors', 'temperature', 'kitchen'))?.toISOString()).toBe(
        '2026-11-06T13:00:30.000Z',
      );
      expect(await lastDataTo(sql, 'room_sensors', 'temperature', 'attic')).toBeNull();
    });

    it('series_latest shows the newest reading per series', async () => {
      const rows = await sql<{ latest_ts: Date; value: number }[]>`
        select l.latest_ts, l.value from series_latest l join series s on s.id = l.series_id
        where s.source_id = 'room_sensors' and s.metric = 'temperature'`;
      expect(rows).toEqual([{ latest_ts: new Date('2026-11-06T13:00:30Z'), value: 20.2 }]);
    });

    it('rejects a reading whose unit differs from its series, writing nothing from the batch', async () => {
      const before = await count(sql, 'readings');
      const writer = createReadingWriter(sql);
      await expect(
        writer.write('room_sensors', [
          {
            metric: 'humidity',
            entity: 'kitchen',
            unit: '%',
            valueType: 'gauge',
            ts: '2026-11-06T14:00:00Z',
            value: 55,
          },
          { ...kitchenTemps[0]!, ts: '2026-11-06T14:00:00Z', unit: '°F' },
        ]),
      ).rejects.toThrow(/temperature\|kitchen: unit °F ≠ series unit °C/);
      expect(await count(sql, 'readings')).toBe(before);
      expect((await sql`select 1 from series where metric = 'humidity'`).length).toBe(0); // rolled back
    });

    it('rejects readings for a source that is not in the registry', async () => {
      await expect(
        createReadingWriter(sql).write('no_such_source', kitchenTemps),
      ).rejects.toThrow();
    });

    it('writes large batches in several statements', async () => {
      // Weeks-old rows: a backfill, which also refreshes the hourly rollup (Timescale only).
      const rollupErrors: unknown[] = [];
      const writer = createReadingWriter(sql, { onRollupError: (e) => rollupErrors.push(e) });
      const many: ReadingInput[] = Array.from({ length: 12_000 }, (_, i) => ({
        metric: 'cpu_temperature',
        entity: 'pi',
        unit: '°C',
        valueType: 'gauge',
        ts: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60_000),
        value: 40 + (i % 10),
      }));
      expect(await writer.write('pi_stats', many)).toBe(12_000);
      const [row] = await sql<{ n: string }[]>`
        select count(*) as n from readings r join series s on s.id = r.series_id where s.metric = 'cpu_temperature'`;
      expect(Number(row?.n)).toBe(12_000);
      expect(rollupErrors).toEqual([]);
    });

    it('notifies listeners with the newest point of each series, after commit', async (ctx) => {
      if (!db.supportsNotify) ctx.skip('PGlite: needs TEST_DATABASE_URL (real Postgres)');
      const received: unknown[] = [];
      const unlisten = await db.listen(READINGS_CHANNEL, (payload) =>
        received.push(JSON.parse(payload)),
      );
      try {
        await createReadingWriter(sql).write('room_sensors', [
          { ...kitchenTemps[0]!, ts: '2026-11-06T15:00:00Z', value: 21 },
          { ...kitchenTemps[0]!, ts: '2026-11-06T15:00:30Z', value: 21.5 },
        ]);
        for (let i = 0; i < 50 && received.length === 0; i++)
          await new Promise((r) => setTimeout(r, 50));
        const [series] = await sql<
          { id: number }[]
        >`select id from series where metric = 'temperature' and entity = 'kitchen'`;
        expect(received).toEqual([
          { seriesId: series?.id, ts: '2026-11-06T15:00:30.000Z', value: 21.5 },
        ]);
      } finally {
        await unlisten();
      }
    });
  });
  describe('latestBySource', () => {
    it('takes each source from the series that reaches furthest, ignoring forecasts', async () => {
      const writer = createReadingWriter(sql);
      await writer.write('open_meteo', [
        {
          metric: 'temperature',
          entity: 'outdoor',
          unit: '°C',
          valueType: 'gauge',
          ts: '2026-11-06T13:00:00Z',
          value: 9,
        },
        {
          metric: 'forecast_temperature',
          entity: 'outdoor',
          unit: '°C',
          valueType: 'gauge',
          ts: '2026-11-07T12:00:00Z',
          value: 11,
        },
      ]);
      const latest = await latestBySource(sql);
      expect(latest.get('open_meteo')).toEqual({
        ts: new Date('2026-11-06T13:00:00Z'),
        intervalSeconds: null,
      });
      // smart_meters: last half-hour starts 23:30 on the 5th and keeps its interval.
      expect(latest.get('smart_meters')).toEqual({
        ts: new Date('2026-11-05T23:30:00Z'),
        intervalSeconds: 1800,
      });
      expect(latest.has('thames_water')).toBe(false);
    });
  });

  describe('collector runs', () => {
    it('records a run from start to finish', async () => {
      const id = await startRun(sql, 'pi_stats', new Date('2026-11-06T13:00:00Z'));
      await finishRun(
        sql,
        id,
        { ok: false, rowsWritten: 0, error: 'x'.repeat(2000) },
        new Date('2026-11-06T13:00:02Z'),
      );
      const [run] = await sql<{ ok: boolean; rows_written: number; error: string; ms: number }[]>`
        select ok, rows_written, error, extract(epoch from finished_at - started_at) * 1000 as ms
        from collector_runs where id = ${id}`;
      expect(run).toMatchObject({ ok: false, rows_written: 0 });
      expect(Number(run?.ms)).toBe(2000);
      expect(run?.error.length).toBe(500); // truncated
    });

    it('counts attempts that did work, not skipped runs', async () => {
      const since = new Date('2026-11-07T00:00:00Z');
      const run = async (ok: boolean, rows: number) => {
        const id = await startRun(sql, 'thames_water', new Date('2026-11-07T06:00:00Z'));
        await finishRun(sql, id, { ok, rowsWritten: rows, error: ok ? null : 'login failed' });
      };
      await run(false, 0); // failed login
      await run(true, 0); // skipped: limit reached
      await run(true, 168); // success
      expect(await attemptsSince(sql, 'thames_water', since)).toBe(2);
      expect(await attemptsSince(sql, 'thames_water', new Date('2026-11-08T00:00:00Z'))).toBe(0);
    });

    it('records a summarised run in one go and prunes old history', async () => {
      await recordRun(
        sql,
        'room_sensors',
        new Date('2020-01-01T00:00:00Z'),
        new Date('2020-01-01T00:01:00Z'),
        { ok: true, rowsWritten: 12 },
      );
      await recordRun(sql, 'room_sensors', new Date(Date.now() - 60_000), new Date(), {
        ok: true,
        rowsWritten: 12,
      });
      expect(await pruneRuns(sql, 30)).toBeGreaterThanOrEqual(1);
      const [row] = await sql<
        { n: string }[]
      >`select count(*) as n from collector_runs where started_at < '2021-01-01'`;
      expect(Number(row?.n)).toBe(0);
    });
  });

  describe('addPublishedTariff', () => {
    const rows = () =>
      sql<{ fuel: string; unit: number; standing: number; from: string; to: string | null }[]>`
        select fuel, unit_rate_pence::float8 as unit, standing_pence::float8 as standing,
               valid_from::text as from, valid_to::text as to
        from tariffs where fuel = 'water' order by valid_from`;
    const thames = (validFrom: string, unitRatePence = 420.67) => ({
      fuel: 'water' as const,
      unitRatePence,
      standingPence: 53.425,
      validFrom,
      publisher: 'Thames Water',
    });

    it('adds published rates, ends the previous row the day before, and is idempotent', async () => {
      await sql`delete from tariffs where fuel = 'water'`;
      await sql`insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from)
                values ('water', 380, 50, '2025-04-01')`;
      expect(await addPublishedTariff(sql, thames('2026-04-01'))).toBe(true);
      expect(await rows()).toEqual([
        { fuel: 'water', unit: 380, standing: 50, from: '2025-04-01', to: '2026-03-31' },
        { fuel: 'water', unit: 420.67, standing: 53.425, from: '2026-04-01', to: null },
      ]);
      expect(await addPublishedTariff(sql, thames('2026-04-01'))).toBe(false);
      expect(await rows()).toHaveLength(2);
      const [event] = await sql<
        { level: string; kind: string; message: string; resolved: boolean }[]
      >`
        select level, kind, message, resolved_at is not null as resolved
        from events where kind = 'tariff_updated' order by id desc limit 1`;
      expect(event).toEqual({
        level: 'info',
        kind: 'tariff_updated',
        message:
          'Water rates from Thames Water added: 420.67 p per m³, 53.425 p a day, from 2026-04-01',
        resolved: true,
      });
    });

    it('leaves rates the owner entered for a later date alone', async () => {
      await sql`delete from tariffs where fuel = 'water'`;
      await sql`insert into tariffs (fuel, unit_rate_pence, standing_pence, valid_from)
                values ('water', 999, 1, '2026-05-01')`;
      expect(await addPublishedTariff(sql, thames('2026-04-01'))).toBe(false);
      expect((await rows()).map((r) => r.unit)).toEqual([999]);
    });
  });

  describe('events', () => {
    const late = {
      level: 'warning' as const,
      sourceId: 'room_sensors',
      kind: 'source_late',
      message: 'Room sensors: no data since 13:10',
    };
    const openCount = async () =>
      Number(
        (
          await sql<
            { n: string }[]
          >`select count(*) as n from events where kind = 'source_late' and resolved_at is null`
        )[0]?.n,
      );

    it('opens at most one event per source and kind', async () => {
      const id = await openEvent(sql, { ...late, data: { state: 'late' } });
      expect(id).toEqual(expect.any(Number));
      expect(await openEvent(sql, late)).toBeNull();
      expect(await openCount()).toBe(1);
    });

    it('resolves the open event, after which a new one can open', async () => {
      expect(await resolveEvent(sql, 'room_sensors', 'source_late')).toEqual(expect.any(Number));
      expect(await resolveEvent(sql, 'room_sensors', 'source_late')).toBeNull();
      expect(await openCount()).toBe(0);
      expect(await openEvent(sql, late)).toEqual(expect.any(Number));
      expect(await openCount()).toBe(1);
      await resolveEvent(sql, 'room_sensors', 'source_late');
    });

    it('keeps one open event per entity, and resolves only that entity', async () => {
      const warn = {
        level: 'warning' as const,
        sourceId: 'roborock',
        kind: 'test_kind',
        message: 'x',
      };
      expect(await openEvent(sql, { ...warn, entity: 'kitchen' })).toEqual(expect.any(Number));
      expect(await openEvent(sql, { ...warn, entity: 'bedroom' })).toEqual(expect.any(Number));
      expect(await openEvent(sql, { ...warn, entity: 'kitchen' })).toBeNull();
      expect(await resolveEvent(sql, 'roborock', 'test_kind', 'kitchen')).toEqual(
        expect.any(Number),
      );
      const open = await sql<{ entity: string }[]>`
        select entity from events where kind = 'test_kind' and resolved_at is null`;
      expect(open.map((r) => r.entity)).toEqual(['bedroom']);
      await resolveEvent(sql, 'roborock', 'test_kind', 'bedroom');
    });

    it('escalates an open event to a higher level, and only refreshes it otherwise', async () => {
      const base = {
        sourceId: 'room_sensors',
        kind: 'co2_high',
        entity: 'kitchen',
        ruleId: 'co2_high',
      };
      const id = await openEvent(sql, {
        ...base,
        level: 'warning',
        message: 'CO₂ high · Kitchen 1,100 ppm',
      });
      await sql`update events set dispatched_at = now() where id = ${id}`;
      const row = async () =>
        (
          await sql<
            {
              level: string;
              message: string;
              escalated_at: Date | null;
              dispatched_at: Date | null;
              rule_id: string;
              data: unknown;
            }[]
          >`select level, message, escalated_at, dispatched_at, rule_id, data from events where id = ${id}`
        )[0]!;

      expect(
        await openEvent(sql, {
          ...base,
          level: 'alert',
          message: 'CO₂ high · Kitchen 1,600 ppm',
          title: 'Urgent',
        }),
      ).toBeNull();
      const escalated = await row();
      expect(escalated).toMatchObject({
        level: 'alert',
        message: 'CO₂ high · Kitchen 1,600 ppm',
        dispatched_at: null,
        rule_id: 'co2_high',
        data: { title: 'Urgent' },
      });
      expect(escalated.escalated_at).toBeInstanceOf(Date);

      await sql`update events set dispatched_at = now() where id = ${id}`;
      expect(
        await openEvent(sql, {
          ...base,
          level: 'warning',
          message: 'CO₂ high · Kitchen 1,200 ppm',
        }),
      ).toBeNull();
      const refreshed = await row();
      expect(refreshed).toMatchObject({ level: 'alert', message: 'CO₂ high · Kitchen 1,200 ppm' });
      expect(refreshed.dispatched_at).toBeInstanceOf(Date); // still dispatched: no new push
      await resolveEvent(sql, 'room_sensors', 'co2_high', 'kitchen');
    });

    it('lets sourceless events (backups) repeat while open, as before', async () => {
      await sql`insert into events (level, kind, message) values ('info', 'backup', 'one'), ('info', 'backup', 'two')`;
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from events where kind = 'backup' and resolved_at is null`;
      expect(row?.n).toBe(2);
    });

    it('notifies the event id from a trigger, on open and on resolve', async (ctx) => {
      if (!db.supportsNotify) ctx.skip('PGlite: needs TEST_DATABASE_URL (real Postgres)');
      const received: string[] = [];
      const unlisten = await db.listen(EVENTS_CHANNEL, (payload) => received.push(payload));
      try {
        const id = await openEvent(sql, { ...late, kind: 'notify_test' });
        await resolveEvent(sql, 'room_sensors', 'notify_test');
        for (let i = 0; i < 50 && received.length < 2; i++)
          await new Promise((r) => setTimeout(r, 50));
        expect(received).toEqual([String(id), String(id)]);
      } finally {
        await unlisten();
      }
    });
  });

  describe('network devices (docs/10 §5)', () => {
    const dev = (
      mac: string,
      over: Partial<Parameters<typeof recordNetworkScan>[1][number]> = {},
    ) => ({
      mac,
      ip: '192.168.1.10',
      vendor: null,
      hostname: null,
      wired: null,
      randomised: false,
      ...over,
    });

    it('takes the first scan as the baseline: all known, nothing new', async () => {
      const fresh = await recordNetworkScan(sql, [
        dev('aa:00:00:00:00:01', { vendor: 'Raspberry Pi Foundation' }),
        dev('aa:00:00:00:00:02'),
      ]);
      expect(fresh).toEqual([]);
      expect((await listNetworkDevices(sql)).every((d) => d.known)).toBe(true);
    });

    it('reports a new device once, then only refreshes it', async () => {
      const phone = dev('3a:00:00:00:00:03', { ip: '192.168.1.47', randomised: true });
      expect(await recordNetworkScan(sql, [dev('aa:00:00:00:00:01'), phone])).toEqual([phone]);
      expect(
        await recordNetworkScan(sql, [
          { ...phone, ip: '192.168.1.48', hostname: 'Galaxy-S24', wired: false },
        ]),
      ).toEqual([]);
      const [row] = await listNetworkDevices(sql, false);
      expect(row).toMatchObject({
        mac: '3a:00:00:00:00:03',
        lastIp: '192.168.1.48',
        hostname: 'Galaxy-S24',
        wired: false,
        randomised: true,
        known: false,
      });
    });

    it('lets an admin name it and mark it as ours, and forgetting makes it new again', async () => {
      const admin = await signInUser(sql, 'netadmin@example.com', { admin: true });
      const marked = await updateNetworkDevice(
        sql,
        '3a:00:00:00:00:03',
        { known: true, label: "Anna's phone" },
        admin.id,
      );
      expect(marked).toMatchObject({
        known: true,
        label: "Anna's phone",
        markedKnownBy: 'netadmin@example.com',
      });
      expect(marked?.markedKnownAt).toBeInstanceOf(Date);
      expect(
        await updateNetworkDevice(sql, 'ff:ff:ff:ff:ff:ff', { known: true }, admin.id),
      ).toBeNull();
      expect(await forgetNetworkDevice(sql, '3a:00:00:00:00:03')).toBe(true);
      expect(await recordNetworkScan(sql, [dev('3a:00:00:00:00:03')])).toHaveLength(1);
    });
  });

  describe('users', () => {
    it('creates members, makes ADMIN_EMAILS admin, and keeps a stored role', async () => {
      const anna = await signInUser(sql, 'Anna@Example.com', { admin: false });
      expect(anna).toMatchObject({
        email: 'anna@example.com',
        role: 'member',
        enabled: true,
        tz: 'Europe/London',
        quietStart: null,
        urgentIgnoresQuiet: true,
      });
      expect(anna.lastSeenAt).toBeInstanceOf(Date);
      expect((await signInUser(sql, 'owner@example.com', { admin: true })).role).toBe('admin');
      await updateUserAccess(sql, anna.id, { role: 'admin' });
      expect((await signInUser(sql, 'anna@example.com', { admin: false })).role).toBe('admin');
      await updateUserAccess(sql, anna.id, { role: 'member' });
    });

    it('moves last_seen_at at most every 5 minutes', async () => {
      const first = await signInUser(sql, 'seen@example.com', { admin: false });
      const again = await signInUser(sql, 'seen@example.com', { admin: false });
      expect(again.lastSeenAt).toEqual(first.lastSeenAt);
      await sql`update users set last_seen_at = now() - interval '6 minutes' where id = ${first.id}`;
      const later = await signInUser(sql, 'seen@example.com', { admin: false });
      expect(later.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('changes only the profile fields given', async () => {
      const u = await signInUser(sql, 'quiet@example.com', { admin: false });
      const named = await updateProfile(sql, u.id, { name: 'Quiet one' });
      expect(named).toMatchObject({ name: 'Quiet one', quietStart: null });
      const quiet = await updateProfile(sql, u.id, {
        quiet: { start: '23:00', end: '07:00' },
        urgentIgnoresQuiet: false,
      });
      expect(quiet).toMatchObject({
        name: 'Quiet one',
        quietStart: '23:00',
        quietEnd: '07:00',
        urgentIgnoresQuiet: false,
      });
      expect(await updateProfile(sql, u.id, { quiet: null })).toMatchObject({ quietStart: null });
    });

    it('disables a user and lists everyone with their device count', async () => {
      const u = await signInUser(sql, 'gone@example.com', { admin: false });
      expect(await updateUserAccess(sql, u.id, { enabled: false })).toMatchObject({
        enabled: false,
      });
      expect(await updateUserAccess(sql, 999_999, { enabled: false })).toBeNull();
      await sql`insert into push_subscriptions (user_id, endpoint, p256dh, auth, label)
                values (${u.id}, 'https://push.example/1', 'k', 'a', 'Phone')`;
      const all = await listUsers(sql);
      expect(all.find((x) => x.email === 'gone@example.com')).toMatchObject({
        devices: 1,
        enabled: false,
      });
      expect(all.find((x) => x.email === 'anna@example.com')).toMatchObject({ devices: 0 });
    });
  });
});
