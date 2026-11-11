/**
 * netprobe: the network measurements the collector can't make from inside Docker's network
 * (docs/01 § Containers that need host access). Runs with host networking and NET_ADMIN /
 * NET_RAW, and publishes results to MQTT for the collector's `wifi` and `speed_test` sources.
 */
import { HOME_TIME_ZONE } from '@home/shared';
import { Cron } from 'croner';
import mqtt from 'mqtt';
import { pino } from 'pino';
import { z } from 'zod';
import { probeChannels, probeNetwork, probeSpeed, type ProbeResult } from './probes.js';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const env = z
  .object({
    LOG_LEVEL: z.string().default('info'),
    MQTT_URL: z.preprocess(blank, z.string().url().default('mqtt://127.0.0.1:1883')),
    MQTT_NETPROBE_USERNAME: z.preprocess(blank, z.string().optional()),
    MQTT_NETPROBE_PASSWORD: z.preprocess(blank, z.string().optional()),
    WIFI_INTERFACE: z.preprocess(blank, z.string().default('wlan0')),
    PING_TARGET: z.preprocess(blank, z.string().default('1.1.1.1')),
    ROUTER_URL: z.preprocess(blank, z.string().url().optional()),
    ROUTER_PASSWORD: z.preprocess(blank, z.string().optional()),
  })
  .parse(process.env);

const log = pino({ level: env.LOG_LEVEL });
const client = mqtt.connect(env.MQTT_URL, {
  clientId: `home-netprobe-${process.pid}`,
  protocolVersion: 4,
  reconnectPeriod: 5000,
  ...(env.MQTT_NETPROBE_USERNAME && { username: env.MQTT_NETPROBE_USERNAME }),
  ...(env.MQTT_NETPROBE_PASSWORD && { password: env.MQTT_NETPROBE_PASSWORD }),
});
client.on('connect', () => log.info({ broker: new URL(env.MQTT_URL).host }, 'netprobe connected'));
client.on('error', (err) => log.warn({ error: err.message }, 'MQTT error'));

async function publish(source: 'wifi' | 'speed_test', result: ProbeResult): Promise<void> {
  for (const e of result.errors) log.warn({ source, error: e }, 'probe problem');
  if (!client.connected) {
    log.warn({ source }, 'MQTT not connected; dropping this round');
    return;
  }
  await client.publishAsync(`home/net/${source}`, JSON.stringify(result), { qos: 1 });
  log.debug({ source, readings: result.readings.length }, 'published');
}

/** Runs `job` now and every `ms`, never overlapping itself. */
function every(ms: number, name: string, job: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    job()
      .catch((err: unknown) => log.error({ job: name, error: String(err) }, 'probe failed'))
      .finally(() => (running = false));
  };
  setTimeout(tick, 5000); // let MQTT connect first
  return setInterval(tick, ms);
}

const timers = [
  every(5 * 60_000, 'network', async () =>
    publish('wifi', await probeNetwork(env, AbortSignal.timeout(120_000))),
  ),
  every(30 * 60_000, 'channels', async () => publish('wifi', await probeChannels(env))),
];
const speed = new Cron(
  '0 12 * * *',
  {
    timezone: HOME_TIME_ZONE,
    protect: true, // never two at once
    // A throw must not become an unhandled rejection: that would exit netprobe.
    catch: (err) => log.error({ job: 'speed test', error: String(err) }, 'probe failed'),
  },
  async () => {
    log.info('speed test started');
    const result = await probeSpeed();
    log.info(
      {
        readings: result.readings.map((r) => `${r.metric} ${r.value} ${r.unit}`),
        errors: result.errors.length,
      },
      'speed test finished',
    );
    await publish('speed_test', result);
  },
);
log.info(
  {
    interface: env.WIFI_INTERFACE,
    router: env.ROUTER_PASSWORD ? 'JNAP' : 'ARP scan',
    nextSpeedTest: speed.nextRun()?.toISOString(),
  },
  'netprobe started',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    timers.forEach(clearInterval);
    speed.stop();
    void client.endAsync().then(() => process.exit(0));
  });
}
