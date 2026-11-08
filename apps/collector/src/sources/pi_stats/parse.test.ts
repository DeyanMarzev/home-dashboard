import { ReadingInputSchema } from '@home/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePiStats, type RawPiStats } from './parse.js';

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/pi4-under-load.json', import.meta.url), 'utf8'),
) as RawPiStats & { note: string };
const ts = new Date('2026-11-07T12:00:00Z');
const valueOf = (readings: ReturnType<typeof parsePiStats>, metric: string, entity = 'pi') =>
  readings.find((r) => r.metric === metric && r.entity === entity)?.value;

describe('parsePiStats', () => {
  const readings = parsePiStats(fixture, ts);

  it('reads every metric', () => {
    expect(readings.map((r) => `${r.metric}/${r.entity}`)).toEqual([
      'cpu_temperature/pi',
      'throttle_flags/pi',
      'memory_total/pi',
      'memory_used/pi',
      'load_1m/pi',
      'load_5m/pi',
      'load_15m/pi',
      'uptime/pi',
      'disk_used/sd_card',
      'disk_free/sd_card',
      'disk_used/ssd',
      'disk_free/ssd',
      'database_size/pi',
    ]);
  });

  it('converts units', () => {
    expect(valueOf(readings, 'cpu_temperature')).toBe(61.8); // millidegrees → °C
    expect(valueOf(readings, 'memory_total')).toBe(3977); // kB (KiB) → MB
    expect(valueOf(readings, 'memory_used')).toBe(1792); // total - available
    expect(valueOf(readings, 'uptime')).toBe(864214);
    expect(valueOf(readings, 'load_1m')).toBe(0.42);
    expect(valueOf(readings, 'disk_used', 'sd_card')).toBe(9.74); // (blocks - bfree) × bsize
    expect(valueOf(readings, 'disk_free', 'sd_card')).toBe(20.04); // bavail × bsize
    expect(valueOf(readings, 'database_size')).toBe(48.3);
  });

  it('decodes the throttle bitmask from hex (0x50005: under-voltage + throttled, now and since boot)', () => {
    const flags = valueOf(readings, 'throttle_flags')!;
    expect(flags).toBe(0x50005);
    expect(flags & 0b1).toBe(1); // bit 0: under-voltage now
    expect((flags >> 16) & 0b1).toBe(1); // bit 16: under-voltage has occurred
    expect(
      parsePiStats({ ...fixture, throttled: '0x0\n' }, ts).find(
        (r) => r.metric === 'throttle_flags',
      )?.value,
    ).toBe(0);
  });

  it('falls back to the rpi_volt under-voltage alarm when get_throttled is missing (kernel 6.12+)', () => {
    const newer = parsePiStats({ ...fixture, throttled: null, underVoltage: '1\n' }, ts);
    expect(valueOf(newer, 'under_voltage')).toBe(1);
    expect(valueOf(newer, 'throttle_flags')).toBeUndefined();
    const ok = parsePiStats({ ...fixture, throttled: null, underVoltage: '0\n' }, ts);
    expect(ok.find((r) => r.metric === 'under_voltage')).toMatchObject({
      unit: 'flag',
      valueType: 'state',
      value: 0,
    });
    // get_throttled wins when both exist; neither → no power reading at all.
    expect(
      valueOf(parsePiStats({ ...fixture, underVoltage: '1' }, ts), 'under_voltage'),
    ).toBeUndefined();
    const none = parsePiStats({ ...fixture, throttled: null, underVoltage: null }, ts);
    expect(none.some((r) => ['throttle_flags', 'under_voltage'].includes(r.metric))).toBe(false);
    expect(() => parsePiStats({ ...fixture, throttled: null, underVoltage: 'x' }, ts)).toThrow(
      /under-voltage alarm/,
    );
  });

  it('stamps everything with the given time and passes validation', () => {
    for (const r of readings) {
      expect(r.ts).toBe(ts);
      expect(ReadingInputSchema.safeParse(r).success).toBe(true);
    }
  });

  it('skips missing optional sources (not a Pi, no SSD, no DB size)', () => {
    const minimal = parsePiStats(
      { ...fixture, thermal: null, throttled: null, disks: [], databaseBytes: null },
      ts,
    );
    expect(minimal.map((r) => r.metric)).toEqual([
      'memory_total',
      'memory_used',
      'load_1m',
      'load_5m',
      'load_15m',
      'uptime',
    ]);
  });

  it('fails loudly on garbage rather than storing it', () => {
    expect(() => parsePiStats({ ...fixture, thermal: 'n/a' }, ts)).toThrow(/not a number/);
    expect(() => parsePiStats({ ...fixture, throttled: 'throttled=0x0' }, ts)).toThrow(/not hex/);
    expect(() => parsePiStats({ ...fixture, meminfo: 'MemTotal: 1 kB\n' }, ts)).toThrow(
      /MemAvailable/,
    );
    expect(() => parsePiStats({ ...fixture, loadavg: '' }, ts)).toThrow(/loadavg/);
  });
});
