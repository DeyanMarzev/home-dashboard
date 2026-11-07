import { isSnakeCase, type ReadingInput } from '@home/shared';
import { z } from 'zod';

const THERMOSTAT = 'sdm.devices.types.THERMOSTAT';
const T = 'sdm.devices.traits.';

/** `thermostat_mode` state codes. */
export const THERMOSTAT_MODES = { OFF: 0, HEAT: 1, COOL: 2, HEATCOOL: 3 } as const;
/** `eco_mode` state codes. */
export const ECO_MODES = { OFF: 0, MANUAL_ECO: 1 } as const;
/** The boiler's firing state is stored on this entity (docs/03 § nest). */
export const BOILER_ENTITY = 'boiler';

export class NestOfflineError extends Error {
  override name = 'NestOfflineError';
}

const DevicesSchema = z.object({
  devices: z
    .array(
      z.object({
        type: z.string(),
        traits: z.record(z.string(), z.unknown()),
        parentRelations: z.array(z.object({ displayName: z.string().optional() })).optional(),
      }),
    )
    .default([]),
});

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const trait = (traits: Record<string, unknown>, name: string) =>
  (traits[T + name] ?? {}) as Record<string, unknown>;

/** "Living Room" → "living_room"; null if nothing usable is left. */
export function roomKey(displayName: string | undefined): string | null {
  const key = (displayName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key && isSnakeCase(key) ? key : null;
}

/**
 * SDM `devices.list` → readings for each thermostat (docs/03 § nest). SDM gives no
 * timestamps, so everything is stamped `ts` (the time of the poll). An offline thermostat
 * still reports its last values; those are refused rather than stored as current.
 */
export function parseNestDevices(
  body: unknown,
  ts: Date,
  options: { entity?: string } = {},
): ReadingInput[] {
  const thermostats = DevicesSchema.parse(body).devices.filter((d) => d.type === THERMOSTAT);
  if (thermostats.length === 0) throw new Error('No Nest thermostat in this Device Access project');

  return thermostats.flatMap((d, index) => {
    const base = options.entity ?? roomKey(d.parentRelations?.[0]?.displayName) ?? 'thermostat';
    const entity = index === 0 ? base : `${base}_${index + 1}`;
    if (trait(d.traits, 'Connectivity').status === 'OFFLINE') {
      throw new NestOfflineError(`Nest thermostat (${entity}) is offline`);
    }
    const out: ReadingInput[] = [];
    const add = (
      metric: string,
      unit: string,
      value: number | null,
      valueType: 'gauge' | 'state' = 'gauge',
      on = entity,
    ) => {
      if (value !== null) out.push({ metric, entity: on, unit, valueType, ts, value });
    };
    add('temperature', '°C', num(trait(d.traits, 'Temperature').ambientTemperatureCelsius));
    add('humidity', '%', num(trait(d.traits, 'Humidity').ambientHumidityPercent));
    // Absent in OFF mode and while eco is on: no target is being held.
    add(
      'target_temperature',
      '°C',
      num(trait(d.traits, 'ThermostatTemperatureSetpoint').heatCelsius),
    );

    const hvac = trait(d.traits, 'ThermostatHvac').status;
    if (typeof hvac === 'string')
      add('hvac_heating', 'state', hvac === 'HEATING' ? 1 : 0, 'state', BOILER_ENTITY);
    const mode = trait(d.traits, 'ThermostatMode').mode as
      keyof typeof THERMOSTAT_MODES | undefined;
    if (mode && mode in THERMOSTAT_MODES)
      add('thermostat_mode', 'mode', THERMOSTAT_MODES[mode], 'state');
    const eco = trait(d.traits, 'ThermostatEco').mode as keyof typeof ECO_MODES | undefined;
    if (eco && eco in ECO_MODES) add('eco_mode', 'mode', ECO_MODES[eco], 'state');
    return out;
  });
}
