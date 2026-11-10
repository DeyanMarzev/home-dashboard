/**
 * Prints the Thames Water account's meter list and the last few days of hourly usage, with
 * meter serials and other personal details redacted (./redact.ts), for parser fixtures
 * (src/sources/thames_water/__fixtures__). Run on the Pi:
 *   docker compose exec collector node dist/tools/thames-capture.js > thames.json
 * It signs in once (the collector's own limit is 3 sign-ins a day).
 */
import { addLondonDays, londonDateString } from '@home/shared';
import { loadCollectorEnv } from '../env.js';
import { MetersResponseSchema } from '../sources/thames_water/providers/thames-parse.js';
import {
  getHourlyUsage,
  getMeters,
  signIn,
  signOut,
} from '../sources/thames_water/providers/thames.js';
import { redactor } from './redact.js';

const env = loadCollectorEnv(process.env);
const { session } = await signIn(env, AbortSignal.timeout(120_000));
try {
  const meters = await getMeters(session);
  const meter = env.THAMES_METER_ID ?? MetersResponseSchema.parse(meters).Meters[0];
  const today = londonDateString(new Date());
  const start = addLondonDays(today, -6);
  const hourly = meter
    ? await getHourlyUsage(session, meter, start, addLondonDays(today, -1))
    : null;
  // Not `meters`: that key is redacted as a list of meter serials.
  console.log(JSON.stringify({ start, meterList: meters, hourly }, redactor(), 2));
} finally {
  await signOut(session);
}
