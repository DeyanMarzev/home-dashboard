import {
  DAQI_POLLUTANT_CODES,
  DAQI_POLLUTANTS,
  daqiByHour,
  type DaqiPollutant,
  type PollutantHour,
  type ReadingInput,
} from '@home/shared';
import { z } from 'zod';

/** Open-Meteo air quality (CAMS European model), docs/03 § air_quality. */
const VARIABLES: Record<DaqiPollutant, string> = {
  o3: 'ozone',
  no2: 'nitrogen_dioxide',
  so2: 'sulphur_dioxide',
  pm2_5: 'pm2_5',
  pm10: 'pm10',
};
const FIELDS = Object.values(VARIABLES).join(',');

/** A day back for the 24-hour particle means, two ahead for the forecast. */
export const AIR_QUALITY_QUERY = {
  current: FIELDS,
  hourly: FIELDS,
  past_days: '1',
  forecast_days: '2',
  timeformat: 'unixtime',
  timezone: 'GMT',
} as const;

const Series = z.array(z.number().nullable());
const ResponseSchema = z.object({
  current: z.object({ time: z.number().int() }).loose(),
  hourly_units: z.record(z.string(), z.string()),
  hourly: z.object({ time: z.array(z.number().int()) }).catchall(Series),
});

/** "µg/m³" with either micro sign (Open-Meteo sends the Greek mu). */
const isMicrograms = (unit: string | undefined) => unit === 'µg/m³' || unit === 'μg/m³';

/**
 * Hourly concentrations up to now as `<pollutant>` (µg/m³), the DAQI for each hour with enough
 * history as `daqi` (with `daqi_pollutant`, the one that set it), and the hours after now as
 * `forecast_daqi`. Entity `outdoor`.
 */
export function parseAirQuality(body: unknown): ReadingInput[] {
  const data = ResponseSchema.parse(body);
  for (const variable of Object.values(VARIABLES)) {
    if (!isMicrograms(data.hourly_units[variable]))
      throw new Error(
        `Open-Meteo returned ${variable} in "${data.hourly_units[variable]}", expected µg/m³`,
      );
  }
  const now = data.current.time;
  const hours: PollutantHour[] = data.hourly.time.map((t, i) => ({
    ts: new Date(t * 1000),
    values: Object.fromEntries(
      DAQI_POLLUTANTS.map((p) => {
        const column = data.hourly[VARIABLES[p]];
        if (!column || column.length !== data.hourly.time.length)
          throw new Error(`Open-Meteo hourly ${VARIABLES[p]} doesn't match its times`);
        return [p, column[i] ?? null];
      }),
    ) as PollutantHour['values'],
  }));

  const readings: ReadingInput[] = [];
  const add = (
    metric: string,
    unit: string,
    ts: Date,
    value: number,
    valueType: 'gauge' | 'state',
  ) => readings.push({ metric, entity: 'outdoor', unit, valueType, ts, value });

  for (const h of hours) {
    if (h.ts.getTime() / 1000 > now) continue; // forecast hours only feed the forecast index
    for (const p of DAQI_POLLUTANTS) {
      const v = h.values[p];
      if (v !== null) add(p, 'µg/m³', h.ts, v, 'gauge');
    }
  }
  for (const d of daqiByHour(hours)) {
    if (d.ts.getTime() / 1000 <= now) {
      add('daqi', 'index', d.ts, d.index, 'state');
      add('daqi_pollutant', 'code', d.ts, DAQI_POLLUTANT_CODES[d.pollutant], 'state');
    } else {
      add('forecast_daqi', 'index', d.ts, d.index, 'state');
    }
  }
  return readings;
}
