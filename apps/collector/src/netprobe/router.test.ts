import { readFileSync } from 'node:fs';
import { ReadingInputSchema } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { routerReadings } from './probes.js';
import { jnap, parseDevices, parseRouterSnapshot, RouterAuthError } from './router.js';

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

describe('parseRouterSnapshot (owner’s MX4200 capture, 2026-11-09)', () => {
  const mx = JSON.parse(
    readFileSync(new URL('./__fixtures__/jnap-mx4200.json', import.meta.url), 'utf8'),
  ) as { devices: unknown; connections: unknown };
  const snapshot = parseRouterSnapshot(mx.devices, mx.connections);

  it('lists the 13 connected clients, leaving out the router and its satellite', () => {
    expect(snapshot.counts).toEqual({ total: 13, wifi: 13, wired: 0 });
    expect(snapshot.clients).toHaveLength(13);
    expect(new Set(snapshot.clients.map((c) => c.key)).size).toBe(13);
    for (const c of snapshot.clients) expect(c.key).toMatch(/^device_[a-z0-9]+$/);
  });

  it('joins band, signal and link speed from the main router by MAC', () => {
    const withSignal = snapshot.clients.filter((c) => c.signalDbm !== null);
    expect(withSignal.map((c) => c.signalDbm).sort((a, b) => a! - b!)).toEqual([
      -87, -77, -76, -73, -73, -71, -66, -65, -62, -43, -36,
    ]);
    const weakest = snapshot.clients.find((c) => c.signalDbm === -87);
    expect(weakest).toMatchObject({
      key: 'device_redacteddeviceid10',
      name: 'device 13',
      band: '2.4',
      linkMbps: 1,
      viaSatellite: false,
    });
  });

  it('marks the satellite’s clients, which have a band but no signal', () => {
    const via = snapshot.clients.filter((c) => c.viaSatellite);
    expect(via).toHaveLength(2);
    for (const c of via) {
      expect(c.signalDbm).toBeNull();
      expect(c.band).not.toBeNull();
    }
  });

  it('prefers the name given in the Linksys app', () => {
    const given = snapshot.clients.filter((c) => /^device \d+$/.test(c.name));
    expect(given).toHaveLength(13); // every name in the fixture is a placeholder
    expect(
      parseRouterSnapshot(
        {
          devices: [
            {
              deviceID: 'A1',
              friendlyName: 'android-123',
              properties: [{ name: 'userDeviceName', value: 'Kitchen tablet' }],
              connections: [{ macAddress: 'x' }],
            },
            { deviceID: 'B2', model: { manufacturer: 'Espressif' }, connections: [{}] },
            { deviceID: 'C3', connections: [{}] },
          ],
        },
        null,
      ).clients.map((c) => c.name),
    ).toEqual(['Kitchen tablet', 'Unknown (Espressif)', 'Unknown device']);
  });

  it('reports the satellite’s own link to the main router', () => {
    expect(snapshot.satellites).toEqual([
      {
        key: 'node_redacteddeviceid4',
        name: expect.any(String) as string,
        band: '5',
        signalDbm: -62,
        linkMbps: 960,
      },
    ]);
  });
});

describe('routerReadings', () => {
  const ts = new Date('2026-11-09T12:00:00Z');
  it('publishes labelled per-device series and backhaul series', () => {
    const readings = routerReadings(
      {
        counts: { total: 2, wifi: 1, wired: 1 },
        clients: [
          {
            key: 'device_a1',
            name: 'Laptop',
            band: '5',
            signalDbm: -51,
            linkMbps: 866,
            viaSatellite: false,
          },
          {
            key: 'device_b2',
            name: 'Desktop PC',
            band: 'wired',
            signalDbm: null,
            linkMbps: null,
            viaSatellite: true,
          },
        ],
        satellites: [
          { key: 'node_c3', name: 'Upstairs', band: '5', signalDbm: -62, linkMbps: 960 },
        ],
      },
      ts,
    );
    const by = (metric: string, entity: string) =>
      readings.find((r) => r.metric === metric && r.entity === entity);
    expect(by('device_signal', 'device_a1')).toMatchObject({
      unit: 'dBm',
      valueType: 'gauge',
      value: -51,
      label: 'Laptop',
      ts,
    });
    expect(by('device_band', 'device_b2')?.value).toBe(0); // wired
    expect(by('device_signal', 'device_b2')).toBeUndefined();
    expect(by('device_via_satellite', 'device_b2')?.value).toBe(1);
    expect(by('backhaul_signal', 'node_c3')).toMatchObject({ value: -62, label: 'Upstairs' });
    expect(by('backhaul_via_satellite', 'node_c3')).toBeUndefined();
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });
});
