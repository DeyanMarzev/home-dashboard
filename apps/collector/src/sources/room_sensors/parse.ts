import { isSnakeCase, type ReadingInput } from '@home/shared';
import { z } from 'zod';

/** Metrics a room sensor may publish, and the unit each is stored in (CLAUDE.md § Units). */
export const SENSOR_METRICS: Record<string, string> = {
  temperature: '°C',
  humidity: '%',
  co2: 'ppm',
  pressure: 'hPa',
};

/** Readings further from "now" than this are rejected (e.g. an ESP32 that never got NTP time). */
const MAX_PAST_MS = 7 * 86400_000;
const MAX_FUTURE_MS = 5 * 60_000;

export class SensorMessageError extends Error {
  override name = 'SensorMessageError';
}

// `{ "value": 20.6, "ts": "2026-11-06T13:41:00Z", "rssi": -48 }`; ts and rssi optional.
// A bare number (`20.6`) is accepted too: many ESP32 firmwares publish that way.
const PayloadSchema = z.union([
  z
    .number()
    .finite()
    .transform((value) => ({ value, ts: undefined, rssi: undefined })),
  z.object({
    value: z.number().finite(),
    ts: z.iso.datetime({ offset: true }).optional(),
    rssi: z.number().int().min(-120).max(0).optional(),
  }),
]);

/**
 * One MQTT message on `home/sensors/<entity>/<metric>` → readings (docs/03 § room_sensors).
 * `rssi` becomes a `wifi_rssi` series for the entity (Wi-Fi "signal by room").
 * Throws SensorMessageError saying what's wrong; the subscriber logs and drops the message.
 */
export function parseSensorMessage(
  topic: string,
  payload: Buffer | string,
  receivedAt: Date,
): ReadingInput[] {
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== 'home' || parts[1] !== 'sensors') {
    throw new SensorMessageError(`topic ${topic} is not home/sensors/<entity>/<metric>`);
  }
  const [, , entity = '', metric = ''] = parts;
  if (!isSnakeCase(entity))
    throw new SensorMessageError(`entity "${entity}" must be snake_case, e.g. living_room`);
  const unit = SENSOR_METRICS[metric];
  if (!unit) {
    throw new SensorMessageError(
      `unknown metric "${metric}" (known: ${Object.keys(SENSOR_METRICS).join(', ')})`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(payload.toString());
  } catch {
    throw new SensorMessageError('payload is not JSON');
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new SensorMessageError(
      `payload invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`,
    );
  }

  const ts = parsed.data.ts ? new Date(parsed.data.ts) : receivedAt;
  const offset = ts.getTime() - receivedAt.getTime();
  if (offset > MAX_FUTURE_MS || -offset > MAX_PAST_MS) {
    throw new SensorMessageError(
      `ts ${ts.toISOString()} is too far from now; is the sensor's clock set?`,
    );
  }

  const readings: ReadingInput[] = [
    { metric, entity, unit, valueType: 'gauge', ts, value: parsed.data.value },
  ];
  if (parsed.data.rssi !== undefined) {
    readings.push({
      metric: 'wifi_rssi',
      entity,
      unit: 'dBm',
      valueType: 'gauge',
      ts,
      value: parsed.data.rssi,
    });
  }
  return readings;
}
