import { ReadingInputSchema, type ReadingInput, type ValueType } from '@home/shared';

/** What identifies a series within a source, plus what must stay the same for it. */
export interface SeriesSpec {
  key: string; // `${metric}|${entity}`
  metric: string;
  entity: string;
  unit: string;
  valueType: ValueType;
  intervalSeconds: number | null;
  label: string | null;
}

export interface BatchRow {
  key: string;
  ts: Date;
  value: number;
}

export interface PreparedBatch {
  series: SeriesSpec[];
  rows: BatchRow[];
}

export class ReadingBatchError extends Error {
  override name = 'ReadingBatchError';
}

export const seriesKey = (metric: string, entity: string) => `${metric}|${entity}`;

/**
 * Validates collector output and shapes it for the database: one spec per series, and one row
 * per (series, ts), keeping the last value when a batch repeats a timestamp (an upsert can't
 * touch the same row twice in one statement). Throws on the first invalid reading, with its
 * index, so a broken parser is caught rather than half-written.
 */
export function prepareBatch(inputs: readonly ReadingInput[]): PreparedBatch {
  const series = new Map<string, SeriesSpec>();
  const rows = new Map<string, BatchRow>();

  inputs.forEach((input, index) => {
    const parsed = ReadingInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ReadingBatchError(`Reading ${index} is invalid: ${issues}`);
    }
    const r = parsed.data;
    const key = seriesKey(r.metric, r.entity);
    const spec: SeriesSpec = {
      key,
      metric: r.metric,
      entity: r.entity,
      unit: r.unit,
      valueType: r.valueType,
      intervalSeconds: r.interval ?? null,
      label: r.label ?? null,
    };

    const known = series.get(key);
    if (!known) series.set(key, spec);
    else {
      const conflict = specConflict(known, spec);
      if (conflict) throw new ReadingBatchError(`Reading ${index} (${key}): ${conflict}`);
    }

    rows.set(`${key}@${r.ts.getTime()}`, { key, ts: r.ts, value: r.value });
  });

  return { series: [...series.values()], rows: [...rows.values()] };
}

/** Describes why `next` can't be written to the series `existing`, or null if it can. */
export function specConflict(
  existing: Pick<SeriesSpec, 'unit' | 'valueType' | 'intervalSeconds'>,
  next: Pick<SeriesSpec, 'unit' | 'valueType' | 'intervalSeconds'>,
): string | null {
  if (existing.unit !== next.unit) return `unit ${next.unit} ≠ series unit ${existing.unit}`;
  if (existing.valueType !== next.valueType) {
    return `value type ${next.valueType} ≠ series value type ${existing.valueType}`;
  }
  if (existing.intervalSeconds !== next.intervalSeconds) {
    return `interval ${next.intervalSeconds}s ≠ series interval ${existing.intervalSeconds}s`;
  }
  return null;
}

/** The newest row of each series in the batch (for NOTIFY). */
export function latestPerSeries(rows: readonly BatchRow[]): BatchRow[] {
  const latest = new Map<string, BatchRow>();
  for (const row of rows) {
    const current = latest.get(row.key);
    if (!current || row.ts > current.ts) latest.set(row.key, row);
  }
  return [...latest.values()];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
