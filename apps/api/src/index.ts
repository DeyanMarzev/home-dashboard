import { createDb, prepareDatabase, startupPaths } from '@home/db';
import { ConfigError, loadConfig, type Config } from './config.js';
import { buildServer, createLogger } from './server.js';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const log = createLogger(config.logLevel);
const db = createDb({ applicationName: 'api', max: 10, log });

// Migrations and registry sync finish before the port opens, so the healthcheck (and
// cloudflared, which waits for it) only see a ready API.
const registry = await prepareDatabase(db, startupPaths(process.env), log);
const app = await buildServer(config, { db, registry, logger: log });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => db.end({ timeout: 5 }))
      .then(() => process.exit(0));
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
