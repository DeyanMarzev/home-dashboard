import { openEvent, resolveEvent } from '@home/db';
import type { PullCollector } from '../../collector.js';
import { parsePiStats, underVoltageNow } from './parse.js';

const UNDER_VOLTAGE_EVENT = 'pi_undervoltage';
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
    const readings = parsePiStats(raw, new Date());
    await ctx.writeReadings(readings);

    // A weak power supply corrupts SD cards: say so on the Overview (and, from M11, on phones).
    const under = underVoltageNow(readings);
    if (under === true) {
      await openEvent(ctx.db, {
        level: 'warning',
        sourceId: 'pi_stats',
        kind: UNDER_VOLTAGE_EVENT,
        message: "Pi power problem · under-voltage now. Check the Pi's power supply and cable",
      });
    } else if (under === false) {
      await resolveEvent(ctx.db, 'pi_stats', UNDER_VOLTAGE_EVENT);
    }
  },
};
