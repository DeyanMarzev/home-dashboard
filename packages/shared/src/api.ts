import { z } from 'zod';
import { SOURCE_KINDS } from './registry.js';
import { VALUE_TYPES } from './readings.js';

/**
 * Request and response shapes of the REST API (docs/04-api.md), shared by the API, the web
 * app and the Android app. Requests are validated at runtime; responses are checked against
 * these schemas in the API's tests.
 */

// --- Common ------------------------------------------------------------------------------

const IsoTimestamp = z.iso.datetime({ offset: true });

export const FreshnessSchema = z.object({
  state: z.enum(['live', 'delayed', 'late']),
  dataTo: IsoTimestamp.nullable(),
  lagSeconds: z.number().int().nullable(),
  daysBehind: z.number().int().nullable(),
  label: z.string(),
  compactLabel: z.string(),
});

export const SeriesMetaSchema = z.object({
  id: z.number().int(),
  sourceId: z.string(),
  metric: z.string(),
  entity: z.string(),
  unit: z.string(),
  valueType: z.enum(VALUE_TYPES),
  /** ISO 8601 duration, e.g. `PT30M`; only for interval_total. */
  interval: z.string().optional(),
  label: z.string().optional(),
});
export type SeriesMeta = z.infer<typeof SeriesMetaSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** `1,2,3` → [1, 2, 3]. */
const IdList = z
  .string()
  .regex(/^\d+(,\d+)*$/, 'expected comma-separated series ids, e.g. 1,2,3')
  .transform((s) => [...new Set(s.split(',').map(Number))])
  .refine((ids) => ids.length <= 50, 'at most 50 series per request');

const snake = z.string().regex(/^[a-z][a-z0-9_]*$/, 'expected a snake_case key');

// --- GET /api/health ---------------------------------------------------------------------

export const HealthSchema = z.object({
  ok: z.literal(true),
  db: z.enum(['up', 'down']),
  version: z.string(),
});

// --- GET /api/sources --------------------------------------------------------------------

export const SourceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(SOURCE_KINDS),
  /** `15m`, `cron: 0 6 * * *`, or null for push sources. */
  poll: z.string().nullable(),
  pushInterval: z.string().nullable(),
  expectedDelay: z.string(),
  enabled: z.boolean(),
  freshness: FreshnessSchema,
  lastRun: z
    .object({
      startedAt: IsoTimestamp,
      finishedAt: IsoTimestamp.nullable(),
      ok: z.boolean().nullable(),
      rowsWritten: z.number().int().nullable(),
      durationMs: z.number().int().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  errors24h: z.number().int(),
});
export type SourceInfo = z.infer<typeof SourceInfoSchema>;
export const SourcesResponseSchema = z.array(SourceInfoSchema);

// --- GET /api/series ---------------------------------------------------------------------

export const SeriesQuerySchema = z.strictObject({
  source: snake.optional(),
  metric: snake.optional(),
  entity: snake.optional(),
});
export const SeriesResponseSchema = z.array(SeriesMetaSchema);

// --- GET /api/latest ---------------------------------------------------------------------

export const LatestQuerySchema = z
  .strictObject({
    series: IdList.optional(),
    source: snake.optional(),
    metric: snake.optional(),
    entity: snake.optional(),
  })
  .refine((q) => q.series || q.source || q.metric, 'give series, source or metric');

export const LatestItemSchema = z.object({
  series: SeriesMetaSchema,
  ts: IsoTimestamp.nullable(),
  value: z.number().nullable(),
  freshness: FreshnessSchema,
});
export type LatestItem = z.infer<typeof LatestItemSchema>;
export const LatestResponseSchema = z.object({
  items: z.array(LatestItemSchema),
  freshness: FreshnessSchema.nullable(),
});
export type LatestResponse = z.infer<typeof LatestResponseSchema>;

// --- GET /api/readings -------------------------------------------------------------------

