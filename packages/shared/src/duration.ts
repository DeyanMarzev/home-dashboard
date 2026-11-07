/** Durations in the registry and collectors: `30s`, `15m`, `6h`, `1d` (1d = 24 h exactly). */
export const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;
type Unit = keyof typeof UNIT_SECONDS;

/** Parses `30s` / `15m` / `6h` / `1d` into seconds. Throws on anything else. */
export function parseDuration(text: string): number {
  const match = DURATION_PATTERN.exec(text.trim());
  if (!match) throw new Error(`Invalid duration "${text}": expected e.g. 30s, 15m, 6h or 1d`);
  return Number(match[1]) * UNIT_SECONDS[match[2] as Unit];
}

/** Seconds → the shortest exact registry form: 1800 → `30m`, 90 → `90s`, 0 → `0s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`Invalid duration ${seconds}s`);
  for (const unit of ['d', 'h', 'm'] as const) {
    const size = UNIT_SECONDS[unit];
    if (seconds > 0 && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/** Seconds → ISO 8601 duration for API responses: 1800 → `PT30M`, 86400 → `P1D`. */
export function toIsoDuration(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error(`Invalid duration ${seconds}s`);
  if (seconds === 0) return 'PT0S';
  const days = Math.floor(seconds / 86400);
  let rest = seconds % 86400;
  const hours = Math.floor(rest / 3600);
  rest %= 3600;
  const minutes = Math.floor(rest / 60);
  const secs = rest % 60;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${secs ? `${secs}S` : ''}`;
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}
