import { channelOf } from '@home/shared';

/** Parsers for the Linux tools netprobe runs (pure: text in, numbers out). */

export interface WifiLink {
  ssid: string | null;
  freqMhz: number;
  signalDbm: number;
  /** Transmit bitrate, Mbit/s. */
  txMbps: number | null;
}

/** `iw dev wlan0 link`; null when not connected (e.g. the Pi is on Ethernet). */
export function parseIwLink(text: string): WifiLink | null {
  if (/^Not connected\.?/m.test(text) || !/^Connected to /m.test(text)) return null;
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  const freqMhz = num(/^\s*freq:\s*([\d.]+)/m);
  const signalDbm = num(/^\s*signal:\s*(-?[\d.]+)\s*dBm/m);
  if (freqMhz === null || signalDbm === null) throw new Error('iw link output not understood');
  return {
    ssid: /^\s*SSID:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? null,
    freqMhz,
    signalDbm,
    txMbps: num(/^\s*tx bitrate:\s*([\d.]+)\s*MBit\/s/m),
  };
}

export interface ScannedNetwork {
  bssid: string;
  freqMhz: number;
  signalDbm: number;
  ssid: string;
  associated: boolean;
}

/** `iw dev wlan0 scan`: one entry per BSS. */
export function parseIwScan(text: string): ScannedNetwork[] {
  return text
    .split(/^BSS /m)
    .slice(1)
    .flatMap((block) => {
      const bssid = /^([0-9a-f:]{17})/i.exec(block)?.[1];
      const freq = /^\s*freq:\s*([\d.]+)/m.exec(block)?.[1];
      const signal = /^\s*signal:\s*(-?[\d.]+)\s*dBm/m.exec(block)?.[1];
      if (!bssid || !freq || !signal) return [];
      return [
        {
          bssid: bssid.toLowerCase(),
          freqMhz: Number(freq),
          signalDbm: Number(signal),
          ssid: /^\s*SSID:\s*(.*)$/m.exec(block)?.[1]?.trim() ?? '',
          associated: /--\s*associated/.test(block.split('\n')[0] ?? ''),
        },
      ];
    });
}

export interface BandSummary {
  band: '2.4' | '5' | '6';
  /** Our channel on this band (from the network we're on, or our other BSSIDs with the same SSID). */
  ownChannel: number | null;
  /** Other networks (different SSID) heard on this band. */
  neighbours: number;
  /** Other networks on our channel. */
  onOwnChannel: number;
}

/** Neighbours per band, relative to our own network (same SSID = ours, e.g. other mesh nodes). */
export function summariseScan(
  networks: readonly ScannedNetwork[],
  ownSsid: string | null,
): BandSummary[] {
  const bands = new Map<BandSummary['band'], BandSummary>();
  const own = networks.filter((n) => n.associated || (ownSsid && n.ssid === ownSsid));
  for (const n of networks) {
    const ch = channelOf(n.freqMhz);
    if (!ch) continue;
    const b = bands.get(ch.band) ?? {
      band: ch.band,
      ownChannel: null,
      neighbours: 0,
      onOwnChannel: 0,
    };
    bands.set(ch.band, b);
  }
  for (const b of bands.values()) {
    const ours = own.map((n) => channelOf(n.freqMhz)).find((c) => c?.band === b.band);
    b.ownChannel = ours?.channel ?? null;
    for (const n of networks) {
      const ch = channelOf(n.freqMhz);
      if (ch?.band !== b.band || own.includes(n)) continue;
      b.neighbours++;
      if (ch.channel === b.ownChannel) b.onOwnChannel++;
    }
  }
  return [...bands.values()].sort((a, b) => a.band.localeCompare(b.band));
}

export interface PingResult {
  sent: number;
  received: number;
  lossPercent: number;
  avgMs: number | null;
}

/** `ping -q -c N host` summary (iputils). */
export function parsePing(text: string): PingResult {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(text);
  if (!counts) throw new Error('ping output not understood');
  const sent = Number(counts[1]);
  const received = Number(counts[2]);
  const rtt = /= [\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+ ms/.exec(text);
  return {
    sent,
    received,
    lossPercent: sent ? Math.round(((sent - received) / sent) * 100) : 100,
    avgMs: rtt ? Number(rtt[1]) : null,
  };
}

/** `arp-scan --localnet --plain --quiet`: number of distinct devices answering. */
export function parseArpScan(text: string): number {
  const macs = new Set(
    text
      .split('\n')
      .map((line) => /^\d+\.\d+\.\d+\.\d+\s+([0-9a-f:]{17})/i.exec(line.trim())?.[1]?.toLowerCase())
      .filter((m): m is string => !!m),
  );
  return macs.size;
}

/** `ip route show default` → the gateway (router) address. */
export function parseDefaultGateway(text: string): string | null {
  return /^default via (\S+)/m.exec(text)?.[1] ?? null;
}
