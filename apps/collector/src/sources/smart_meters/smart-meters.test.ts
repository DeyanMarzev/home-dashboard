import { londonDayBounds, ReadingInputSchema, type ReadingInput } from '@home/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCollectorEnv } from '../../env.js';
import { fakeContext, silentLog, source } from '../../test-helpers.js';
import { smartMeters } from './index.js';
import { fakeHalfHour, fakeProvider } from './providers/fake.js';

const ctx = { env: loadCollectorEnv({}), signal: new AbortController().signal, log: silentLog };

afterEach(() => vi.useRealTimers());

describe('fake meter provider', () => {
  it('gives 48 half-hours per fuel per normal day, and 50 on the day the clocks go back', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    for (const [date, slots] of [
      ['2026-11-04', 48],
      ['2026-10-25', 50],
    ] as const) {
      const { from, to } = londonDayBounds(date);
      const readings = await fakeProvider.fetch(from, to, ctx);
      expect(readings.filter((r) => r.entity === 'electricity')).toHaveLength(slots);
      expect(readings.filter((r) => r.entity === 'gas')).toHaveLength(slots);
    }
  });

  it('is a day behind: nothing from today (London) yet', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    const readings = await fakeProvider.fetch(
      new Date('2026-11-05T00:00:00Z'),
      new Date('2026-11-06T14:00:00Z'),
      ctx,
    );
    const last = readings.map((r) => (r.ts as Date).getTime()).reduce((a, b) => Math.max(a, b));
    expect(new Date(last).toISOString()).toBe('2026-11-05T23:30:00.000Z');
  });

  it('is deterministic and plausible', () => {
    const t = new Date('2026-11-05T18:00:00Z');
    expect(fakeHalfHour(t)).toEqual(fakeHalfHour(new Date(t)));
    const night = fakeHalfHour(new Date('2026-11-05T03:00:00Z'));
    expect(night.electricityKwh).toBeGreaterThanOrEqual(0.084);
    expect(night.electricityKwh).toBeLessThan(0.1);
    expect(fakeHalfHour(t).gasKwh).toBeGreaterThan(0.5);
  });

  it('produces valid interval_total readings', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    const readings = await fakeProvider.fetch(
      new Date('2026-11-05T00:00:00Z'),
      new Date('2026-11-06T00:00:00Z'),
      ctx,
    );
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
    expect(readings[0]).toMatchObject({
      metric: 'energy_import',
      unit: 'kWh',
      valueType: 'interval_total',
      interval: '30m',
    });
  });
});

describe('smart_meters collector', () => {
  function run(lastDataTo: Record<string, Date | null>, env: Record<string, string> = {}) {
    const written: ReadingInput[] = [];
    const src = source('smart_meters', { kind: 'api', poll: '6h', expected_delay: '1d' });
    const c = {
      ...fakeContext(src, new AbortController().signal, () => undefined),
      env: loadCollectorEnv(env),
      lastDataTo: (_m: string, entity?: string) =>
        Promise.resolve(lastDataTo[entity ?? ''] ?? null),
      writeReadings: (r: ReadingInput[]) => (written.push(...r), Promise.resolve(r.length)),
    };
    return { promise: smartMeters.run(c), written };
  }

  it('backfills 30 days on the first run', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    const { promise, written } = run({});
    await promise;
    const first = Math.min(...written.map((r) => (r.ts as Date).getTime()));
    expect(new Date(first).toISOString()).toBe('2026-10-07T14:00:00.000Z');
  });

  it('re-fetches from 2 days before the older of the two fuels', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    const { promise, written } = run({
      electricity: new Date('2026-11-05T00:00:00Z'),
      gas: new Date('2026-11-04T00:00:00Z'),
    });
    await promise;
    const first = Math.min(...written.map((r) => (r.ts as Date).getTime()));
    expect(new Date(first).toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('refuses an unknown provider, pointing at the open question', async () => {
    await expect(run({}, { METER_PROVIDER: 'octopus' }).promise).rejects.toThrow(
      /METER_PROVIDER "octopus" isn't supported/,
    );
  });
});
