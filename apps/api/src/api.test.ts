import {
  createReadingWriter,
  finishRun,
  loadRegistryFile,
  migrate,
  openEvent,
  startRun,
  syncSources,
} from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import {
  ApiErrorSchema,
  EventsResponseSchema,
  LatestResponseSchema,
  ReadingsResponseSchema,
  SeriesResponseSchema,
  SourcesResponseSchema,
  TariffsResponseSchema,
  type ReadingInput,
} from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';

/** The fixed "now" for every test: 6 Nov 2026, 14:00 GMT. */
const NOW = new Date('2026-11-06T14:00:00Z');
const MIN = 60_000;

const config: Config = {
  env: 'test',
  port: 3000,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: { disabled: true },
};

let db: TestDatabase;
let app: FastifyInstance;
const ids: Record<string, number> = {};

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json<unknown>(), headers: res.headers };
};

function halfHours(fromIso: string, count: number, kwh: number): ReadingInput[] {
  return Array.from({ length: count }, (_, i) => ({
    metric: 'energy_import',
    entity: 'electricity',
    unit: 'kWh',
    valueType: 'interval_total' as const,
    interval: '30m',
    ts: new Date(Date.parse(fromIso) + i * 30 * MIN),
    value: kwh,
  }));
}

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);

  const writer = createReadingWriter(db.sql);
  // Kitchen sensor every 30 s for the last 3 h (360 readings), stopped 2 min ago: Live.
  const kitchen: ReadingInput[] = [];
  for (let i = 0; i < 360; i++) {
    const ts = new Date(NOW.getTime() - 2 * MIN - i * 30_000);
    kitchen.push({
      metric: 'temperature',
      entity: 'kitchen',
      unit: '°C',
      valueType: 'gauge',
      ts,
      value: 20 + (i % 10) / 10,
    });
    kitchen.push({
      metric: 'co2',
      entity: 'kitchen',
      unit: 'ppm',
      valueType: 'gauge',
      ts,
      value: 600 + i,
    });
  }
  await writer.write('room_sensors', kitchen);
  // A dense kitchen humidity series: every 10 s for ~2 h (700 readings), to force coarsening.
  await writer.write(
    'room_sensors',
    Array.from({ length: 700 }, (_, i) => ({
      metric: 'humidity',
      entity: 'kitchen',
      unit: '%',
      valueType: 'gauge' as const,
      ts: new Date(NOW.getTime() - MIN - i * 10_000),
      value: 50 + (i % 5),
    })),
  );
  // Bedroom sensor stopped at 13:10: Late.
  await writer.write('room_sensors', [
    {
      metric: 'temperature',
      entity: 'bedroom',
      unit: '°C',
      valueType: 'gauge',
      ts: '2026-11-06T13:10:00Z',
      value: 18.4,
    },
  ]);
  // Smart meter: 24–25 Oct (clocks go back on the 25th: a 25-hour London day) and 4–5 Nov.
  await writer.write('smart_meters', [
    ...halfHours('2026-10-23T23:00:00Z', 48, 0.25), // 24 Oct, BST: 23:00 UTC → 23:00 UTC
    ...halfHours('2026-10-24T23:00:00Z', 50, 0.25), // 25 Oct: 50 half-hours
    ...halfHours('2026-11-04T00:00:00Z', 96, 0.2), // 4 and 5 Nov, GMT
  ]);
  // Weather: a measurement 10 min ago and a forecast for tomorrow.
  await writer.write('open_meteo', [
    {
      metric: 'temperature',
      entity: 'outdoor',
      unit: '°C',
      valueType: 'gauge',
      ts: new Date(NOW.getTime() - 10 * MIN),
      value: 9.1,
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

  const series = await db.sql<
    { id: number; key: string }[]
  >`select id, source_id || '/' || metric || '/' || entity as key from series`;
  for (const s of series) ids[s.key] = s.id;

  const run = await startRun(db.sql, 'pi_stats', new Date(NOW.getTime() - 5 * MIN));
  await finishRun(
    db.sql,
    run,
    { ok: false, rowsWritten: 0, error: 'ENOENT /host/proc/meminfo' },
    new Date(NOW.getTime() - 5 * MIN + 1200),
  );
  await openEvent(db.sql, {
    level: 'warning',
    sourceId: 'pi_stats',
    kind: 'source_late',
    message: 'Raspberry Pi: no data yet',
  });
  await openEvent(db.sql, {
    level: 'alert',
    sourceId: 'room_sensors',
    kind: 'co2_high',
    message: 'Kitchen CO₂ above 1000 ppm',
  });

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

describe('GET /api/health', () => {
  it('reports the database up', async () => {
    expect((await get('/api/health')).body).toEqual({ ok: true, db: 'up', version: 'test' });
  });
});

describe('GET /api/sources', () => {
  it('lists every registry source with freshness, last run and recent errors', async () => {
    const { status, body } = await get('/api/sources');
    expect(status).toBe(200);
    const sources = SourcesResponseSchema.parse(body);
    expect(sources.map((s) => s.id)).toEqual([
      'room_sensors',
      'pi_stats',
      'open_meteo',
      'carbon_intensity',
      'boiler_probes',
      'nest',
      'smart_meters',
      'thames_water',
    ]);
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));

    expect(byId.room_sensors).toMatchObject({
      kind: 'sensor',
      poll: null,
      pushInterval: '30s',
      expectedDelay: '0s',
      freshness: { state: 'live' },
    });
    expect(byId.pi_stats).toMatchObject({
      poll: '1m',
      freshness: { state: 'late', label: 'No data yet' },
      lastRun: { ok: false, rowsWritten: 0, durationMs: 1200, error: 'ENOENT /host/proc/meminfo' },
      errors24h: 1,
    });
    // The forecast for tomorrow doesn't make the weather source look fresher than it is.
    expect(byId.open_meteo?.freshness).toMatchObject({
      state: 'live',
      dataTo: '2026-11-06T13:50:00.000Z',
    });
    expect(byId.smart_meters).toMatchObject({
      enabled: false,
      expectedDelay: '1d',
      freshness: {
        state: 'delayed',
        label: 'Data to 5 Nov · 1 day behind',
        compactLabel: '1 day behind',
      },
    });
    expect(byId.thames_water?.poll).toBe('cron: 0 6 * * *');
  });
});

describe('GET /api/series', () => {
  it('lists series, filterable', async () => {
    const all = SeriesResponseSchema.parse((await get('/api/series')).body);
    expect(all.length).toBe(Object.keys(ids).length);
    const kitchen = SeriesResponseSchema.parse(
      (await get('/api/series?source=room_sensors&entity=kitchen')).body,
    );
    expect(kitchen.map((s) => s.metric)).toEqual(['co2', 'humidity', 'temperature']);
  });

  it('describes interval totals with an ISO 8601 interval', async () => {
    const [meter] = SeriesResponseSchema.parse((await get('/api/series?source=smart_meters')).body);
    expect(meter).toEqual({
      id: ids['smart_meters/energy_import/electricity'],
      sourceId: 'smart_meters',
      metric: 'energy_import',
      entity: 'electricity',
      unit: 'kWh',
      valueType: 'interval_total',
      interval: 'PT30M',
    });
  });

  it('rejects bad filters', async () => {
    const { status, body } = await get('/api/series?source=Room-Sensors');
    expect(status).toBe(400);
    expect(ApiErrorSchema.parse(body).error.code).toBe('BAD_REQUEST');
    expect((await get('/api/series?colour=red')).status).toBe(400);
  });
});

describe('GET /api/latest', () => {
  it('returns the latest value per series with freshness, and the worst combined', async () => {
    const { body } = await get('/api/latest?source=room_sensors&metric=temperature');
    const latest = LatestResponseSchema.parse(body);
    expect(latest.items.map((i) => [i.series.entity, i.value, i.freshness.state])).toEqual([
      ['bedroom', 18.4, 'late'],
      ['kitchen', 20, 'live'],
    ]);
    expect(latest.freshness).toMatchObject({ state: 'late', label: 'No data since 13:10' });
  });

  it('selects by series ids or by metric', async () => {
    const byIds = LatestResponseSchema.parse(
      (await get(`/api/latest?series=${ids['room_sensors/co2/kitchen']}`)).body,
    );
    expect(byIds.items).toHaveLength(1);
    expect(byIds.items[0]?.value).toBe(600);
    const byMetric = LatestResponseSchema.parse((await get('/api/latest?metric=co2')).body);
    expect(byMetric.items.map((i) => i.series.entity)).toEqual(['kitchen']);
  });

  it('requires a selector', async () => {
    expect((await get('/api/latest')).status).toBe(400);
  });
});

describe('GET /api/readings', () => {
  const kitchenTemp = () => ids['room_sensors/temperature/kitchen'];
  const meter = () => ids['smart_meters/energy_import/electricity'];

  it('defaults to the last 24 h and buckets to stay under 600 points', async () => {
    const res = ReadingsResponseSchema.parse(
      (await get(`/api/readings?series=${kitchenTemp()}`)).body,
    );
    expect(res).toMatchObject({
      from: '2026-11-05T14:00:00.000Z',
      to: NOW.toISOString(),
      bucket: '5m',
    });
    expect(res.series[0]?.points).toHaveLength(37); // 10:58–13:58 touches 37 five-minute buckets
    expect(res.series[0]?.freshness.state).toBe('live');
  });

  it('returns raw points when asked and they fit', async () => {
    const from = new Date(NOW.getTime() - 30 * MIN).toISOString();
    const res = ReadingsResponseSchema.parse(
      (await get(`/api/readings?series=${kitchenTemp()}&from=${from}&bucket=raw`)).body,
    );
    expect(res.bucket).toBe('raw');
    expect(res.series[0]?.points).toHaveLength(57); // 13:30 (inclusive) to 13:58, every 30 s
  });

  it('coarsens raw when there would be more than 600 points, and says so', async () => {
    const humidity = ids['room_sensors/humidity/kitchen'];
    const from = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const res = ReadingsResponseSchema.parse(
      (await get(`/api/readings?series=${humidity}&from=${from}&bucket=raw`)).body,
    );
    expect(res.bucket).toBe('5m'); // 700 raw readings in 2 h
    expect(res.series[0]?.points.length).toBeLessThanOrEqual(24);
  });

  it('sums interval totals per London day, including the 25-hour day', async () => {
    // London midnight is 23:00 UTC in BST and 00:00 UTC in GMT, so 25 Oct ends at 00:00 UTC on the 26th.
    const url = `/api/readings?series=${meter()}&from=2026-10-23T23:00:00Z&to=2026-10-26T00:00:00Z&bucket=1d`;
    const res = ReadingsResponseSchema.parse((await get(url)).body);
    expect(res.series[0]?.points).toEqual([
      ['2026-10-23T23:00:00.000Z', 12], // 24 Oct: 48 × 0.25
      ['2026-10-24T23:00:00.000Z', 12.5], // 25 Oct (clocks back): 50 × 0.25
    ]);
    expect(res.series[0]?.freshness).toMatchObject({ state: 'delayed', daysBehind: 1 });
  });

  it('uses the requested aggregate', async () => {
    const url = (agg: string) =>
      `/api/readings?series=${kitchenTemp()}&from=2026-11-06T11:00:00Z&to=2026-11-06T12:00:00Z&bucket=1h&agg=${agg}`;
    const point = async (agg: string) =>
      ReadingsResponseSchema.parse((await get(url(agg))).body).series[0]?.points[0]?.[1];
    expect(await point('max')).toBe(20.9);
    expect(await point('min')).toBe(20);
    expect(await point('avg')).toBeCloseTo(20.45, 5);
  });

  it('returns several series in the order asked, with a combined freshness', async () => {
    const bedroom = ids['room_sensors/temperature/bedroom'];
    const res = ReadingsResponseSchema.parse(
      (await get(`/api/readings?series=${bedroom},${kitchenTemp()}`)).body,
    );
    expect(res.series.map((s) => s.meta.entity)).toEqual(['bedroom', 'kitchen']);
    expect(res.freshness?.state).toBe('late');
  });

  it('validates the query', async () => {
    expect((await get('/api/readings')).status).toBe(400);
    expect(
      (await get(`/api/readings?series=${kitchenTemp()}&from=2026-11-06T13:00:00`)).status,
    ).toBe(400); // no zone
    expect(
      (
        await get(
          `/api/readings?series=${kitchenTemp()}&from=2026-11-06T13:00:00Z&to=2026-11-06T12:00:00Z`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await get(`/api/readings?series=${kitchenTemp()}&from=2020-01-01T00:00:00Z`)).status,
    ).toBe(400); // > 600 days
    expect((await get(`/api/readings?series=${kitchenTemp()}&tz=Mars/Olympus`)).status).toBe(400);
    const missing = await get('/api/readings?series=99999');
    expect(missing.status).toBe(404);
    expect(ApiErrorSchema.parse(missing.body).error.message).toBe('Unknown series: 99999');
  });
});

describe('GET /api/events', () => {
  it('lists recent events newest first, filterable by level', async () => {
    const all = EventsResponseSchema.parse((await get('/api/events')).body);
    expect(all.items.map((e) => e.kind)).toEqual(['co2_high', 'source_late']);
    const alerts = EventsResponseSchema.parse((await get('/api/events?level=alert&limit=5')).body);
    expect(alerts.items).toHaveLength(1);
    expect(alerts.items[0]).toMatchObject({
      level: 'alert',
      sourceId: 'room_sensors',
      resolvedAt: null,
    });
    expect((await get('/api/events?limit=0')).status).toBe(400);
  });
});

describe('GET / PUT /api/tariffs', () => {
  const put = (body: unknown) =>
    app.inject({ method: 'PUT', url: '/api/tariffs', payload: body as object });

  it('starts empty, then replaces all rows', async () => {
    expect(TariffsResponseSchema.parse((await get('/api/tariffs')).body).items).toEqual([]);
    const res = await put({
      items: [
        {
          fuel: 'electricity',
          unitRatePence: 24.5,
          standingPence: 53.35,
          validFrom: '2026-04-01',
          validTo: '2026-09-30',
        },
        {
          fuel: 'electricity',
          unitRatePence: 26.123,
          standingPence: 51.2,
          validFrom: '2026-10-01',
        },
        { fuel: 'gas', unitRatePence: 6.24, standingPence: 31.65, validFrom: '2026-10-01' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const items = TariffsResponseSchema.parse(res.json()).items;
    expect(items.map((t) => [t.fuel, t.unitRatePence, t.validFrom, t.validTo])).toEqual([
      ['electricity', 24.5, '2026-04-01', '2026-09-30'],
      ['electricity', 26.123, '2026-10-01', null],
      ['gas', 6.24, '2026-10-01', null],
    ]);
    expect(TariffsResponseSchema.parse((await get('/api/tariffs')).body).items).toHaveLength(3);
  });

  it('rejects overlapping periods for the same fuel and leaves the rows alone', async () => {
    const res = await put({
      items: [
        { fuel: 'gas', unitRatePence: 6, validFrom: '2026-01-01' },
        { fuel: 'gas', unitRatePence: 7, validFrom: '2026-06-01' },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.message).toMatch(
      /gas tariff from 2026-06-01 overlaps/,
    );
    expect(TariffsResponseSchema.parse((await get('/api/tariffs')).body).items).toHaveLength(3);
  });

  it('rejects bad values', async () => {
    expect(
      (await put({ items: [{ fuel: 'oil', unitRatePence: 6, validFrom: '2026-01-01' }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put({ items: [{ fuel: 'gas', unitRatePence: -1, validFrom: '2026-01-01' }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put({ items: [{ fuel: 'gas', unitRatePence: 6.12345, validFrom: '2026-01-01' }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await put({
          items: [
            { fuel: 'gas', unitRatePence: 6, validFrom: '2026-02-01', validTo: '2026-01-01' },
          ],
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('compression', () => {
  it('gzips large JSON responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});
