import type { ReadingInput } from '@home/shared';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullCollector } from '../../collector.js';
import { describeError } from '../../errors.js';
import { parseW1Temperature } from './parse.js';

export const W1_DEVICES = 'bus/w1/devices';
/** DS18B20 family code. */
const DS18B20 = /^28-[0-9a-f]+$/i;

let notedNoProbes = false;

async function listProbes(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => DS18B20.test(name)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // 1-Wire not enabled (yet)
    throw err;
  }
}

async function readProbe(dir: string, id: string): Promise<number> {
  try {
    return parseW1Temperature(await readFile(join(dir, id, 'temperature'), 'utf8'), 'temperature');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return parseW1Temperature(await readFile(join(dir, id, 'w1_slave'), 'utf8'), 'w1_slave');
  }
}

/**
 * Flow and return pipe temperatures from two DS18B20 probes on GPIO4 (docs/03). Runs fine
 * with no probes fitted: it notes what it can see once and writes nothing.
 */
export const boilerProbes: PullCollector = {
  id: 'boiler_probes',
  kind: 'pull',
  async run(ctx) {
    const dir = join(ctx.env.HOST_SYS, W1_DEVICES);
    const found = await listProbes(dir);
    const wanted = [
      [ctx.env.BOILER_FLOW_W1_ID, 'boiler_flow'],
      [ctx.env.BOILER_RETURN_W1_ID, 'boiler_return'],
    ].filter((pair): pair is [string, string] => !!pair[0]);

    if (wanted.length === 0) {
      if (!notedNoProbes) {
        notedNoProbes = true;
        if (found.length)
          ctx.log.info(
            { found },
            'DS18B20 probes found: set BOILER_FLOW_W1_ID and BOILER_RETURN_W1_ID in .env',
          );
        else ctx.log.info('no boiler probes fitted yet; nothing to read');
      }
      return;
    }

    const now = new Date();
    const readings: ReadingInput[] = [];
    const problems: string[] = [];
    for (const [id, entity] of wanted) {
      if (!found.includes(id)) {
        problems.push(`${entity} probe ${id} not found (seen: ${found.join(', ') || 'none'})`);
        continue;
      }
      try {
        readings.push({
          metric: 'temperature',
          entity,
          unit: '°C',
          valueType: 'gauge',
          ts: now,
          value: await readProbe(dir, id),
        });
      } catch (err) {
        problems.push(`${entity} probe ${id}: ${describeError(err)}`);
      }
    }
    // Keep the probe that worked; fail the run (and retry) for the one that didn't.
    if (readings.length) await ctx.writeReadings(readings);
    if (problems.length) throw new Error(problems.join('; '));
  },
};
