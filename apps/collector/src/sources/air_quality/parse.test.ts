import { readFileSync } from 'node:fs';
import { DAQI_POLLUTANT_CODES, ReadingInputSchema } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { parseAirQuality } from './parse.js';

// Recorded from Open-Meteo for central London (51.50, −0.12) at 19:00 UTC on 11 Nov 2026:
// 24 h back, 48 h ahead.
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/air-quality-2026-11-11.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const iso = (d: Date | string) => new Date(d).toISOString();

describe('parseAirQuality', () => {
  const readings = parseAirQuality(fixture);
  const of = (metric: string) => readings.filter((r) => r.metric === metric);

  it('stores the hourly concentrations up to now, not the forecast hours', () => {
    expect(of('pm2_5')).toHaveLength(44); // 00:00 yesterday … 19:00 today
    expect(iso(of('pm2_5').at(-1)!.ts)).toBe('2026-11-11T19:00:00.000Z');
    expect(of('no2').at(-1)).toMatchObject({ value: 52.3, unit: 'µg/m³', entity: 'outdoor' });
    expect(of('o3').at(-1)?.value).toBe(12);
  });

  it('works out the DAQI once 24 hours of particles are in, and the forecast after now', () => {
    const daqi = of('daqi');
    expect(daqi).toHaveLength(21); // 23:00 yesterday … 19:00 today
    // Checked independently: PM2.5's 24-hour mean of 16.9 µg/m³ is band 2 (Low).
    expect(daqi.at(-1)).toMatchObject({ value: 2, valueType: 'state' });
    expect(iso(daqi.at(-1)!.ts)).toBe('2026-11-11T19:00:00.000Z');
    expect(of('daqi_pollutant').at(-1)?.value).toBe(DAQI_POLLUTANT_CODES.pm2_5);
    const forecast = of('forecast_daqi');
    expect(forecast).toHaveLength(28);
    expect(iso(forecast[0]!.ts)).toBe('2026-11-11T20:00:00.000Z');
    for (const r of readings) expect(ReadingInputSchema.safeParse(r).success).toBe(true);
  });

  it('refuses unexpected units', () => {
    const changed = structuredClone(fixture) as { hourly_units: Record<string, string> };
    changed.hourly_units.ozone = 'ppb';
    expect(() => parseAirQuality(changed)).toThrow(/ozone in "ppb"/);
  });
});
