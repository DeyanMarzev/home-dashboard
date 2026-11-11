/**
 * The UK Daily Air Quality Index (DAQI), as DEFRA defines it (uk-air.defra.gov.uk/air-pollution/daqi,
 * checked 2026-11-11): each pollutant's concentration, averaged over its own period, falls in a
 * band 1–10; the index is the highest band. 1–3 Low, 4–6 Moderate, 7–9 High, 10 Very High.
 */

export const DAQI_POLLUTANTS = ['o3', 'no2', 'so2', 'pm2_5', 'pm10'] as const;
export type DaqiPollutant = (typeof DAQI_POLLUTANTS)[number];

/** Upper bound (µg/m³, inclusive) of bands 1–9; anything above the last is band 10. */
const BANDS: Record<DaqiPollutant, readonly number[]> = {
  o3: [33, 66, 100, 120, 140, 160, 187, 213, 240],
  no2: [67, 134, 200, 267, 334, 400, 467, 534, 600],
  so2: [88, 177, 266, 354, 443, 532, 710, 887, 1064],
  pm2_5: [11, 23, 35, 41, 47, 53, 58, 64, 70],
  pm10: [16, 33, 50, 58, 66, 75, 83, 91, 100],
};

/**
 * Hours each pollutant is averaged over. DEFRA: ozone a running 8-hour mean, nitrogen dioxide
 * hourly, sulphur dioxide 15-minute (hourly is the finest the model gives), particles a
 * running 24-hour mean for the current day.
 */
export const DAQI_HOURS: Record<DaqiPollutant, number> = {
  o3: 8,
  no2: 1,
  so2: 1,
  pm2_5: 24,
  pm10: 24,
};

export const DAQI_POLLUTANT_NAMES: Record<DaqiPollutant, string> = {
  o3: 'Ozone',
  no2: 'Nitrogen dioxide',
  so2: 'Sulphur dioxide',
  pm2_5: 'PM2.5',
  pm10: 'PM10',
};

/** Pollutants as numbers, for the `daqi_pollutant` state series. */
export const DAQI_POLLUTANT_CODES: Record<DaqiPollutant, number> = {
  o3: 1,
  no2: 2,
  so2: 3,
  pm2_5: 4,
  pm10: 5,
};

export type DaqiLevel = 'low' | 'moderate' | 'high' | 'very_high';
export const DAQI_LABELS: Record<DaqiLevel, string> = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  very_high: 'Very high',
};

/** Band 1–10 for an averaged concentration (rounded to whole µg/m³, as the bands are). */
export function daqiBand(pollutant: DaqiPollutant, microgramsPerM3: number): number {
  const value = Math.round(microgramsPerM3);
  const i = BANDS[pollutant].findIndex((upper) => value <= upper);
  return i < 0 ? 10 : i + 1;
}

export function daqiLevel(index: number): DaqiLevel {
  return index >= 10 ? 'very_high' : index >= 7 ? 'high' : index >= 4 ? 'moderate' : 'low';
}

export function daqiPollutantFromCode(code: number): DaqiPollutant | null {
  return (
    (Object.entries(DAQI_POLLUTANT_CODES).find(([, c]) => c === code)?.[0] as DaqiPollutant) ?? null
  );
}

/** One hour of concentrations (µg/m³); null where the model has no value. */
export interface PollutantHour {
  ts: Date;
  values: Record<DaqiPollutant, number | null>;
}

export interface DaqiHour {
  ts: Date;
  index: number;
  /** The pollutant that set the index. */
  pollutant: DaqiPollutant;
}

/**
 * The DAQI for each hour that has enough history for every pollutant's averaging period
 * (hours in order, one apart). An hour is skipped if any needed value is missing.
 */
export function daqiByHour(hours: readonly PollutantHour[]): DaqiHour[] {
  const out: DaqiHour[] = [];
  hours.forEach((hour, i) => {
    let best: DaqiHour | null = null;
    for (const p of DAQI_POLLUTANTS) {
      const n = DAQI_HOURS[p];
      if (i + 1 < n) return;
      const window = hours.slice(i + 1 - n, i + 1).map((h) => h.values[p]);
      if (window.some((v) => v === null)) return;
      const mean = (window as number[]).reduce((s, v) => s + v, 0) / n;
      const band = daqiBand(p, mean);
      if (!best || band > best.index) best = { ts: hour.ts, index: band, pollutant: p };
    }
    if (best) out.push(best);
  });
  return out;
}
