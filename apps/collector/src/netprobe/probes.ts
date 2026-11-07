import type { ReadingInput } from '@home/shared';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseArpScan,
  parseDefaultGateway,
  parseIwLink,
  parseIwScan,
  parsePing,
  summariseScan,
} from './parse.js';
import { jnap, parseDevices } from './router.js';
import { speedTest } from './speedtest.js';

const exec = promisify(execFile);

export interface ProbeEnv {
  WIFI_INTERFACE: string;
  PING_TARGET: string;
  ROUTER_URL?: string | undefined;
  ROUTER_PASSWORD?: string | undefined;
}

export interface ProbeResult {
  readings: ReadingInput[];
  /** Problems that didn't stop the other measurements. */
  errors: string[];
}

async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { timeout: timeoutMs, maxBuffer: 4_000_000 });
  return stdout;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message.split('\n')[0]! : String(err);

/** Every 5 minutes: the Pi's own link, latency/loss to the router and the internet, devices. */
export async function probeNetwork(env: ProbeEnv, signal: AbortSignal): Promise<ProbeResult> {
  const ts = new Date();
  const readings: ReadingInput[] = [];
  const errors: string[] = [];
  const add = (
    metric: string,
    entity: string,
    unit: string,
    value: number,
    valueType: 'gauge' | 'state' = 'gauge',
  ) => readings.push({ metric, entity, unit, valueType, ts, value });
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(`${what}: ${message(err)}`);
    }
  };

  let gateway: string | null = null;
  await attempt('route', async () => {
    gateway = parseDefaultGateway(await run('ip', ['route', 'show', 'default']));
  });
  await attempt('wifi link', async () => {
    const link = parseIwLink(await run('iw', ['dev', env.WIFI_INTERFACE, 'link']));
    if (!link) return; // on Ethernet: nothing to report
    add('wifi_rssi', 'pi', 'dBm', link.signalDbm);
    if (link.txMbps !== null) add('wifi_bitrate', 'pi', 'Mbit/s', link.txMbps);
  });
  for (const [entity, host] of [
    ['router', gateway],
    ['internet', env.PING_TARGET],
  ] as const) {
    if (!host) continue;
    await attempt(`ping ${entity}`, async () => {
      // ping exits non-zero on loss; its summary is still on stdout.
      const out = await run('ping', ['-q', '-n', '-c', '10', '-i', '0.2', '-W', '2', host]).catch(
        (e: { stdout?: string }) => {
          if (e.stdout) return e.stdout;
          throw e;
        },
      );
      const p = parsePing(out);
      add('packet_loss', entity, '%', p.lossPercent);
      if (p.avgMs !== null) add('latency', entity, 'ms', Math.round(p.avgMs * 10) / 10);
    });
  }
  await attempt('devices', async () => {
    if (env.ROUTER_PASSWORD) {
      const base = env.ROUTER_URL ?? (gateway ? `http://${gateway}` : null);
      if (!base) throw new Error('no router address (set ROUTER_URL)');
      const d = parseDevices(
        await jnap(base, env.ROUTER_PASSWORD, 'devicelist/GetDevices3', signal),
      );
      add('devices_connected', 'network', 'devices', d.total);
      add('devices_wifi', 'network', 'devices', d.wifi);
      add('devices_wired', 'network', 'devices', d.wired);
    } else {
      // Without the router's API: whoever answers ARP on the local network.
      add(
        'devices_connected',
        'network',
        'devices',
        parseArpScan(
          await run('arp-scan', ['--localnet', '--plain', '--quiet', '--retry=2'], 60_000),
        ),
      );
    }
  });
  return { readings, errors };
}

/** Every 30 minutes: who else is on our Wi-Fi channels. */
export async function probeChannels(env: ProbeEnv): Promise<ProbeResult> {
  const ts = new Date();
  try {
    const link = parseIwLink(await run('iw', ['dev', env.WIFI_INTERFACE, 'link']));
    const scan = parseIwScan(await run('iw', ['dev', env.WIFI_INTERFACE, 'scan'], 30_000));
    const readings: ReadingInput[] = summariseScan(scan, link?.ssid ?? null).flatMap((b) => {
      const entity = `band_${b.band.replace('.', '_')}ghz`;
      const out: ReadingInput[] = [
        {
          metric: 'neighbour_networks',
          entity,
          unit: 'networks',
          valueType: 'gauge',
          ts,
          value: b.neighbours,
        },
        {
          metric: 'neighbours_on_channel',
          entity,
          unit: 'networks',
          valueType: 'gauge',
          ts,
          value: b.onOwnChannel,
        },
      ];
      if (b.ownChannel !== null)
        out.push({
          metric: 'wifi_channel',
          entity,
          unit: 'channel',
          valueType: 'state',
          ts,
          value: b.ownChannel,
        });
      return out;
    });
    return { readings, errors: [] };
  } catch (err) {
    return { readings: [], errors: [`channel scan: ${message(err)}`] };
  }
}

/** Daily: broadband download, upload and latency. */
export async function probeSpeed(signal: AbortSignal): Promise<ProbeResult> {
  const ts = new Date();
  try {
    const s = await speedTest(signal);
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      readings: [
        {
          metric: 'download',
          entity: 'internet',
          unit: 'Mbit/s',
          valueType: 'gauge',
          ts,
          value: round(s.downloadMbps),
        },
        {
          metric: 'upload',
          entity: 'internet',
          unit: 'Mbit/s',
          valueType: 'gauge',
          ts,
          value: round(s.uploadMbps),
        },
        {
          metric: 'latency',
          entity: 'speed_test',
          unit: 'ms',
          valueType: 'gauge',
          ts,
          value: round(s.latencyMs),
        },
      ],
      errors: [],
    };
  } catch (err) {
    return { readings: [], errors: [`speed test: ${message(err)}`] };
  }
}
