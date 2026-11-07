import { z } from 'zod';
import { DURATION_PATTERN, parseDuration } from './duration.js';
import { SNAKE_CASE } from './ids.js';

export const VALUE_TYPES = ['gauge', 'interval_total', 'state'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** What a collector's parser returns (docs/03 § Adding a new source). */
export interface ReadingInput {
  metric: string;
  /** Room or device, snake_case. Empty for source-wide series. */
  entity?: string;
  unit: string;
  valueType: ValueType;
  /** Required for interval_total: the interval each value covers, e.g. `30m`. */
  interval?: string;
  /** The time the value is FOR (start of the interval for interval_total). Must carry a zone. */
  ts: Date | string;
  value: number;
  /** Optional display name for the series. */
  label?: string;
}

export const ReadingInputSchema = z
  .strictObject({
    metric: z.string().regex(SNAKE_CASE, 'metric must be snake_case'),
    entity: z
      .string()
      .refine((e) => e === '' || SNAKE_CASE.test(e), 'entity must be snake_case')
      .default(''),
    unit: z.string().min(1),
    valueType: z.enum(VALUE_TYPES),
    interval: z
      .string()
      .regex(DURATION_PATTERN, 'interval must be a duration like 30m')
      .transform(parseDuration)
      .optional(),
    // A timestamp without a zone is ambiguous (CLAUDE.md rule 4), so it's rejected.
    ts: z.union([z.date(), z.iso.datetime({ offset: true })]).transform((v) => new Date(v)),
    value: z.number().finite(),
    label: z.string().min(1).optional(),
  })
  .superRefine((r, ctx) => {
    // Refinements still run when a field failed; skip checks that depend on it.
    if (r.ts instanceof Date && Number.isNaN(r.ts.getTime())) {
      ctx.addIssue({ code: 'custom', path: ['ts'], message: 'invalid date' });
    }
    if (r.valueType === 'interval_total' && !r.interval) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval'],
        message: 'interval_total needs interval',
      });
    }
    if (r.valueType !== 'interval_total' && r.interval !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['interval'],
        message: 'only interval_total has interval',
      });
    }
  });

/** A validated reading: entity defaulted, ts a Date, interval in seconds. */
export type Reading = z.output<typeof ReadingInputSchema>;
