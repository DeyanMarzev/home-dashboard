import type { SourceConfig } from '@home/shared';
import type { Logger } from 'pino';
import type { CollectorContext, PullCollector } from './collector.js';
import { describeError } from './errors.js';
import { nextRunAt, retryDelaySeconds, runTimeoutSeconds } from './schedule.js';

export interface RunStore {
  start(sourceId: string, startedAt: Date): Promise<number>;
  finish(
    runId: number,
    outcome: { ok: boolean; rowsWritten: number; error: string | null },
    finishedAt: Date,
  ): Promise<void>;
}

export interface PullLoopDeps {
  collector: PullCollector;
  source: SourceConfig;
  store: RunStore;
  log: Logger;
  /** Builds the context for one run; `onRows` counts rows written during it. */
  makeContext(signal: AbortSignal, onRows: (n: number) => void): CollectorContext;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Delay before the very first run, so sources don't all fire at once at startup. */
  initialDelayMs?: number;
  /** Override the run time limit (tests). */
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  rowsWritten: number;
  error: string | null;
  durationMs: number;
}

class RunTimeout extends Error {
  override name = 'RunTimeout';
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Runs one pull source on its schedule, forever: each run timed, logged to collector_runs,
 * isolated (an error or hang here never affects other sources), and retried with backoff.
 */
export class PullLoop {
  private readonly stopController = new AbortController();
  private loop: Promise<void> | null = null;
  private failures = 0;
  private lastStart: Date | null = null;

  constructor(private readonly deps: PullLoopDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  start(): void {
    this.loop ??= this.runForever();
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.loop;
  }

  /** Delay until the next run: the regular schedule, or a backoff retry after failures. */
  nextDelayMs(): number {
    const { poll } = this.deps.source;
    if (!poll) return Infinity;
    const now = this.now();
    if (this.failures > 0) return retryDelaySeconds(poll, this.failures) * 1000;
    return nextRunAt(poll, this.lastStart, now).getTime() - now.getTime();
  }

  private async runForever(): Promise<void> {
    const sleep = this.deps.sleep ?? abortableSleep;
    const stop = this.stopController.signal;
    await sleep(this.deps.initialDelayMs ?? 0, stop);
    while (!stop.aborted) {
      const delay = this.nextDelayMs();
      if (delay > 0) await sleep(delay, stop);
      if (stop.aborted) break;
      const result = await this.runOnce();
      this.failures = result.ok ? 0 : this.failures + 1;
      if (!result.ok && this.deps.source.poll) {
        this.deps.log.warn(
          {
            failures: this.failures,
            retryInSeconds: retryDelaySeconds(this.deps.source.poll, this.failures),
          },
          'will retry',
        );
      }
    }
  }

  /** One wrapped run. Never throws. */
  async runOnce(): Promise<RunResult> {
    const { collector, source, store, log } = this.deps;
    const startedAt = this.now();
    this.lastStart = startedAt;

    let runId: number | null = null;
    try {
      runId = await store.start(source.id, startedAt);
    } catch (err) {
      log.warn({ error: describeError(err) }, 'could not record run start');
    }

    const timeoutMs =
      this.deps.timeoutMs ??
      runTimeoutSeconds(source.poll ?? { type: 'every', seconds: 300 }) * 1000;
    const runController = new AbortController();
    const signal = AbortSignal.any([runController.signal, this.stopController.signal]);
    let rowsWritten = 0;
    let error: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const ctx = this.deps.makeContext(signal, (n) => (rowsWritten += n));
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          runController.abort();
          reject(new RunTimeout(`run took longer than ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });
      await Promise.race([collector.run(ctx), timeout]);
    } catch (err) {
      error = describeError(err);
    } finally {
      clearTimeout(timer);
    }

    const finishedAt = this.now();
    const result: RunResult = {
      ok: error === null,
      rowsWritten,
      error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    if (result.ok) log.debug({ rowsWritten, durationMs: result.durationMs }, 'run ok');
    else log.warn({ rowsWritten, durationMs: result.durationMs, error }, 'run failed');

    if (runId !== null) {
      try {
        await store.finish(runId, { ok: result.ok, rowsWritten, error }, finishedAt);
      } catch (err) {
        log.warn({ error: describeError(err) }, 'could not record run result');
      }
    }
    return result;
  }
}
