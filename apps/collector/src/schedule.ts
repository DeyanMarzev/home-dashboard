import { HOME_TIME_ZONE, type Poll } from '@home/shared';
import { Cron } from 'croner';

/** Retries after a failure start at this (or the poll interval, if shorter). */
const FIRST_RETRY_SECONDS = 5 * 60;
/** Cron sources have no interval to multiply; cap their retries at a day. */
const CRON_RETRY_CAP_SECONDS = 86400;

/**
 * Delay before retrying after `failures` consecutive failures (≥ 1): doubling from
 * min(poll, 5 min), capped at poll × 4 (docs/01 § Failure handling).
 * 1m poll: 1m, 2m, 4m, 4m…  ·  6h poll: 5m, 10m, 20m … 24h.
 */
export function retryDelaySeconds(poll: Poll, failures: number): number {
  const interval = poll.type === 'every' ? poll.seconds : null;
  const first = interval === null ? FIRST_RETRY_SECONDS : Math.min(interval, FIRST_RETRY_SECONDS);
  const cap = interval === null ? CRON_RETRY_CAP_SECONDS : interval * 4;
  return Math.min(first * 2 ** Math.max(0, failures - 1), cap);
}

/**
 * When the next regular run is due. Interval sources run at a fixed rate from the start of
 * the previous run (immediately on startup); cron sources at the next match in Europe/London.
 */
export function nextRunAt(poll: Poll, lastStart: Date | null, now: Date): Date {
  if (poll.type === 'every') {
    if (!lastStart) return now;
    const due = lastStart.getTime() + poll.seconds * 1000;
    return new Date(Math.max(due, now.getTime()));
  }
  const next = new Cron(poll.expression, { timezone: HOME_TIME_ZONE }).nextRun(now);
  if (!next) throw new Error(`cron "${poll.expression}" never runs`);
  return next;
}

/** A run's time limit: its poll interval, between 30 s and 5 min; 10 min for cron sources. */
export function runTimeoutSeconds(poll: Poll): number {
  return poll.type === 'every' ? Math.min(Math.max(poll.seconds, 30), 300) : 600;
}
