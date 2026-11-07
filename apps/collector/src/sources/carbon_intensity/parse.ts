import { INTENSITY_INDEX, isSnakeCase, type ReadingInput } from '@home/shared';
import { z } from 'zod';

// Timestamps look like "2026-11-07T11:30Z" (no seconds): valid ISO 8601, UTC.
const Timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/,
    'expected a UTC timestamp like 2026-11-07T11:30Z',
  )
  .transform((s) => new Date(s));

const Period = z.object({
  from: Timestamp,
  to: Timestamp,
  intensity: z.object({ forecast: z.number(), index: z.enum(INTENSITY_INDEX) }),
  generationmix: z.array(z.object({ fuel: z.string(), perc: z.number() })).optional(),
});

const Region = z.object({ regionid: z.number(), shortname: z.string(), data: z.array(Period) });

/** GET /regional/postcode/{outcode}: `data` is a list with one region. */
const CurrentSchema = z.object({ data: z.array(Region).min(1) });
/** GET /regional/intensity/{from}/fw48h/postcode/{outcode}: `data` is the region itself. */
const ForecastSchema = z.object({ data: Region });

const GRID = 'grid';
const UNIT = 'gCO₂/kWh';

/**
 * The current half-hour for the home's region: intensity, its index band, and the
 * generation mix (one `generation_share` series per fuel). Regional values are forecasts
 * by nature (NESO publishes no regional actuals); this is the best estimate for "now".
 */
export function parseCurrent(body: unknown): ReadingInput[] {
  const region = CurrentSchema.parse(body).data[0]!;
  const period = region.data[0];
  if (!period)
    throw new Error(`Carbon Intensity returned no current period for ${region.shortname}`);

  const ts = period.from;
  const readings: ReadingInput[] = [
    {
      metric: 'intensity',
      entity: GRID,
      unit: UNIT,
      valueType: 'gauge',
      ts,
      value: period.intensity.forecast,
    },
    {
      metric: 'intensity_index',
      entity: GRID,
      unit: 'index',
      valueType: 'state',
      ts,
      value: INTENSITY_INDEX.indexOf(period.intensity.index),
      label: `0 = ${INTENSITY_INDEX[0]} … 4 = ${INTENSITY_INDEX[4]}`,
    },
  ];
  for (const { fuel, perc } of period.generationmix ?? []) {
    if (!isSnakeCase(fuel)) throw new Error(`Unexpected fuel name "${fuel}"`);
    readings.push({
      metric: 'generation_share',
      entity: fuel,
      unit: '%',
      valueType: 'gauge',
      ts,
      value: perc,
    });
  }
  return readings;
}

/** The next 48 h, half-hourly, as `forecast_intensity` (for "greenest window"). */
export function parseForecast(body: unknown): ReadingInput[] {
  return ForecastSchema.parse(body).data.data.map((p) => ({
    metric: 'forecast_intensity',
    entity: GRID,
    unit: UNIT,
    valueType: 'gauge' as const,
    ts: p.from,
    value: p.intensity.forecast,
  }));
}