export const BUCKETS = ['raw', '5m', '15m', '1h', '1d'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const AGGREGATES = ['auto', 'avg', 'sum', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/** At most this many points per series per response (docs/02 § Query rules). */
export const MAX_POINTS = 600;

export const ReadingsQuerySchema = z
  .strictObject({
    series: IdList,
    from: IsoTimestamp.optional(),
    to: IsoTimestamp.optional(),
    bucket: z.enum(BUCKETS).optional(),
    agg: z.enum(AGGREGATES).default('auto'),
    tz: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'unknown time zone')
      .default('Europe/London'),
  })
  .refine(
    (q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to),
    'from must be before to',
  );
export type ReadingsQuery = z.infer<typeof ReadingsQuerySchema>;

export const ReadingsSeriesSchema = z.object({
  meta: SeriesMetaSchema,
  /** [ISO timestamp (start of bucket), value]. */
  points: z.array(z.tuple([IsoTimestamp, z.number()])),
  freshness: FreshnessSchema,
});
export const ReadingsResponseSchema = z.object({
  from: IsoTimestamp,
  to: IsoTimestamp,
  /** The bucket actually used: coarser than requested if needed to stay within MAX_POINTS. */
  bucket: z.enum(BUCKETS),
  series: z.array(ReadingsSeriesSchema),
  freshness: FreshnessSchema.nullable(),
});
export type ReadingsResponse = z.infer<typeof ReadingsResponseSchema>;

// --- GET /api/events ---------------------------------------------------------------------

export const EVENT_LEVELS = ['info', 'warning', 'alert'] as const;

export const EventsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  level: z.enum(EVENT_LEVELS).optional(),
});

export const EventItemSchema = z.object({
  id: z.number().int(),
  ts: IsoTimestamp,
  level: z.enum(EVENT_LEVELS),
  sourceId: z.string().nullable(),
  kind: z.string(),
  message: z.string(),
  data: z.unknown(),
  resolvedAt: IsoTimestamp.nullable(),
});
export type EventItem = z.infer<typeof EventItemSchema>;
export const EventsResponseSchema = z.object({ items: z.array(EventItemSchema) });

// --- GET / PUT /api/tariffs --------------------------------------------------------------

export const FUELS = ['electricity', 'gas', 'water'] as const;
const IsoDate = z.iso.date();
/** Pence with at most 3 decimals, as stored (numeric(8,3)). */
const Pence = z
  .number()
  .min(0)
  .max(99999.999)
  .refine(
    (n) => Math.round(n * 1000) === Number((n * 1000).toFixed(6)),
    'at most 3 decimal places',
  );

export const TariffInputSchema = z
  .strictObject({
    fuel: z.enum(FUELS),
    /** Per kWh (per m³ for water). */
    unitRatePence: Pence,
    /** Per day. */
    standingPence: Pence.default(0),
    validFrom: IsoDate,
    /** Last day the rate applies (inclusive); null = still current. */
    validTo: IsoDate.nullable().default(null),
  })
  .refine(
    (t) => t.validTo === null || t.validTo >= t.validFrom,
    'validTo must not be before validFrom',
  );
export type TariffInput = z.infer<typeof TariffInputSchema>;

/** PUT replaces every tariff row. Periods of the same fuel must not overlap. */
export const TariffsPutSchema = z
  .strictObject({ items: z.array(TariffInputSchema).max(200) })
  .superRefine(({ items }, ctx) => {
    for (const fuel of FUELS) {
      const periods = items
        .map((t, index) => ({ ...t, index }))
        .filter((t) => t.fuel === fuel)
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
      for (let i = 1; i < periods.length; i++) {
        const prev = periods[i - 1]!;
        const cur = periods[i]!;
        if (prev.validTo === null || prev.validTo >= cur.validFrom) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', cur.index],
            message: `${fuel} tariff from ${cur.validFrom} overlaps the one from ${prev.validFrom}`,
          });
        }
      }
    }
  });

export const TariffSchema = z.object({
  id: z.number().int(),
  fuel: z.enum(FUELS),
  unitRatePence: z.number(),
  standingPence: z.number(),
  validFrom: IsoDate,
  validTo: IsoDate.nullable(),
});
export type Tariff = z.infer<typeof TariffSchema>;
export const TariffsResponseSchema = z.object({ items: z.array(TariffSchema) });

// --- GET /api/stream (Server-Sent Events) ------------------------------------------------

export const StreamReadingSchema = z.object({
  seriesId: z.number().int(),
  ts: IsoTimestamp,
  value: z.number(),
});
export const StreamFreshnessSchema = z.object({ sourceId: z.string(), freshness: FreshnessSchema });
export type StreamReading = z.infer<typeof StreamReadingSchema>;
export type StreamFreshness = z.infer<typeof StreamFreshnessSchema>;
