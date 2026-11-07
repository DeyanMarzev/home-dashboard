import { parseRegistry, type ReadingInput, type Registry } from '@home/shared';
import { cp, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEvent, resolveEvent } from './events.js';
import { latestBySource } from './latest.js';
import { migrate, MigrationError } from './migrate.js';
import { createReadingWriter, lastDataTo, READINGS_CHANNEL } from './readings.js';
import { loadRegistryFile } from './registry-file.js';
import { finishRun, pruneRuns, recordRun, startRun } from './runs.js';
import { syncSources } from './sources.js';
import { SOURCES_FILE, testBackends, type TestDatabase } from './test/database.js';

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
      const writer = createReadingWriter(sql);
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
  });
});
