import { readFileSync } from 'node:fs';
import { ReadingInputSchema, type ReadingInput } from '@home/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCollectorEnv } from '../../../env.js';
import { silentLog } from '../../../test-helpers.js';
import {
  BrightAuthError,
  brightProvider,
  dropUnreceived,
  parseReadings,
  parseResources,
  resetBrightSession,
} from './bright.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8'));

const env = loadCollectorEnv({
  METER_PROVIDER: 'bright',
  BRIGHT_USERNAME: 'owner@example.com',
  BRIGHT_PASSWORD: 'pa$$word-x9',
});
const ctx = { env, signal: new AbortController().signal, log: silentLog };
const ts = (r: ReadingInput) => (r.ts as Date).toISOString();
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetBrightSession();
});

describe('parseResources', () => {
  it('finds the electricity and gas consumption resources, not the cost ones', () => {
    // Recorded from the owner's account (2026-11-08): gas cost, gas, electricity, electricity cost.
    expect(parseResources([fixture('bright-resources.json')])).toEqual([
      { fuel: 'gas', resourceId: 'REDACTED-resourceId-5' },
      { fuel: 'electricity', resourceId: 'REDACTED-resourceId-7' },
    ]);
  });

  it('copes with an electricity-only account', () => {
    const body = {
      resources: [{ resourceId: 'e1', classifier: 'electricity.consumption' }, { resourceId: 'x' }],
    };
    expect(parseResources([body])).toEqual([{ fuel: 'electricity', resourceId: 'e1' }]);
  });
});

describe('parseReadings', () => {
  it('turns [unix seconds, kWh] pairs into half-hour interval totals starting at that time', () => {
    const readings = parseReadings(fixture('bright-readings-electricity.json'), 'electricity');
    expect(readings).toHaveLength(96);
    expect(readings[0]).toEqual({
      metric: 'energy_import',
      entity: 'electricity',
      unit: 'kWh',
      valueType: 'interval_total',
      interval: '30m',
      ts: new Date('2026-11-06T19:30:00Z'),
      value: 0.464,
    });
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
    const day = readings.filter((r) => ts(r).startsWith('2026-11-07'));
    expect(day).toHaveLength(48);
    expect(day.reduce((sum, r) => sum + r.value, 0)).toBeCloseTo(9.858, 3);
  });

  it('skips null half-hours', () => {
    const body = {
      units: 'kWh',
      data: [
        [1793993400, 1.2],
        [1793995200, null],
        [1793997000, 0],
      ],
    };
    expect(parseReadings(body, 'gas').map((r) => r.value)).toEqual([1.2, 0]);
  });

  it('converts gas reported in m³ to kWh', () => {
    const [r] = parseReadings({ units: 'm3', data: [[1793836800, 1]] }, 'gas');
    expect(r?.value).toBeCloseTo(11.22, 2);
  });

  it('rejects a response without data', () => {
    expect(() => parseReadings({ status: 'OK' }, 'gas')).toThrow();
  });
});

describe('dropUnreceived', () => {
  it('cuts both fuels after the last half-hour with any electricity', () => {
    const readings = [
      ...parseReadings(fixture('bright-readings-electricity.json'), 'electricity'),
      ...parseReadings(fixture('bright-readings-gas.json'), 'gas'),
    ];
    const kept = dropUnreceived(readings);
    const last = (entity: string) =>
      kept
        .filter((r) => r.entity === entity)
        .map(ts)
        .sort()
        .at(-1);
    // Captured at 19:30 on 8 Nov: Bright had data to 01:00 and padded the rest with 0.
    expect(last('electricity')).toBe('2026-11-08T01:00:00.000Z');
    expect(last('gas')).toBe('2026-11-08T01:00:00.000Z');
    expect(kept).toHaveLength(120);
    // Gas zeros before that (no heating) are real and stay.
    expect(kept.filter((r) => r.entity === 'gas' && r.value === 0).length).toBeGreaterThan(20);
  });

  it('keeps gas-only data as it is', () => {
    const gas = parseReadings(fixture('bright-readings-gas.json'), 'gas');
    expect(dropUnreceived(gas)).toEqual(gas);
  });
});

