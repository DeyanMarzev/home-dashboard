import { gasKwhFromM3, type ReadingInput } from '@home/shared';
import { z } from 'zod';
import { requireSetting, type CollectorEnv } from '../../../env.js';
import { fetchJson, HttpError } from '../../../http.js';
import type { MeterProvider } from './types.js';

/**
 * Hildebrand Glowmarkt, the API behind the Bright app (docs/03 § smart_meters): free DCC
 * smart meter data, half-hourly kWh for electricity and gas, normally complete the next day.
 * Format taken from community clients (glowmarkt crate, pyglowmarkt): confirm it with
 * `dist/tools/bright-capture.js` (docs/06 § Bright).
 */
const BASE = 'https://api.glowmarkt.com/api/v0-1/';
/** The Bright app's public application id: every Bright account can use it. */
const APPLICATION_ID = 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d';
const HALF_HOUR = 1800_000;
/** Glowmarkt serves at most 10 days of half-hours per request. */
const MAX_SPAN_MS = 10 * 86400_000;
/** Tokens last 7 days; log in again a day before that. */
const EARLY_RENEW_MS = 86400_000;

/** Glowmarkt resource classifier → our `energy_import` entity. */
const CLASSIFIERS = { 'electricity.consumption': 'electricity', 'gas.consumption': 'gas' } as const;
type Fuel = (typeof CLASSIFIERS)[keyof typeof CLASSIFIERS];

/** Bright refused the username or password: needs the owner, not a retry. */
export class BrightAuthError extends Error {
  override name = 'BrightAuthError';
}

const AuthSchema = z.object({
  valid: z.boolean().optional(),
  token: z.string().min(1),
  /** Expiry, Unix seconds. */
  exp: z.number().optional(),
});
const VirtualEntitiesSchema = z.array(z.object({ veId: z.string() }));
const ResourcesSchema = z.object({
  resources: z.array(z.object({ resourceId: z.string(), classifier: z.string().optional() })),
});
const ReadingsSchema = z.object({
  units: z.string().optional(),
  data: z.array(z.tuple([z.number(), z.number().nullable()])),
});

export interface BrightResource {
  resourceId: string;
  fuel: Fuel;
}

let session: { token: string; expiresAt: number } | null = null;
let resources: BrightResource[] | null = null;

/** Forget the cached token and resource ids (tests; or after Bright rejects them). */
export function resetBrightSession(): void {
  session = null;
  resources = null;
}

async function login(env: CollectorEnv, signal: AbortSignal, now = Date.now()): Promise<string> {
  if (session && session.expiresAt - EARLY_RENEW_MS > now) return session.token;
  const res = await fetch(new URL('auth', BASE), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', applicationId: APPLICATION_ID },
    body: JSON.stringify({
      username: requireSetting(env.BRIGHT_USERNAME, 'BRIGHT_USERNAME'),
      password: requireSetting(env.BRIGHT_PASSWORD, 'BRIGHT_PASSWORD'),
    }),
  });
  const body: unknown = await res.json().catch(() => null);
  const parsed = AuthSchema.safeParse(body);
  if (res.status === 401 || res.status === 403 || (res.ok && parsed.data?.valid === false)) {
    throw new BrightAuthError(
      'Bright refused the login. Check BRIGHT_USERNAME and BRIGHT_PASSWORD in .env (the Bright app login).',
    );
  }
  if (!res.ok) throw new HttpError(res.status, `api.glowmarkt.com answered HTTP ${res.status}`);
  if (!parsed.success) throw new Error('api.glowmarkt.com sent a login response without a token');
  const expiresAt = parsed.data.exp ? parsed.data.exp * 1000 : now + 7 * 86400_000;
  session = { token: parsed.data.token, expiresAt };
  return session.token;
}

/** GET a Glowmarkt path with the session token. */
export async function brightGet(
  path: string,
  ctx: { env: CollectorEnv; signal: AbortSignal },
  query: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const token = await login(ctx.env, ctx.signal);
  try {
    return await fetchJson(url, ctx.signal, { token, applicationId: APPLICATION_ID });
  } catch (err) {
    // An expired token or a resource that changed: start again on the next run.
    if (err instanceof HttpError && (err.status === 401 || err.status === 404)) {
      resetBrightSession();
    }
    throw err;
  }
}

