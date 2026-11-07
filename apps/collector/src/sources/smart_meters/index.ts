import type { PullCollector } from '../../collector.js';
import { fakeProvider } from './providers/fake.js';
import type { MeterProvider } from './providers/types.js';

/** Providers by METER_PROVIDER. The real one is added once docs/08 question 3 is answered. */
export const PROVIDERS: Record<string, MeterProvider> = { fake: fakeProvider };

/** Re-fetch this far behind what we have: delayed sources re-send and revise (docs/03). */
const OVERLAP_MS = 2 * 86400_000;
/** On the very first run, fetch this much history. */
const BACKFILL_MS = 30 * 86400_000;

/** Half-hourly electricity and gas, 1 day behind (docs/03 § smart_meters). */
export const smartMeters: PullCollector = {
  id: 'smart_meters',
  kind: 'pull',
  async run(ctx) {
    const provider = PROVIDERS[ctx.env.METER_PROVIDER];
    if (!provider) {
      throw new Error(
        `METER_PROVIDER "${ctx.env.METER_PROVIDER}" isn't supported yet (see docs/08 question 3)`,
      );
    }
    const [electricity, gas] = await Promise.all([
      ctx.lastDataTo('energy_import', 'electricity'),
      ctx.lastDataTo('energy_import', 'gas'),
    ]);
    const now = new Date();
    const known = [electricity, gas].filter((d): d is Date => d !== null);
    const from =
      known.length === 2
        ? new Date(Math.min(...known.map((d) => d.getTime())) - OVERLAP_MS)
        : new Date(now.getTime() - BACKFILL_MS);
    const readings = await provider.fetch(from, now, {
      env: ctx.env,
      signal: ctx.signal,
      log: ctx.log,
    });
    ctx.log.debug(
      { provider: provider.id, from: from.toISOString(), readings: readings.length },
      'meter data fetched',
    );
    if (readings.length) await ctx.writeReadings(readings);
  },
};
