import {
  createDb,
  createReadingWriter,
  finishRun,
  lastDataTo,
  latestBySource,
  openEvent,
  prepareDatabase,
  pruneRuns,
  recordRun,
  resolveEvent,
  startRun,
  startupPaths,
} from '@home/db';
import { pino } from 'pino';
import type { CollectorContext } from './collector.js';
import { EnvError, loadCollectorEnv, type CollectorEnv } from './env.js';
import { describeError } from './errors.js';
import { checkLateSources, lateMessage, SOURCE_LATE, type LateStore } from './late-check.js';
import { PullLoop } from './pull-loop.js';
import { startPushSource } from './push-runner.js';
import { collectors } from './sources/index.js';

const LATE_CHECK_INTERVAL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 6 * 3600_000;
/** Pull sources start this far apart so they don't all hit the network/DB at once. */
const STARTUP_STAGGER_MS = 2000;

let env: CollectorEnv;
try {
  env = loadCollectorEnv(process.env);
} catch (err) {
  if (!(err instanceof EnvError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });
// One collector failing never stops the others (CLAUDE.md rule 7): log stray errors, keep going.
process.on('unhandledRejection', (err) =>
  log.error({ error: describeError(err) }, 'unhandled rejection'),
);

const db = createDb({ applicationName: 'collector', max: 4, log });
const registry = await prepareDatabase(db, startupPaths(process.env), log);
const writer = createReadingWriter(db);
const shutdown = new AbortController();

function makeContext(sourceId: string) {
  const source = registry.sources.find((s) => s.id === sourceId)!;
  const sourceLog = log.child({ source: sourceId });
  return (signal: AbortSignal, onRows: (n: number) => void): CollectorContext => ({
    source,
    env,
    log: sourceLog,
    signal,
    db,
    async writeReadings(readings) {
      const n = await writer.write(sourceId, readings);
      onRows(n);
      return n;
    },
    lastDataTo: (metric, entity) => lastDataTo(db, sourceId, metric, entity),
  });
}

// --- Start every enabled source that has a collector -------------------------------------
const byId = new Map(collectors.map((c) => [c.id, c]));
const pullLoops: PullLoop[] = [];
const pushSubscriptions: { stop(): Promise<void> }[] = [];
let stagger = 0;

for (const source of registry.sources) {
  const collector = byId.get(source.id);
  if (!source.enabled) continue;
  if (!collector) {
    log.warn(
      { source: source.id },
      'enabled in config/sources.yaml but no collector exists; it will show as Late',
    );
    continue;
  }
  const sourceLog = log.child({ source: source.id });
  if (collector.kind === 'pull') {
    const loop = new PullLoop({
      collector,
      source,
      log: sourceLog,
      store: {
        start: (id, at) => startRun(db, id, at),
        finish: (id, outcome, at) => finishRun(db, id, outcome, at),
      },
      makeContext: makeContext(source.id),
      initialDelayMs: stagger++ * STARTUP_STAGGER_MS,
    });
    loop.start();
    pullLoops.push(loop);
  } else {
    try {
      pushSubscriptions.push(
        await startPushSource({
          collector,
          source,
          log: sourceLog,
          signal: shutdown.signal,
          store: { record: (id, from, to, outcome) => recordRun(db, id, from, to, outcome) },
          makeContext: makeContext(source.id),
        }),
      );
    } catch (err) {
      sourceLog.error(
        { error: describeError(err) },
        'push source failed to start; it will show as Late',
      );
    }
  }
}
for (const c of collectors) {
  if (!registry.sources.some((s) => s.id === c.id))
    log.warn({ source: c.id }, 'collector exists but is not in config/sources.yaml');
}
log.info(
  {
    pull: pullLoops.length,
    push: pushSubscriptions.length,
    enabled: registry.sources.filter((s) => s.enabled).map((s) => s.id),
  },
  'collector started',
);

// --- Periodic jobs -----------------------------------------------------------------------
const lateStore: LateStore = {
  latestBySource: () => latestBySource(db),
  openLate: async (source, f) =>
    (await openEvent(db, {
      level: 'warning',
      sourceId: source.id,
      kind: SOURCE_LATE,
      message: lateMessage(source, f),
      data: f,
    })) !== null,
  resolveLate: async (sourceId) => (await resolveEvent(db, sourceId, SOURCE_LATE)) !== null,
};

function every(ms: number, name: string, job: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((err: unknown) =>
        log.error({ job: name, error: describeError(err) }, 'periodic job failed'),
      )
      .finally(() => (running = false));
  }, ms);
}

// The first late check runs one interval after startup, giving every source time to report.
const timers = [
  every(LATE_CHECK_INTERVAL_MS, 'late-check', () =>
    checkLateSources(registry.sources, lateStore, log),
  ),
  every(PRUNE_INTERVAL_MS, 'prune-runs', async () => {
    const removed = await pruneRuns(db);
    if (removed > 0) log.info({ removed }, 'pruned old collector runs');
  }),
];

// --- Shutdown ----------------------------------------------------------------------------
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    shutdown.abort();
    timers.forEach(clearInterval);
    void Promise.allSettled([
      ...pullLoops.map((l) => l.stop()),
      ...pushSubscriptions.map((s) => s.stop()),
    ])
      .then(() => db.end({ timeout: 5 }))
      .then(() => process.exit(0));
  });
}
