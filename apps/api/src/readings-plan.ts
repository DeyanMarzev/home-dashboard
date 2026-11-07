import { MAX_POINTS, type Aggregate, type Bucket, type ValueType } from '@home/shared';

/** Coarser and coarser buckets, tried in order until a range fits in MAX_POINTS. */
const LADDER = ['5m', '15m', '1h', '1d'] as const;
export type FixedBucket = (typeof LADDER)[number];

export const BUCKET_SECONDS: Record<FixedBucket, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};

/** Raw readings only for ranges up to 48 h (docs/02 § Query rules). */
export const RAW_MAX_RANGE_SECONDS = 48 * 3600;
/** Without a bucket, ranges up to 2 h come back raw. */
const DEFAULT_RAW_RANGE_SECONDS = 2 * 3600;
/** The longest range: MAX_POINTS daily buckets. */
export const MAX_RANGE_SECONDS = MAX_POINTS * 86400;

const fits = (bucket: Bucket, rangeSeconds: number) =>
  bucket === 'raw'
    ? rangeSeconds <= RAW_MAX_RANGE_SECONDS
    : rangeSeconds / BUCKET_SECONDS[bucket] <= MAX_POINTS;

/** The finest ladder bucket, at or after `from`, that keeps the range within MAX_POINTS. */
export function smallestFitting(rangeSeconds: number, from: FixedBucket = '5m'): FixedBucket {
  return LADDER.slice(LADDER.indexOf(from)).find((b) => fits(b, rangeSeconds)) ?? '1d';
}

/**
 * The bucket to use: the requested one if the range fits it, otherwise the next coarser one
 * that does. Without a request: raw up to 2 h, then the finest bucket that fits.
 * (A raw result can still turn out too dense; the handler then coarsens with smallestFitting.)
 */
export function chooseBucket(requested: Bucket | undefined, rangeSeconds: number): Bucket {
  if (requested === undefined)
    return rangeSeconds <= DEFAULT_RAW_RANGE_SECONDS ? 'raw' : smallestFitting(rangeSeconds);
  if (fits(requested, rangeSeconds)) return requested;
  return smallestFitting(rangeSeconds, requested === 'raw' ? '5m' : requested);
}

/**
 * `auto` sums interval totals (kWh per half-hour → kWh per day) and averages everything else.
 * States average to the share of time in state 1 when sampled evenly (e.g. boiler on 0/1);
 * exact time-weighting comes with the heating summary (M6).
 */
export function chooseAggregate(agg: Aggregate, valueType: ValueType): Exclude<Aggregate, 'auto'> {
  if (agg !== 'auto') return agg;
  return valueType === 'interval_total' ? 'sum' : 'avg';
}
