import type { ReadingInput } from '@home/shared';
import { z } from 'zod';

/**
 * What we ask Open-Meteo for (docs/03 § open_meteo). Times as unixtime: no zone ambiguity.
 * The time zone only sets the daily forecast's day boundaries (London days).
 */
export const OPEN_METEO_QUERY = {
  current:
    'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
  hourly:
    'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,is_day',
  daily:
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
  forecast_hours: '24',
  forecast_days: '7',
  timeformat: 'unixtime',
  timezone: 'Europe/London',
  wind_speed_unit: 'kmh',
} as const;

const ENTITY = 'outdoor';

type Kind = 'gauge' | 'state';
/** Open-Meteo field → our metric, unit and kind, with the unit Open-Meteo must answer in. */
interface Field {
  metric: string;
  unit: string;
  kind: Kind;
  expect: string;
}
const field = (metric: string, unit: string, expect: string, kind: Kind = 'gauge'): Field => ({
  metric,
  unit,
  kind,
  expect,
});

const CURRENT: Record<string, Field> = {
  temperature_2m: field('temperature', '°C', '°C'),
  relative_humidity_2m: field('humidity', '%', '%'),
  apparent_temperature: field('apparent_temperature', '°C', '°C'),
  precipitation: field('precipitation', 'mm', 'mm'),
  weather_code: field('weather_code', 'wmo', 'wmo code', 'state'),
  cloud_cover: field('cloud_cover', '%', '%'),
  pressure_msl: field('pressure', 'hPa', 'hPa'),
  wind_speed_10m: field('wind_speed', 'km/h', 'km/h'),
  wind_direction_10m: field('wind_direction', '°', '°'),
  wind_gusts_10m: field('wind_gust', 'km/h', 'km/h'),
  is_day: field('is_day', 'flag', '', 'state'),
};

// Forecasts are their own `forecast_*` metrics, so they're never mistaken for measurements
// (and freshness ignores them).
const HOURLY: Record<string, Field> = {
  temperature_2m: field('forecast_temperature', '°C', '°C'),
  precipitation_probability: field('forecast_precipitation_probability', '%', '%'),
  weather_code: field('forecast_weather_code', 'wmo', 'wmo code', 'state'),
  wind_speed_10m: field('forecast_wind_speed', 'km/h', 'km/h'),
  wind_gusts_10m: field('forecast_wind_gust', 'km/h', 'km/h'),
  is_day: field('forecast_is_day', 'flag', '', 'state'),
};

/** Each London day's forecast, stamped at that day's London midnight. */
const DAILY: Record<string, Field> = {
  weather_code: field('forecast_day_weather_code', 'wmo', 'wmo code', 'state'),
  temperature_2m_max: field('forecast_day_temperature_max', '°C', '°C'),
  temperature_2m_min: field('forecast_day_temperature_min', '°C', '°C'),
  precipitation_sum: field('forecast_day_precipitation', 'mm', 'mm'),
  precipitation_probability_max: field('forecast_day_precipitation_probability', '%', '%'),
  wind_speed_10m_max: field('forecast_day_wind_speed_max', 'km/h', 'km/h'),
  wind_gusts_10m_max: field('forecast_day_wind_gust_max', 'km/h', 'km/h'),
  // Stored as seconds after that London midnight.
  sunrise: field('forecast_day_sunrise', 's', 'unixtime'),
  sunset: field('forecast_day_sunset', 's', 'unixtime'),
};

const Column = z.array(z.number().nullable());
const ResponseSchema = z.object({
  current_units: z.record(z.string(), z.string()),
  current: z.object({ time: z.number().int() }).catchall(z.number()),
  hourly_units: z.record(z.string(), z.string()),
  hourly: z.object({ time: z.array(z.number().int()) }).catchall(Column),
  daily_units: z.record(z.string(), z.string()),
  daily: z.object({ time: z.array(z.number().int()) }).catchall(Column),
});

// The units we store; if Open-Meteo ever answers in others, fail rather than store wrong numbers.
function checkUnits(section: string, units: Record<string, string>, fields: Record<string, Field>) {
  for (const [name, f] of Object.entries(fields)) {
    if (units[name] !== f.expect)
      throw new Error(
        `Open-Meteo returned ${section} ${name} in "${units[name]}", expected "${f.expect}"`,
      );
  }
}

/** Open-Meteo forecast response → readings for entity `outdoor`. */
export function parseOpenMeteo(body: unknown): ReadingInput[] {
  const data = ResponseSchema.parse(body);
  checkUnits('current', data.current_units, CURRENT);
  checkUnits('hourly', data.hourly_units, HOURLY);
  checkUnits('daily', data.daily_units, DAILY);

  const readings: ReadingInput[] = [];
  const add = (f: Field, ts: Date, value: number) =>
    readings.push({ metric: f.metric, entity: ENTITY, unit: f.unit, valueType: f.kind, ts, value });

  const now = new Date(data.current.time * 1000);
  for (const [name, f] of Object.entries(CURRENT)) {
    const value = data.current[name];
    if (value === undefined) throw new Error(`Open-Meteo sent no current ${name}`);
    add(f, now, value);
  }

  const columns = (
    section: 'hourly' | 'daily',
    fields: Record<string, Field>,
    value: (raw: number, time: number, f: Field) => number,
  ) => {
    const block = data[section];
    for (const [name, f] of Object.entries(fields)) {
      const column = block[name];
      if (!column || column.length !== block.time.length)
        throw new Error(`Open-Meteo ${section} ${name} doesn't match its times`);
      block.time.forEach((t, i) => {
        const raw = column[i];
        if (raw !== null && raw !== undefined) add(f, new Date(t * 1000), value(raw, t, f));
      });
    }
  };
  columns('hourly', HOURLY, (v) => v);
  // Sunrise and sunset come as instants: keep them as seconds after the day's London midnight.
  columns('daily', DAILY, (v, dayStart, f) => (f.expect === 'unixtime' ? v - dayStart : v));
  return readings;
}
