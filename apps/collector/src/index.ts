import { pino } from 'pino';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// M0 placeholder: collectors and the MQTT subscriber arrive in M2/M3.
// Keep the process alive so the container doesn't restart-loop.
const keepAlive = setInterval(() => undefined, 60_000);
log.info('collector started (no collectors registered yet)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
  });
}
