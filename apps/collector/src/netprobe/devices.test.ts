import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRandomised, mergeDevices, parseArpDevices, SeenDeviceSchema } from './devices.js';
import type { RouterClient } from './router.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

describe('parseArpDevices', () => {
  it('lists each device once with its maker; unknown and private ones have none', () => {
    const devices = parseArpDevices(fixture('arp-scan-vendors.txt'));
    expect(devices.map((d) => [d.mac, d.ip, d.vendor])).toEqual([
      ['a4:c3:f0:11:22:33', '192.168.1.1', 'TP-LINK TECHNOLOGIES CO.,LTD.'],
      ['b8:27:eb:aa:bb:cc', '192.168.1.20', 'Raspberry Pi Foundation'],
      ['24:6f:28:01:02:03', '192.168.1.31', 'Espressif Inc.'],
      ['3a:1f:9c:5e:77:01', '192.168.1.47', null],
      ['00:11:22:33:44:55', '192.168.1.52', null],
    ]);
    for (const d of devices) expect(SeenDeviceSchema.safeParse(d).success).toBe(true);
  });

  it('also reads the --quiet format (no maker column)', () => {
    expect(parseArpDevices(fixture('arp-scan.txt'))).toHaveLength(4);
  });
});

describe('isRandomised', () => {
  it('spots private (locally administered) addresses', () => {
    expect(isRandomised('3a:1f:9c:5e:77:01')).toBe(true);
    expect(isRandomised('b8:27:eb:aa:bb:cc')).toBe(false);
    expect(isRandomised('02:00:00:00:00:01')).toBe(true);
  });
});

describe('mergeDevices', () => {
  const client = (over: Partial<RouterClient>): RouterClient => ({
    key: 'device_x',
    name: 'Unknown device',
    band: '5',
    signalDbm: -50,
    linkMbps: 400,
    viaSatellite: false,
    mac: null,
    ip: null,
    manufacturer: null,
    ...over,
  });

  it('adds the router names and links, and devices ARP missed, never dropping any', () => {
    const arp = parseArpDevices(fixture('arp-scan-vendors.txt'));
    const merged = mergeDevices(arp, [
      client({ mac: 'b8:27:eb:aa:bb:cc', name: 'raspberrypi', band: 'wired' }),
      client({ mac: '3a:1f:9c:5e:77:01', name: 'Unknown (Samsung)' }),
      client({
        mac: 'f0:f0:f0:00:00:01',
        name: "Anna's iPad",
        ip: '192.168.1.60',
        manufacturer: 'Apple',
      }),
    ]);
    expect(merged).toHaveLength(6);
    expect(merged.find((d) => d.mac === 'b8:27:eb:aa:bb:cc')).toMatchObject({
      hostname: 'raspberrypi',
      wired: true,
      vendor: 'Raspberry Pi Foundation',
    });
    expect(merged.find((d) => d.mac === '3a:1f:9c:5e:77:01')).toMatchObject({
      hostname: null,
      wired: false,
    });
    expect(merged.find((d) => d.mac === 'f0:f0:f0:00:00:01')).toEqual({
      mac: 'f0:f0:f0:00:00:01',
      ip: '192.168.1.60',
      vendor: 'Apple',
      hostname: "Anna's iPad",
      wired: false,
    });
  });
});
