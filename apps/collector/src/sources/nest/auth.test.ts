import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAccessToken, getAccessToken, NestAuthError } from './auth.js';

const creds = {
  clientId: 'client-id-x1',
  clientSecret: 'client-secret-x2',
  refreshToken: '1//refresh-token-x3',
};
const signal = new AbortController().signal;
const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
});

describe('getAccessToken', () => {
  it('refreshes once, then reuses the token until shortly before it expires', async () => {
    const fetch = vi.fn(() => reply(200, { access_token: 'a1', expires_in: 3599 }));
    vi.stubGlobal('fetch', fetch);
    expect(await getAccessToken(creds, signal, 0)).toBe('a1');
    expect(await getAccessToken(creds, signal, 3000_000)).toBe('a1');
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
      .body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');

    fetch.mockImplementation(() => reply(200, { access_token: 'a2', expires_in: 3599 }));
    expect(await getAccessToken(creds, signal, 3500_000)).toBe('a2');
  });

  it('reports a refused refresh token as a NestAuthError naming the fix, without the token', async () => {
    vi.stubGlobal('fetch', () =>
      reply(400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
    );
    const err = await getAccessToken(creds, signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NestAuthError);
    expect((err as Error).message).toMatch(/invalid_grant.*NEST_REFRESH_TOKEN/);
    expect((err as Error).message).not.toContain('refresh-token-x3');
    expect((err as Error).message).not.toContain('client-secret-x2');
  });

  it('treats a server error as retryable, not an auth problem', async () => {
    vi.stubGlobal('fetch', () => reply(503, {}));
    const err = await getAccessToken(creds, signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NestAuthError);
    expect((err as Error).message).toMatch(/HTTP 503/);
  });
});
