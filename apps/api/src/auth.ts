import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from './config.js';
import { HttpError } from './errors.js';

/** Who Cloudflare Access let in: a person (email) or a service token (commonName). */
export interface AccessIdentity {
  sub: string;
  email?: string;
  commonName?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: AccessIdentity | null;
  }
}

/** Routes that answer without a token. Must never return data. */
const PUBLIC_ROUTES = new Set(['/api/health']);

const ACCESS_HEADER = 'cf-access-jwt-assertion';

// jose errors that mean "we couldn't fetch Cloudflare's keys", not "the token is bad".
const KEY_FETCH_ERRORS = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC']);

/**
 * Defence in depth behind Cloudflare Access (docs/04-api.md § Auth): every request except
 * PUBLIC_ROUTES must carry a valid Access JWT, so someone reaching the origin directly
 * (bypassing the tunnel) gets 401.
 *
 * `keys` is for tests; in production the keys come from the team's certs URL (cached by jose).
 */
export function registerAccessAuth(
  app: FastifyInstance,
  auth: AuthConfig,
  keys?: JWTVerifyGetKey,
): void {
  app.decorateRequest('identity', null);

  if (auth.disabled) {
    app.log.warn('AUTH_DISABLED=true: Cloudflare Access JWT check is OFF (development only)');
    return;
  }

  const getKey = keys ?? createRemoteJWKSet(new URL(auth.certsUrl));

  app.addHook('onRequest', async (request) => {
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;

    const token = request.headers[ACCESS_HEADER];
    if (typeof token !== 'string' || token === '') {
      throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in required');
    }

    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: auth.issuer,
        audience: auth.audience,
        algorithms: ['RS256'],
        clockTolerance: 30,
      });
      request.identity = {
        sub: payload.sub ?? '',
        ...(typeof payload.email === 'string' && { email: payload.email }),
        ...(typeof payload.common_name === 'string' && { commonName: payload.common_name }),
      };
    } catch (err) {
      if (err instanceof errors.JOSEError && !KEY_FETCH_ERRORS.has(err.code)) {
        // Log the reason, never the token.
        request.log.warn({ reason: err.code }, 'rejected Cloudflare Access token');
        throw new HttpError(401, 'UNAUTHORIZED', 'Sign-in required');
      }
      request.log.error({ err }, 'could not load Cloudflare Access signing keys');
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Cannot verify sign-in right now');
    }
  });
}
