import Fastify, { type FastifyInstance } from 'fastify';

export const VERSION = process.env.APP_VERSION ?? '0.0.0-dev';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // Unauthenticated; used by the Docker healthcheck. Returns no data.
  // M0 placeholder: the database check is added with the DB in M2.
  app.get('/api/health', () => ({ ok: true, version: VERSION }));

  return app;
}
