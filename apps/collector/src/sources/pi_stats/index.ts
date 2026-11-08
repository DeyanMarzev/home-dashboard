import type { PullCollector } from '../../collector.js';
import { parsePiStats } from './parse.js';
import { HWMON_DIR, readPiStats, THERMAL_PATH, THROTTLED_PATH } from './read.js';

let warnedMissing = false;

/** The Pi's own health: CPU temperature, throttling, memory, load, uptime, disks, DB size. */
export const piStats: PullCollector = {
  id: 'pi_stats',
  kind: 'pull',
  async run(ctx) {
    const raw = await readPiStats(ctx.env, ctx.db);
    const power = raw.throttled ?? raw.underVoltage ?? null;
    if (!warnedMissing && (raw.thermal === null || power === null)) {
      // Expected off the Pi (e.g. in development); on the Pi, check the /sys mount.
      ctx.log.warn(
        {
          thermal: raw.thermal !== null,
          power: power !== null,
          paths: [THERMAL_PATH, THROTTLED_PATH, `${HWMON_DIR}/*/in0_lcrit_alarm (rpi_volt)`],
        },
        'some Pi sensor files are missing; skipping those metrics',
      );
      warnedMissing = true;
    }
    await ctx.writeReadings(parsePiStats(raw, new Date()));
  },
};
