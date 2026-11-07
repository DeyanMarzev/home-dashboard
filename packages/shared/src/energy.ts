/**
 * Energy maths for /api/summary/energy and the Energy page (docs/04, docs/05). Money is in
 * pence (integer) everywhere except the UI, which shows £ (CLAUDE.md § Units).
 */

/** UK government greenhouse gas conversion factor for natural gas, kg CO₂e per kWh (gross CV). */
export const GAS_KG_CO2_PER_KWH = 0.183;
/** Default calorific value for converting gas m³ to kWh (MJ/m³); suppliers publish the actual. */
export const DEFAULT_GAS_CALORIFIC_VALUE = 39.5;
/** Base temperature for heating degree-days (UK convention). */
export const DEGREE_DAY_BASE_C = 15.5;

/** Gas meters in m³ → kWh: m³ × 1.02264 (volume correction) × CV ÷ 3.6 (docs/03 § smart_meters). */
export function gasKwhFromM3(m3: number, calorificValue = DEFAULT_GAS_CALORIFIC_VALUE): number {
  return (m3 * 1.02264 * calorificValue) / 3.6;
}

export interface TariffRow {
  fuel: 'electricity' | 'gas' | 'water';
  unitRatePence: number;
  standingPence: number;
  validFrom: string;
  /** Inclusive; null = still current. */
  validTo: string | null;
}

/** The tariff in force for a fuel on a London date (YYYY-MM-DD), or null if none covers it. */
export function tariffOn<T extends TariffRow>(
  tariffs: readonly T[],
  fuel: TariffRow['fuel'],
  date: string,
): T | null {
  return (
    tariffs.find(
      (t) => t.fuel === fuel && t.validFrom <= date && (t.validTo === null || t.validTo >= date),
    ) ?? null
  );
}

/** Pence for a day's use: energy (kWh × unit rate) and the daily standing charge, rounded. */
export function dayCost(
  kwh: number,
  tariff: Pick<TariffRow, 'unitRatePence' | 'standingPence'>,
): { energyPence: number; standingPence: number } {
  return {
    energyPence: Math.round(kwh * tariff.unitRatePence),
    standingPence: Math.round(tariff.standingPence),
  };
}

/** Heating degree-days for a day with this average outdoor temperature. */
export function heatingDegreeDays(avgOutdoorC: number, baseC = DEGREE_DAY_BASE_C): number {
  return Math.max(0, baseC - avgOutdoorC);
}

/** Lowest half-hour of use (kWh per 30 min) as a constant draw in watts. */
export function halfHourKwhToWatts(kwh: number): number {
  return Math.round(kwh * 2 * 1000);
}

/** What a constant draw costs over a year at a unit rate, in pence. */
export function yearlyPenceForWatts(watts: number, unitRatePence: number): number {
  return Math.round((watts / 1000) * 24 * 365 * unitRatePence);
}

/** Least-squares line through (x, y) points; null with fewer than 3 points or no spread in x. */
export function linearFit(
  points: readonly (readonly [number, number])[],
): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

/** Relative change from `before` to `after` (0.02 = +2 %); null if `before` is 0. */
export function relativeChange(before: number, after: number): number | null {
  return before === 0 ? null : (after - before) / before;
}

/** Straight-line projection of a month's total from the days counted so far. */
export function projectMonth(
  soFar: number,
  daysCounted: number,
  daysInMonth: number,
): number | null {
  return daysCounted === 0 ? null : (soFar / daysCounted) * daysInMonth;
}

/** "£4.39" from pence. */
export function formatPounds(pence: number, digits = 2): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
