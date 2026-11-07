import postgres, { type Sql } from 'postgres';
import { silentLogger, type Logger } from './logger.js';

export type { Sql };

export interface DbOptions {
  /** Connection URL; default: the standard PG* environment variables (PGHOST, PGUSER, ...). */
  url?: string;
  /** Pool size (docs/04: max 10 for the API). */
  max?: number;
  /** Shows up in pg_stat_activity, e.g. 'api' or 'collector'. */
  applicationName: string;
  log?: Logger;
}

export function createDb(options: DbOptions): Sql {
  const log = options.log ?? silentLogger;
  const config = {
    max: options.max ?? 5,
    idle_timeout: 60,
    connect_timeout: 10,
    connection: { application_name: options.applicationName, TimeZone: 'UTC' },
    onnotice: (notice: { message?: string }) =>
      log.debug({ notice: notice.message }, 'postgres notice'),
  };
  return options.url ? postgres(options.url, config) : postgres(config);
}

/** True if the database answers within `timeoutMs` (kept short for healthchecks). */
export async function pingDb(sql: Sql, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([sql`select 1`.then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until the database answers, retrying with backoff (Postgres may still be starting).
 * Logs each failure without credentials. Gives up after `maxWaitMs`.
 */
export async function waitForDb(
  sql: Sql,
  log: Logger = silentLogger,
  { maxWaitMs = 120_000 }: { maxWaitMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  let delay = 500;
  for (;;) {
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (Date.now() - started + delay > maxWaitMs) throw err;
      log.warn({ code, retryInMs: delay }, 'database not reachable yet');
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
}
