import { EVENTS_CHANNEL, latestBySource, READINGS_CHANNEL, type Sql } from '@home/db';
import { StreamReadingSchema, type Freshness, type Registry } from '@home/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { FreshnessService } from './freshness.js';
import { findEvent } from './routes/data.js';

/** Where notifications come from: Postgres LISTEN in production, a fake in tests. */
export interface NotificationSource {
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
}

export function postgresNotifications(sql: Sql): NotificationSource {
  return {
    async listen(channel, onPayload) {
      const listener = await sql.listen(channel, onPayload);
      return () => listener.unlisten();
    },
  };
}

export interface StreamHubOptions {
  db: Sql;
  registry: Registry;
  freshness: FreshnessService;
  notifications: NotificationSource;
  log: FastifyBaseLogger;
  /** How often source freshness is re-checked for state changes. */
  freshnessIntervalMs?: number;
  /** Comment line sent to keep idle connections open (Cloudflare closes them at ~100 s). */
  heartbeatMs?: number;
  maxClients?: number;
}

/** A client that falls this far behind (bytes buffered) is disconnected. */
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * Server-Sent Events for every connected browser (docs/04 § GET /api/stream):
 * `reading` for each committed reading (via NOTIFY), `event` for new/resolved events, and
 * `freshness` when a source's state changes. One LISTEN connection serves all clients.
 */
export class StreamHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly current = new Map<string, Freshness>();
  private readonly seriesSource = new Map<number, string>();
  private unlisteners: (() => Promise<void>)[] = [];
  private timers: NodeJS.Timeout[] = [];
  private recheck: NodeJS.Timeout | null = null;

  constructor(private readonly o: StreamHubOptions) {}

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    await this.refreshFreshness(false);
    this.unlisteners.push(
      await this.o.notifications.listen(READINGS_CHANNEL, (payload) => this.onReading(payload)),
      await this.o.notifications.listen(EVENTS_CHANNEL, (payload) => void this.onEvent(payload)),
    );
    this.timers.push(
      setInterval(() => void this.refreshFreshness(true), this.o.freshnessIntervalMs ?? 30_000),
      setInterval(() => this.writeAll(': ping\n\n'), this.o.heartbeatMs ?? 25_000),
    );
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    if (this.recheck) clearTimeout(this.recheck);
    await Promise.allSettled(this.unlisteners.map((u) => u()));
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  /** Starts streaming to `res`. False if the hub is full. */
  addClient(res: ServerResponse): boolean {
    if (this.clients.size >= (this.o.maxClients ?? 50)) return false;
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    // Reconnect after 5 s if the connection drops; then where every source stands right now.
    res.write('retry: 5000\n\n');
    for (const [sourceId, freshness] of this.current)
      res.write(frame('freshness', { sourceId, freshness }));
    return true;
  }

  private onReading(payload: string): void {
    const parsed = StreamReadingSchema.safeParse(safeJson(payload));
    if (!parsed.success) {
      this.o.log.warn('ignoring malformed readings notification');
      return;
    }
    this.writeAll(frame('reading', parsed.data));
    void this.noteSourceActivity(parsed.data.seriesId);
  }

  /** New data for a source that isn't Live: re-check soon, so badges flip back without waiting. */
  private async noteSourceActivity(seriesId: number): Promise<void> {
    let sourceId = this.seriesSource.get(seriesId);
    if (!sourceId) {
      const [row] = await this.o.db<
        { source_id: string }[]
      >`select source_id from series where id = ${seriesId}`;
      if (!row) return;
      sourceId = row.source_id;
      this.seriesSource.set(seriesId, sourceId);
    }
    if (this.current.get(sourceId)?.state !== 'live' && !this.recheck) {
      this.recheck = setTimeout(() => {
        this.recheck = null;
        void this.refreshFreshness(true);
      }, 1000);
    }
  }

  private async onEvent(payload: string): Promise<void> {
    const id = Number(payload);
    if (!Number.isInteger(id)) return;
    try {
      const event = await findEvent(this.o.db, id);
      if (event) this.writeAll(frame('event', event));
    } catch (err) {
      this.o.log.warn({ err }, 'could not load event for stream');
    }
  }

  /** Recomputes every source's freshness; broadcasts the ones whose state changed. */
  async refreshFreshness(broadcast: boolean): Promise<void> {
    let latest;
    try {
      latest = await latestBySource(this.o.db);
    } catch (err) {
      this.o.log.warn({ err }, 'could not refresh freshness for stream');
      return;
    }
    for (const source of this.o.registry.sources) {
      const next = this.o.freshness.of(source.id, latest.get(source.id) ?? null);
      const before = this.current.get(source.id);
      this.current.set(source.id, next);
      if (broadcast && before?.state !== next.state)
        this.writeAll(frame('freshness', { sourceId: source.id, freshness: next }));
    }
  }

  private writeAll(chunk: string): void {
    for (const res of this.clients) {
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        this.o.log.warn('dropping a stream client that stopped reading');
        res.destroy();
        this.clients.delete(res);
        continue;
      }
      res.write(chunk);
    }
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
