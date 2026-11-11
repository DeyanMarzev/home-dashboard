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
import { jnap, parseRouterSnapshot, type Band, type RouterSnapshot } from './router.js';
import { speedTest, type CurlRunner } from './speedtest.js';

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

/** Band as a number for a `state` series: 2.4, 5 or 6 GHz; 0 for wired. */
const BAND_VALUE: Record<Band, number> = { '2.4': 2.4, '5': 5, '6': 6, wired: 0 };

/**
 * Per-device readings (docs/03 § wifi): entity `device_<router id>` labelled with the device's
 * name; satellites' own links as `backhaul_*` on `node_<router id>`.
 */
export function routerReadings(snapshot: RouterSnapshot, ts: Date): ReadingInput[] {
  const readings: ReadingInput[] = [];
  const links = [
    ...snapshot.clients.map((c) => ({ ...c, prefix: 'device' })),
    ...snapshot.satellites.map((s) => ({ ...s, prefix: 'backhaul', viaSatellite: undefined })),
  ];
  for (const l of links) {
    const add = (metric: string, unit: string, value: number, valueType: 'gauge' | 'state') =>
      readings.push({
        metric: `${l.prefix}_${metric}`,
        entity: l.key,
        unit,
        valueType,
        ts,
        value,
        label: l.name,
      });
    if (l.band !== null) add('band', 'GHz', BAND_VALUE[l.band], 'state');
    if (l.signalDbm !== null) add('signal', 'dBm', l.signalDbm, 'gauge');
    if (l.linkMbps !== null) add('link_speed', 'Mbit/s', l.linkMbps, 'gauge');
    if (l.viaSatellite !== undefined) add('via_satellite', 'flag', l.viaSatellite ? 1 : 0, 'state');
  }
  return readings;
}

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
      const devices = await jnap(base, env.ROUTER_PASSWORD, 'devicelist/GetDevices3', signal);
      // Band, signal and link speed: without them the devices are still listed.
      let connections: unknown = null;
      await attempt('router connections', async () => {
        connections = await jnap(
          base,
          env.ROUTER_PASSWORD!,
          'networkconnections/GetNetworkConnections2',
          signal,
        );
      });
      const snapshot = parseRouterSnapshot(devices, connections);
      add('devices_connected', 'network', 'devices', snapshot.counts.total);
      add('devices_wifi', 'network', 'devices', snapshot.counts.wifi);
      add('devices_wired', 'network', 'devices', snapshot.counts.wired);
      readings.push(...routerReadings(snapshot, ts));
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
/** curl for the speed test; a failure reports curl's own message (e.g. "curl: (28) …"). */
const curl: CurlRunner = async (args) => {
  try {
    return await run('curl', args, 90_000);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr ? stderr.split('\n')[0] : message(err), { cause: err });
  }
};

export async function probeSpeed(): Promise<ProbeResult> {
  const ts = new Date();
  try {
    const s = await speedTest(curl);
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
