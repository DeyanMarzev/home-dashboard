/**
 * Indoor comfort rules shown on Overview and Rooms (docs/05). Thresholds are rules of thumb,
 * kept here in one place so they can be tuned.
 */

/** Dew point (°C) from temperature (°C) and relative humidity (%), Magnus formula. */
export function dewPoint(temperatureC: number, humidityPercent: number): number {
  const a = 17.62;
  const b = 243.12;
  const gamma =
    Math.log(Math.max(humidityPercent, 0.1) / 100) + (a * temperatureC) / (b + temperatureC);
  return (b * gamma) / (a - gamma);
}

export type Co2Level = 'good' | 'fair' | 'high' | 'very_high';

/** The line drawn on CO₂ charts and used for "time above". */
export const CO2_THRESHOLD_PPM = 1000;

/** < 800 good, < 1000 fair, < 1500 high (ventilate), otherwise very high. */
export function co2Level(ppm: number): Co2Level {
  if (ppm < 800) return 'good';
  if (ppm < CO2_THRESHOLD_PPM) return 'fair';
  if (ppm < 1500) return 'high';
  return 'very_high';
}

export const CO2_LABELS: Record<Co2Level, string> = {
  good: 'Good',
  fair: 'Fair',
  high: 'High',
  very_high: 'Very high',
};

export type MouldRisk = 'low' | 'watch' | 'high';

export interface MouldRiskInput {
  /** Lowest temperature in the period (the coldest the room's surfaces get, roughly). */
  minTemperatureC: number;
  avgTemperatureC: number;
  avgHumidityPercent: number;
}

/**
 * Mould risk combines humidity and how cold the room gets: the closer the coldest temperature
 * comes to the dew point of the room's air, the more condensation on cold walls and windows.
 * high: humidity ≥ 70 % or < 3 °C margin · watch: ≥ 60 % or < 5 °C margin · otherwise low.
 */
export function mouldRisk(i: MouldRiskInput): { risk: MouldRisk; marginC: number } {
  const marginC = i.minTemperatureC - dewPoint(i.avgTemperatureC, i.avgHumidityPercent);
  const risk: MouldRisk =
    i.avgHumidityPercent >= 70 || marginC < 3
      ? 'high'
      : i.avgHumidityPercent >= 60 || marginC < 5
        ? 'watch'
        : 'low';
  return { risk, marginC };
}

export const MOULD_LABELS: Record<MouldRisk, string> = { low: 'Low', watch: 'Watch', high: 'High' };

export interface PressureTrend {
  changeHpa: number;
  direction: 'falling' | 'rising' | 'steady';
  label: string;
}

/** Change over the period (usually 3 h); ±1.5 hPa or more is a meaningful trend. */
export function pressureTrend(oldest: number, newest: number, hours: number): PressureTrend {
  const changeHpa = Math.round((newest - oldest) * 10) / 10;
  const amount = `${Math.abs(changeHpa).toLocaleString('en-GB', { maximumFractionDigits: 1 })} hPa in ${hours} h`;
  if (changeHpa <= -1.5)
    return { changeHpa, direction: 'falling', label: `Falling ${amount} · rain likely` };
  if (changeHpa >= 1.5)
    return { changeHpa, direction: 'rising', label: `Rising ${amount} · settling` };
  return { changeHpa, direction: 'steady', label: `Steady over ${hours} h` };
}

export interface RoomAdviceInput {
  co2NowPpm: number | null;
  /** Time above CO2_THRESHOLD_PPM in the period, seconds. */
  co2SecondsAbove: number | null;
  humidityNowPercent: number | null;
  mould: MouldRisk | null;
}

/** One line of advice for a room card, worst problem first (docs/05 § Rooms). */
export function roomAdvice(i: RoomAdviceInput): { tone: 'good' | 'warn'; text: string } {
  if (i.co2NowPpm !== null && i.co2NowPpm >= CO2_THRESHOLD_PPM) {
    return {
      tone: 'warn',
      text: `CO₂ is ${co2Level(i.co2NowPpm) === 'very_high' ? 'very high' : 'high'} now · open a window`,
    };
  }
  if (i.mould === 'high')
    return { tone: 'warn', text: 'Mould risk high · ventilate and keep it warmer' };
  if (i.co2SecondsAbove !== null && i.co2SecondsAbove >= 3600) {
    const hours = Math.round(i.co2SecondsAbove / 1800) / 2;
    return { tone: 'warn', text: `Above 1,000 ppm CO₂ for ${hours} h · ventilate more` };
  }
  if (i.humidityNowPercent !== null && i.humidityNowPercent >= 65)
    return { tone: 'warn', text: 'Humid · ventilate after cooking and showers' };
  if (i.mould === 'watch')
    return { tone: 'warn', text: 'Mould risk worth watching · coldest spots near dew point' };
  return { tone: 'good', text: 'Comfortable' };
}
