import type { FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import { AUDIENCE, fakeAccess, ISSUER, TEAM } from './test/access-token.js';

const INDEX_HTML = '<!doctype html><title>Home</title><h1>Home dashboard is running</h1>';

let publicDir: string;
let access: Awaited<ReturnType<typeof fakeAccess>>;

function config(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    port: 3000,
    logLevel: 'silent',
    version: '1.2.3',
    publicDir,
    auth: {
      disabled: false,
      team: TEAM,
      audience: AUDIENCE,
      issuer: ISSUER,
      certsUrl: `${ISSUER}/cdn-cgi/access/certs`,
    },
    ...overrides,
  };
}

beforeAll(async () => {
  publicDir = mkdtempSync(join(tmpdir(), 'home-web-'));
  writeFileSync(join(publicDir, 'index.html'), INDEX_HTML);
  mkdirSync(join(publicDir, 'assets'));
  writeFileSync(join(publicDir, 'assets', 'index-abc123.js'), 'console.log(1)');
  access = await fakeAccess();
});

afterAll(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

describe('with Cloudflare Access enabled', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer(config(), { accessKeys: access.keys });
    app.get('/api/test/whoami', (request) => request.identity);
    await app.ready();
  });
  afterAll(() => app.close());

  const get = (url: string, token?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: token === undefined ? {} : { 'cf-access-jwt-assertion': token },
    });

  it('serves /api/health without a token, with no data in it', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'down', version: '1.2.3' });
  });

  it('serves HEAD /api/health without a token', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it.each(['/', '/rooms', '/assets/index-abc123.js', '/api/sources', '/api/does-not-exist'])(
    'rejects %s without a token (401, JSON error, no hint of what exists)',
    async (url) => {
      const res = await get(url);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Sign-in required' } });
    },
  );

  it('rejects a token for another Access application (wrong audience)', async () => {
    const res = await get('/', await access.sign(undefined, { audience: 'someone-elses-app' }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token from another Access team (wrong issuer)', async () => {
    const issuer = 'https://evil.cloudflareaccess.com';
    expect((await get('/', await access.sign(undefined, { issuer }))).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 120;
    expect((await get('/', await access.sign(undefined, { expiresAt }))).statusCode).toBe(401);
  });

  it('rejects a token signed by a key Access does not publish', async () => {
    expect((await get('/', await access.signWithUnknownKey())).statusCode).toBe(401);
  });

  it('rejects garbage', async () => {
    expect((await get('/', 'not-a-jwt')).statusCode).toBe(401);
    expect((await get('/', 'a.b.c')).statusCode).toBe(401);
  });

  it('serves the web app with a valid token', async () => {
    const res = await get('/', await access.sign());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Home dashboard is running');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await get('/rooms', await access.sign());
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Home dashboard is running');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('caches hashed assets forever, privately', async () => {
    const res = await get('/assets/index-abc123.js', await access.sign());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('returns a JSON 404 for unknown API paths (not index.html)', async () => {
    const res = await get('/api/does-not-exist', await access.sign());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('exposes who signed in: a person', async () => {
    const res = await get('/api/test/whoami', await access.sign({ email: 'owner@example.com' }));
    expect(res.json()).toEqual({ sub: 'user-123', email: 'owner@example.com' });
  });

  it('exposes who signed in: a service token (Android app)', async () => {
    const res = await get('/api/test/whoami', await access.sign({ common_name: 'abc.access' }));
    expect(res.json()).toEqual({ sub: 'user-123', commonName: 'abc.access' });
  });
});

describe('when Cloudflare signing keys cannot be fetched', () => {
  it('answers 503, not 401, so a Cloudflare outage is not mistaken for a bad login', async () => {
    const app = await buildServer(config(), {
      accessKeys: () => Promise.reject(new TypeError('fetch failed')),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'cf-access-jwt-assertion': await access.sign() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    await app.close();
  });
});

describe('with AUTH_DISABLED (development)', () => {
  it('serves pages without a token', async () => {
    const app = await buildServer(config({ auth: { disabled: true } }));
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('without a web build', () => {
  it('serves the API only and 404s pages as JSON', async () => {
    const app = await buildServer(config({ auth: { disabled: true }, publicDir: null }));
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await app.close();
  });
});
