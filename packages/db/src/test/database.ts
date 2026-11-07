import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
export const SOURCES_FILE = fileURLToPath(
  new URL('../../../../config/sources.yaml', import.meta.url),
);

export interface TestDatabase {
  kind: 'pglite' | 'timescale';
  sql: Sql;
  /** Migrations to apply for this backend. */
  migrationsDir: string;
  /** Connect another client. */
  connect(): Sql;
  /** Whether LISTEN/NOTIFY works (PGlite's socket server doesn't deliver notifications). */
  supportsNotify: boolean;
  /** LISTEN on a channel; resolves to an unsubscribe function. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/**
 * PGlite has no TimescaleDB, so: stub the two Timescale functions 001 calls, drop its
 * CREATE EXTENSION line, and skip 002 (Timescale policies). Everything else is real Postgres.
 */
const TIMESCALE_STUB = `
CREATE FUNCTION by_range(column_name name, partition_interval interval) RETURNS text
  LANGUAGE sql AS $$ SELECT column_name::text $$;
CREATE FUNCTION create_hypertable(relation regclass, dimension text, create_default_indexes boolean DEFAULT true)
  RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
`;

export async function startPglite(): Promise<TestDatabase> {
  const db = await PGlite.create();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 4 });
  await server.start();

  const migrationsDir = await mkdtemp(join(tmpdir(), 'home-migrations-'));
  await writeFile(join(migrationsDir, '000_timescale_stub.sql'), TIMESCALE_STUB);
  const init = await readFile(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');
  await writeFile(
    join(migrationsDir, '001_init.sql'),
    init.replace(/^CREATE EXTENSION IF NOT EXISTS timescaledb;$/m, ''),
  );

  const connect = () =>
    postgres({
      host: '127.0.0.1',
      port,
      username: 'postgres',
      database: 'postgres',
      max: 1,
      ssl: false,
      onnotice: () => undefined,
    });
  const sql = connect();
  return {
    kind: 'pglite',
    supportsNotify: false,
    sql,
    migrationsDir,
    connect,
    listen() {
      throw new Error(
        'PGlite does not deliver NOTIFY to socket clients; run with TEST_DATABASE_URL',
      );
    },
    async close() {
      await sql.end();
      await server.stop();
      await db.close();
      await rm(migrationsDir, { recursive: true, force: true });
    },
  };
}

/** A throwaway database on a real TimescaleDB server (TEST_DATABASE_URL), with the real migrations. */
export async function startTimescale(url: string): Promise<TestDatabase> {
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const name = `home_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.unsafe(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const connect = () => postgres(target.toString(), { max: 4, onnotice: () => undefined });
  const sql = connect();
  return {
    kind: 'timescale',
    supportsNotify: true,
    sql,
    migrationsDir: MIGRATIONS_DIR,
    connect,
    async listen(channel, onPayload) {
      const listener = connect();
      await listener.listen(channel, onPayload);
      return () => listener.end();
    },
    async close() {
      await sql.end();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

/** Always PGlite; plus real TimescaleDB when TEST_DATABASE_URL is set. */
export const testBackends: { name: string; start: () => Promise<TestDatabase> }[] = [
  { name: 'PGlite', start: startPglite },
  ...(process.env.TEST_DATABASE_URL
    ? [{ name: 'TimescaleDB', start: () => startTimescale(process.env.TEST_DATABASE_URL!) }]
    : []),
];
