import type { SourceInfo } from '@home/shared';

/** "30s" → "30 s", "2m" → "2 min", "6h" → "Every 6 h", "1d" → "Daily", "cron: 0 6 * * *" → "Daily 06:00". */
export function describePoll(source: Pick<SourceInfo, 'poll' | 'pushInterval'>): string {
  const text = source.poll ?? source.pushInterval;
  if (!text) return '—';
  const cron = /^cron: (\d{1,2}) (\d{1,2}) \* \* \*$/.exec(text);
  if (cron) return `Daily ${cron[2]!.padStart(2, '0')}:${cron[1]!.padStart(2, '0')}`;
  if (text.startsWith('cron:')) return 'Scheduled';
  const match = /^(\d+)([smhd])$/.exec(text);
  if (!match) return text;
  const n = Number(match[1]);
  switch (match[2]) {
    case 's':
      return `${n} s`;
    case 'm':
      return `${n} min`;
    case 'h':
      return `Every ${n} h`;
    default:
      return n === 1 ? 'Daily' : `Every ${n} days`;
  }
}

export type CollectorStatus = 'running' | 'scheduled' | 'failing' | 'late' | 'not_connected';

/**
 * What the collectors table says: not connected (disabled), failing (last run failed),
 * late (no fresh data), scheduled (cron sources between runs) or running.
 */
export function collectorStatus(
  s: Pick<SourceInfo, 'enabled' | 'poll' | 'lastRun' | 'freshness'>,
): CollectorStatus {
  if (!s.enabled) return 'not_connected';
  if (s.lastRun?.ok === false) return 'failing';
  if (s.freshness.state === 'late') return 'late';
  return s.poll?.startsWith('cron:') ? 'scheduled' : 'running';
}

export const COLLECTOR_STATUS_TEXT: Record<CollectorStatus, string> = {
  running: 'Running',
  scheduled: 'Scheduled',
  failing: 'Failing',
  late: 'Late',
  not_connected: 'Not connected',
};
