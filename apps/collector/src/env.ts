import { z } from 'zod';

// Compose passes unset optional variables as empty strings (`${VAR:-}`).
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalNumber = (min: number, max: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().min(min).max(max).optional());

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MQTT_URL: z.preprocess(blankToUndefined, z.string().url().default('mqtt://localhost:1883')),
  MQTT_USERNAME: optionalString,
  MQTT_PASSWORD: optionalString,

  // Home location (docs/08 question 5): set in .env, never hardcoded.
  HOME_LAT: optionalNumber(-90, 90),
  HOME_LON: optionalNumber(-180, 180),
  HOME_POSTCODE_OUTCODE: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{1,2}[0-9][A-Z0-9]?$/, 'expected the first half of a UK postcode, e.g. SW1A')
      .optional(),
  ),

  // Nest (Google Smart Device Management API). Secrets: never logged.
  NEST_PROJECT_ID: optionalString,
  NEST_CLIENT_ID: optionalString,
  NEST_CLIENT_SECRET: optionalString,
  NEST_REFRESH_TOKEN: optionalString,

  // DS18B20 boiler pipe probes (1-Wire ids like 28-0123456789ab). Unset until fitted.
  BOILER_FLOW_W1_ID: optionalString,
  BOILER_RETURN_W1_ID: optionalString,

  // Host paths, mounted read-only into the container (docker-compose.yml).
  HOST_SYS: z.preprocess(blankToUndefined, z.string().default('/sys')),
  HOST_PROC: z.preprocess(blankToUndefined, z.string().default('/proc')),
  HOST_ROOTFS: z.preprocess(blankToUndefined, z.string().default('/')),
  HOST_DATA_DIR: optionalString,
});

export type CollectorEnv = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export function loadCollectorEnv(env: Record<string, string | undefined>): CollectorEnv {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }
  return parsed.data;
}

/** For collectors: a required setting, with a message saying where to set it. */
export function requireSetting<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not set (add it to .env on the Pi)`);
  return value;
}
