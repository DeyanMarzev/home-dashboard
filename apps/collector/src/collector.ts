import type { Sql } from '@home/db';
import type { ReadingInput, SourceConfig } from '@home/shared';
import type { Logger } from 'pino';
import type { CollectorEnv } from './env.js';

/** What every collector gets (docs/03-sources-and-freshness.md § Adding a new source). */
export interface CollectorContext {
  source: SourceConfig;
  env: CollectorEnv;
  log: Logger;
  /** Aborted when the run times out or the process shuts down. Pass it to fetch(). */
  signal: AbortSignal;
  /** Validates, upserts (idempotent), creates series and NOTIFYs. Returns rows written. */
  writeReadings(readings: ReadingInput[]): Promise<number>;
  /** Newest instant already stored for a series, to resume from. */
  lastDataTo(metric: string, entity?: string): Promise<Date | null>;
  /** Direct database access, for local sources that report on the database itself. */
  db: Sql;
}

/** Push sources also report problems that aren't failed writes (e.g. a lost broker). */
export interface PushContext extends CollectorContext {
  reportError(message: string): void;
}

/** Scheduled by the registry's `poll`. Throw to mark the run failed (it is retried with backoff). */
export interface PullCollector {
  id: string;
  kind: 'pull';
  run(ctx: CollectorContext): Promise<void>;
}

/** Long-running (e.g. MQTT). Resolves once started (not necessarily connected); `stop` at shutdown. */
export interface PushCollector {
  id: string;
  kind: 'push';
  subscribe(ctx: PushContext): Promise<{ stop(): Promise<void> }>;
}

export type Collector = PullCollector | PushCollector;
