import { describe, expect, it } from 'vitest';
import { co2Level, dewPoint, mouldRisk, pressureTrend, roomAdvice } from './comfort.js';

describe('dewPoint', () => {
  it.each([
    [20.6, 53, 10.7], // the mockup's living room
    [21.3, 61, 13.5], // the mockup's kitchen
    [20, 100, 20],
    [0, 50, -9.2],
  ])('%s °C at %s %% → %s °C', (t, rh, dp) => {
    expect(dewPoint(t, rh)).toBeCloseTo(dp, 1);
  });

  it('is always at or below the air temperature', () => {
    for (const rh of [10, 40, 70, 99]) expect(dewPoint(18, rh)).toBeLessThanOrEqual(18);
  });
});

describe('co2Level', () => {
  it.each([
    [450, 'good'],
    [799, 'good'],
    [800, 'fair'],
    [999, 'fair'],
    [1000, 'high'],
    [1240, 'high'],
    [1500, 'very_high'],
  ])('%i ppm → %s', (ppm, level) => {
    expect(co2Level(ppm)).toBe(level);
  });
});

describe('mouldRisk', () => {
  it('is low for a warm, moderately humid room', () => {
    expect(
      mouldRisk({ minTemperatureC: 17.8, avgTemperatureC: 19.5, avgHumidityPercent: 54 }).risk,
    ).toBe('low');
  });

  it('is watch when humidity is 60 % or more', () => {
    expect(
      mouldRisk({ minTemperatureC: 18.1, avgTemperatureC: 20, avgHumidityPercent: 60 }).risk,
    ).toBe('watch');
  });

  it('is watch when the coldest temperature gets within 5 °C of the dew point', () => {
    // avg 16 °C, 55 % → dew point ≈ 7.0 °C; coldest 11 °C → margin ≈ 4.0 °C
    const r = mouldRisk({ minTemperatureC: 11, avgTemperatureC: 16, avgHumidityPercent: 55 });
    expect(r.marginC).toBeCloseTo(4.0, 1);
    expect(r.risk).toBe('watch');
  });

  it('is high at 70 % humidity or a margin under 3 °C', () => {
    expect(
      mouldRisk({ minTemperatureC: 19, avgTemperatureC: 20, avgHumidityPercent: 72 }).risk,
    ).toBe('high');
    expect(
      mouldRisk({ minTemperatureC: 9, avgTemperatureC: 16, avgHumidityPercent: 55 }).risk,
    ).toBe('high');
  });
});

describe('pressureTrend', () => {
  it('reads a fall of 1.5 hPa or more as falling', () => {
    expect(pressureTrend(1014, 1012, 3)).toEqual({
      changeHpa: -2,
      direction: 'falling',
      label: 'Falling 2 hPa in 3 h · rain likely',
    });
  });

  it('reads a rise as rising', () => {
    expect(pressureTrend(1008.2, 1010.4, 3)).toMatchObject({
      direction: 'rising',
      label: 'Rising 2.2 hPa in 3 h · settling',
    });
  });

  it('calls small changes steady', () => {
    expect(pressureTrend(1012, 1012.9, 3)).toMatchObject({
      direction: 'steady',
      label: 'Steady over 3 h',
    });
  });
});

describe('roomAdvice', () => {
  const calm = {
    co2NowPpm: 640,
    co2SecondsAbove: 0,
    humidityNowPercent: 53,
    mould: 'low' as const,
  };
  it('says comfortable when nothing is wrong', () => {
    expect(roomAdvice(calm)).toEqual({ tone: 'good', text: 'Comfortable' });
  });
  it('puts high CO₂ now first', () => {
    expect(roomAdvice({ ...calm, co2NowPpm: 1240, mould: 'high' }).text).toBe(
      'CO₂ is high now · open a window',
    );
    expect(roomAdvice({ ...calm, co2NowPpm: 1600 }).text).toBe(
      'CO₂ is very high now · open a window',
    );
  });
  it('reports long periods above 1,000 ppm, in half hours', () => {
    expect(roomAdvice({ ...calm, co2SecondsAbove: 7 * 3600 }).text).toBe(
      'Above 1,000 ppm CO₂ for 7 h · ventilate more',
    );
    expect(roomAdvice({ ...calm, co2SecondsAbove: 5400 }).text).toBe(
      'Above 1,000 ppm CO₂ for 1.5 h · ventilate more',
    );
  });
  it('flags humidity and mould risk', () => {
    expect(roomAdvice({ ...calm, humidityNowPercent: 68 }).tone).toBe('warn');
    expect(roomAdvice({ ...calm, mould: 'watch' }).tone).toBe('warn');
  });
  it('copes with a room without CO₂ or humidity sensors', () => {
    expect(
      roomAdvice({ co2NowPpm: null, co2SecondsAbove: null, humidityNowPercent: null, mould: null })
        .tone,
    ).toBe('good');
  });
});
