import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeContext, silentLog, source } from '../../test-helpers.js';
import { loadCollectorEnv } from '../../env.js';
import { boilerProbes, W1_DEVICES } from './index.js';
import { parseW1Temperature, ProbeReadError } from './parse.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

describe('parseW1Temperature', () => {
  it('reads millidegrees from `temperature`', () => {
    expect(parseW1Temperature(fixture('temperature.txt'), 'temperature')).toBe(58.1);
  });

  it('reads t= from `w1_slave` when the CRC is good', () => {
    expect(parseW1Temperature(fixture('w1_slave.txt'), 'w1_slave')).toBe(44.1);
    expect(() => parseW1Temperature(fixture('w1_slave-crc-fail.txt'), 'w1_slave')).toThrow(/CRC/);
  });

  it('rejects the 85 °C power-on value and the −127 °C disconnected value', () => {
    expect(() => parseW1Temperature('85000', 'temperature')).toThrow(/power-on/);
    expect(() => parseW1Temperature('-127000', 'temperature')).toThrow(/disconnected/);
    expect(() => parseW1Temperature('hot', 'temperature')).toThrow(ProbeReadError);
  });

  it('reads below-zero values', () => {
    expect(parseW1Temperature('-1062', 'temperature')).toBe(-1.1);
  });
});

describe('boilerProbes collector', () => {
  let sys: string;
  afterEach(() => rmSync(sys, { recursive: true, force: true }));

  function setup(probes: Record<string, string>, env: Record<string, string> = {}) {
    sys = mkdtempSync(join(tmpdir(), 'w1-'));
    for (const [id, millis] of Object.entries(probes)) {
      mkdirSync(join(sys, W1_DEVICES, id), { recursive: true });
      writeFileSync(join(sys, W1_DEVICES, id, 'temperature'), `${millis}\n`);
    }
    const src = source('boiler_probes', { kind: 'local', poll: '30s' });
    const written: unknown[] = [];
    const ctx = {
      ...fakeContext(src, new AbortController().signal, () => undefined),
      env: loadCollectorEnv({ HOST_SYS: sys, ...env }),
      log: silentLog,
    };
    ctx.writeReadings = (r) => (written.push(...r), Promise.resolve(r.length));
    return { ctx, written };
  }

  it('runs quietly with no probes fitted and no 1-Wire bus at all', async () => {
    const { ctx, written } = setup({});
    await expect(boilerProbes.run(ctx)).resolves.toBeUndefined();
    expect(written).toEqual([]);
  });

  it('reads flow and return from the configured probes', async () => {
    const { ctx, written } = setup(
      { '28-0000000000a1': '58125', '28-0000000000b2': '44062' },
      { BOILER_FLOW_W1_ID: '28-0000000000a1', BOILER_RETURN_W1_ID: '28-0000000000b2' },
    );
    await boilerProbes.run(ctx);
    expect(written).toMatchObject([
      { metric: 'temperature', entity: 'boiler_flow', unit: '°C', value: 58.1 },
      { metric: 'temperature', entity: 'boiler_return', unit: '°C', value: 44.1 },
    ]);
  });

  it('keeps the working probe and fails the run for a missing one', async () => {
    const { ctx, written } = setup(
      { '28-0000000000a1': '58125' },
      { BOILER_FLOW_W1_ID: '28-0000000000a1', BOILER_RETURN_W1_ID: '28-0000000000b2' },
    );
    await expect(boilerProbes.run(ctx)).rejects.toThrow(
      /boiler_return probe 28-0000000000b2 not found \(seen: 28-0000000000a1\)/,
    );
    expect(written).toHaveLength(1);
  });
});
