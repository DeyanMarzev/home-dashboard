import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';

/**
 * Serves the built web app at `/` with SPA fallback: unknown non-API GETs get index.html so
 * client-side routes (e.g. /rooms) work on reload. Unknown /api paths get a JSON 404.
 */
export async function registerWebApp(
  app: FastifyInstance,
  publicDir: string | null,
): Promise<void> {
  const hasBuild = publicDir !== null && existsSync(join(publicDir, 'index.html'));

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root: publicDir,
      // Vite puts content-hashed files under /assets: safe to cache forever. Everything
      // else (index.html) must be revalidated so new deploys show up. `private` because
      // everything here sits behind Cloudflare Access.
      setHeaders(reply, path) {
        reply.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(path) ? 'private, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  } else {
    app.log.info({ publicDir }, 'no web build found; serving the API only');
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isPageRequest =
      hasBuild &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !path.startsWith('/api/');
    if (!isPageRequest) {
      throw new HttpError(404, 'NOT_FOUND', `No route for ${request.method} ${path}`);
    }
    return reply.header('cache-control', 'no-cache').sendFile('index.html');
  });
}
