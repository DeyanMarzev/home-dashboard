import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSensorMessage, SensorMessageError } from './parse.js';

const messages = JSON.parse(
  readFileSync(new URL('./__fixtures__/messages.json', import.meta.url), 'utf8'),
) as { topic: string; payload: string }[];
const receivedAt = new Date('2026-11-06T13:41:05Z');
const parse = (topic: string, payload: string) => parseSensorMessage(topic, payload, receivedAt);

describe('parseSensorMessage', () => {
  it('reads a full payload, turning rssi into wifi_rssi', () => {
    const [m] = messages;
    expect(parse(m!.topic, m!.payload)).toEqual([
      {
        metric: 'temperature',
        entity: 'living_room',
        unit: '°C',
        valueType: 'gauge',
        ts: new Date('2026-11-06T13:41:00Z'),
        value: 20.6,
      },
      {
        metric: 'wifi_rssi',
        entity: 'living_room',
        unit: 'dBm',
        valueType: 'gauge',
        ts: new Date('2026-11-06T13:41:00Z'),
        value: -48,
      },
    ]);
  });

  it('uses the receive time when ts is missing', () => {
    expect(parse(messages[1]!.topic, messages[1]!.payload)).toEqual([
      {
        metric: 'co2',
        entity: 'kitchen',
        unit: 'ppm',
        valueType: 'gauge',
        ts: receivedAt,
        value: 780,
      },
    ]);
  });

  it('accepts a bare number payload', () => {
    expect(parse(messages[2]!.topic, messages[2]!.payload)[0]).toMatchObject({
      metric: 'humidity',
      unit: '%',
      value: 54.2,
    });
  });

  it('accepts a Buffer payload (as MQTT delivers it)', () => {
    expect(
      parseSensorMessage(messages[3]!.topic, Buffer.from(messages[3]!.payload), receivedAt),
    ).toHaveLength(2);
  });

  it('produces readings that pass validation for every fixture', () => {
    for (const m of messages)
      for (const r of parse(m.topic, m.payload))
        expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it.each([
    ['home/sensors/living_room', '1', /not home\/sensors\/<entity>\/<metric>/],
    ['home/sensors/living_room/temperature/extra', '1', /not home\/sensors/],
    ['office/sensors/a/temperature', '1', /not home\/sensors/],
    ['home/sensors/Living-Room/temperature', '1', /snake_case/],
    ['home/sensors/kitchen/radon', '1', /unknown metric "radon"/],
    ['home/sensors/kitchen/temperature', 'hot', /not JSON/],
    ['home/sensors/kitchen/temperature', '{"temp": 20}', /payload invalid/],
    ['home/sensors/kitchen/temperature', '{"value": "20"}', /payload invalid/],
    [
      'home/sensors/kitchen/temperature',
      '{"value": 20, "ts": "2026-11-06T13:41:00"}',
      /payload invalid/,
    ],
    ['home/sensors/kitchen/temperature', '{"value": 20, "rssi": 5}', /payload invalid/],
    [
      'home/sensors/kitchen/temperature',
      '{"value": 20, "ts": "1970-01-01T00:00:10Z"}',
      /too far from now/,
    ],
    [
      'home/sensors/kitchen/temperature',
      '{"value": 20, "ts": "2026-11-06T14:00:00Z"}',
      /too far from now/,
    ],
  ])('rejects %s %s', (topic, payload, message) => {
    expect(() => parse(topic, payload)).toThrow(SensorMessageError);
    expect(() => parse(topic, payload)).toThrow(message);
  });
});
