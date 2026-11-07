import type { EventItem } from '@home/shared';

/** What the System page says about backups, from the newest `backup` event (scripts/backup.sh). */
export interface BackupStatus {
  ok: boolean;
  ts: string;
  /** Dump size in MB (successful backups only). */
  sizeMb: number | null;
  /** Copied off the Pi (Google Drive), or kept on the Pi only. */
  offsite: boolean | null;
  keptLocal: number | null;
  keptRemoteDays: number | null;
  /** The step that failed. */
  failedStep: string | null;
}

export function backupStatus(event: EventItem | undefined): BackupStatus | null {
  if (!event) return null;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const ok = event.level === 'info';
  return {
    ok,
    ts: event.ts,
    sizeMb: ok && typeof data.bytes === 'number' ? data.bytes / 1e6 : null,
    offsite: ok && typeof data.offsite === 'boolean' ? data.offsite : null,
    keptLocal: ok && typeof data.keptLocal === 'number' ? data.keptLocal : null,
    keptRemoteDays:
      ok && data.offsite === true && typeof data.keptRemoteDays === 'number'
        ? data.keptRemoteDays
        : null,
    failedStep: !ok && typeof data.step === 'string' ? data.step : null,
  };
}

/** A backup older than this is overdue: the nightly cron runs at 03:00. */
export const BACKUP_OVERDUE_SECONDS = 36 * 3600;
