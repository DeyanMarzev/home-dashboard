import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Thrown when the environment is invalid; the message lists every problem at once. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type AuthConfig =
  | { disabled: true }
  | {
      disabled: false;
      team: string;
      audience: string;
      /** `https://<team>.cloudflareaccess.com`, the `iss` claim of every Access JWT. */
      issuer: string;
      /** JWKS with the keys Access signs its JWTs with. */
      certsUrl: string;
    };

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  logLevel: string;
  version: string;
  /** Built web app to serve at `/`, or null to serve the API only. */
  publicDir: string | null;
  auth: AuthConfig;
}

// Compose passes unset optional variables as empty strings (`${VAR:-}`).
const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().trim().optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    // Port 8000 belongs to the owner's FastAPI project on the Pi (CLAUDE.md rule 9).
    .refine((p) => p !== 8000, 'port 8000 is reserved for the existing FastAPI project')
    .default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: optional,
  PUBLIC_DIR: optional,
  AUTH_DISABLED: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['true', 'false']).default('false'),
  ),
  CF_ACCESS_TEAM: optional,
  CF_ACCESS_AUD: optional,
});

/** Accepts `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com/`. */
export function normaliseAccessTeam(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.cloudflareaccess\.com$/, '');
}

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }
  const e = parsed.data;
  const problems: string[] = [];

  let auth: AuthConfig;
  if (e.AUTH_DISABLED === 'true') {
    if (e.NODE_ENV === 'production') {
      problems.push('AUTH_DISABLED=true is not allowed when NODE_ENV=production');
    }
    auth = { disabled: true };
  } else {
    const team = e.CF_ACCESS_TEAM ? normaliseAccessTeam(e.CF_ACCESS_TEAM) : '';
    if (!team) problems.push('CF_ACCESS_TEAM is required (or AUTH_DISABLED=true in development)');
    else if (!/^[a-z0-9-]+$/.test(team))
      problems.push(`CF_ACCESS_TEAM "${team}" is not a valid team name`);
    if (!e.CF_ACCESS_AUD)
      problems.push('CF_ACCESS_AUD is required (or AUTH_DISABLED=true in development)');
    const issuer = `https://${team}.cloudflareaccess.com`;
    auth = {
      disabled: false,
      team,
      audience: e.CF_ACCESS_AUD ?? '',
      issuer,
      certsUrl: `${issuer}/cdn-cgi/access/certs`,
    };
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid environment:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    version: e.APP_VERSION ?? '0.0.0-dev',
    publicDir: e.PUBLIC_DIR ? resolve(e.PUBLIC_DIR) : DEFAULT_PUBLIC_DIR,
    auth,
  };
}
