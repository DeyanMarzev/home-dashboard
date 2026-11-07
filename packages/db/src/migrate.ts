import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { silentLogger, type Logger } from './logger.js';

/** Any fixed number; all runners (api, collector) must use the same one. */
const MIGRATION_LOCK_KEY = 7_212_026_001;

const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: string; // '001'
  name: string; // '001_init.sql'
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export async function readMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match?.[1])
      throw new MigrationError(`Bad migration file name "${name}": expected e.g. 003_add_x.sql`);
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({
      version: match[1],
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const versions = files.map((f) => f.version);
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) throw new MigrationError(`Two migrations have version ${duplicate}`);
  return files;
}

/**
 * Applies pending migrations from `dir` in order. Safe to run from several processes at once
 * (api and collector both call it at startup): each migration runs in its own transaction
 * holding a transaction-level advisory lock, and re-checks whether it was already applied.
 *
 * An already-applied migration whose file changed is an error: add a new migration instead.
 */
export async function migrate(
  sql: Sql,
  dir: string,
  log: Logger = silentLogger,
): Promise<string[]> {
  const files = await readMigrations(dir);

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx`
      create table if not exists schema_migrations (
        version    text primary key,
        name       text not null,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`;
  });

  const applied: string[] = [];
  for (const file of files) {
    const didApply = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      const [existing] = await tx<{ checksum: string }[]>`
        select checksum from schema_migrations where version = ${file.version}`;
      if (existing) {
        if (existing.checksum !== file.checksum) {
          throw new MigrationError(
            `Migration ${file.name} was changed after it was applied. ` +
              'Never edit an applied migration; add a new one instead.',
          );
        }
        return false;
      }
      log.info({ migration: file.name }, 'applying migration');
      await tx.unsafe(file.sql);
      await tx`
        insert into schema_migrations (version, name, checksum)
        values (${file.version}, ${file.name}, ${file.checksum})`;
      return true;
    });
    if (didApply) applied.push(file.name);
  }

  log.info({ applied: applied.length, total: files.length }, 'migrations up to date');
  return applied;
}
