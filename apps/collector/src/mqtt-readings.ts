import mqtt from 'mqtt';
import { z } from 'zod';
import type { PushCollector } from './collector.js';
import { describeError } from './errors.js';

/** What another container (e.g. netprobe) publishes: ready-made readings, plus any problems. */
const MessageSchema = z.object({
  readings: z.array(z.unknown()),
  errors: z.array(z.string()).default([]),
});

/**
 * A push collector for a source whose readings arrive pre-built over MQTT on the registry's
 * `mqtt_topic`. Readings are validated by writeReadings; reported problems show in collector_runs.
 */
export function mqttReadingsCollector(id: string): PushCollector {
  return {
    id,
    kind: 'push',
    subscribe(ctx) {
      const topic = ctx.source.mqttTopic ?? `home/net/${id}`;
      const client = mqtt.connect(ctx.env.MQTT_URL, {
        clientId: `home-collector-${id}`,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 5000,
        ...(ctx.env.MQTT_USERNAME && { username: ctx.env.MQTT_USERNAME }),
        ...(ctx.env.MQTT_PASSWORD && { password: ctx.env.MQTT_PASSWORD }),
      });
      client.on('connect', () => {
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) ctx.reportError(`MQTT subscribe to ${topic} failed: ${err.message}`);
        });
      });
      client.on('error', (err) => ctx.reportError(`MQTT: ${err.message}`));

      let writing: Promise<void> = Promise.resolve();
      client.on('message', (_topic, payload) => {
        writing = writing.then(async () => {
          try {
            const message = MessageSchema.parse(JSON.parse(payload.toString()));
            for (const e of message.errors) ctx.reportError(e);
            if (message.readings.length)
              await ctx.writeReadings(message.readings as Parameters<typeof ctx.writeReadings>[0]);
          } catch (err) {
            ctx.reportError(`message on ${topic} rejected: ${describeError(err)}`);
          }
        });
      });

      return Promise.resolve({
        async stop() {
          await client.endAsync();
          await writing;
        },
      });
    },
  };
}
