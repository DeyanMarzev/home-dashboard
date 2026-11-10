import { addPublishedTariff, attemptsSince, openEvent, resolveEvent, type Sql } from '@home/db';
import {
  addLondonDays,
  leakStatus,
  LEAK_NIGHTS,
  londonDateString,
  londonMidnight,
  nightMinimums,
} from '@home/shared';
import type { PullCollector } from '../../collector.js';
import { refuseFakeInProduction } from '../../env.js';
import { fakeWaterProvider } from './providers/fake.js';
import { thamesProvider, USER_AGENT } from './providers/thames.js';
import { parseThamesTariff, TARIFF_URL } from './tariff.js';
import type { WaterProvider } from './providers/types.js';

export const PROVIDERS: Record<string, WaterProvider> = {
  fake: fakeWaterProvider,
  thames: thamesProvider,
};

/** Never more than this many login attempts a London day: protects the account from lockout. */
export const MAX_ATTEMPTS_PER_DAY = 3;
/** Each run re-fetches this many days (the feed is ~3 days late and revises). */
const FETCH_DAYS = 7;
const LEAK_EVENT = 'water_leak';

/** Hourly water use from Thames Water, about 3 days behind (docs/03 § thames_water). */
export const thamesWater: PullCollector = {
  id: 'thames_water',
  kind: 'pull',
  async run(ctx) {
    const provider = PROVIDERS[ctx.env.WATER_PROVIDER];
    if (!provider)
      throw new Error(`WATER_PROVIDER "${ctx.env.WATER_PROVIDER}" isn't known (thames | fake)`);
    refuseFakeInProduction(ctx.env, provider.id, 'WATER_PROVIDER', 'thames');

    const today = londonDateString(new Date());
    const attempts = await attemptsSince(ctx.db, 'thames_water', londonMidnight(today));
    if (attempts >= MAX_ATTEMPTS_PER_DAY) {
      ctx.log.warn(
        { attempts },
        `already tried ${attempts} times today; next try tomorrow (account lockout protection)`,
      );
      return;
    }

    const from = londonMidnight(addLondonDays(today, -FETCH_DAYS));
    const readings = await provider.fetch(from, new Date(), {
      env: ctx.env,
      signal: ctx.signal,
      log: ctx.log,
    });
    if (provider.id === 'thames') {
      // Best effort: the readings matter more than the rates.
      await updateTariff(
        ctx.db,
        ctx.signal,
        ctx.source.options.surface_water_rebate === true,
      ).catch((err: unknown) => ctx.log.warn({ error: String(err) }, 'water rates not updated'));
    }
    if (readings.length === 0) return;
    await ctx.writeReadings(readings);

    // Leak check: water flowing between midnight and 05:00, night after night.
    const hourly = readings
      .filter((r) => r.metric === 'volume')
      .map((r) => [new Date(r.ts).toISOString(), r.value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const nights = nightMinimums(hourly);
    const leak = leakStatus(nights);
    if (leak.state === 'leak') {
      const lowest = Math.min(
        ...nights
          .filter((n) => n.complete)
          .slice(-LEAK_NIGHTS)
          .map((n) => n.minLitres),
      );
      await openEvent(ctx.db, {
        level: 'alert',
        sourceId: 'thames_water',
        kind: LEAK_EVENT,
        message: `Possible water leak: water flowed between midnight and 05:00 for ${leak.consecutive} nights in a row (at least ${lowest} L an hour)`,
        data: { nights: nights.slice(-leak.consecutive) },
      });
    } else if (leak.state === 'ok') {
      await resolveEvent(ctx.db, 'thames_water', LEAK_EVENT);
    }
  },
};

/**
 * Thames Water's published metered rates (public page, no login) into `tariffs`, so water
 * costs need no typing. Skipped when the rates are already there, or the owner has entered a
 * water tariff starting later.
 */
async function updateTariff(db: Sql, signal: AbortSignal, surfaceWaterRebate: boolean) {
  const res = await fetch(TARIFF_URL, { signal, headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Thames Water's rates page answered HTTP ${res.status}`);
  const tariff = parseThamesTariff(await res.text(), { surfaceWaterRebate });
  await addPublishedTariff(db, { ...tariff, publisher: 'Thames Water' });
}
