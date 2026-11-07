import type { SourceConfig } from '@home/shared';
import type { Logger } from 'pino';
import type { CollectorContext, PushCollector } from './collector.js';
import { describeError } from './errors.js';

export interface PushRunStore {
  record(
    sourceId: string,
    startedAt: Date,
    finishedAt: Date,
    outcome: { ok: boolean; rowsWritten: number; error: string | null },
  ): Promise<void>;
}

/** collector_runs gets one summary row per window for push sources (not one per 5 s flush). */
const SUMMARY_WINDOW_MS = 60_000;

/**
 * Starts a push source and summarises its activity into collector_runs every minute:
 * rows written, and the last error if anything went wrong in that minute.
 */
export async function startPushSource(deps: {
  collector: PushCollector;
  source: SourceConfig;
  store: PushRunStore;
  log: Logger;
  signal: AbortSignal;
  makeContext(signal: AbortSignal, onRows: (n: number) => void): CollectorContext;
  windowMs?: number;
}): Promise<{ stop(): Promise<void> }> {
  const { collector, source, store, log } = deps;
  let windowStart = new Date();
  let rows = 0;
  let lastError: string | null = null;

  const flushSummary = async () => {
    if (rows === 0 && lastError === null) {
      windowStart = new Date();
      return;
    }
    const summary = { ok: lastError === null, rowsWritten: rows, error: lastError };
    const startedAt = windowStart;
    windowStart = new Date();
    rows = 0;
    lastError = null;
    try {
      await store.record(source.id, startedAt, windowStart, summary);
    } catch (err) {
      log.warn({ error: describeError(err) }, 'could not record push summary');
    }
  };
  const timer = setInterval(() => void flushSummary(), deps.windowMs ?? SUMMARY_WINDOW_MS);

  const base = deps.makeContext(deps.signal, (n) => (rows += n));
  const subscription = await collector.subscribe({
    ...base,
    reportError(message) {
      lastError = message;
      log.warn({ error: message }, 'push source error');
    },
  });

  return {
    async stop() {
      clearInterval(timer);
      await subscription.stop();
      await flushSummary();
    },
  };
}
