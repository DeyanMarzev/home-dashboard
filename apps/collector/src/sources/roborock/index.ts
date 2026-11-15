import { openEvent, resolveEvent } from '@home/db';
import type { CollectorContext, PullCollector } from '../../collector.js';
import { parseRoborockSnapshot } from './parse.js';

const AUTH_EVENT = 'roborock_auth';

/** The helper said the Roborock sign-in is missing or no longer accepted (HTTP 401). */
export class RoborockAuthError extends Error {
  override name = 'RoborockAuthError';
}

/**
 * GET the helper's snapshot. The helper's error bodies are its own short messages (never
 * tokens), so they're passed on to the run log.
 */
export async function fetchSnapshot(
  ctx: Pick<CollectorContext, 'env' | 'signal'>,
): Promise<unknown> {
  const url = new URL('/snapshot', ctx.env.ROBOROCK_HELPER_URL);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctx.signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(
      `Roborock helper at ${url.host} is not reachable (is the roborock container up?)`,
      { cause: err },
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body;
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Roborock helper answered HTTP ${res.status}`;
  throw res.status === 401 ? new RoborockAuthError(message) : new Error(message);
}

/** Roborock vacuum runs per floor, via the python-roborock helper (docs/03 § roborock). */
export const roborock: PullCollector = {
  id: 'roborock',
  kind: 'pull',
  async run(ctx) {
    let body: unknown;
    try {
      body = await fetchSnapshot(ctx);
    } catch (err) {
      // Signing in again needs the owner: raise it as an event, not just a failed run.
      if (err instanceof RoborockAuthError) {
        await openEvent(ctx.db, {
          level: 'alert',
          sourceId: 'roborock',
          kind: AUTH_EVENT,
          message: err.message,
        });
      }
      throw err;
    }
    await resolveEvent(ctx.db, 'roborock', AUTH_EVENT);

    const { readings, skipped, problems } = parseRoborockSnapshot(body, new Date());
    if (skipped > 0) {
      ctx.log.warn({ skipped, problems }, 'cleaning records in an unexpected shape left out');
    }

    // The robot re-sends its last ~20 runs every time: write only the ones not stored yet.
    const stored = new Map<string, number>();
    for (const entity of new Set(readings.map((r) => r.entity ?? ''))) {
      const to = await ctx.lastDataTo('clean_minutes', entity);
      stored.set(entity, to?.getTime() ?? -Infinity);
    }
    await ctx.writeReadings(
      readings.filter(
        (r) => r.metric === 'battery' || new Date(r.ts).getTime() > stored.get(r.entity ?? '')!,
      ),
    );
  },
};
