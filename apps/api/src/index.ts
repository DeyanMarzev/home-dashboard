import { createDb, prepareDatabase, startupPaths } from '@home/db';
import { ConfigError, loadConfig, type Config } from './config.js';
import { buildServer } from './server.js';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}

const db = createDb({ applicationName: 'api', max: 10 });
const app = await buildServer(config, { db });

// Migrations and registry sync finish before the port opens, so the healthcheck (and
// cloudflared, which waits for it) only see a ready API.
await prepareDatabase(db, startupPaths(process.env), app.log);

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
