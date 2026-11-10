import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { addLondonDays, londonDateString } from '@home/shared';
import { requireSetting, type CollectorEnv } from '../../../env.js';
import {
  consumptionToReadings,
  ConsumptionResponseSchema,
  MetersResponseSchema,
} from './thames-parse.js';
import type { WaterProvider } from './types.js';

/**
 * Thames Water's account website, which has no public API (docs/03 § thames_water). The flow
 * is ported from the MIT-licensed `thameswaterapi` Python client by Jelmer Vernooĳ and
 * Ayrton Bourn (github.com/jelmer/thameswaterapi, 2026-10): an Azure AD B2C sign-in with
 * PKCE, the id token traded for a myaccount session, the meter page visited (it scopes the
 * session to the account), then the site's own AJAX endpoints.
 *
 * It signs in with the password on every run (once a day; the collector caps attempts at 3
 * a day). Errors name the step and HTTP status only: never credentials, tokens or bodies.
 */

const B2C = 'https://login.thameswater.co.uk/identity.thameswater.co.uk';
const FLOW = 'B2C_1_tw_website_signin';
const AUTHORIZE = `${B2C}/b2c_1_tw_website_signin/oauth2/v2.0/authorize`;
const TOKEN = `${B2C}/b2c_1_tw_website_signin/oauth2/v2.0/token`;
const LOGOUT = `${B2C}/b2c_1_tw_website_signin/oauth2/v2.0/logout`;
const MYACCOUNT = 'https://myaccount.thameswater.co.uk';
const METER_PAGE = `${MYACCOUNT}/mydashboard/my-meters-usage`;
const REDIRECT_URI = 'https://www.thameswater.co.uk/login';
/** The Thames Water website's own (public) client id. */
const CLIENT_ID = 'cedfde2d-79a7-44fd-9833-cae769640d3d';
/** The site answers browsers; the client this is ported from sends the same. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const AJAX = { referer: METER_PAGE, 'x-requested-with': 'XMLHttpRequest' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/** Thames Water refused the email or password: needs the owner, not a retry. */
export class ThamesAuthError extends Error {
  override name = 'ThamesAuthError';
}

interface Cookie {
  name: string;
  value: string;
  /** '' = sent to every host; otherwise the host, or a parent domain if `subdomains`. */
  domain: string;
  subdomains: boolean;
}

/** Just enough of a cookie jar for this flow: no paths, no expiry beyond deletion. */
export class CookieJar {
  private cookies: Cookie[] = [];

  store(url: URL, setCookie: readonly string[]): void {
    for (const header of setCookie) {
      const [pair = '', ...attrs] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = url.hostname;
      let subdomains = false;
      let expired = false;
      for (const attr of attrs) {
        const [k = '', v = ''] = attr.split('=').map((s) => s.trim());
        if (k.toLowerCase() === 'domain' && v) {
          domain = v.replace(/^\./, '').toLowerCase();
          subdomains = true;
        }
        if (k.toLowerCase() === 'max-age' && Number(v) <= 0) expired = true;
        if (k.toLowerCase() === 'expires' && Date.parse(v) < Date.now()) expired = true;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
      if (!expired) this.cookies.push({ name, value, domain, subdomains });
    }
  }

  set(name: string, value: string): void {
    this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === ''));
    this.cookies.push({ name, value, domain: '', subdomains: true });
  }

  get(host: string, name: string): string | undefined {
    return this.matching(host).find((c) => c.name === name)?.value;
  }

  header(host: string): string {
    return this.matching(host)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  private matching(host: string): Cookie[] {
    return this.cookies.filter(
      (c) =>
        c.domain === '' || c.domain === host || (c.subdomains && host.endsWith(`.${c.domain}`)),
    );
  }
}

interface Reply {
  status: number;
  url: URL;
  location: string | null;
  text: string;
}

/** One browser-like session: cookies, manual redirects, the step named in every error. */
export class Session {
  readonly jar = new CookieJar();

