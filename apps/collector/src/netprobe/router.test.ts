import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jnap, parseDevices, RouterAuthError } from './router.js';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/jnap-devices.json', import.meta.url), 'utf8'),
) as unknown;
const signal = new AbortController().signal;

describe('parseDevices', () => {
  it('counts connected clients, excluding the router and mesh nodes, split by interface', () => {
    expect(parseDevices(fixture)).toEqual({ total: 3, wifi: 2, wired: 1 });
  });

  it('refuses output without a device list', () => {
    expect(() => parseDevices({})).toThrow();
  });
});

describe('jnap', () => {
  it('sends the action and admin password as JNAP expects', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake = ((url: URL, init: RequestInit) => {
      seen = { url: url.toString(), headers: init.headers as Record<string, string> };
      return Promise.resolve(Response.json({ result: 'OK', output: { devices: [] } }));
    }) as unknown as typeof fetch;
    expect(
      await jnap('http://192.168.1.1', 'secret-pw', 'devicelist/GetDevices3', signal, {}, fake),
    ).toEqual({ devices: [] });
    expect(seen?.url).toBe('http://192.168.1.1/JNAP/');
    expect(seen?.headers['x-jnap-action']).toBe('http://linksys.com/jnap/devicelist/GetDevices3');
    expect(seen?.headers['x-jnap-authorization']).toBe(
      `Basic ${Buffer.from('admin:secret-pw').toString('base64')}`,
    );
  });

  it('reports a wrong password clearly, without echoing it', async () => {
    const fake = (() =>
      Promise.resolve(Response.json({ result: '_ErrorUnauthorized' }))) as unknown as typeof fetch;
    const err = await jnap(
      'http://192.168.1.1',
      'secret-pw',
      'devicelist/GetDevices3',
      signal,
      {},
      fake,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouterAuthError);
    expect((err as Error).message).not.toContain('secret-pw');
  });
});
