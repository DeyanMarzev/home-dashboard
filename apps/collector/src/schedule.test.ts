import type { Poll } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { nextRunAt, retryDelaySeconds, runTimeoutSeconds } from './schedule.js';

const every = (seconds: number): Poll => ({ type: 'every', seconds });
const daily6am: Poll = { type: 'cron', expression: '0 6 * * *' };
const at = (iso: string) => new Date(iso);

describe('retryDelaySeconds', () => {
  it('doubles from the poll interval for fast sources, capped at 4×', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelaySeconds(every(60), n))).toEqual([
      60, 120, 240, 240, 240,
    ]);
  });

  it('starts at 5 minutes for slow sources, capped at 4× the poll', () => {
    expect([1, 2, 3, 4].map((n) => retryDelaySeconds(every(21600), n))).toEqual([
      300, 600, 1200, 2400,
    ]);
    expect(retryDelaySeconds(every(21600), 20)).toBe(86400);
    expect(retryDelaySeconds(every(900), 10)).toBe(3600);
  });

  it('caps cron sources at a day', () => {
    expect(retryDelaySeconds(daily6am, 1)).toBe(300);
    expect(retryDelaySeconds(daily6am, 30)).toBe(86400);
  });
});

describe('nextRunAt', () => {
  it('runs interval sources immediately on startup', () => {
    expect(nextRunAt(every(60), null, at('2026-11-07T12:00:00Z'))).toEqual(
      at('2026-11-07T12:00:00Z'),
    );
  });

  it('runs interval sources at a fixed rate from the previous start', () => {
    expect(nextRunAt(every(60), at('2026-11-07T12:00:00Z'), at('2026-11-07T12:00:05Z'))).toEqual(
      at('2026-11-07T12:01:00Z'),
    );
  });

  it('runs at once when overdue', () => {
    expect(nextRunAt(every(60), at('2026-11-07T12:00:00Z'), at('2026-11-07T12:03:00Z'))).toEqual(
      at('2026-11-07T12:03:00Z'),
    );
  });

  it('runs cron sources at the next match in London time (GMT in winter)', () => {
    expect(nextRunAt(daily6am, null, at('2026-11-07T07:00:00Z'))).toEqual(
      at('2026-11-08T06:00:00Z'),
    );
    expect(nextRunAt(daily6am, null, at('2026-11-07T05:59:00Z'))).toEqual(
      at('2026-11-07T06:00:00Z'),
    );
  });

  it('follows BST in summer (06:00 London = 05:00 UTC)', () => {
    expect(nextRunAt(daily6am, null, at('2026-07-01T07:00:00Z'))).toEqual(
      at('2026-07-02T05:00:00Z'),
    );
  });

  it('handles the clock changes', () => {
    expect(nextRunAt(daily6am, null, at('2026-03-28T07:00:00Z'))).toEqual(
      at('2026-03-29T05:00:00Z'),
    ); // BST from 01:00 UTC
    expect(nextRunAt(daily6am, null, at('2026-10-24T06:00:00Z'))).toEqual(
      at('2026-10-25T06:00:00Z'),
    ); // GMT again
  });
});

describe('runTimeoutSeconds', () => {
  it('is the poll interval, between 30 s and 5 min', () => {
    expect(runTimeoutSeconds(every(10))).toBe(30);
    expect(runTimeoutSeconds(every(120))).toBe(120);
    expect(runTimeoutSeconds(every(21600))).toBe(300);
    expect(runTimeoutSeconds(daily6am)).toBe(600);
  });
});
