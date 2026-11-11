import { describe, expect, it } from 'vitest';
import { compassPoint, describeWeather, weatherKind } from './weather.js';

describe('describeWeather', () => {
  it('describes known WMO codes and falls back for unknown ones', () => {
    expect(describeWeather(3)).toBe('Overcast');
    expect(describeWeather(61)).toBe('Light rain');
    expect(describeWeather(42)).toBe('Weather code 42');
  });
});

describe('weatherKind', () => {
  it.each([
    [0, 'clear'],
    [1, 'clear'],
    [2, 'partly_cloudy'],
    [3, 'cloudy'],
    [45, 'fog'],
    [53, 'drizzle'],
    [63, 'rain'],
    [81, 'rain'],
    [73, 'snow'],
    [86, 'snow'],
    [95, 'thunder'],
    [42, 'cloudy'],
  ] as const)('%s → %s', (code, kind) => {
    expect(weatherKind(code)).toBe(kind);
  });
});

describe('compassPoint', () => {
  it.each([
    [0, 'N'],
    [22, 'NNE'],
    [90, 'E'],
    [200, 'SSW'],
    [349, 'N'],
    [360, 'N'],
    [-90, 'W'],
  ] as const)('%s° → %s', (deg, point) => {
    expect(compassPoint(deg)).toBe(point);
  });
});
