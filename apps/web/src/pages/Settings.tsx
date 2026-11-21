import { formatLongDate } from '@home/shared';
import { useMe } from '../api/hooks.js';
import { Empty, Panel, Skeleton } from '../components/Cards.js';
import { PageHeader } from '../components/PageHeader.js';
import { Status } from '../components/Status.js';
import { promptInstall, useInstall } from '../lib/install.js';
import { useNow } from '../lib/now-context.js';

/** Settings (docs/09 §7). For now: who you are and this device's install state. */
export function SettingsPage() {
  const now = useNow();
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle={formatLongDate(now)} />
      <div className="row">
        <You />
        <ThisDevice />
      </div>
    </div>
  );
}

function You() {
  const me = useMe();
  return (
    <Panel id="you-h" title="You" flex="1 1 320px">
      {me.isPending ? (
        <Skeleton height={60} />
      ) : me.isError ? (
        <Empty>{me.error.message}</Empty>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <strong>{me.data.name ?? me.data.email}</strong>
          {me.data.name && <span className="small muted">{me.data.email}</span>}
          <span>
            {me.data.role === 'admin' ? 'Admin' : 'Member'}
            {me.data.roleLocked && (
              <span className="small muted"> · set on the Pi (ADMIN_EMAILS)</span>
            )}
          </span>
          <p className="small muted">
            {me.data.role === 'admin'
              ? 'Admins can change tariffs, alert thresholds and who has access.'
              : 'Members see everything and manage their own notifications.'}
          </p>
        </div>
      )}
    </Panel>
  );
}

function ThisDevice() {
  const { canInstall, installed } = useInstall();
  return (
    <Panel id="device-h" title="This device" flex="1 1 420px">
      <div className="stack">
        {installed ? (
          <Status tone="good">Installed as an app on this device</Status>
        ) : canInstall ? (
          <>
            <p>Install the dashboard as an app: its own icon, full screen, no app store.</p>
            <div>
              <button
                type="button"
                className="pill pill--primary"
                onClick={() => void promptInstall()}
              >
                Install app
              </button>
            </div>
          </>
        ) : (
          <>
            <Status tone="muted">Not installed</Status>
            <p className="small muted">
              To install it on Android: Chrome menu ⋮ → <strong>Add to Home screen</strong> or{' '}
              <strong>Install app</strong>.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
