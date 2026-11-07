import type { ReadingInput } from '@home/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CollectorContext, PullCollector } from './collector.js';
import { PullLoop, type RunStore } from './pull-loop.js';
import { fakeContext, silentLog, source } from './test-helpers.js';

const reading: ReadingInput = {
  metric: 'x',
  unit: 'u',
  valueType: 'gauge',
  ts: '2026-11-07T12:00:00Z',
  value: 1,
};

function memoryStore() {
  const runs: {
    id: number;
    sourceId: string;
    ok?: boolean;
    rowsWritten?: number;
    error?: string | null;
  }[] = [];
  const store: RunStore = {
    start: (sourceId) => {
      runs.push({ id: runs.length + 1, sourceId });
      return Promise.resolve(runs.length);
    },
    finish: (id, outcome) => {
      Object.assign(runs[id - 1]!, outcome);
      return Promise.resolve();
    },
  };
  return { runs, store };
}

function loopFor(
  run: (ctx: CollectorContext) => Promise<void>,
  extra: Partial<ConstructorParameters<typeof PullLoop>[0]> = {},
) {
  const collector: PullCollector = { id: 'pi_stats', kind: 'pull', run };
  const src = source('pi_stats', { kind: 'local', poll: '1m' });
  const { runs, store } = memoryStore();
  const loop = new PullLoop({
    collector,
    source: src,
    store,
    log: silentLog,
    makeContext: (signal, onRows) => fakeContext(src, signal, onRows),
    ...extra,
  });
  return { loop, runs };
}

describe('PullLoop.runOnce', () => {
  it('records a successful run with its row count', async () => {
    const { loop, runs } = loopFor(async (ctx) => {
      await ctx.writeReadings([reading, reading]);
    });
    expect(await loop.runOnce()).toMatchObject({ ok: true, rowsWritten: 2, error: null });
    expect(runs).toEqual([{ id: 1, sourceId: 'pi_stats', ok: true, rowsWritten: 2, error: null }]);
  });

  it('records a failure with its message and cause, without throwing', async () => {
    const { loop, runs } = loopFor(() =>
      Promise.reject(
        new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.example') }),
      ),
    );
    expect(await loop.runOnce()).toMatchObject({
      ok: false,
      error: 'TypeError: fetch failed (getaddrinfo ENOTFOUND api.example)',
    });
    expect(runs[0]).toMatchObject({ ok: false, rowsWritten: 0 });
  });

  it('keeps rows written before a failure', async () => {
    const { loop } = loopFor(async (ctx) => {
      await ctx.writeReadings([reading]);
      throw new Error('second page failed');
    });
    expect(await loop.runOnce()).toMatchObject({ ok: false, rowsWritten: 1 });
  });

  it('times out a hung run and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const { loop } = loopFor(
      (ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined); // never settles
      },
      { timeoutMs: 50 },
    );
    expect(await loop.runOnce()).toMatchObject({
      ok: false,
      error: 'RunTimeout: run took longer than 0.05s',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('still runs when the run log can not be written (database down)', async () => {
    let ran = false;
    const collector: PullCollector = {
      id: 'pi_stats',
      kind: 'pull',
      run: () => ((ran = true), Promise.resolve()),
    };
    const src = source('pi_stats', { kind: 'local', poll: '1m' });
    const store: RunStore = {
      start: () => Promise.reject(new Error('db down')),
      finish: () => Promise.reject(new Error('db down')),
    };
    const loop = new PullLoop({
      collector,
      source: src,
      store,
      log: silentLog,
      makeContext: (s, r) => fakeContext(src, s, r),
    });
    expect(await loop.runOnce()).toMatchObject({ ok: true });
    expect(ran).toBe(true);
  });
});

describe('PullLoop scheduling', () => {
  it('runs on schedule, backs off after failures, and recovers', async () => {
    let clock = Date.parse('2026-11-07T12:00:00Z');
    const outcomes = [true, false, false, true, true];
    const delays: number[] = [];
    let calls = 0;
    let stopped: Promise<void> | undefined;
    const holder: { loop?: PullLoop } = {};

    const { loop } = loopFor(
      () => {
        const ok = outcomes[calls++];
        if (calls === outcomes.length) stopped = holder.loop!.stop();
        return ok ? Promise.resolve() : Promise.reject(new Error('down'));
      },
      {
        now: () => new Date(clock),
        sleep: (ms) => {
          delays.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      },
    );
    holder.loop = loop;
    loop.start();
    await vi.waitFor(() => expect(stopped).toBeDefined());
    await stopped;

    // Startup delay; run 1 at once (ok); next run 1 min later (fails); retry after 1 min (fails);
    // retry after 2 min (ok); back to the regular 1 min.
    expect(delays).toEqual([0, 60_000, 60_000, 120_000, 60_000]);
    expect(calls).toBe(5);
  });
});
