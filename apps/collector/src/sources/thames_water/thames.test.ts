import { londonDayBounds, ReadingInputSchema, type ReadingInput } from '@home/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCollectorEnv } from '../../env.js';
import { fakeContext, silentLog, source } from '../../test-helpers.js';
import { thamesWater } from './index.js';
import { fakeHourLitres, fakeWaterProvider } from './providers/fake.js';
import { thamesProvider } from './providers/thames.js';

const ctx = { env: loadCollectorEnv({}), signal: new AbortController().signal, log: silentLog };
afterEach(() => vi.useRealTimers());

describe('fake water provider', () => {
  it('is 3 days behind: the last hour is the end of the day 3 days ago', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    const readings = await fakeWaterProvider.fetch(
      new Date('2026-10-30T00:00:00Z'),
      new Date(),
      ctx,
    );
    const volumes = readings.filter((r) => r.metric === 'volume');
    expect(new Date(volumes.at(-1)!.ts).toISOString()).toBe('2026-11-03T23:00:00.000Z');
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('gives 24 hours a normal day (25 when the clocks go back) and a daily meter reading', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-06T14:00:00Z'), toFake: ['Date'] });
    for (const [date, hours] of [
      ['2026-11-02', 24],
      ['2026-10-25', 25],
    ] as const) {
      const { from, to } = londonDayBounds(date);
      const readings: ReadingInput[] = await fakeWaterProvider.fetch(from, to, ctx);
      expect(readings.filter((r) => r.metric === 'volume')).toHaveLength(hours);
      expect(readings.filter((r) => r.metric === 'meter_reading')).toHaveLength(1);
    }
  });

  it('uses no water at night and about 300 L a day', () => {
    const day = Array.from({ length: 24 }, (_, h) =>
      fakeHourLitres(new Date(Date.UTC(2026, 10, 2, h))),
    );
    expect(day.slice(0, 6).every((l) => l === 0)).toBe(true);
    expect(day.reduce((a, b) => a + b, 0)).toBeGreaterThan(200);
    expect(day.reduce((a, b) => a + b, 0)).toBeLessThan(420);
  });
});

describe('thames_water collector', () => {
  it('refuses the fake provider in production, so sample data never reaches the real database', async () => {
    const env = loadCollectorEnv({ NODE_ENV: 'production', WATER_PROVIDER: 'fake' });
    const src = source('thames_water', {
      kind: 'scrape',
      poll: 'cron: 0 6 * * *',
      expected_delay: '3d',
    });
    const run = thamesWater.run({
      ...fakeContext(src, new AbortController().signal, () => undefined),
      env,
    });
    await expect(run).rejects.toThrow(/set WATER_PROVIDER=thames in \.env/);
  });

  it('asks for the Thames Water login when it is missing', async () => {
    await expect(thamesProvider.fetch(new Date(), new Date(), ctx)).rejects.toThrow(
      /THAMES_EMAIL is not set/,
    );
  });
});