  constructor(
    private readonly signal: AbortSignal,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(
    step: string,
    url: string | URL,
    init: {
      method?: 'GET' | 'POST';
      query?: Record<string, string>;
      form?: Record<string, string>;
      headers?: Record<string, string>;
      follow?: boolean;
    } = {},
  ): Promise<Reply> {
    let target = new URL(url);
    for (const [k, v] of Object.entries(init.query ?? {})) target.searchParams.set(k, v);
    let method = init.method ?? 'GET';
    let body = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 10; hop++) {
      const cookie = this.jar.header(target.hostname);
      const res = await this.fetchImpl(target, {
        method,
        signal: this.signal,
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
          ...(body !== undefined ? FORM : {}),
          ...init.headers,
          ...(cookie ? { cookie } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      this.jar.store(target, res.headers.getSetCookie());
      const location = res.headers.get('location');
      if (res.status === 429)
        throw new Error(`Thames Water is rate limiting (${step}); next try later`);
      if (res.status >= 400) {
        await res.body?.cancel();
        throw new Error(`Thames Water answered HTTP ${res.status} at "${step}"`);
      }
      if (res.status >= 300 && res.status < 400 && location && init.follow !== false) {
        await res.body?.cancel();
        target = new URL(location, target);
        // As browsers do: 301/302/303 become a GET without the form; 307/308 keep both.
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return { status: res.status, url: target, location, text: await res.text() };
    }
    throw new Error(`Thames Water redirected too many times at "${step}"`);
  }

  async json(step: string, url: string, init: Parameters<Session['request']>[2] = {}) {
    const reply = await this.request(step, url, init);
    try {
      return JSON.parse(reply.text) as unknown;
    } catch {
      throw new Error(`Thames Water sent something other than JSON at "${step}" (site changed?)`);
    }
  }
}

const base64url = (b: Buffer) => b.toString('base64url');

/** The `name` parameter from a redirect's #fragment. */
function fragmentParam(location: string | null, name: string): string | null {
  if (!location) return null;
  const hash = location.indexOf('#');
  return hash < 0 ? null : new URLSearchParams(location.slice(hash + 1)).get(name);
}

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Thames Water sent a malformed id token');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export interface ThamesSession {
  session: Session;
  accountNumber: string;
}

/** Sign in with the password and open a myaccount session scoped to the contract account. */
export async function signIn(
  env: CollectorEnv,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ThamesSession> {
  const email = requireSetting(env.THAMES_EMAIL, 'THAMES_EMAIL');
  const password = requireSetting(env.THAMES_PASSWORD, 'THAMES_PASSWORD');
  const s = new Session(signal, fetchImpl);

  // 1. Start the B2C flow (PKCE); it sets the transaction and CSRF cookies.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  await s.request('sign-in page', AUTHORIZE, {
    query: {
      client_id: CLIENT_ID,
      scope: 'openid profile offline_access',
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      response_mode: 'fragment',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce: randomUUID(),
      state: randomUUID(),
    },
  });
  const host = new URL(B2C).hostname;
  const trans = s.jar.get(host, 'x-ms-cpim-trans');
  const csrf = s.jar.get(host, 'x-ms-cpim-csrf');
  if (!trans || !csrf) throw new Error('Thames Water sign-in page changed (no session cookies)');

  // 2. Email and password. A refusal comes back as HTTP 200 with its own status field.
  const asserted = await s.json('sign-in', `${B2C}/${FLOW}/SelfAsserted`, {
    method: 'POST',
    query: { tx: `StateProperties=${trans}`, p: FLOW },
    form: { request_type: 'RESPONSE', email, password },
    headers: { 'x-csrf-token': csrf },
  });
  if (String((asserted as { status?: unknown }).status) !== '200') {
    throw new ThamesAuthError(
      'Thames Water refused the login. Check THAMES_EMAIL and THAMES_PASSWORD in .env (your Thames Water account login).',
    );
  }

  // 3. Confirm: the redirect's fragment carries the authorisation code.
  const confirmed = await s.request(
    'sign-in confirmation',
    `${B2C}/${FLOW}/api/CombinedSigninAndSignup/confirmed`,
    {
      query: { rememberMe: 'false', tx: `StateProperties=${trans}`, csrf_token: csrf, p: FLOW },
      follow: false,
    },
  );
  const code = fragmentParam(confirmed.location, 'code');
  if (!code) throw new Error('Thames Water sign-in changed (no authorisation code)');

  // 4. Code → id token.
  const tokens = (await s.json('token', TOKEN, {
    method: 'POST',
    form: {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid offline_access profile',
      grant_type: 'authorization_code',
      client_info: '1',
      code_verifier: verifier,
      code,
    },
  })) as { id_token?: unknown };
  if (typeof tokens.id_token !== 'string') throw new Error('Thames Water sent no id token');

  // 5. Trade it for a myaccount session: the first POST lands on a page carrying a new state
  // (in its URL) and a fresh id token (in a hidden field), which a second POST completes.
  const first = await s.request('account session', `${MYACCOUNT}/login`, {
    method: 'POST',
    form: { id_token: tokens.id_token, state: '' },
  });
  const state = first.url.searchParams.get('state');
  const hidden = /id='id_token' value='([^']+)'/.exec(first.text)?.[1];
  if (!state || !hidden) throw new Error('Thames Water account login page changed');
  await s.request('account session', `${MYACCOUNT}/login`, {
    method: 'POST',
    form: { state, id_token: hidden },
  });
  s.jar.set('b2cAuthenticated', 'true');

