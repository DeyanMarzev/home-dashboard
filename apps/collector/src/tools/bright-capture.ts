/**
 * Prints the Bright account's virtual entities, resources and the last two days of half-hourly
 * readings with ids and personal details redacted, for parser fixtures
 * (src/sources/smart_meters/__fixtures__). Run on the Pi:
 *   docker compose exec collector node dist/tools/bright-capture.js > bright.json
 */
import { loadCollectorEnv } from '../env.js';
import { brightGet, parseResources } from '../sources/smart_meters/providers/bright.js';

const env = loadCollectorEnv(process.env);
const ctx = { env, signal: AbortSignal.timeout(60_000) };

const entities = (await brightGet('virtualentity', ctx)) as { veId: string }[];
const resources: unknown[] = [];
for (const { veId } of entities) {
  resources.push(await brightGet(`virtualentity/${encodeURIComponent(veId)}/resources`, ctx));
}

const now = Math.floor(Date.now() / 1800_000) * 1800_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
const readings: Record<string, unknown> = {};
for (const { fuel, resourceId } of parseResources(resources)) {
  readings[fuel] = await brightGet(`resource/${encodeURIComponent(resourceId)}/readings`, ctx, {
    from: iso(now - 2 * 86400_000),
    to: iso(now - 1000),
    period: 'PT30M',
    offset: '0',
    function: 'sum',
  });
}

// Ids are replaced with stable placeholders, so the structure (which id is which) survives.
const ids = new Map<string, string>();
const REDACT_KEYS = new Set(['veId', 'resourceId', 'resourceTypeId', 'ownerId', 'deviceId']);
const PERSONAL_KEYS = new Set(['postalCode', 'address', 'email', 'username', 'mpan', 'mprn']);
console.log(
  JSON.stringify(
    { entities, resources, readings },
    (key, value: unknown) => {
      if (typeof value !== 'string') return value;
      if (PERSONAL_KEYS.has(key)) return 'REDACTED';
      if (REDACT_KEYS.has(key)) {
        if (!ids.has(value)) ids.set(value, `REDACTED-${key}-${ids.size + 1}`);
        return ids.get(value);
      }
      return value;
    },
    2,
  ),
);
