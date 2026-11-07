import { attemptsSince, openEvent, resolveEvent } from '@home/db';
import {
  addLondonDays,
  leakStatus,
  LEAK_NIGHTS,
  londonDateString,
  londonMidnight,
  nightMinimums,
} from '@home/shared';
import type { PullCollector } from '../../collector.js';
import { fakeWaterProvider } from './providers/fake.js';
import { thamesProvider } from './providers/thames.js';
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
      throw new Error(`WATER_PROVIDER "${ctx.env.WATER_PROVIDER}" isn't known (fake | thames)`);

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
