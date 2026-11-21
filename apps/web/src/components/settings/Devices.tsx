import { formatAgo, type DeviceItem } from '@home/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useDeviceActions, useDevices } from '../../api/settings.js';
import { useNow } from '../../lib/now-context.js';
import { Empty, Panel, Skeleton } from '../Cards.js';

/** Settings → My devices (docs/09 §7): every phone or browser that gets your notifications. */
export function DevicesPanel() {
  const devices = useDevices();
  // Set by "This device" once it has synced this phone's subscription.
  const thisDevice = useQuery<{ deviceId: number | null }>({
    queryKey: ['push-device'],
    enabled: false,
  }).data?.deviceId;
  return (
    <Panel id="devices-h" title="My devices" flex="1 1 360px">
      {devices.isPending ? (
        <Skeleton height={80} />
      ) : devices.isError ? (
        <Empty>{devices.error.message}</Empty>
      ) : devices.data.items.length === 0 ? (
        <Empty>No devices yet: turn on notifications under This device</Empty>
      ) : (
        <ul className="rules">
          {devices.data.items.map((d) => (
            <DeviceRow key={d.id} device={d} current={d.id === thisDevice} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DeviceRow({ device, current }: { device: DeviceItem; current: boolean }) {
  const now = useNow();
  const { rename, remove } = useDeviceActions();
  const [label, setLabel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="rule">
      {label === null ? (
        <div className="rule-head rule-head--wrap">
          <span className="stack" style={{ gap: 2 }}>
            <strong>
              {device.label}
              {current && <span className="small muted"> · this device</span>}
            </strong>
            <span className="small muted">
              Seen {formatAgo(device.lastSeenAt, now)}
              {device.lastSuccessAt &&
                ` · last notification ${formatAgo(device.lastSuccessAt, now)}`}
            </span>
            {device.failureCount >= 3 && (
              <span className="small warn-text">
                The last {device.failureCount} notifications didn&apos;t reach it
              </span>
            )}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="pill" onClick={() => setLabel(device.label)}>
              Rename
            </button>
            <button
              type="button"
              className="pill"
              disabled={remove.isPending}
              onClick={() => (confirm ? remove.mutate(device.id) : setConfirm(true))}
            >
              {confirm ? 'Really remove?' : 'Remove'}
            </button>
          </span>
        </div>
      ) : (
        <form
          className="row"
          style={{ gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = label.trim();
            if (name)
              rename.mutate({ id: device.id, label: name }, { onSuccess: () => setLabel(null) });
          }}
        >
          <input
            aria-label="Device name"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
          <button type="submit" className="pill pill--primary" disabled={rename.isPending}>
            Save
          </button>
          <button type="button" className="pill" onClick={() => setLabel(null)}>
            Cancel
          </button>
        </form>
      )}
      {(rename.isError || remove.isError) && (
        <p className="small warn-text">{(rename.error ?? remove.error)?.message}</p>
      )}
    </li>
  );
}
