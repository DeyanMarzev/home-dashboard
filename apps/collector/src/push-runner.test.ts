import { describe, expect, it } from 'vitest';
import type { PushCollector, PushContext } from './collector.js';
import { startPushSource, type PushRunStore } from './push-runner.js';
import { fakeContext, silentLog, source } from './test-helpers.js';

describe('startPushSource', () => {
  it('summarises rows and the last error into one run row', async () => {
    let ctx: PushContext | undefined;
    let stopped = false;
    const collector: PushCollector = {
      id: 'room_sensors',
      kind: 'push',
      subscribe: (c) => {
        ctx = c;
        return Promise.resolve({ stop: () => ((stopped = true), Promise.resolve()) });
      },
    };
    const recorded: unknown[] = [];
    const store: PushRunStore = {
      record: (_id, _from, _to, outcome) => (recorded.push(outcome), Promise.resolve()),
    };
    const src = source('room_sensors', { kind: 'sensor', push_interval: '30s' });

    const sub = await startPushSource({
      collector,
      source: src,
      store,
      log: silentLog,
      signal: new AbortController().signal,
      makeContext: (signal, onRows) => fakeContext(src, signal, onRows),
      windowMs: 3_600_000,
    });
    const reading = {
      metric: 'temperature',
      entity: 'kitchen',
      unit: '°C',
      valueType: 'gauge' as const,
      ts: new Date(),
      value: 20,
    };
    await ctx!.writeReadings([reading, reading]);
    ctx!.reportError('MQTT broker unreachable; reconnecting');
    await ctx!.writeReadings([reading]);
    await sub.stop();

    expect(stopped).toBe(true);
    expect(recorded).toEqual([
      { ok: false, rowsWritten: 3, error: 'MQTT broker unreachable; reconnecting' },
    ]);
  });

  it('writes nothing for a quiet window', async () => {
    const collector: PushCollector = {
      id: 'x',
      kind: 'push',
      subscribe: () => Promise.resolve({ stop: () => Promise.resolve() }),
    };
    const recorded: unknown[] = [];
    const src = source('x', { kind: 'sensor', push_interval: '30s' });
    const sub = await startPushSource({
      collector,
      source: src,
      log: silentLog,
      signal: new AbortController().signal,
      store: { record: (...args) => (recorded.push(args), Promise.resolve()) },
      makeContext: (signal, onRows) => fakeContext(src, signal, onRows),
    });
    await sub.stop();
    expect(recorded).toEqual([]);
  });
});
