import { pingDb, type Sql } from '@home/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { registerAccessAuth } from './auth.js';
import type { Config } from './config.js';
import { registerErrorHandler } from './errors.js';
import { registerWebApp } from './web-app.js';

export interface ServerDeps {
  /** Database pool; without one, /api/health reports the database as down. */
  db?: Sql;
  /** Override Cloudflare's signing keys (tests). */
  accessKeys?: JWTVerifyGetKey;
}

export async function buildServer(config: Config, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers["cf-access-jwt-assertion"]', 'req.headers.cookie'],
    },
    // Only reachable via cloudflared on the Docker network (or 127.0.0.1 on the Pi).
    trustProxy: true,
  });

  registerErrorHandler(app);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
  });

  // Before any route, so every route (and the 404 handler) is behind it.
  registerAccessAuth(app, config.auth, deps.accessKeys);

  // Unauthenticated (Docker healthcheck). Returns no data.
  app.get('/api/health', { logLevel: 'warn' }, async () => ({
    ok: true,
    db: deps.db && (await pingDb(deps.db)) ? 'up' : 'down',
    version: config.version,
  }));

  await registerWebApp(app, config.publicDir);

  return app;
}
