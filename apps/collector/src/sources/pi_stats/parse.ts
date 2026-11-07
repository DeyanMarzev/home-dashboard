import type { ReadingInput } from '@home/shared';

/** What pi_stats reads from the host, raw (see read.ts). Missing files are null. */
export interface RawPiStats {
  /** /sys/class/thermal/thermal_zone0/temp: millidegrees C. */
  thermal: string | null;
  /** /sys/devices/platform/soc/soc:firmware/get_throttled: hex bitmask. */
  throttled: string | null;
  /** /proc/meminfo */
  meminfo: string;
  /** /proc/loadavg */
  loadavg: string;
  /** /proc/uptime */
  uptime: string;
  /** statfs of each filesystem, by entity (`sd_card`, `ssd`). */
  disks: { entity: string; bsize: number; blocks: number; bfree: number; bavail: number }[];
  /** pg_database_size of the dashboard database, bytes. */
  databaseBytes: number | null;
}

const MB = 1_000_000;
const GB = 1_000_000_000;
const round = (n: number, digits: number) => Number(n.toFixed(digits));

function meminfoKb(meminfo: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
  if (!match) throw new Error(`/proc/meminfo has no ${field}`);
  return Number(match[1]);
}

/**
 * Raw host files → readings, all at `ts` (entity `pi`, disks by filesystem).
 * Throttle bits (decoded by the API): 0 under-voltage, 1 frequency capped, 2 throttled,
 * 3 soft temperature limit; bits 16–19 the same "has occurred since boot".
 */
export function parsePiStats(raw: RawPiStats, ts: Date): ReadingInput[] {
  const pi = (
    metric: string,
    unit: string,
    value: number,
    valueType: 'gauge' | 'state' = 'gauge',
  ): ReadingInput => ({
    metric,
    entity: 'pi',
    unit,
    valueType,
    ts,
    value,
  });
  const readings: ReadingInput[] = [];

  if (raw.thermal !== null) {
    const milli = Number(raw.thermal.trim());
    if (!Number.isFinite(milli))
      throw new Error(`CPU temperature "${raw.thermal.trim()}" is not a number`);
    readings.push(pi('cpu_temperature', '°C', round(milli / 1000, 1)));
  }

  if (raw.throttled !== null) {
    const text = raw.throttled.trim().replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(text))
      throw new Error(`throttle flags "${raw.throttled.trim()}" are not hex`);
    readings.push(pi('throttle_flags', 'flags', parseInt(text, 16), 'state'));
  }

  const totalKb = meminfoKb(raw.meminfo, 'MemTotal');
  const availableKb = meminfoKb(raw.meminfo, 'MemAvailable');
  readings.push(pi('memory_total', 'MB', round((totalKb * 1024) / MB, 0)));
  readings.push(pi('memory_used', 'MB', round(((totalKb - availableKb) * 1024) / MB, 0)));

  const loads = raw.loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  if (loads.length !== 3 || loads.some((n) => !Number.isFinite(n)))
    throw new Error(`/proc/loadavg "${raw.loadavg.trim()}" not understood`);
  readings.push(
    pi('load_1m', 'load', loads[0]!),
    pi('load_5m', 'load', loads[1]!),
    pi('load_15m', 'load', loads[2]!),
  );

  const uptime = Number(raw.uptime.trim().split(/\s+/)[0]);
  if (!Number.isFinite(uptime))
    throw new Error(`/proc/uptime "${raw.uptime.trim()}" not understood`);
  readings.push(pi('uptime', 's', Math.round(uptime)));

  for (const d of raw.disks) {
    // As df does: used = total - free; available to us = bavail (excludes root-reserved blocks).
    const used = (d.blocks - d.bfree) * d.bsize;
    const free = d.bavail * d.bsize;
    readings.push(
      {
        metric: 'disk_used',
        entity: d.entity,
        unit: 'GB',
        valueType: 'gauge',
        ts,
        value: round(used / GB, 2),
      },
      {
        metric: 'disk_free',
        entity: d.entity,
        unit: 'GB',
        valueType: 'gauge',
        ts,
        value: round(free / GB, 2),
      },
    );
  }

  if (raw.databaseBytes !== null)
    readings.push(pi('database_size', 'MB', round(raw.databaseBytes / MB, 1)));
  return readings;
}