  // 6. The account: from .env, else the default named in the id token. The meter page visit
  // scopes the session to it; without it the AJAX endpoints don't answer with JSON.
  const claimed = jwtClaims(tokens.id_token).extension_DefaultContractAccountNumber;
  const accountNumber =
    env.THAMES_ACCOUNT_NUMBER ??
    (typeof claimed === 'string' || typeof claimed === 'number' ? String(claimed) : '');
  if (!accountNumber) throw new Error('No Thames Water account number (set THAMES_ACCOUNT_NUMBER)');
  await s.request('meter page', METER_PAGE, { query: { contractAccountNumber: accountNumber } });
  return { session: s, accountNumber };
}

export async function getMeters(s: Session): Promise<unknown> {
  return s.json('meters', `${MYACCOUNT}/ajax/waterMeter/getMeters`, { headers: AJAX });
}

/** Hourly usage for London dates [start, end] inclusive. */
export async function getHourlyUsage(
  s: Session,
  meter: string,
  start: string,
  end: string,
): Promise<unknown> {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  return s.json('hourly usage', `${MYACCOUNT}/ajax/waterMeter/getSmartWaterMeterConsumptions`, {
    headers: AJAX,
    query: {
      meter,
      startDate: String(sd),
      startMonth: String(sm),
      startYear: String(sy),
      endDate: String(ed),
      endMonth: String(em),
      endYear: String(ey),
      granularity: 'H',
      premiseId: '',
      isForC4C: 'false',
    },
  });
}

/** End the B2C session (best effort: the run's data is already in hand). */
export async function signOut(s: Session): Promise<void> {
  await s.request('sign out', LOGOUT, { follow: false }).catch(() => undefined);
}

export const thamesProvider: WaterProvider = {
  id: 'thames',
  async fetch(from, to, ctx) {
    const { session } = await signIn(ctx.env, ctx.signal);
    try {
      let meter = ctx.env.THAMES_METER_ID;
      if (!meter) {
        const meters = MetersResponseSchema.parse(await getMeters(session)).Meters;
        meter = meters[0];
        if (!meter) throw new Error('The Thames Water account lists no water meter');
        if (meters.length > 1) {
          ctx.log.info(
            { meters: meters.length },
            'several meters on the account; using the first (set THAMES_METER_ID to choose)',
          );
        }
      }
      const start = londonDateString(from);
      // Up to yesterday: the site publishes whole days only, about 3 days late.
      const end = addLondonDays(londonDateString(to), -1);
      const body = await getHourlyUsage(session, meter, start, end);
      const usage = ConsumptionResponseSchema.parse(body);
      if (!usage.IsDataAvailable) {
        throw new Error(
          'Thames Water has no hourly data for this meter (is it a smart meter? Check "My water use" on the account site)',
        );
      }
      return consumptionToReadings(start, body);
    } finally {
      await signOut(session);
    }
  },
};
