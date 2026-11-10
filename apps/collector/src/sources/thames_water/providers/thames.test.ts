import { readFileSync } from 'node:fs';
import { ReadingInputSchema } from '@home/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCollectorEnv } from '../../../env.js';
import { silentLog } from '../../../test-helpers.js';
import { consumptionToReadings, londonHourStart } from './thames-parse.js';
import { CookieJar, thamesProvider, ThamesAuthError } from './thames.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8'));
const iso = (d: Date | string) => new Date(d).toISOString();
const lines = (labels: string[], usage = 1) => ({
  IsError: false,
  IsDataAvailable: true,
  Lines: labels.map((Label, i) => ({ Label, Usage: usage, Read: 1000 + i * usage })),
});
const hours = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}:00`);

afterEach(() => vi.unstubAllGlobals());

describe('londonHourStart', () => {
  it('maps London clock hours to UTC across the clock changes', () => {
    expect(iso(londonHourStart('2026-11-04', 7)!)).toBe('2026-11-04T07:00:00.000Z'); // GMT
    expect(iso(londonHourStart('2026-07-01', 7)!)).toBe('2026-07-01T06:00:00.000Z'); // BST
    expect(londonHourStart('2026-03-29', 1)).toBeNull(); // clocks skip 01:00
    expect(iso(londonHourStart('2026-10-25', 1, 0)!)).toBe('2026-10-25T00:00:00.000Z');
    expect(iso(londonHourStart('2026-10-25', 1, 1)!)).toBe('2026-10-25T01:00:00.000Z');
  });
});

describe('consumptionToReadings', () => {
  it('turns two days of hourly lines into volumes and a meter reading per day', () => {
    const readings = consumptionToReadings('2026-11-03', fixture('thames-hourly.json'));
    const volumes = readings.filter((r) => r.metric === 'volume');
    const meter = readings.filter((r) => r.metric === 'meter_reading');
    expect(volumes).toHaveLength(48);
    expect(iso(volumes[0]!.ts)).toBe('2026-11-03T00:00:00.000Z');
    expect(iso(volumes.at(-1)!.ts)).toBe('2026-11-04T23:00:00.000Z');
    expect(volumes.slice(0, 24).reduce((s, r) => s + r.value, 0)).toBe(265);
    expect(volumes.slice(24).reduce((s, r) => s + r.value, 0)).toBe(271);
    expect(meter.map((r) => [iso(r.ts), r.value])).toEqual([
      ['2026-11-04T00:00:00.000Z', 25.685],
      ['2026-11-05T00:00:00.000Z', 25.956],
    ]);
    expect(volumes[7]).toMatchObject({ unit: 'L', valueType: 'interval_total', interval: '1h' });
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('places the repeated 01:00 of the autumn clock change an hour later', () => {
    const autumn = consumptionToReadings(
      '2026-10-25',
      lines(['0:00', '1:00', '1:00', ...hours(2, 23)]),
    );
    const ts = autumn.filter((r) => r.metric === 'volume').map((r) => iso(r.ts));
    expect(ts).toHaveLength(25);
    expect(ts.slice(0, 4)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T02:00:00.000Z',
    ]);
    expect(new Set(ts).size).toBe(25);
  });

  it('handles the 23-hour spring day and a following day', () => {
    const spring = consumptionToReadings(
      '2026-03-29',
      lines(['0:00', ...hours(2, 23), ...hours(0, 23)]),
    );
    const ts = spring.filter((r) => r.metric === 'volume').map((r) => iso(r.ts));
    expect(ts).toHaveLength(47);
    expect(ts.slice(0, 2)).toEqual(['2026-03-29T00:00:00.000Z', '2026-03-29T01:00:00.000Z']);
    expect(ts[23]).toBe('2026-03-29T23:00:00.000Z'); // the 30th's 00:00 BST
    expect(new Set(ts).size).toBe(47);
  });

  it('fails loudly on a changed format, and is empty when no data is available', () => {
    expect(() => consumptionToReadings('2026-11-03', lines(['7am']))).toThrow(
      /unexpected hourly label/,
    );
    expect(() => consumptionToReadings('2026-11-03', { ...lines([]), IsError: true })).toThrow(
      /reported an error/,
    );
    expect(() => consumptionToReadings('2026-11-03', { Lines: [] })).toThrow();
    expect(
      consumptionToReadings('2026-11-03', { IsError: false, IsDataAvailable: false, Lines: null }),
    ).toEqual([]);
  });
});

describe('CookieJar', () => {
  it('sends host and domain cookies to the right hosts, and forgets expired ones', () => {
    const jar = new CookieJar();
    jar.store(new URL('https://login.thameswater.co.uk/x'), [
      'x-ms-cpim-trans=T1; path=/; secure; HttpOnly',
      'wide=1; Domain=.thameswater.co.uk; path=/',
    ]);
    jar.store(new URL('https://myaccount.thameswater.co.uk/'), ['sess=S; path=/']);
    jar.set('b2cAuthenticated', 'true');
    expect(jar.header('login.thameswater.co.uk')).toBe(
      'x-ms-cpim-trans=T1; wide=1; b2cAuthenticated=true',
    );
    expect(jar.header('myaccount.thameswater.co.uk')).toBe('wide=1; sess=S; b2cAuthenticated=true');
    jar.store(new URL('https://myaccount.thameswater.co.uk/'), ['sess=; Max-Age=0']);
    expect(jar.get('myaccount.thameswater.co.uk', 'sess')).toBeUndefined();
  });
});

describe('thamesProvider (the site replayed)', () => {
  const env = loadCollectorEnv({
    WATER_PROVIDER: 'thames',
    THAMES_EMAIL: 'owner@example.com',
    THAMES_PASSWORD: 'pa$$-x9',
  });
  const ctx = { env, signal: new AbortController().signal, log: silentLog };
  // An id token whose payload names the default account (signature not checked).
  const idToken = (account: string) =>
    `h.${Buffer.from(JSON.stringify({ extension_DefaultContractAccountNumber: account })).toString('base64url')}.s`;

  function stubSite(options: { refuse?: boolean } = {}) {
    const calls: { method: string; url: URL; body: string; cookie: string }[] = [];
    vi.stubGlobal('fetch', (input: URL, init: RequestInit) => {
      const url = new URL(input);
      const headers = init.headers as Record<string, string>;
      calls.push({
        method: init.method ?? 'GET',
        url,
        body: typeof init.body === 'string' ? init.body : '',
        cookie: headers.cookie ?? '',
      });
      const reply = (
        status: number,
        body: string,
        extra: Record<string, string> = {},
        cookies: string[] = [],
      ) => {
        const h = new Headers(extra);
        for (const c of cookies) h.append('set-cookie', c);
        return Promise.resolve(
          new Response(status >= 300 && status < 400 ? null : body, { status, headers: h }),
        );
      };
      const path = url.pathname;
      if (path.endsWith('/oauth2/v2.0/authorize'))
        return reply(200, '<html>sign in</html>', {}, [
          'x-ms-cpim-trans=TRANS; path=/',
          'x-ms-cpim-csrf=CSRF; path=/',
        ]);
      if (path.endsWith('/SelfAsserted'))
        return reply(
          200,
          JSON.stringify(
            options.refuse
              ? { status: '400', message: 'Your password is incorrect' }
              : { status: '200' },
          ),
        );
      if (path.endsWith('/confirmed'))
        return reply(302, '', {
          location: 'https://www.thameswater.co.uk/login#state=x&code=CODE1',
        });
      if (path.endsWith('/oauth2/v2.0/token'))
        return reply(200, JSON.stringify({ id_token: idToken('900000001') }));
      const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
      // First POST: redirects to a page whose URL carries a new state and whose body a new token.
      if (path === '/login' && form.get('state') === '')
        return reply(302, '', { location: '/twservice/Account/SignIn?state=STATE2' }, [
          'ASP.NET_SessionId=SID; path=/',
        ]);
      if (path === '/twservice/Account/SignIn')
        return reply(200, "<form><input id='id_token' value='SECOND.TOKEN.X'/></form>", {});
      if (path === '/login')
        return reply(302, '', { location: '/mydashboard' }, ['auth=OK; path=/']);
      if (path === '/mydashboard') return reply(200, 'dashboard');
      if (path === '/mydashboard/my-meters-usage') return reply(200, 'meters page');
      if (path.endsWith('/getMeters'))
        return reply(200, JSON.stringify(fixture('thames-meters.json')));
      if (path.endsWith('/getSmartWaterMeterConsumptions'))
        return reply(200, JSON.stringify(fixture('thames-hourly.json')));
      if (path.endsWith('/logout'))
        return reply(302, '', { location: 'https://www.thameswater.co.uk/' });
      return reply(404, 'not found');
    });
    return calls;
  }

  it('signs in, scopes the session to the account, fetches hourly usage and signs out', async () => {
    const calls = stubSite();

    const readings = await thamesProvider.fetch(
      new Date('2026-11-03T00:00:00Z'),
      new Date('2026-11-05T12:00:00Z'),
      ctx,
    );
    expect(readings.filter((r) => r.metric === 'volume')).toHaveLength(48);

    const step = (pred: (c: (typeof calls)[number]) => boolean) => calls.find(pred)!;
    const asserted = step((c) => c.url.pathname.endsWith('/SelfAsserted'));
    expect(new URLSearchParams(asserted.body).get('password')).toBe('pa$$-x9');
    expect(asserted.url.searchParams.get('tx')).toBe('StateProperties=TRANS');
    // The password goes only to the sign-in step, and never in a URL.
    expect(
      calls.filter((c) => c.body.includes('pa%24%24-x9') || c.body.includes('pa$$-x9')),
    ).toHaveLength(1);
    for (const c of calls) expect(c.url.href).not.toContain('x9');

    const token = step((c) => c.url.pathname.endsWith('/token'));
    expect(new URLSearchParams(token.body).get('code')).toBe('CODE1');
    const second = calls.filter((c) => c.url.pathname === '/login')[1]!;
    expect(Object.fromEntries(new URLSearchParams(second.body))).toEqual({
      state: 'STATE2',
      id_token: 'SECOND.TOKEN.X',
    });
    const page = step((c) => c.url.pathname === '/mydashboard/my-meters-usage');
    expect(page.url.searchParams.get('contractAccountNumber')).toBe('900000001');
    expect(page.cookie).toContain('ASP.NET_SessionId=SID');
    expect(page.cookie).toContain('b2cAuthenticated=true');

    const usage = step((c) => c.url.pathname.endsWith('/getSmartWaterMeterConsumptions'));
    expect(Object.fromEntries(usage.url.searchParams)).toMatchObject({
      meter: 'REDACTED-meter-1',
      startDate: '3',
      startMonth: '11',
      startYear: '2026',
      endDate: '4',
      endMonth: '11',
      granularity: 'H',
    });
    expect(calls.at(-1)?.url.pathname).toMatch(/logout$/);
  });

  it('reports a refused login without repeating the credentials', async () => {
    stubSite({ refuse: true });
    const err = await thamesProvider
      .fetch(new Date('2026-11-03T00:00:00Z'), new Date('2026-11-05T00:00:00Z'), ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThamesAuthError);
    expect(String(err)).toMatch(/Check THAMES_EMAIL and THAMES_PASSWORD/);
    expect(String(err)).not.toMatch(/owner@example|pa\$\$/);
  });
});
