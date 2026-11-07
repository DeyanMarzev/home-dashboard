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
  intervalSeconds: z.number().int().nullable(),
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
  description: z.string().nullable(),
  kind: z.enum(SOURCE_KINDS),
  /** `15m`, `cron: 0 6 * * *`, or null for push sources. */
  poll: z.string().nullable(),
  pushInterval: z.string().nullable(),
  expectedDelay: z.string(),
  enabled: z.boolean(),
  /** What freshness is computed from, so clients can re-tick badges (`retick`). */
  policy: z.object({
    expectedDelaySeconds: z.number().int(),
    cadenceSeconds: z.number().int().nullable(),
    graceSeconds: z.number().int().nullable(),
  }),
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
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
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

// --- GET /api/summary/heating ------------------------------------------------------------

export const HeatingSummaryQuerySchema = z.strictObject({
  /** London calendar date; default today. */
  date: IsoDate.optional(),
});

const RunSchema = z.object({ from: IsoTimestamp, to: IsoTimestamp });

export const HeatingSummarySchema = z.object({
  date: IsoDate,
  boiler: z.object({
    /** Whether the Nest reports heating right now (null when the date isn't today or no data). */
    heatingNow: z.boolean().nullable(),
    minutesOn: z.number().int(),
    cycles: z.number().int(),
    shortCycles: z.number().int(),
    /** When the boiler fired during the day (also the "boiler firing" chart bands). */
    runs: z.array(RunSchema),
  }),
  /** Share (0–1) of firing time with the return below 55 °C; null without boiler probes. */
  condensingShare: z.number().nullable(),
  flowPeakC: z.number().nullable(),
  warmUp: z
    .object({
      ratePerHour: z.number(),
      longest: z.object({
        from: IsoTimestamp,
        to: IsoTimestamp,
        startC: z.number(),
        endC: z.number(),
      }),
    })
    .nullable(),
  /** The 7 days ending `date`, oldest first. */
  days: z.array(z.object({ date: IsoDate, minutesOn: z.number().int(), cycles: z.number().int() })),
  /** The Nest's target temperature during the day: [time, °C], as observed (SDM exposes no schedule). */
  setpoints: z.array(z.tuple([IsoTimestamp, z.number()])),
  tips: z.array(z.object({ title: z.string(), detail: z.string() })),
  freshness: FreshnessSchema.nullable(),
});
export type HeatingSummary = z.infer<typeof HeatingSummarySchema>;

// --- GET /api/summary/energy -------------------------------------------------------------

export const EnergySummaryQuerySchema = z
  .strictObject({
    /** London calendar dates, inclusive. Default: the 14 days ending the latest day with data. */
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    /** Without `from`: how many days ending `to` (default 14). */
    days: z.coerce.number().int().min(1).max(400).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'from must not be after to')
  .refine(
    (q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 400 * 86400_000,
    'at most 400 days',
  );

const FuelDaySchema = z.object({
  kwh: z.number(),
  /** kWh × unit rate; null without a tariff for that day. */
  energyPence: z.number().int().nullable(),
  standingPence: z.number().int().nullable(),
});

export const EnergyDaySchema = z.object({
  date: IsoDate,
  /** Null when the meter sent nothing for that fuel that day. */
  electricity: FuelDaySchema.nullable(),
  gas: FuelDaySchema.nullable(),
  /** Every half-hour present for both fuels (46/48/50 on clock-change days). */
  complete: z.boolean(),
  /** Average outdoor temperature (Open-Meteo), and heating degree-days from it. */
  outdoorC: z.number().nullable(),
  degreeDays: z.number().nullable(),
});
export type EnergyDay = z.infer<typeof EnergyDaySchema>;

export const EnergySummarySchema = z.object({
  from: IsoDate,
  to: IsoDate,
  /** The newest day with complete data, if any. */
  latestDay: IsoDate.nullable(),
  days: z.array(EnergyDaySchema),
  /** The month of `to`, from its 1st to `to`. */
  month: z.object({
    from: IsoDate,
    to: IsoDate,
    costPence: z.number().int(),
    /** Straight-line projection for the whole month, including standing charges. */
    projectedPence: z.number().int().nullable(),
  }),
  /** Lowest half-hour of electricity overnight (00:00–05:00) on `latestDay`, as watts. */
  baseload: z
    .object({
      watts: z.number().int(),
      night: IsoDate,
      yearlyPence: z.number().int().nullable(),
      /** The same measure 28 days earlier, for "up from 142 W a month ago". */
      previousWatts: z.number().int().nullable(),
    })
    .nullable(),
  carbon: z.object({
    /** kWh × the grid's recorded half-hourly intensity; null if fewer than 90 % of half-hours have one. */
    electricityKg: z.number().nullable(),
    gasKg: z.number().nullable(),
  }),
  freshness: FreshnessSchema.nullable(),
});
export type EnergySummary = z.infer<typeof EnergySummarySchema>;

// --- GET /api/summary/water --------------------------------------------------------------

export const WaterSummaryQuerySchema = z
  .strictObject({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    /** Without `from`: how many days ending `to` (default 28). */
    days: z.coerce.number().int().min(1).max(400).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'from must not be after to');

export const WaterSummarySchema = z.object({
  from: IsoDate,
  to: IsoDate,
  /** The newest day with every hour present. */
  latestDay: IsoDate.nullable(),
  days: z.array(
    z.object({
      date: IsoDate,
      litres: z.number().nullable(),
      /** With a `water` tariff: litres priced per m³ plus the standing charge. */
      costPence: z.number().int().nullable(),
      complete: z.boolean(),
    }),
  ),
  /** Litres per hour on `latestDay`: [start of hour, litres]. */
  hourly: z.array(z.tuple([IsoTimestamp, z.number()])),
  nights: z.array(z.object({ night: IsoDate, minLitres: z.number(), complete: z.boolean() })),
  leak: z.object({
    state: z.enum(['ok', 'watch', 'leak', 'unknown']),
    consecutive: z.number().int(),
    nightsChecked: z.number().int(),
  }),
  /** The meter's own cumulative reading, when the provider reports one. */
  meterReadingM3: z.number().nullable(),
  freshness: FreshnessSchema.nullable(),
});
export type WaterSummary = z.infer<typeof WaterSummarySchema>;
