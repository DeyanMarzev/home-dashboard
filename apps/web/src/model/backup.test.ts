import type { EventItem } from '@home/shared';
import { describe, expect, it } from 'vitest';
import { backupStatus } from './backup.js';

const event = (level: EventItem['level'], data: unknown): EventItem => ({
  id: 1,
  ts: '2026-11-07T03:00:12Z',
  level,
  sourceId: null,
  kind: 'backup',
  message: 'x',
  data,
  resolvedAt: null,
});

describe('backupStatus', () => {
  it('is null before the first backup', () => {
    expect(backupStatus(undefined)).toBeNull();
  });

  it('reads size, off-site copy and local count from a finished backup', () => {
    const data = {
      file: 'home-2026-11-07.dump',
      bytes: 41_200_000,
      offsite: true,
      keptLocal: 7,
      keptRemoteDays: 30,
    };
    expect(backupStatus(event('info', data))).toEqual({
      ok: true,
      ts: '2026-11-07T03:00:12Z',
      sizeMb: 41.2,
      offsite: true,
      keptLocal: 7,
      keptRemoteDays: 30,
      failedStep: null,
    });
  });

  it('reports the failed step', () => {
    expect(backupStatus(event('warning', { step: 'pg_dump' }))).toMatchObject({
      ok: false,
      sizeMb: null,
      offsite: null,
      failedStep: 'pg_dump',
    });
  });

  it('tolerates missing or odd data', () => {
    expect(backupStatus(event('info', null))).toMatchObject({ ok: true, sizeMb: null });
    expect(backupStatus(event('warning', 'x'))).toMatchObject({ ok: false, failedStep: null });
  });
});
