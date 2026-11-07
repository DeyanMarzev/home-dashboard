import { parseRegistry, type SourceConfig } from '@home/shared';
import { pino } from 'pino';
import type { CollectorContext } from './collector.js';
import { loadCollectorEnv } from './env.js';

export const silentLog = pino({ level: 'silent' });

export function source(id: string, entry: Record<string, unknown>): SourceConfig {
  return parseRegistry({ sources: { [id]: { name: id, ...entry } } }).sources[0]!;
}

/** A context whose writeReadings just counts rows. */
export function fakeContext(
  src: SourceConfig,
  signal: AbortSignal,
  onRows: (n: number) => void,
): CollectorContext {
  return {
    source: src,
    env: loadCollectorEnv({}),
    log: silentLog,
    signal,
    db: undefined as never,
    writeReadings: (readings) => {
      onRows(readings.length);
      return Promise.resolve(readings.length);
    },
    lastDataTo: () => Promise.resolve(null),
  };
}
