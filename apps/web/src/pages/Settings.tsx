import { formatLongDate } from '@home/shared';
import { Panel } from '../components/Cards.js';
import { PageHeader } from '../components/PageHeader.js';
import { Status } from '../components/Status.js';
import { promptInstall, useInstall } from '../lib/install.js';
import { useNow } from '../lib/now-context.js';

/** Settings (docs/09 §7). For now: this device's install state; notifications come next. */
export function SettingsPage() {
  const now = useNow();
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle={formatLongDate(now)} />
      <div className="row">
        <ThisDevice />
      </div>
    </div>
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
