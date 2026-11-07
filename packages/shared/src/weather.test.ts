import { describe, expect, it } from 'vitest';
import { describeWeather } from './weather.js';

describe('describeWeather', () => {
  it('describes known WMO codes and falls back for unknown ones', () => {
    expect(describeWeather(3)).toBe('Overcast');
    expect(describeWeather(61)).toBe('Light rain');
    expect(describeWeather(42)).toBe('Weather code 42');
  });
});
