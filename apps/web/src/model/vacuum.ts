import {
  addLondonDays,
  londonDateString,
  londonMidnight,
  vacuumState,
  type LatestItem,
  type ReadingsResponse,
  type SeriesMeta,
  type VacuumState,
} from '@home/shared';

/** Floors in the order they're listed, each with its colour (docs/03 § roborock). */
const FLOORS: readonly { entity: string; colour: string }[] = [
  { entity: 'ground_floor', colour: 'var(--floor-ground)' },
  { entity: 'first_floor', colour: 'var(--floor-first)' },
  { entity: 'top_floor', colour: 'var(--floor-top)' },
];
export const NO_MAP = 'no_map';

/**
 * How a floor is drawn: its own colour, grey for runs without a map, and one hatched grey for
 * any other map (a fourth floor hue couldn't be told apart from these three by everyone).
 */
export type FloorStyle = { kind: 'solid'; colour: string } | { kind: 'other' };

export function floorStyle(entity: string): FloorStyle {
  const known = FLOORS.find((f) => f.entity === entity);
  if (known) return { kind: 'solid', colour: known.colour };
  if (entity === NO_MAP) return { kind: 'solid', colour: 'var(--floor-none)' };
  return { kind: 'other' };
}

/** Sort key: the three floors, then other maps, then runs without a map. */
export function floorRank(entity: string): number {
  const i = FLOORS.findIndex((f) => f.entity === entity);
  if (i >= 0) return i;
  return entity === NO_MAP ? FLOORS.length + 1 : FLOORS.length;
}

/** "ground_floor" → "Ground floor", when a series has no label. */
export function floorLabel(meta: Pick<SeriesMeta, 'entity' | 'label'>): string {
  if (meta.label) return meta.label;
  const words = meta.entity.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "2026-11" for the London month an instant falls in. */
export function londonMonth(date: Date): string {
  return londonDateString(date).slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** [start, end) of a London month, as instants. */
export function monthBounds(month: string): { from: Date; to: Date } {
  return { from: londonMidnight(`${month}-01`), to: londonMidnight(`${addMonths(month, 1)}-01`) };
}

export function formatMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The month's dates in weeks starting on Monday; `null` pads the first and last week. */
export function monthWeeks(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (string | null)[] = Array.from({ length: offset }, () => null);
  for (let d = first; d.startsWith(month); d = addLondonDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

export interface FloorDay {
  entity: string;
  label: string;
  minutes: number;
}

/** Daily `clean_minutes` sums (1d buckets, London days) → each date's floors, in floor order. */
export function floorsByDay(readings: ReadingsResponse | undefined): Map<string, FloorDay[]> {
  const days = new Map<string, FloorDay[]>();
  for (const s of readings?.series ?? []) {
    for (const [ts, value] of s.points) {
      if (value <= 0) continue;
      const date = londonDateString(new Date(ts));
      const list = days.get(date) ?? [];
      list.push({ entity: s.meta.entity, label: floorLabel(s.meta), minutes: value });
      days.set(date, list);
    }
  }
  for (const list of days.values()) list.sort((a, b) => floorRank(a.entity) - floorRank(b.entity));
  return days;
}

export interface Run {
  ts: string;
  entity: string;
  label: string;
  minutes: number;
  areaM2: number | null;
}

/** One day's raw `clean_minutes` and `clean_area` readings → its runs, earliest first. */
export function runsOfDay(readings: ReadingsResponse | undefined): Run[] {
  const runs = new Map<string, Run>();
  const key = (entity: string, ts: string) => `${entity}|${Date.parse(ts)}`;
  const series = readings?.series ?? [];
  for (const s of series.filter((x) => x.meta.metric === 'clean_minutes')) {
    for (const [ts, value] of s.points) {
      runs.set(key(s.meta.entity, ts), {
        ts,
        entity: s.meta.entity,
        label: floorLabel(s.meta),
        minutes: value,
        areaM2: null,
      });
    }
  }
  for (const s of series.filter((x) => x.meta.metric === 'clean_area')) {
    for (const [ts, value] of s.points) {
      const run = runs.get(key(s.meta.entity, ts));
      if (run) run.areaM2 = value;
    }
  }
  return [...runs.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** "1 h 05 min", "21 min". */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

export interface VacuumNow {
  battery: number | null;
  state: VacuumState | null;
  /** When the robot was last asked (the newer of the two readings). */
  ts: string;
}

/** The robot's own latest battery and state, from `/api/latest` (entity `vacuum`). */
export function vacuumNow(items: readonly LatestItem[] | undefined): VacuumNow | null {
  const own = (metric: string) =>
    items?.find((i) => i.series.entity === 'vacuum' && i.series.metric === metric);
  const battery = own('battery');
  const state = own('state');
  const times = [battery?.ts, state?.ts].filter((t): t is string => !!t).sort();
  const ts = times.at(-1);
  if (!ts) return null;
  return {
    battery: battery?.value ?? null,
    state: state?.value === null || state?.value === undefined ? null : vacuumState(state.value),
    ts,
  };
}
