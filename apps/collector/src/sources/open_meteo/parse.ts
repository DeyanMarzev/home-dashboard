import type { ReadingInput } from '@home/shared';
import { z } from 'zod';

/** What we ask Open-Meteo for (docs/03 § open_meteo). Times as unixtime: no zone ambiguity. */
export const OPEN_METEO_QUERY = {
  current: 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
  hourly: 'temperature_2m',
  forecast_hours: '24',
  timeformat: 'unixtime',
  timezone: 'GMT',
  wind_speed_unit: 'kmh',
} as const;

// The units we store; if Open-Meteo ever answers in others, fail rather than store wrong numbers.
const EXPECTED_CURRENT_UNITS = {
  time: 'unixtime',
  temperature_2m: '°C',
  relative_humidity_2m: '%',
  precipitation: 'mm',
  weather_code: 'wmo code',
  wind_speed_10m: 'km/h',
};

const ResponseSchema = z.object({
  current_units: z.record(z.string(), z.string()),
  current: z.object({
    time: z.number().int(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    precipitation: z.number(),
    weather_code: z.number().int(),
    wind_speed_10m: z.number(),
  }),
  hourly_units: z.object({ time: z.literal('unixtime'), temperature_2m: z.literal('°C') }),
  hourly: z.object({
    time: z.array(z.number().int()),
    temperature_2m: z.array(z.number().nullable()),
  }),
});

const ENTITY = 'outdoor';

/** Open-Meteo forecast response → readings for entity `outdoor`. */
export function parseOpenMeteo(body: unknown): ReadingInput[] {
  const data = ResponseSchema.parse(body);
  for (const [field, unit] of Object.entries(EXPECTED_CURRENT_UNITS)) {
    if (data.current_units[field] !== unit) {
      throw new Error(
        `Open-Meteo returned ${field} in "${data.current_units[field]}", expected "${unit}"`,
      );
    }
  }
  if (data.hourly.time.length !== data.hourly.temperature_2m.length) {
    throw new Error('Open-Meteo hourly arrays have different lengths');
  }

  const c = data.current;
  const ts = new Date(c.time * 1000);
  const now = (
    metric: string,
    unit: string,
    value: number,
    valueType: 'gauge' | 'state' = 'gauge',
  ): ReadingInput => ({
    metric,
    entity: ENTITY,
    unit,
    valueType,
    ts,
    value,
  });

  const readings: ReadingInput[] = [
    now('temperature', '°C', c.temperature_2m),
    now('humidity', '%', c.relative_humidity_2m),
    now('precipitation', 'mm', c.precipitation),
    now('weather_code', 'wmo', c.weather_code, 'state'),
    now('wind_speed', 'km/h', c.wind_speed_10m),
  ];

  // Forecasts are stored as their own metric so they're never mistaken for measurements
  // (and `forecast_*` is ignored by freshness).
  data.hourly.time.forEach((t, i) => {
    const value = data.hourly.temperature_2m[i];
    if (value === null || value === undefined) return;
    readings.push({
      metric: 'forecast_temperature',
      entity: ENTITY,
      unit: '°C',
      valueType: 'gauge',
      ts: new Date(t * 1000),
      value,
    });
  });
  return readings;
}
