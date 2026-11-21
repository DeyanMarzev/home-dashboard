import { formatLongDate } from '@home/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { sendJson } from '../api/client.js';
import { useMe } from '../api/hooks.js';
import { Empty, Panel, Skeleton } from '../components/Cards.js';
import { PageHeader } from '../components/PageHeader.js';
import { Status } from '../components/Status.js';
import { promptInstall, useInstall } from '../lib/install.js';
import { useNow } from '../lib/now-context.js';
import { pushState, syncOnStart, turnOff, turnOn } from '../lib/push.js';

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
        <PushControls />
      </div>
    </Panel>
  );
}

/** Notifications on this phone (docs/09 §7 This device). */
function PushControls() {
  const me = useMe();
  const client = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const push = useQuery({
    queryKey: ['push-device'],
    queryFn: async () => ({ state: await pushState(), deviceId: await syncOnStart() }),
    staleTime: Infinity,
  });
  const refresh = (deviceId: number | null) =>
    pushState().then((state) => client.setQueryData(['push-device'], { state, deviceId }));

  const on = useMutation({
    mutationFn: () => turnOn(me.data!.vapidPublicKey!),
    onSuccess: (device) => refresh(device.id),
    onError: (err) => setProblem(err.message),
  });
  const off = useMutation({
    mutationFn: async () => {
      const current = push.data;
      if (current?.state.kind === 'on') await turnOff(current.state.subscription, current.deviceId);
    },
    onSuccess: () => refresh(null),
    onError: (err) => setProblem(err.message),
  });
  const test = useMutation({
    mutationFn: () => sendJson('POST', `/api/me/devices/${push.data!.deviceId}/test`),
    onSuccess: () => setTested(true),
    onError: (err) => setProblem(err.message),
  });

  if (push.isPending) return <Skeleton height={40} />;
  const state = push.data?.state ?? { kind: 'unsupported' as const };
  const keyMissing = me.data && !me.data.vapidPublicKey;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <strong>Notifications</strong>
      {state.kind === 'unsupported' ? (
        <Status tone="muted">This browser doesn&apos;t support notifications</Status>
      ) : state.kind === 'blocked' ? (
        <>
          <Status tone="bad">Blocked in Chrome</Status>
          <p className="small muted">
            To allow them: Chrome ⋮ → Settings → Site settings → Notifications → home.deyan.uk →
            Allow. On Android 13 and later, Chrome itself must also be allowed to notify (phone
            Settings → Apps → Chrome → Notifications).
          </p>
        </>
      ) : state.kind === 'off' ? (
        <>
          <Status tone="muted">Off on this phone</Status>
          {keyMissing ? (
            <p className="small muted">Notifications aren&apos;t set up on the Pi yet.</p>
          ) : (
            <div>
              <button
                type="button"
                className="pill pill--primary"
                disabled={on.isPending || !me.data}
                onClick={() => {
                  setProblem(null);
                  on.mutate();
                }}
              >
                {on.isPending ? 'Turning on…' : 'Turn on notifications'}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <Status tone="good">Notifications are on for this phone</Status>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="pill"
              disabled={test.isPending || push.data?.deviceId == null}
              onClick={() => {
                setProblem(null);
                setTested(false);
                test.mutate();
              }}
            >
              Send test notification
            </button>
            <button
              type="button"
              className="pill"
              disabled={off.isPending}
              onClick={() => {
                setProblem(null);
                off.mutate();
              }}
            >
              Turn off on this phone
            </button>
          </div>
          {tested && <p className="small muted">Sent: it should arrive within a few seconds.</p>}
        </>
      )}
      {problem && <p className="small warn-text">{problem}</p>}
    </div>
  );
}
