import { createDb, prepareDatabase, startupPaths } from '@home/db';
import { pino } from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = createDb({ applicationName: 'collector', max: 4, log });

// Collectors and the MQTT subscriber arrive in M3. For now: migrate, sync the registry
// and stay up so the container doesn't restart-loop.
const registry = await prepareDatabase(db, startupPaths(process.env), log);
const enabled = registry.sources.filter((s) => s.enabled).map((s) => s.id);
log.info({ enabled }, 'collector started (no collectors registered yet)');
const keepAlive = setInterval(() => undefined, 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    void db.end({ timeout: 5 });
  });
}
