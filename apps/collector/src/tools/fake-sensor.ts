/**
 * Publishes realistic readings for three rooms over MQTT, exactly as real sensors would
 * (docs/03 § room_sensors), so the pipeline can be proven before real sensors exist.
 *
 *   Local:  pnpm fake-sensor                       (MQTT_URL default mqtt://localhost:1883)
 *   Pi:     docker compose --profile fake up -d fake-sensor
 *           docker compose stop fake-sensor        (room_sensors turns Late within 5 min)
 *
 * To test alerts (docs/09 §9): hold one room's CO₂ high for a while, then back to normal.
 *   pnpm fake-sensor --co2-spike bedroom --ppm 1600 --minutes 20
 */
import { isSnakeCase } from '@home/shared';
import mqtt from 'mqtt';
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { fakeRoomReadings, FAKE_ROOMS, type Co2Spike } from './fake-readings.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
const intervalMs = Number(process.env.FAKE_SENSOR_INTERVAL_SECONDS || 30) * 1000;

const { values: args } = parseArgs({
  options: {
    'co2-spike': { type: 'string' },
    ppm: { type: 'string', default: '1600' },
    minutes: { type: 'string', default: '20' },
  },
});
let spike: Co2Spike | null = null;
if (args['co2-spike']) {
  const room = args['co2-spike'];
  const ppm = Number(args.ppm);
  const minutes = Number(args.minutes);
  if (!isSnakeCase(room) || !(ppm > 0) || !(minutes > 0)) {
    console.error('usage: --co2-spike <room> [--ppm 1600] [--minutes 20]');
    process.exit(1);
  }
  spike = { room, ppm, until: new Date(Date.now() + minutes * 60_000) };
  log.info({ room, ppm, minutes }, 'CO₂ spike: held high, then back to normal');
}

const client = mqtt.connect(url, {
  clientId: `home-fake-sensor-${process.pid}`,
  protocolVersion: 4, // MQTT 3.1.1, like most real ESP32 sensors
  reconnectPeriod: 5000,
  ...(process.env.MQTT_SENSOR_USERNAME && { username: process.env.MQTT_SENSOR_USERNAME }),
  ...(process.env.MQTT_SENSOR_PASSWORD && { password: process.env.MQTT_SENSOR_PASSWORD }),
});
client.on('connect', () =>
  log.info({ broker: new URL(url).host, rooms: FAKE_ROOMS }, 'fake sensor connected'),
);
client.on('error', (err) => log.warn({ error: err.message }, 'MQTT error'));

async function publishAll() {
  if (!client.connected) return;
  const messages = fakeRoomReadings(new Date(), undefined, spike);
  await Promise.all(
    messages.map((m) => client.publishAsync(m.topic, JSON.stringify(m.payload), { qos: 1 })),
  );
  log.debug({ published: messages.length }, 'published');
}

const timer = setInterval(
  () => void publishAll().catch((err: Error) => log.warn({ error: err.message }, 'publish failed')),
  intervalMs,
);
client.once('connect', () => void publishAll());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void client.endAsync().then(() => process.exit(0));
  });
}
