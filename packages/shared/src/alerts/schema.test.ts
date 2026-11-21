import { describe, expect, it } from 'vitest';
import { AlertsFileSchema, buildAlertRules, mergeRule, ruleLevels } from './schema.js';

const co2 = {
  id: 'co2_high',
  group: 'air',
  name: 'CO₂ high',
  type: 'threshold',
  match: { metric: 'co2' },
  direction: 'above',
  warning: { level: 1000, for: '15m' },
  alert: { level: 1500, for: '10m' },
  clear: { level: 900, for: '5m' },
  link: '/rooms',
  defaults: { audience: 'all', minLevel: 'alert' },
};
const battery = {
  id: 'vacuum_battery_low',
  group: 'devices',
  name: 'Vacuum battery low',
  type: 'threshold',
  match: { metric: 'battery', sources: ['roborock'] },
  direction: 'below',
  warning: { level: 50, for: '6h' },
  clear: { level: 55, for: '10m' },
  link: '/misc',
  defaults: { audience: 'all', minLevel: 'warning' },
};
const notCharging = {
  id: 'vacuum_not_charging',
  group: 'devices',
  name: "Vacuum isn't charging",
  type: 'event',
  level: 'warning',
  link: '/misc',
  defaults: { audience: 'all', minLevel: 'warning' },
};
const newDevice = {
  ...notCharging,
  id: 'network_new_device',
  options: { ignoreRandomised: false },
};

describe('alert rules', () => {
  it('parses durations and defaults', () => {
    const merged = mergeRule(co2, undefined);
    expect(merged).toMatchObject({
      rule: { warning: { level: 1000, for: 900 }, enabled: true, resolvedNotice: true },
    });
  });

  it('accepts a single-level rule, which only reaches warning', () => {
    const merged = mergeRule(battery, undefined);
    if (!('rule' in merged)) throw new Error(merged.problems.join());
    expect(ruleLevels(merged.rule)).toEqual(['warning']);
    expect(ruleLevels((mergeRule(co2, undefined) as { rule: never }).rule)).toEqual([
      'warning',
      'alert',
    ]);
  });

  it('applies an admin override on top of the YAML', () => {
    expect(mergeRule(co2, { warning: { level: 1100 }, enabled: false })).toMatchObject({
      rule: { warning: { level: 1100, for: 900 }, alert: { level: 1500 }, enabled: false },
    });
  });

  it('rejects overrides that break the order, durations out of range or new levels', () => {
    expect(mergeRule(co2, { clear: { level: 1000 } })).toEqual({
      problems: ['clear must be below the warning level'],
    });
    expect(mergeRule(co2, { alert: { level: 900 } })).toEqual({
      problems: ['the urgent level must be at or above the warning level'],
    });
    expect(mergeRule(battery, { clear: { level: 40 } })).toEqual({
      problems: ['clear must be above the warning level'],
    });
    expect(mergeRule(co2, { warning: { for: '30s' } })).toEqual({
      problems: ['warning.for: must be between 1 min and 24 h'],
    });
    expect(mergeRule(co2, { warning: { for: '2d' } })).toMatchObject({
      problems: [expect.any(String)],
    });
    expect(mergeRule(battery, { alert: { level: 10, for: '1h' } })).toEqual({
      problems: ['alert: this rule has no alert level to change'],
    });
  });

  it('lets admins switch rule options, but not invent new ones', () => {
    expect(mergeRule(newDevice, { options: { ignoreRandomised: true } })).toMatchObject({
      rule: { options: { ignoreRandomised: true } },
    });
    expect(mergeRule(newDevice, { options: { other: true } })).toEqual({
      problems: ['options.other: not an option of this rule'],
    });
    expect(mergeRule(notCharging, { options: { x: 1 } })).toEqual({
      problems: ['options: this rule has no options'],
    });
  });

  it('builds the effective rules, naming bad rules and ignoring bad overrides', () => {
    const file = AlertsFileSchema.parse({
      groups: [
        { id: 'air', name: 'Rooms & air' },
        { id: 'devices', name: 'Devices & network' },
      ],
      rules: [
        co2,
        battery,
        notCharging,
        { ...co2, id: 'co2_high' },
        { ...co2, id: 'odd', group: 'nowhere' },
        { ...co2, id: 'broken', direction: 'sideways' },
      ],
    });
    const built = buildAlertRules(
      file,
      new Map([
        ['co2_high', { warning: { level: 1100 } }],
        ['vacuum_battery_low', { clear: { level: 10 } }],
      ]),
    );
    expect(built.rules.map((r) => r.id)).toEqual([
      'co2_high',
      'vacuum_battery_low',
      'vacuum_not_charging',
    ]);
    expect(built.rules[0]).toMatchObject({ warning: { level: 1100 } });
    expect(built.rules[1]).toMatchObject({ clear: { level: 55 } });
    expect(built.problems).toEqual([
      'vacuum_battery_low: override ignored (clear must be above the warning level)',
      'co2_high: duplicate rule id',
      'odd: unknown group "nowhere"',
      expect.stringMatching(/^broken: /),
    ]);
  });
});
