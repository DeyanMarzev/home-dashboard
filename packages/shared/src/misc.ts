import { z } from 'zod';

/**
 * The Misc page's settings (config/misc.yaml, docs/05 § Misc): things that are a schedule, not
 * readings from a source. The API serves the file as it is on each request (GET /api/misc).
 */

const LondonDate = z.iso.date(); // YYYY-MM-DD

export const BinSchema = z.strictObject({
  name: z.string().trim().min(1),
  /** Drawn in this colour; known: green, black, brown, blue, grey, purple. */
  colour: z.string().regex(/^[a-z]+$/, 'colour must be a lowercase word, e.g. green'),
  every_weeks: z.number().int().min(1).max(8),
  /** Any one collection date (past or future): the rest follow every `every_weeks` weeks. */
  collected_on: LondonDate,
});

export const MiscFileSchema = z.strictObject({
  bins: z.array(BinSchema).default([]),
});
export type MiscFile = z.infer<typeof MiscFileSchema>;

export interface Bin {
  name: string;
  colour: string;
  everyWeeks: number;
  collectedOn: string;
}

export const MiscResponseSchema = z.object({
  bins: z.array(
    z.object({
      name: z.string(),
      colour: z.string(),
      everyWeeks: z.number().int(),
      collectedOn: LondonDate,
    }),
  ),
});
export type MiscResponse = z.infer<typeof MiscResponseSchema>;

export function toMiscResponse(file: MiscFile): MiscResponse {
  return {
    bins: file.bins.map((b) => ({
      name: b.name,
      colour: b.colour,
      everyWeeks: b.every_weeks,
      collectedOn: b.collected_on,
    })),
  };
}

const DAY = 86_400_000;
/** Calendar dates as day numbers (noon UTC avoids any clock-change edge). */
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / DAY);
const fromDayNumber = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

export interface Collection {
  /** London date, YYYY-MM-DD. */
  date: string;
  bins: Bin[];
}

/**
 * Collection days from `today` (inclusive) for the next `days` days, each with the bins that
 * go out, in date order. A bin's dates are `collectedOn` ± whole multiples of its period.
 */
export function upcomingCollections(bins: readonly Bin[], today: string, days = 42): Collection[] {
  const start = dayNumber(today);
  const end = start + days;
  const byDay = new Map<number, Bin[]>();
  for (const bin of bins) {
    const period = bin.everyWeeks * 7;
    const anchor = dayNumber(bin.collectedOn);
    const offset = (((start - anchor) % period) + period) % period;
    for (let d = offset === 0 ? start : start + period - offset; d < end; d += period) {
      byDay.set(d, [...(byDay.get(d) ?? []), bin]);
    }
  }
  return [...byDay]
    .sort(([a], [b]) => a - b)
    .map(([d, list]) => ({ date: fromDayNumber(d), bins: list }));
}