/** The account's electricity and gas consumption resources (virtual entity = smart meter set). */
export function parseResources(bodies: unknown[]): BrightResource[] {
  const found = new Map<Fuel, string>();
  for (const body of bodies) {
    for (const r of ResourcesSchema.parse(body).resources) {
      const fuel = CLASSIFIERS[r.classifier as keyof typeof CLASSIFIERS];
      if (fuel && !found.has(fuel)) found.set(fuel, r.resourceId);
    }
  }
  return [...found].map(([fuel, resourceId]) => ({ fuel, resourceId }));
}

export async function findResources(ctx: {
  env: CollectorEnv;
  signal: AbortSignal;
}): Promise<BrightResource[]> {
  if (resources) return resources;
  const entities = VirtualEntitiesSchema.parse(await brightGet('virtualentity', ctx));
  const bodies: unknown[] = [];
  for (const { veId } of entities) {
    bodies.push(await brightGet(`virtualentity/${encodeURIComponent(veId)}/resources`, ctx));
  }
  const found = parseResources(bodies);
  if (found.length === 0) {
    throw new Error(
      'The Bright account has no electricity or gas consumption data yet (finish the set-up in the Bright app).',
    );
  }
  resources = found;
  return found;
}

/** One readings response → `energy_import` readings (kWh per half-hour; gas m³ converted). */
export function parseReadings(body: unknown, fuel: Fuel): ReadingInput[] {
  const { units, data } = ReadingsSchema.parse(body);
  const m3 = units !== undefined && /^m(3|³)$/i.test(units.trim());
  return data.flatMap(([seconds, value]) =>
    value === null
      ? []
      : [
          {
            metric: 'energy_import',
            entity: fuel,
            unit: 'kWh',
            valueType: 'interval_total' as const,
            interval: '30m',
            ts: new Date(seconds * 1000),
            value: m3 ? gasKwhFromM3(value) : value,
          },
        ],
  );
}

/**
 * Glowmarkt fills half-hours it hasn't received from the meter yet with 0. A house always uses
 * some electricity, so drop everything after the last non-zero electricity half-hour (gas can
 * genuinely be 0 for hours, so it can't mark the end on its own).
 */
export function dropUnreceived(readings: ReadingInput[]): ReadingInput[] {
  const electricity = readings.filter((r) => r.entity === 'electricity');
  if (electricity.length === 0) return readings;
  const lastUsed = electricity
    .filter((r) => r.value !== 0)
    .reduce((max, r) => Math.max(max, (r.ts as Date).getTime()), -Infinity);
  return readings.filter((r) => (r.ts as Date).getTime() <= lastUsed);
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 19); // UTC, no zone (offset=0)

export const brightProvider: MeterProvider = {
  id: 'bright',
  async fetch(from, to, ctx) {
    const found = await findResources(ctx);
    const start = Math.floor(from.getTime() / HALF_HOUR) * HALF_HOUR;
    const end = Math.floor(Math.min(to.getTime(), Date.now()) / HALF_HOUR) * HALF_HOUR;
    const bySlot = new Map<string, ReadingInput>();
    for (const { resourceId, fuel } of found) {
      const id = encodeURIComponent(resourceId);
      // Ask Bright to pull the newest data from the meter (DCC). Best effort: it's served later.
      await brightGet(`resource/${id}/catchup`, ctx).catch((err: unknown) =>
        ctx.log.debug({ err: String(err), fuel }, 'bright catchup request failed'),
      );
      for (let t = start; t < end; t += MAX_SPAN_MS) {
        const body = await brightGet(`resource/${id}/readings`, ctx, {
          from: iso(t),
          to: iso(Math.min(t + MAX_SPAN_MS, end) - 1000),
          period: 'PT30M',
          offset: '0',
          function: 'sum',
        });
        for (const r of parseReadings(body, fuel)) {
          const ts = (r.ts as Date).getTime();
          // Writes must not contain the same (series, ts) twice.
          if (ts >= start && ts < end) bySlot.set(`${fuel} ${ts}`, r);
        }
      }
    }
    return dropUnreceived([...bySlot.values()]);
  },
};
