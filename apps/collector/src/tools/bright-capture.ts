/**
 * Prints the Bright account's virtual entities, resources and the last two days of half-hourly
 * readings with ids, the address and other personal details redacted (./redact.ts), for parser fixtures
 * (src/sources/smart_meters/__fixtures__). Run on the Pi:
 *   docker compose exec collector node dist/tools/bright-capture.js > bright.json
 */
import { loadCollectorEnv } from '../env.js';
import { brightGet, parseResources } from '../sources/smart_meters/providers/bright.js';
import { redactor } from './redact.js';

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

console.log(JSON.stringify({ entities, resources, readings }, redactor(), 2));
