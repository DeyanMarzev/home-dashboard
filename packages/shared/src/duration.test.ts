import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, toIsoDuration } from './duration.js';

describe('parseDuration', () => {
  it.each([
    ['0s', 0],
    ['30s', 30],
    ['15m', 900],
    ['6h', 21600],
    ['1d', 86400],
    [' 2m ', 120],
  ])('%j → %i s', (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });

  it.each(['', '15', 'm', '1.5h', '-1m', '1w', '1 h', '1h30m'])('rejects %j', (text) => {
    expect(() => parseDuration(text)).toThrow(/Invalid duration/);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [30, '30s'],
    [90, '90s'],
    [900, '15m'],
    [5400, '90m'],
    [21600, '6h'],
    [86400, '1d'],
    [3 * 86400, '3d'],
  ])('%i s → %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
    expect(parseDuration(text)).toBe(seconds);
  });
});

describe('toIsoDuration', () => {
  it.each([
    [0, 'PT0S'],
    [30, 'PT30S'],
    [1800, 'PT30M'],
    [3600, 'PT1H'],
    [5430, 'PT1H30M30S'],
    [86400, 'P1D'],
    [90000, 'P1DT1H'],
  ])('%i s → %s', (seconds, iso) => {
    expect(toIsoDuration(seconds)).toBe(iso);
  });
});
