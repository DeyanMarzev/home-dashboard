import type { Sql } from '@home/db';
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectorEnv } from '../../env.js';
import type { RawPiStats } from './parse.js';

export const THERMAL_PATH = 'class/thermal/thermal_zone0/temp';
export const THROTTLED_PATH = 'devices/platform/soc/soc:firmware/get_throttled';

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Reads everything pi_stats reports from the (read-only mounted) host paths. */
export async function readPiStats(env: CollectorEnv, db: Sql): Promise<RawPiStats> {
  const filesystems = [
    { entity: 'sd_card', path: env.HOST_ROOTFS },
    ...(env.HOST_DATA_DIR ? [{ entity: 'ssd', path: env.HOST_DATA_DIR }] : []),
  ];
  const [thermal, throttled, meminfo, loadavg, uptime, disks, [size]] = await Promise.all([
    readOptional(join(env.HOST_SYS, THERMAL_PATH)),
    readOptional(join(env.HOST_SYS, THROTTLED_PATH)),
    readFile(join(env.HOST_PROC, 'meminfo'), 'utf8'),
    readFile(join(env.HOST_PROC, 'loadavg'), 'utf8'),
    readFile(join(env.HOST_PROC, 'uptime'), 'utf8'),
    Promise.all(filesystems.map(async ({ entity, path }) => ({ entity, ...(await statfs(path)) }))),
    db<{ bytes: string }[]>`select pg_database_size(current_database())::text as bytes`,
  ]);
  return {
    thermal,
    throttled,
    meminfo,
    loadavg,
    uptime,
    disks: disks.map(({ entity, bsize, blocks, bfree, bavail }) => ({
      entity,
      bsize,
      blocks,
      bfree,
      bavail,
    })),
    databaseBytes: size ? Number(size.bytes) : null,
  };
}
