import { describe, expect, it } from 'vitest';
import { freshnessPolicy, parseRegistry, RegistryError } from './registry.js';

// The registry from docs/03, as the YAML parser would hand it over.
const docsRegistry = {
  sources: {
    room_sensors: {
      name: 'Room sensors',
      kind: 'sensor',
      expected_delay: '0s',
      push_interval: '30s',
      mqtt_topic: 'home/sensors/+/+',
    },
    pi_stats: { name: 'Raspberry Pi', kind: 'local', poll: '1m', expected_delay: '0s' },
    smart_meters: {
      name: 'Smart meters',
      kind: 'api',
      poll: '6h',
      expected_delay: '1d',
      grace: '12h',
    },
    thames_water: {
      name: 'Thames Water',
      kind: 'scrape',
      poll: 'cron: 0 6 * * *',
      expected_delay: '3d',
      grace: '1d',
    },
  },
};

function problemsOf(raw: unknown): string {
  try {
    parseRegistry(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(RegistryError);
    return (err as Error).message;
  }
  throw new Error('expected parseRegistry to throw');
}

describe('parseRegistry', () => {
  it('parses the registry from docs/03', () => {
    const { sources } = parseRegistry(docsRegistry);
    expect(sources.map((s) => s.id)).toEqual([
      'room_sensors',
      'pi_stats',
      'smart_meters',
      'thames_water',
    ]);
    expect(sources[0]).toEqual({
      id: 'room_sensors',
      name: 'Room sensors',
      kind: 'sensor',
      poll: null,
      pushIntervalSeconds: 30,
      expectedDelaySeconds: 0,
      graceSeconds: null,
      enabled: true,
      mqttTopic: 'home/sensors/+/+',
      options: {},
    });
    expect(sources[2]).toMatchObject({
      poll: { type: 'every', seconds: 21600 },
      expectedDelaySeconds: 86400,
      graceSeconds: 43200,
    });
    expect(sources[3]).toMatchObject({ poll: { type: 'cron', expression: '0 6 * * *' } });
  });

  it('defaults expected_delay to 0 and enabled to true', () => {
    const { sources } = parseRegistry({ sources: { x: { name: 'X', kind: 'api', poll: '5m' } } });
    expect(sources[0]).toMatchObject({ expectedDelaySeconds: 0, enabled: true });
  });

  it('keeps source-specific options for the collector', () => {
    const { sources } = parseRegistry({
      sources: { x: { name: 'X', kind: 'api', poll: '5m', options: { cv: 39.5 } } },
    });
    expect(sources[0]?.options).toEqual({ cv: 39.5 });
  });

  it('accepts an empty registry', () => {
    expect(parseRegistry({ sources: {} })).toEqual({ sources: [] });
  });

  it('rejects ids that are not snake_case', () => {
    expect(
      problemsOf({ sources: { 'Room-Sensors': { name: 'X', kind: 'api', poll: '5m' } } }),
    ).toMatch(/snake_case/);
  });

  it('rejects unknown keys, so typos are caught', () => {
    expect(
      problemsOf({ sources: { x: { name: 'X', kind: 'api', poll: '5m', expected_dealy: '1d' } } }),
    ).toMatch(/sources\.x.*expected_dealy/);
  });

  it('rejects bad durations and kinds', () => {
    const message = problemsOf({ sources: { x: { name: 'X', kind: 'cloud', poll: '5 minutes' } } });
    expect(message).toMatch(/sources\.x\.kind/);
    expect(message).toMatch(/sources\.x\.poll/);
  });

  it('requires push_interval and no poll for sensors', () => {
    expect(problemsOf({ sources: { x: { name: 'X', kind: 'sensor' } } })).toMatch(
      /need push_interval/,
    );
    expect(
      problemsOf({
        sources: { x: { name: 'X', kind: 'sensor', push_interval: '30s', poll: '1m' } },
      }),
    ).toMatch(/not polled/);
  });

  it('requires poll for pull sources', () => {
    expect(problemsOf({ sources: { x: { name: 'X', kind: 'api' } } })).toMatch(
      /kind: api needs poll/,
    );
  });

  it('rejects a cron poll on a live source (no fixed cadence for the Live window)', () => {
    expect(
      problemsOf({ sources: { x: { name: 'X', kind: 'api', poll: 'cron: */5 * * * *' } } }),
    ).toMatch(/needs a duration poll/);
  });

  it('rejects malformed cron and 0s poll', () => {
    expect(
      problemsOf({
        sources: { x: { name: 'X', kind: 'scrape', poll: 'cron: 0 6 *', expected_delay: '1d' } },
      }),
    ).toMatch(/5 fields/);
    expect(problemsOf({ sources: { x: { name: 'X', kind: 'api', poll: '0s' } } })).toMatch(
      /longer than 0s/,
    );
  });

  it('lists every problem at once', () => {
    const message = problemsOf({
      sources: { a: { name: 'A', kind: 'api' }, b: { name: '', kind: 'api', poll: '1m' } },
    });
    expect(message).toMatch(/sources\.a\.poll/);
    expect(message).toMatch(/sources\.b\.name/);
  });

  it('rejects a missing sources key', () => {
    expect(problemsOf({})).toMatch(/sources/);
    expect(problemsOf(null)).toMatch(/Invalid source registry/);
  });
});

describe('freshnessPolicy', () => {
  const { sources } = parseRegistry(docsRegistry);
  const byId = (id: string) => sources.find((s) => s.id === id)!;

  it('uses push_interval for push sources', () => {
    expect(freshnessPolicy(byId('room_sensors'))).toEqual({
      expectedDelaySeconds: 0,
      cadenceSeconds: 30,
      graceSeconds: null,
    });
  });

  it('uses poll for pull sources', () => {
    expect(freshnessPolicy(byId('smart_meters'))).toEqual({
      expectedDelaySeconds: 86400,
      cadenceSeconds: 21600,
      graceSeconds: 43200,
    });
  });

  it('has no cadence for cron sources', () => {
    expect(freshnessPolicy(byId('thames_water')).cadenceSeconds).toBeNull();
  });
});
