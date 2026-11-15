import { isSnakeCase, type ReadingInput } from '@home/shared';
import { z } from 'zod';

/** Runs without a map: the robot on a landing between floors, or a single-room clean. */
export const NO_MAP_ENTITY = 'no_map';
/** The robot itself (battery), so the source stays Live between runs. */
export const VACUUM_ENTITY = 'vacuum';
/** Shorter runs are false starts (cancelled at once), not cleans. */
export const MIN_RUN_SECONDS = 60;

const RecordSchema = z.object({
  begin: z.number().int().positive(), // Unix seconds; also the run's id
  duration: z.number().nonnegative(), // seconds
  area: z.number().nonnegative().nullish(), // mm² (19 897 500 = 19.9 m²)
  // Runs without a map (landings, single rooms): -1, or absent.
  map_flag: z.number().int().nullish(),
});

const SnapshotSchema = z.object({
  status: z.object({ battery: z.number().min(0).max(100).optional() }).nullish(),
  maps: z
    .object({
      map_info: z
        .array(z.object({ mapFlag: z.number().int(), name: z.string().optional() }))
        .default([]),
    })
    .nullish(),
  records: z.array(z.unknown()).default([]),
});

export interface Floor {
  entity: string;
  label: string;
}

/** "Ground Floor" → ground_floor; a map without a usable name → map_<flag>. */
export function floorFor(
  flag: number | null | undefined,
  names: ReadonlyMap<number, string>,
): Floor {
  if (flag === undefined || flag === null || flag < 0)
    return { entity: NO_MAP_ENTITY, label: 'No map' };
  const name = names.get(flag)?.trim();
  const key = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name && key && isSnakeCase(key) && key !== NO_MAP_ENTITY && key !== VACUUM_ENTITY) {
    return { entity: key, label: name };
  }
  return { entity: `map_${flag}`, label: `Map ${flag + 1}` };
}

export interface ParsedSnapshot {
  readings: ReadingInput[];
  /** Records that weren't in the expected shape (left out). */
  skipped: number;
  /** Which fields those records had wrong, e.g. `duration: Invalid input` (no values). */
  problems: string[];
}

/**
 * The helper's snapshot (docker/roborock/helper.py) → readings (docs/03 § roborock).
 * Each finished run becomes `clean_minutes` and `clean_area` on its floor's entity, stamped
 * with the run's start; the battery is stamped `now` (the robot gives no time for it).
 */
export function parseRoborockSnapshot(body: unknown, now: Date): ParsedSnapshot {
  const snapshot = SnapshotSchema.parse(body);
  const names = new Map(
    (snapshot.maps?.map_info ?? []).flatMap((m) => (m.name ? [[m.mapFlag, m.name] as const] : [])),
  );

  const readings: ReadingInput[] = [];
  let skipped = 0;
  const problems = new Set<string>();
  for (const raw of snapshot.records) {
    const record = RecordSchema.safeParse(raw);
    if (!record.success) {
      skipped++;
      for (const issue of record.error.issues) {
        problems.add(`${issue.path.join('.') || 'record'}: ${issue.message}`);
      }
      continue;
    }
    const { begin, duration, area, map_flag } = record.data;
    if (duration < MIN_RUN_SECONDS) continue;
    const { entity, label } = floorFor(map_flag, names);
    const ts = new Date(begin * 1000);
    readings.push({
      metric: 'clean_minutes',
      entity,
      unit: 'min',
      valueType: 'gauge',
      ts,
      value: Math.round(duration / 6) / 10,
      label,
    });
    if (area !== undefined && area !== null) {
      readings.push({
        metric: 'clean_area',
        entity,
        unit: 'm²',
        valueType: 'gauge',
        ts,
        value: Math.round(area / 100_000) / 10,
        label,
      });
    }
  }

  const battery = snapshot.status?.battery;
  if (battery !== undefined) {
    readings.push({
      metric: 'battery',
      entity: VACUUM_ENTITY,
      unit: '%',
      valueType: 'gauge',
      ts: now,
      value: battery,
    });
  }
  return { readings, skipped, problems: [...problems] };
}
