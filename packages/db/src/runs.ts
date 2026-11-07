import type { Sql } from 'postgres';

/** Longest error text stored in collector_runs (and shown on the System page). */
const MAX_ERROR_LENGTH = 500;

export interface RunOutcome {
  ok: boolean;
  rowsWritten: number;
  error?: string | null;
}

/** Records that a collector run started; returns its id for finishRun. */
export async function startRun(
  sql: Sql,
  sourceId: string,
  startedAt = new Date(),
): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into collector_runs (source_id, started_at) values (${sourceId}, ${startedAt.toISOString()}::timestamptz)
    returning id`;
  return Number(row!.id);
}

export async function finishRun(
  sql: Sql,
  id: number,
  outcome: RunOutcome,
  finishedAt = new Date(),
): Promise<void> {
  await sql`
    update collector_runs
    set finished_at = ${finishedAt.toISOString()}::timestamptz, ok = ${outcome.ok},
        rows_written = ${outcome.rowsWritten}, error = ${truncateError(outcome.error)}
    where id = ${id}`;
}

/** One finished row in one go, for push sources that summarise a window of activity. */
export async function recordRun(
  sql: Sql,
  sourceId: string,
  startedAt: Date,
  finishedAt: Date,
  outcome: RunOutcome,
): Promise<void> {
  await sql`
    insert into collector_runs (source_id, started_at, finished_at, ok, rows_written, error)
    values (${sourceId}, ${startedAt.toISOString()}::timestamptz, ${finishedAt.toISOString()}::timestamptz,
            ${outcome.ok}, ${outcome.rowsWritten}, ${truncateError(outcome.error)})`;
}

/** Deletes run history older than `keepDays`. Returns how many rows were removed. */
export async function pruneRuns(sql: Sql, keepDays = 30): Promise<number> {
  const result = await sql`
    delete from collector_runs where started_at < now() - make_interval(days => ${keepDays}::int)`;
  return result.count;
}

function truncateError(error: string | null | undefined): string | null {
  if (!error) return null;
  return error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH - 1)}…` : error;
}

/**
 * Finished runs since `since` that actually did work (failed, or wrote rows): for sources that
 * must limit their attempts, e.g. Thames Water's 3 logins a day. Skipped runs don't count.
 */
export async function attemptsSince(sql: Sql, sourceId: string, since: Date): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from collector_runs
    where source_id = ${sourceId} and started_at >= ${since.toISOString()}::timestamptz
      and finished_at is not null and (ok = false or rows_written > 0)`;
  return row?.n ?? 0;
}
