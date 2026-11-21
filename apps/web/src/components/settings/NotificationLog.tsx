import { formatWhen, humanise } from '@home/shared';
import { useNotificationLog } from '../../api/settings.js';
import { useNow } from '../../lib/now-context.js';
import { Empty, Panel, Skeleton } from '../Cards.js';

const STATUS: Record<string, string> = {
  sent: 'Sent',
  failed: 'Failed',
  gone: 'Phone unsubscribed (removed)',
  skipped_disabled: 'Not sent: switched off',
  skipped_level: 'Not sent: below their level',
  skipped_entity: 'Not sent: not their room',
  skipped_paused: 'Not sent: paused',
  skipped_quiet: 'Not sent: quiet hours',
  skipped_rate_limited: 'Not sent: too many this hour',
};
const PHASE: Record<string, string> = {
  opened: '',
  escalated: ' (urgent)',
  resolved: ' (back to normal)',
  test: '',
  rate_limit: '',
};

/** System page → Recent notifications (admins; docs/09 §7). */
export function NotificationLogPanel() {
  const log = useNotificationLog(true);
  const now = useNow();
  return (
    <Panel id="notif-h" title="Recent notifications" flex="1 1 100%">
      {log.isPending ? (
        <Skeleton height={120} />
      ) : log.isError ? (
        <Empty>{log.error.message}</Empty>
      ) : log.data.items.length === 0 ? (
        <Empty>No notifications yet</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Person</th>
                <th scope="col">Alert</th>
                <th scope="col">What happened</th>
                <th scope="col">Device</th>
              </tr>
            </thead>
            <tbody>
              {log.data.items.map((r, i) => (
                <tr key={`${r.ts}${i}`}>
                  <td>{formatWhen(r.ts, now)}</td>
                  <td>{r.user}</td>
                  <td>
                    {r.phase === 'test'
                      ? 'Test notification'
                      : r.phase === 'rate_limit'
                        ? 'Too many alerts'
                        : `${r.ruleId ? humanise(r.ruleId) : '–'}${r.entity ? ` · ${humanise(r.entity)}` : ''}${PHASE[r.phase] ?? ''}`}
                  </td>
                  <td>{STATUS[r.status] ?? r.status}</td>
                  <td>{r.device ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
