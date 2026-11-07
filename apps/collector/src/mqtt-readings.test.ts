import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { PushContext } from './collector.js';
import { fakeContext, source } from './test-helpers.js';

// A stand-in MQTT client: lets the test deliver messages.
const client = Object.assign(new EventEmitter(), {
  subscribe: (_t: string, _o: unknown, cb: (e: Error | null) => void) => cb(null),
  endAsync: () => Promise.resolve(),
});
vi.mock('mqtt', () => ({ default: { connect: () => client } }));

const { mqttReadingsCollector } = await import('./mqtt-readings.js');

describe('mqttReadingsCollector', () => {
  it('writes the readings in each message and reports the problems', async () => {
    const src = source('wifi', { kind: 'local', push_interval: '5m', mqtt_topic: 'home/net/wifi' });
    const written: unknown[] = [];
    const errors: string[] = [];
    const ctx: PushContext = {
      ...fakeContext(src, new AbortController().signal, () => undefined),
      writeReadings: (r) => (written.push(...r), Promise.resolve(r.length)),
      reportError: (m) => errors.push(m),
    };
    const sub = await mqttReadingsCollector('wifi').subscribe(ctx);
    const reading = {
      metric: 'latency',
      entity: 'router',
      unit: 'ms',
      valueType: 'gauge',
      ts: '2026-11-07T12:00:00Z',
      value: 3.1,
    };
    client.emit(
      'message',
      'home/net/wifi',
      Buffer.from(
        JSON.stringify({ readings: [reading], errors: ['channel scan: Operation not permitted'] }),
      ),
    );
    client.emit('message', 'home/net/wifi', Buffer.from('not json'));
    await sub.stop();
    expect(written).toEqual([reading]);
    expect(errors).toEqual([
      'channel scan: Operation not permitted',
      expect.stringMatching(/message on home\/net\/wifi rejected/),
    ]);
  });
});
