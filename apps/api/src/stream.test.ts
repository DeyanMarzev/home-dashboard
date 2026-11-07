import { createReadingWriter, loadRegistryFile, migrate, openEvent, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { EventItemSchema, StreamFreshnessSchema, StreamReadingSchema } from '@home/shared';
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { FreshnessService } from './freshness.js';
import { buildServer, createLogger } from './server.js';
import { StreamHub, type NotificationSource } from './stream.js';

const config: Config = {
  env: 'test',
  port: 0,
  logLevel: 'silent',
  version: 'test',
  publicDir: null,
  auth: { disabled: true },
};

/** Stands in for Postgres LISTEN (PGlite can't deliver NOTIFY over its socket server). */
function fakeNotifications() {
  const handlers = new Map<string, (payload: string) => void>();
  const source: NotificationSource = {
    listen: (channel, onPayload) => {
      handlers.set(channel, onPayload);
      return Promise.resolve(() => Promise.resolve());
    },
  };
  return { source, emit: (channel: string, payload: string) => handlers.get(channel)?.(payload) };
}

interface Frame {
  event: string;
  data: unknown;
}

/** A minimal SSE client: collects frames and comments; resolves waits as they arrive. */
function connect(url: string) {
  const frames: Frame[] = [];
  let comments = 0;
  let buffer = '';
  let response: IncomingMessage | undefined;
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    httpGet(url, (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(':')) comments++;
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
      });
      resolve(res);
    }).on('error', reject);
  });
  const waitFor = async (predicate: (f: Frame) => boolean, timeoutMs = 2000): Promise<Frame> => {
    const started = Date.now();
    for (;;) {
      const found = frames.find(predicate);
      if (found) return found;
      if (Date.now() - started > timeoutMs)
        throw new Error(`no matching frame within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { ready, frames, waitFor, comments: () => comments, close: () => response?.destroy() };
}

let db: TestDatabase;
let app: FastifyInstance;
let base: string;
const notifications = fakeNotifications();

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  app = await buildServer(config, { db: db.sql, registry, notifications: notifications.source });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('GET /api/stream', () => {
  it('streams with the right headers and starts with every source’s freshness', async () => {
    const client = connect(`${base}/api/stream`);
    const res = await client.ready;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['content-encoding']).toBeUndefined(); // never compressed: it would buffer
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const first = await client.waitFor((f) => f.event === 'freshness');
    expect(StreamFreshnessSchema.parse(first.data)).toMatchObject({
      sourceId: 'room_sensors',
      freshness: { state: 'late', label: 'No data yet' },
    });
    await client.waitFor(
      (f) =>
        f.event === 'freshness' && (f.data as { sourceId: string }).sourceId === 'thames_water',
    );
    client.close();
  });

  it('delivers a reading within 2 s, and flips a late source to live straight after', async () => {
    const client = connect(`${base}/api/stream`);
    await client.ready;
    await client.waitFor((f) => f.event === 'freshness');

    // What the collector does: write (which NOTIFYs on commit), then Postgres delivers it.
    const now = new Date();
    await createReadingWriter(db.sql).write('room_sensors', [
      {
        metric: 'temperature',
        entity: 'kitchen',
        unit: '°C',
        valueType: 'gauge',
        ts: now,
        value: 20.6,
      },
    ]);
    const [series] = await db.sql<
      { id: number }[]
    >`select id from series where metric = 'temperature' and entity = 'kitchen'`;
    const sent = Date.now();
    notifications.emit(
      'readings',
      JSON.stringify({ seriesId: series!.id, ts: now.toISOString(), value: 20.6 }),
    );

    const reading = await client.waitFor((f) => f.event === 'reading', 2000);
    expect(Date.now() - sent).toBeLessThan(2000);
    expect(StreamReadingSchema.parse(reading.data)).toEqual({
      seriesId: series!.id,
      ts: now.toISOString(),
      value: 20.6,
    });

    const live = await client.waitFor(
      (f) =>
        f.event === 'freshness' &&
        (f.data as { freshness: { state: string } }).freshness.state === 'live',
      3000,
    );
    expect(StreamFreshnessSchema.parse(live.data).sourceId).toBe('room_sensors');
    client.close();
  });

  it('delivers new and resolved events', async () => {
    const client = connect(`${base}/api/stream`);
    await client.ready;
    const id = await openEvent(db.sql, {
      level: 'warning',
      sourceId: 'pi_stats',
      kind: 'source_late',
      message: 'Raspberry Pi: no data yet',
    });
    notifications.emit('events', String(id));
    const frame = await client.waitFor((f) => f.event === 'event');
    expect(EventItemSchema.parse(frame.data)).toMatchObject({
      id,
      kind: 'source_late',
      resolvedAt: null,
    });
    client.close();
  });

  it('ignores malformed notifications without dropping clients', async () => {
    const client = connect(`${base}/api/stream`);
    await client.ready;
    notifications.emit('readings', 'not json');
    notifications.emit('events', 'abc');
    notifications.emit(
      'readings',
      JSON.stringify({ seriesId: 1, ts: new Date().toISOString(), value: 1 }),
    );
    await client.waitFor((f) => f.event === 'reading');
    client.close();
  });

  it('forgets clients that disconnect', async () => {
    const client = connect(`${base}/api/stream`);
    await client.ready;
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    notifications.emit(
      'readings',
      JSON.stringify({ seriesId: 1, ts: new Date().toISOString(), value: 1 }),
    ); // must not throw
  });
});

describe('stream heartbeat', () => {
  it('starts with a retry hint, then sends a comment line to keep the connection open', async () => {
    const registry = await loadRegistryFile(SOURCES_FILE);
    const hub = new StreamHub({
      db: db.sql,
      registry,
      freshness: new FreshnessService(registry, () => new Date()),
      notifications: fakeNotifications().source,
      log: createLogger('silent'),
      heartbeatMs: 50,
    });
    await hub.start();
    const chunks: string[] = [];
    const res = Object.assign(new EventEmitter(), {
      writableLength: 0,
      write: (chunk: string) => (chunks.push(chunk), true),
      end: () => undefined,
    });
    hub.addClient(res as unknown as ServerResponse);
    await new Promise((r) => setTimeout(r, 160));
    await hub.stop();
    expect(chunks[0]).toBe('retry: 5000\n\n');
    expect(chunks.filter((c) => c === ': ping\n\n').length).toBeGreaterThanOrEqual(2);
  });
});