describe('brightProvider.fetch', () => {
  function stubBright(options: { authStatus?: number } = {}) {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (input: URL, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, init });
      const path = url.pathname.replace('/api/v0-1/', '');
      if (path === 'auth') {
        return options.authStatus
          ? json(options.authStatus, { valid: false })
          : json(200, { valid: true, token: 'jwt-token-x7', exp: 1794441600 });
      }
      if (path === 'virtualentity') return json(200, fixture('bright-virtualentity.json'));
      if (path.endsWith('/resources')) return json(200, fixture('bright-resources.json'));
      if (path.endsWith('/catchup')) return json(200, { status: 'OK' });
      if (path.endsWith('/readings')) {
        const fuel = path.includes('REDACTED-resourceId-7') ? 'electricity' : 'gas'; // see bright-resources.json
        return json(200, fixture(`bright-readings-${fuel}.json`));
      }
      return json(404, {});
    });
    return calls;
  }

  it('logs in once, finds the resources and returns received half-hours for both fuels', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-08T19:30:00Z'), toFake: ['Date'] });
    const calls = stubBright();
    const readings = await brightProvider.fetch(
      new Date('2026-11-06T19:30:00Z'),
      new Date('2026-11-08T19:30:00Z'),
      ctx,
    );
    expect(readings.filter((r) => r.entity === 'electricity')).toHaveLength(60);
    expect(readings.filter((r) => r.entity === 'gas')).toHaveLength(60);

    const auth = calls.filter((c) => c.url.pathname.endsWith('/auth'));
    expect(auth).toHaveLength(1);
    expect(JSON.parse(auth[0]!.init!.body as string)).toEqual({
      username: 'owner@example.com',
      password: 'pa$$word-x9',
    });
    const readingCall = calls.find((c) => c.url.pathname.endsWith('/readings'))!;
    expect(readingCall.init?.headers).toMatchObject({
      token: 'jwt-token-x7',
      applicationId: 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d',
    });
    expect(Object.fromEntries(readingCall.url.searchParams)).toEqual({
      from: '2026-11-06T19:30:00',
      to: '2026-11-08T19:29:59',
      period: 'PT30M',
      offset: '0',
      function: 'sum',
    });
    for (const c of calls) expect(c.url.href).not.toContain('pa$$word');
    expect(calls.filter((c) => c.url.pathname.endsWith('/catchup'))).toHaveLength(2);

    // A second run reuses the token and the resource ids.
    await brightProvider.fetch(
      new Date('2026-11-06T19:30:00Z'),
      new Date('2026-11-08T19:30:00Z'),
      ctx,
    );
    expect(calls.filter((c) => c.url.pathname.endsWith('/auth'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith('/virtualentity'))).toHaveLength(1);
  });

  it('splits long ranges into requests of at most 10 days and never asks for the future', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-07T08:10:00Z'), toFake: ['Date'] });
    const calls = stubBright();
    await brightProvider.fetch(
      new Date('2026-10-08T08:10:00Z'),
      new Date('2026-11-08T00:00:00Z'),
      ctx,
    );
    const ranges = calls
      .filter((c) => c.url.pathname.includes('REDACTED-resourceId-7/readings'))
      .map((c) => `${c.url.searchParams.get('from')} → ${c.url.searchParams.get('to')}`);
    expect(ranges).toEqual([
      '2026-10-08T08:00:00 → 2026-10-18T07:59:59',
      '2026-10-18T08:00:00 → 2026-10-28T07:59:59',
      '2026-10-28T08:00:00 → 2026-11-07T07:59:59',
    ]);
  });

  it('reports a refused login without repeating the credentials', async () => {
    stubBright({ authStatus: 401 });
    const err = await brightProvider
      .fetch(new Date('2026-11-05T00:00:00Z'), new Date('2026-11-06T00:00:00Z'), ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrightAuthError);
    expect(String(err)).toMatch(/Check BRIGHT_USERNAME and BRIGHT_PASSWORD/);
    expect(String(err)).not.toMatch(/owner@example|pa\$\$word/);
  });

  it('says which setting is missing', async () => {
    stubBright();
    await expect(
      brightProvider.fetch(new Date(), new Date(), { ...ctx, env: loadCollectorEnv({}) }),
    ).rejects.toThrow(/BRIGHT_USERNAME is not set/);
  });
});
