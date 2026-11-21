import { describe, expect, it } from 'vitest';
import { AlertRuleSchema, type ThresholdRule } from './schema.js';
import { evaluateThreshold, windowSeconds, type ReadingPoint } from './threshold.js';

const co2 = AlertRuleSchema.parse({
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
}) as ThresholdRule;

const battery = AlertRuleSchema.parse({
  id: 'vacuum_battery_low',
  group: 'devices',
  name: 'Vacuum battery low',
  type: 'threshold',
  match: { metric: 'battery', sources: ['roborock'], entities: ['vacuum'] },
  direction: 'below',
  warning: { level: 50, for: '6h' },
  clear: { level: 55, for: '10m' },
  link: '/misc',
  defaults: { audience: 'all', minLevel: 'warning' },
}) as ThresholdRule;

const MIN = 60_000;
const T0 = Date.parse('2026-11-21T12:00:00Z');
/** One reading per `stepMin` minutes from T0, with the given values. */
const series = (values: number[], stepMin = 1): ReadingPoint[] =>
  values.map((value, i) => ({ ts: T0 + i * stepMin * MIN, value }));
const at = (min: number) => T0 + min * MIN;

describe('evaluateThreshold', () => {
  it("doesn't open before `for`, opens at exactly `for`", () => {
    const pts = series(Array.from({ length: 16 }, () => 1100)); // 12:00 … 12:15
    expect(evaluateThreshold(co2, pts.slice(0, 15), null, at(14), false).kind).toBe('none');
    expect(evaluateThreshold(co2, pts, null, at(15), false)).toEqual({
      kind: 'open',
      level: 'warning',
      value: 1100,
      since: T0,
    });
  });

  it('starts the timer again after a reading back under the level', () => {
    const pts = series([
      ...Array.from({ length: 10 }, () => 1100),
      950,
      ...Array.from({ length: 10 }, () => 1100),
    ]);
    expect(evaluateThreshold(co2, pts, null, at(20), false).kind).toBe('none');
    expect(evaluateThreshold(co2, pts, null, at(26), false)).toMatchObject({
      kind: 'open',
      since: at(11),
    });
  });

  it('opens straight at urgent when that has held long enough', () => {
    const pts = series(Array.from({ length: 16 }, () => 1600));
    expect(evaluateThreshold(co2, pts, null, at(15), false)).toMatchObject({
      kind: 'open',
      level: 'alert',
    });
  });

  it('escalates an open warning, then stays urgent until it clears', () => {
    const pts = series([
      ...Array.from({ length: 15 }, () => 1100),
      ...Array.from({ length: 11 }, () => 1600),
    ]);
    expect(evaluateThreshold(co2, pts, 'warning', at(25), false)).toMatchObject({
      kind: 'escalate',
      since: at(15),
    });
    // Back to 1100 (between clear and urgent): no de-escalation, nothing to do.
    const lower = [
      ...pts,
      ...series(Array.from({ length: 30 }, () => 1100)).map((p) => ({ ...p, ts: p.ts + 26 * MIN })),
    ];
    expect(evaluateThreshold(co2, lower, 'alert', at(55), false).kind).toBe('none');
  });

  it('resolves only after `clear` has held, and not between clear and warning (hysteresis)', () => {
    const between = series([
      ...Array.from({ length: 5 }, () => 1100),
      ...Array.from({ length: 30 }, () => 950),
    ]);
    expect(evaluateThreshold(co2, between, 'warning', at(34), false).kind).toBe('none');
    const cleared = series([
      ...Array.from({ length: 5 }, () => 1100),
      ...Array.from({ length: 6 }, () => 850),
    ]);
    expect(evaluateThreshold(co2, cleared, 'warning', at(9), false).kind).toBe('none');
    expect(evaluateThreshold(co2, cleared, 'warning', at(10), false)).toEqual({
      kind: 'resolve',
      value: 850,
    });
  });

  it('freezes on stale data: nothing opens, escalates or resolves', () => {
    expect(
      evaluateThreshold(co2, series(Array.from({ length: 30 }, () => 1600)), null, at(30), true)
        .kind,
    ).toBe('none');
    expect(
      evaluateThreshold(co2, series(Array.from({ length: 30 }, () => 800)), 'alert', at(30), true)
        .kind,
    ).toBe('none');
    expect(evaluateThreshold(co2, [], null, at(30), false).kind).toBe('none');
  });

  it('works downwards, with one level and hourly readings (vacuum battery)', () => {
    const low = series([45, 44, 43, 42, 41, 40, 39], 60); // 12:00 … 18:00
    expect(evaluateThreshold(battery, low.slice(0, 6), null, at(5 * 60 + 59), false).kind).toBe(
      'none',
    );
    expect(evaluateThreshold(battery, low, null, at(6 * 60), false)).toMatchObject({
      kind: 'open',
      level: 'warning',
    });
    // Never escalates: there is no urgent level.
    expect(
      evaluateThreshold(
        battery,
        series(
          Array.from({ length: 30 }, () => 5),
          60,
        ),
        'warning',
        at(29 * 60),
        false,
      ).kind,
    ).toBe('none');
    const charged = [...low, { ts: at(7 * 60), value: 80 }];
    expect(evaluateThreshold(battery, charged, 'warning', at(7 * 60 + 9), false).kind).toBe('none');
    expect(evaluateThreshold(battery, charged, 'warning', at(7 * 60 + 10), false)).toEqual({
      kind: 'resolve',
      value: 80,
    });
  });

  it('reads back far enough for the longest duration and sparse readings', () => {
    expect(windowSeconds(co2, 30)).toBe(15 * 60 + 600);
    expect(windowSeconds(battery, 3600)).toBe(6 * 3600 + 2 * 3600);
  });
});
