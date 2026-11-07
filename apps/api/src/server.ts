import fastifyCompress from '@fastify/compress';
import { pingDb, type Sql } from '@home/db';
import type { Registry } from '@home/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { pino } from 'pino';
import { registerAccessAuth } from './auth.js';
import type { Config } from './config.js';
import { HttpError, registerErrorHandler } from './errors.js';
import { FreshnessService } from './freshness.js';
import { registerDataRoutes } from './routes/data.js';
import { registerEnergyRoutes } from './routes/energy.js';
import { registerHeatingRoutes } from './routes/heating.js';
import { postgresNotifications, StreamHub, type NotificationSource } from './stream.js';
import { registerWebApp } from './web-app.js';

export interface ServerDeps {
  /** Database pool; without one, only /api/health (reporting the database as down) is served. */
  db?: Sql;
  /** The source registry, needed for data routes (freshness policies). */
  registry?: Registry;
  /** Override Cloudflare's signing keys (tests). */
  accessKeys?: JWTVerifyGetKey;
  /** Clock (tests). */
  now?: () => Date;
  /** Override Postgres LISTEN (tests). */
  notifications?: NotificationSource;
  logger?: FastifyBaseLogger;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

export function createLogger(level: string): FastifyBaseLogger {
  return pino({ level, redact: ['req.headers["cf-access-jwt-assertion"]', 'req.headers.cookie'] });
}

export async function buildServer(config: Config, deps: ServerDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger(config.logLevel),
    // Only reachable via cloudflared on the Docker network (or 127.0.0.1 on the Pi).
    trustProxy: true,
    // Open SSE streams would otherwise hold shutdown forever.
    forceCloseConnections: true,
  });

  registerErrorHandler(app);

  app.addHook('onSend', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  // Before any route, so every route (and the 404 handler) is behind it.
  registerAccessAuth(app, config.auth, deps.accessKeys);

  // Gzip JSON and assets (docs/04 § Performance). Must come before @fastify/static.
  await app.register(fastifyCompress, { threshold: 1024 });

  // Unauthenticated (Docker healthcheck). Returns no data.
  app.get('/api/health', { logLevel: 'warn' }, async () => ({
    ok: true,
    db: deps.db && (await pingDb(deps.db)) ? 'up' : 'down',
    version: config.version,
  }));

  if (deps.db && deps.registry) {
    const now = deps.now ?? (() => new Date());
    const freshness = new FreshnessService(deps.registry, now);
    registerDataRoutes(app, { db: deps.db, registry: deps.registry, freshness, now });
    registerHeatingRoutes(app, { db: deps.db, registry: deps.registry, freshness, now });
    registerEnergyRoutes(app, { db: deps.db, freshness, now });

    const hub = new StreamHub({
      db: deps.db,
      registry: deps.registry,
      freshness,
      notifications: deps.notifications ?? postgresNotifications(deps.db),
      log: app.log,
    });
    app.addHook('onReady', () => hub.start());
    app.addHook('onClose', () => hub.stop());

    app.get('/api/stream', { compress: false, logLevel: 'warn' }, (request, reply) => {
      if (hub.clientCount >= 50)
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Too many live connections');
      reply.hijack(); // we write the response ourselves; onSend hooks don't run
      reply.raw.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      hub.addClient(reply.raw);
      request.log.debug({ clients: hub.clientCount }, 'stream client connected');
    });
  }

  await registerWebApp(app, config.publicDir);

  return app;
}
