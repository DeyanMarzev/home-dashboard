import type { Registry } from '@home/shared';
import { resolve } from 'node:path';
import type { Sql } from 'postgres';
import { waitForDb } from './client.js';
import type { Logger } from './logger.js';
import { migrate } from './migrate.js';
import { loadRegistryFile } from './registry-file.js';
import { syncSources } from './sources.js';

export interface StartupPaths {
  migrationsDir: string;
  sourcesFile: string;
}

/**
 * Where migrations and the registry live. Defaults are relative to the working directory,
 * which is /app in the Docker images; `pnpm dev` sets MIGRATIONS_DIR / SOURCES_FILE.
 */
export function startupPaths(env: Record<string, string | undefined>): StartupPaths {
  return {
    migrationsDir: resolve(env.MIGRATIONS_DIR || 'db/migrations'),
    sourcesFile: resolve(env.SOURCES_FILE || 'config/sources.yaml'),
  };
}

/**
 * What api and collector both do at startup: validate the registry (fail fast on a typo,
 * before touching the database), wait for Postgres, apply migrations, sync the registry.
 */
export async function prepareDatabase(
  sql: Sql,
  paths: StartupPaths,
  log: Logger,
): Promise<Registry> {
  const registry = await loadRegistryFile(paths.sourcesFile);
  await waitForDb(sql, log);
  await migrate(sql, paths.migrationsDir, log);
  await syncSources(sql, registry, log);
  log.info({ sources: registry.sources.length }, 'database ready');
  return registry;
}
