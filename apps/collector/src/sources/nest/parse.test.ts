import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NestOfflineError, parseNestDevices, roomKey } from './parse.js';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
const ts = new Date('2026-11-06T13:40:00Z');

describe('parseNestDevices', () => {
  it('reads a heating thermostat (entity from its room name)', () => {
    const readings = parseNestDevices(load('devices-heating.json'), ts);
    expect(readings.map((r) => [r.metric, r.entity, r.value])).toEqual([
      ['temperature', 'hallway', 20.38],
      ['humidity', 'hallway', 55],
      ['target_temperature', 'hallway', 20.5],
      ['hvac_heating', 'boiler', 1],
      ['thermostat_mode', 'hallway', 1],
      ['eco_mode', 'hallway', 0],
    ]);
    expect(readings.every((r) => r.ts === ts)).toBe(true);
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('has no target while eco is on, and an idle boiler', () => {
    const readings = parseNestDevices(load('devices-eco.json'), ts);
    expect(readings.find((r) => r.metric === 'target_temperature')).toBeUndefined();
    expect(readings.find((r) => r.metric === 'hvac_heating')?.value).toBe(0);
    expect(readings.find((r) => r.metric === 'eco_mode')?.value).toBe(1);
  });

  it('uses the entity from the registry options when given', () => {
    expect(
      parseNestDevices(load('devices-heating.json'), ts, { entity: 'landing' })[0]?.entity,
    ).toBe('landing');
  });

  it('refuses an offline thermostat rather than storing stale values as current', () => {
    const offline = structuredClone(load('devices-heating.json')) as {
      devices: { traits: Record<string, unknown> }[];
    };
    offline.devices[0]!.traits['sdm.devices.traits.Connectivity'] = { status: 'OFFLINE' };
    expect(() => parseNestDevices(offline, ts)).toThrow(NestOfflineError);
  });

  it('complains when the project has no thermostat', () => {
    expect(() => parseNestDevices({ devices: [] }, ts)).toThrow(/No Nest thermostat/);
    expect(() => parseNestDevices({}, ts)).toThrow(/No Nest thermostat/);
  });
});

describe('roomKey', () => {
  it.each([
    ['Hallway', 'hallway'],
    ['Living Room', 'living_room'],
    [" Kid's room ", 'kid_s_room'],
    ['', null],
    [undefined, null],
    ['2nd floor', null],
  ])('%j → %j', (name, key) => {
    expect(roomKey(name)).toBe(key);
  });
});
