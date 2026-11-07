import { openEvent, resolveEvent } from '@home/db';
import type { CollectorContext, PullCollector } from '../../collector.js';
import { requireSetting } from '../../env.js';
import { fetchJson, HttpError } from '../../http.js';
import { clearAccessToken, getAccessToken, NestAuthError } from './auth.js';
import { parseNestDevices } from './parse.js';

const AUTH_EVENT = 'nest_auth';

export function devicesUrl(projectId: string): URL {
  return new URL(
    `https://smartdevicemanagement.googleapis.com/v1/enterprises/${encodeURIComponent(projectId)}/devices`,
  );
}

export async function fetchDevices(
  ctx: Pick<CollectorContext, 'env' | 'signal'>,
): Promise<unknown> {
  const creds = {
    clientId: requireSetting(ctx.env.NEST_CLIENT_ID, 'NEST_CLIENT_ID'),
    clientSecret: requireSetting(ctx.env.NEST_CLIENT_SECRET, 'NEST_CLIENT_SECRET'),
    refreshToken: requireSetting(ctx.env.NEST_REFRESH_TOKEN, 'NEST_REFRESH_TOKEN'),
  };
  const url = devicesUrl(requireSetting(ctx.env.NEST_PROJECT_ID, 'NEST_PROJECT_ID'));
  const token = await getAccessToken(creds, ctx.signal);
  try {
    return await fetchJson(url, ctx.signal, { authorization: `Bearer ${token}` });
  } catch (err) {
    // A revoked or expired access token: get a fresh one next run. 429 is retried with backoff.
    if (err instanceof HttpError && err.status === 401) clearAccessToken();
    throw err;
  }
}

/** Nest thermostat via Google's Smart Device Management API (docs/03 § nest). */
export const nest: PullCollector = {
  id: 'nest',
  kind: 'pull',
  async run(ctx) {
    let body: unknown;
    try {
      body = await fetchDevices(ctx);
    } catch (err) {
      // Sign-in problems need the owner: raise them as an event, not just a failed run.
      if (err instanceof NestAuthError) {
        await openEvent(ctx.db, {
          level: 'alert',
          sourceId: 'nest',
          kind: AUTH_EVENT,
          message: err.message,
        });
      }
      throw err;
    }
    await resolveEvent(ctx.db, 'nest', AUTH_EVENT);
    const entity =
      typeof ctx.source.options.entity === 'string' ? ctx.source.options.entity : undefined;
    await ctx.writeReadings(parseNestDevices(body, new Date(), entity ? { entity } : {}));
  },
};
