import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseArpScan,
  parseDefaultGateway,
  parseIwLink,
  parseIwScan,
  parsePing,
  summariseScan,
} from './parse.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

describe('parseIwLink', () => {
  it('reads the Pi’s own connection', () => {
    expect(parseIwLink(fixture('iw-link.txt'))).toEqual({
      ssid: 'HomeMesh',
      freqMhz: 5180,
      signalDbm: -58,
      txMbps: 173.3,
    });
  });

  it('is null when the Pi is not on Wi-Fi', () => {
    expect(parseIwLink(fixture('iw-link-ethernet.txt'))).toBeNull();
  });

  it('fails loudly on output it does not understand', () => {
    expect(() => parseIwLink('Connected to aa:bb:cc:dd:ee:ff (on wlan0)\n\tSSID: X\n')).toThrow(
      /not understood/,
    );
  });
});

describe('parseIwScan and summariseScan', () => {
  const networks = parseIwScan(fixture('iw-scan.txt'));

  it('reads every network heard', () => {
    expect(networks).toHaveLength(6);
    expect(networks[0]).toEqual({
      bssid: 'a4:c3:f0:11:22:33',
      freqMhz: 5180,
      signalDbm: -58,
      ssid: 'HomeMesh',
      associated: true,
    });
  });

  it('counts neighbours per band, treating our mesh nodes (same SSID) as ours', () => {
    expect(summariseScan(networks, 'HomeMesh')).toEqual([
      { band: '2.4', ownChannel: 6, neighbours: 3, onOwnChannel: 1 },
      { band: '5', ownChannel: 36, neighbours: 1, onOwnChannel: 0 },
    ]);
  });
});

describe('parsePing', () => {
  it('reads latency and loss', () => {
    expect(parsePing(fixture('ping-router.txt'))).toEqual({
      sent: 10,
      received: 10,
      lossPercent: 0,
      avgMs: 3.104,
    });
    expect(parsePing(fixture('ping-lossy.txt'))).toEqual({
      sent: 10,
      received: 9,
      lossPercent: 10,
      avgMs: 14.218,
    });
  });

  it('has no latency when nothing came back', () => {
    expect(parsePing(fixture('ping-down.txt'))).toEqual({
      sent: 10,
      received: 0,
      lossPercent: 100,
      avgMs: null,
    });
  });
});

describe('parseArpScan and parseDefaultGateway', () => {
  it('counts distinct devices', () => {
    expect(parseArpScan(fixture('arp-scan.txt'))).toBe(4);
  });

  it('finds the router', () => {
    expect(parseDefaultGateway(fixture('ip-route.txt'))).toBe('192.168.1.1');
    expect(parseDefaultGateway('')).toBeNull();
  });
});
