/** Raspberry Pi health helpers for the System page and the Overview's Pi card. */

export interface ThrottleFlag {
  key: 'under_voltage' | 'frequency_capped' | 'throttled' | 'soft_temp_limit';
  label: string;
  now: boolean;
  sinceBoot: boolean;
}

const FLAGS: [ThrottleFlag['key'], string][] = [
  ['under_voltage', 'Under-voltage'],
  ['frequency_capped', 'CPU speed capped'],
  ['throttled', 'Throttled'],
  ['soft_temp_limit', 'Soft temperature limit'],
];

/** `get_throttled` bitmask: bits 0–3 happening now, bits 16–19 the same "has occurred since boot". */
export function decodeThrottle(mask: number): ThrottleFlag[] {
  return FLAGS.map(([key, label], bit) => ({
    key,
    label,
    now: (mask & (1 << bit)) !== 0,
    sinceBoot: (mask & (1 << (bit + 16))) !== 0,
  }));
}

/** "None", "Under-voltage now", or "Since boot: under-voltage, throttled". */
export function throttleSummary(mask: number): string {
  const flags = decodeThrottle(mask);
  const now = flags.filter((f) => f.now);
  if (now.length) return `${now.map((f) => f.label).join(', ')} now`;
  const past = flags.filter((f) => f.sinceBoot);
  if (past.length) return `Since boot: ${past.map((f) => f.label.toLowerCase()).join(', ')}`;
  return 'None';
}

/**
 * How long until a disk fills at its recent growth rate. `null` if it isn't growing.
 * Points are [ISO time, GB used], oldest first.
 */
export function daysUntilFull(points: readonly [string, number][], freeGb: number): number | null {
  if (points.length < 2) return null;
  const [t0, v0] = points[0]!;
  const [t1, v1] = points[points.length - 1]!;
  const days = (Date.parse(t1) - Date.parse(t0)) / 86_400_000;
  if (days < 0.5) return null;
  const perDay = (v1 - v0) / days;
  return perDay > 0 ? freeGb / perDay : null;
}

/** "about 5 years", "about 3 months", "about 12 days". */
export function describeDays(days: number): string {
  if (days >= 365 * 1.5) return `about ${Math.round(days / 365)} years`;
  if (days >= 60) return `about ${Math.round(days / 30)} months`;
  return `about ${Math.max(1, Math.round(days))} days`;
}

export type PiStatus = 'healthy' | 'warning' | 'problem';

/**
 * One word for the Pi: a problem if throttling or under-voltage is happening now, the CPU is
 * at 80 °C (where it throttles) or a disk is 95 % full; a warning above 70 °C, 85 % disk, or
 * any throttling since boot.
 */
export function piStatus(i: {
  cpuC: number | null;
  throttleMask: number | null;
  diskUsedPercents: number[];
}): PiStatus {
  const flags = i.throttleMask === null ? [] : decodeThrottle(i.throttleMask);
  const maxDisk = Math.max(0, ...i.diskUsedPercents);
  if (flags.some((f) => f.now) || (i.cpuC ?? 0) >= 80 || maxDisk >= 95) return 'problem';
  if (flags.some((f) => f.sinceBoot) || (i.cpuC ?? 0) >= 70 || maxDisk >= 85) return 'warning';
  return 'healthy';
}
