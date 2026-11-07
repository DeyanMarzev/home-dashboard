import type { ReadingInput } from '@home/shared';
import mqtt from 'mqtt';
import type { PushCollector } from '../../collector.js';
import { describeError } from '../../errors.js';
import { parseSensorMessage, SensorMessageError } from './parse.js';

/**
 * Batch database writes (CLAUDE.md rule 8), but flush every second so a reading reaches the
 * browser within ~2 s (M4). A sensor's burst of metrics still lands in one write; an empty
 * buffer costs nothing.
 */
const FLUSH_INTERVAL_MS = 1000;
/** If the database is down, keep at most this many readings, dropping the oldest. */
const MAX_BUFFERED = 20_000;

/** Subscribes to the registry's `mqtt_topic` and writes sensor readings in batches. */
export const roomSensors: PushCollector = {
  id: 'room_sensors',
  kind: 'push',
  // Doesn't wait for the broker: mqtt.js connects (and reconnects) in the background.
  subscribe(ctx) {
    const topic = ctx.source.mqttTopic ?? 'home/sensors/+/+';
    let buffer: ReadingInput[] = [];
    let dropped = 0;
    let rejected = new Map<string, number>(); // reason → count, logged once per flush

    const client = mqtt.connect(ctx.env.MQTT_URL, {
      clientId: `home-collector-${ctx.source.id}`,
      protocolVersion: 4, // MQTT 3.1.1: no v5 features needed; what most ESP32 libraries speak
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      ...(ctx.env.MQTT_USERNAME && { username: ctx.env.MQTT_USERNAME }),
      ...(ctx.env.MQTT_PASSWORD && { password: ctx.env.MQTT_PASSWORD }),
    });

    client.on('connect', () => {
      ctx.log.info({ broker: new URL(ctx.env.MQTT_URL).host, topic }, 'MQTT connected');
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) ctx.reportError(`MQTT subscribe to ${topic} failed: ${err.message}`);
      });
    });
    client.on('offline', () => ctx.reportError('MQTT broker unreachable; reconnecting'));
    client.on('error', (err) => ctx.reportError(`MQTT: ${err.message}`));

    client.on('message', (msgTopic, payload) => {
      try {
        buffer.push(...parseSensorMessage(msgTopic, payload, new Date()));
      } catch (err) {
        // Never throw from an event handler: it would crash the whole collector.
        const reason = `${msgTopic}: ${err instanceof SensorMessageError ? err.message : describeError(err)}`;
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
        return;
      }
      if (buffer.length > MAX_BUFFERED) {
        dropped += buffer.length - MAX_BUFFERED;
        buffer = buffer.slice(-MAX_BUFFERED);
      }
    });

    let flushing: Promise<void> = Promise.resolve();
    const flush = async () => {
      for (const [reason, count] of rejected)
        ctx.log.warn({ count }, `rejected sensor message: ${reason}`);
      rejected = new Map();
      if (dropped > 0) {
        ctx.reportError(
          `buffer full: dropped ${dropped} readings while the database was unavailable`,
        );
        dropped = 0;
      }
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      try {
        await ctx.writeReadings(batch);
      } catch (err) {
        // Put them back so the next flush retries; newest readings win if the buffer overflows.
        buffer = [...batch, ...buffer].slice(-MAX_BUFFERED);
        ctx.reportError(`write failed, will retry: ${describeError(err)}`);
      }
    };
    const timer = setInterval(() => {
      flushing = flushing.then(flush);
    }, FLUSH_INTERVAL_MS);

    return Promise.resolve({
      async stop() {
        clearInterval(timer);
        await client.endAsync();
        await flushing;
        await flush();
      },
    });
  },
};
