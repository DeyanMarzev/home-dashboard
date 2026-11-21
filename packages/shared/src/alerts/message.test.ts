import { describe, expect, it } from 'vitest';
import { buildPushMessage, formatAlertValue, formatHeldFor, testPushMessage } from './message.js';
import { AlertRuleSchema, type AlertRule } from './schema.js';

const co2 = AlertRuleSchema.parse({
  id: 'co2_high',
  group: 'air',
  name: 'CO₂ high',
  resolvedName: 'CO₂ back to normal',
  type: 'threshold',
  match: { metric: 'co2' },
  direction: 'above',
  warning: { level: 1000, for: '15m' },
  alert: { level: 1500, for: '10m' },
  clear: { level: 900, for: '5m' },
  advice: 'Open a window or turn on ventilation.',
  link: '/rooms',
  defaults: { audience: 'all', minLevel: 'alert' },
});
const eventRule = (over: Record<string, unknown>): AlertRule =>
  AlertRuleSchema.parse({
    group: 'devices',
    type: 'event',
    level: 'warning',
    link: '/misc',
    defaults: { audience: 'all', minLevel: 'warning' },
    ...over,
  });

const NOW = new Date('2026-11-21T14:35:00Z');
const kitchen = {
  kind: 'co2_high',
  entity: 'bedroom',
  level: 'warning' as const,
  message: 'CO₂ high · Bedroom 1,240 ppm',
  data: { value: 1240, unit: 'ppm', label: 'Bedroom', since: '2026-11-21T14:20:00.000Z' },
};

describe('buildPushMessage', () => {
  it('threshold opened: room, value, how long, advice; deep link to the room', () => {
    expect(buildPushMessage(co2, kitchen, 'opened', NOW)).toEqual({
      title: 'CO₂ high · Bedroom',
      body: '1,240 ppm for 15 min. Open a window or turn on ventilation.',
      tag: 'co2_high:bedroom',
      url: '/rooms#bedroom',
    });
  });

  it('threshold escalated and resolved replace it (same tag)', () => {
    const urgent = { ...kitchen, level: 'alert' as const, data: { ...kitchen.data, value: 1560 } };
    expect(buildPushMessage(co2, urgent, 'escalated', NOW)).toMatchObject({
      title: 'Urgent: CO₂ high · Bedroom',
      body: '1,560 ppm. Open a window or turn on ventilation.',
      tag: 'co2_high:bedroom',
    });
    expect(buildPushMessage(co2, urgent, 'resolved', NOW, 880)).toMatchObject({
      title: 'CO₂ back to normal · Bedroom',
      body: '880 ppm.',
      tag: 'co2_high:bedroom',
    });
  });

  it('event rules use the event text: head as title, the rest as body', () => {
    const vacuum = eventRule({
      id: 'vacuum_not_charging',
      name: "Vacuum isn't charging",
      resolvedName: 'Vacuum charging again',
    });
    const event = {
      kind: 'vacuum_not_charging',
      entity: '',
      level: 'warning' as const,
      message: "Vacuum isn't charging · Idle at 14:02, battery 63%. Check it's on its dock",
      data: null,
    };
    expect(buildPushMessage(vacuum, event, 'opened', NOW)).toEqual({
      title: "Vacuum isn't charging",
      body: "Idle at 14:02, battery 63%. Check it's on its dock.",
      tag: 'vacuum_not_charging:',
      url: '/misc',
    });
    expect(buildPushMessage(vacuum, event, 'resolved', NOW)).toMatchObject({
      title: 'Vacuum charging again',
      body: 'Since 14:35.',
    });
  });

  it('a message without a head gets the rule name; advice is added', () => {
    const nest = eventRule({
      id: 'nest_auth',
      name: 'Nest connection lost',
      advice: 'Sign in again (docs/06 § 5b).',
    });
    const event = {
      kind: 'nest_auth',
      entity: '',
      level: 'alert' as const,
      message: 'Google refused the refresh token',
      data: null,
    };
    expect(buildPushMessage(nest, event, 'opened', NOW)).toMatchObject({
      title: 'Nest connection lost',
      body: 'Google refused the refresh token. Sign in again (docs/06 § 5b).',
    });
  });

  it('weather: the custom title says the colour, so no "Urgent:" prefix', () => {
    const weather = eventRule({
      id: 'weather_warning',
      name: 'Weather warning',
      resolvedName: 'Warning ended',
      link: '/',
    });
    const amber = {
      kind: 'weather_warning',
      entity: 'w_2222',
      level: 'alert' as const,
      message: 'Amber warning of rain · Mon 23 Nov 18:00 – Wed 25 Nov 06:00',
      data: { title: 'Amber warning · Rain' },
    };
    expect(buildPushMessage(weather, amber, 'escalated', NOW)).toEqual({
      title: 'Amber warning · Rain',
      body: 'Mon 23 Nov 18:00 – Wed 25 Nov 06:00.',
      tag: 'weather_warning:w_2222',
      url: '/#w_2222',
    });
    expect(buildPushMessage(weather, amber, 'resolved', NOW).title).toBe(
      'Warning ended · Amber warning · Rain',
    );
  });

  it('formats values, durations and the test push', () => {
    expect(formatAlertValue(13.46, '°C')).toBe('13.5 °C');
    expect(formatAlertValue(42, '%')).toBe('42%');
    expect(formatHeldFor(6 * 3600_000)).toBe('6 h');
    expect(formatHeldFor(150 * 60_000)).toBe('2 h 30 min');
    expect(testPushMessage("Deyan's Pixel")).toMatchObject({
      title: 'Test notification',
      body: "Notifications work on Deyan's Pixel.",
    });
  });
});
