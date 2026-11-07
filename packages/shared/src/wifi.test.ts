import { describe, expect, it } from 'vitest';
import { channelOf, megabitsPerSecond, signalQuality } from './wifi.js';

describe('signalQuality', () => {
  it.each([
    [-48, 'excellent'],
    [-55, 'excellent'],
    [-58, 'good'],
    [-67, 'good'],
    [-72, 'fair'],
    [-75, 'fair'],
    [-80, 'poor'],
  ])('%i dBm → %s', (dbm, q) => {
    expect(signalQuality(dbm)).toBe(q);
  });
});

describe('channelOf', () => {
  it.each([
    [2412, { band: '2.4', channel: 1 }],
    [2437, { band: '2.4', channel: 6 }],
    [2484, { band: '2.4', channel: 14 }],
    [5180, { band: '5', channel: 36 }],
    [5180.0, { band: '5', channel: 36 }],
    [5745, { band: '5', channel: 149 }],
    [5975, { band: '6', channel: 5 }],
  ])('%s MHz → %j', (f, c) => {
    expect(channelOf(f)).toEqual(c);
  });

  it('rejects other frequencies', () => {
    expect(channelOf(900)).toBeNull();
  });
});

describe('megabitsPerSecond', () => {
  it('converts bytes and milliseconds', () => {
    expect(megabitsPerSecond(25_000_000, 2857)).toBeCloseTo(70, 0);
    expect(megabitsPerSecond(1, 0)).toBe(0);
  });
});
