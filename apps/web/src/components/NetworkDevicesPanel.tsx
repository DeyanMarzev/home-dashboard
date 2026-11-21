import { formatAgo, type NetworkDevice } from '@home/shared';
import { useState } from 'react';
import { useNetworkDeviceActions, useNetworkDevices } from '../api/settings.js';
import { useNow } from '../lib/now-context.js';
import { Empty, Panel, Skeleton } from './Cards.js';
import { Chip } from './Status.js';

/**
 * Wi-Fi page → Devices (admins; docs/10 §5): everything seen on the home network, new
 * (unknown) devices first. A new-device notification links here (`/wifi#<mac>`).
 */
export function NetworkDevicesPanel() {
  const devices = useNetworkDevices(true);
  const [showAll, setShowAll] = useState(false);
  const items = devices.data?.items ?? [];
  const fresh = items.filter((d) => !d.known);
  const shown = showAll ? items : [...fresh, ...items.filter((d) => d.known).slice(0, 8)];

  return (
    <Panel
      id="netdev-h"
      title="Devices on the network"
      flex="1 1 100%"
      meta={
        devices.data && (
          <span className="small muted">
            {items.length} seen · {fresh.length} new
          </span>
        )
      }
    >
      {devices.isPending ? (
        <Skeleton height={120} />
      ) : devices.isError ? (
        <Empty>{devices.error.message}</Empty>
      ) : items.length === 0 ? (
        <Empty>
          No scan yet: the list fills after netprobe&apos;s next round (every 5 minutes)
        </Empty>
      ) : (
        <div className="stack">
          <ul className="rules">
            {shown.map((d) => (
              <DeviceRow key={d.mac} device={d} />
            ))}
          </ul>
          {shown.length < items.length && (
            <div>
              <button type="button" className="pill" onClick={() => setShowAll(true)}>
                Show all {items.length}
              </button>
            </div>
          )}
          <p className="note">
            Admins only. Every device answering on the home network, wired or Wi-Fi, guests
            included. &quot;This is ours&quot; stops it counting as new; &quot;Forget&quot; removes
            it, so it alerts again next time it connects.
          </p>
        </div>
      )}
    </Panel>
  );
}

function DeviceRow({ device: d }: { device: NetworkDevice }) {
  const now = useNow();
  const { patch, forget } = useNetworkDeviceActions();
  const [label, setLabel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const name = d.label ?? d.hostname ?? (d.vendor ? `${d.vendor} device` : 'Unknown device');
  const facts = [
    d.lastIp,
    d.wired === true ? 'wired' : d.wired === false ? 'Wi-Fi' : null,
    d.randomised ? 'private address' : null,
    d.label && d.vendor ? d.vendor : null,
    `first seen ${formatAgo(d.firstSeen, now)}`,
    `last seen ${formatAgo(d.lastSeen, now)}`,
  ].filter(Boolean);
  const error = patch.error ?? forget.error;

  return (
    <li className="rule" id={d.mac}>
      {label === null ? (
        <div className="rule-head rule-head--wrap">
          <span className="stack" style={{ gap: 2 }}>
            <strong>
              {!d.known && (
                <>
                  <Chip tone="warn">New</Chip>{' '}
                </>
              )}
              {name}
            </strong>
            <span className="small muted">{facts.join(' · ')}</span>
            <span className="small muted">
              {d.mac}
              {d.known && d.markedKnownBy && ` · marked as ours by ${d.markedKnownBy}`}
            </span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            {!d.known && (
              <button
                type="button"
                className="pill pill--primary"
                disabled={patch.isPending}
                onClick={() => patch.mutate({ mac: d.mac, patch: { known: true } })}
              >
                This is ours
              </button>
            )}
            <button type="button" className="pill" onClick={() => setLabel(d.label ?? '')}>
              Rename
            </button>
            <button
              type="button"
              className="pill"
              disabled={forget.isPending}
              onClick={() => (confirm ? forget.mutate(d.mac) : setConfirm(true))}
            >
              {confirm ? 'Really forget?' : 'Forget'}
            </button>
          </span>
        </div>
      ) : (
        <form
          className="row"
          style={{ gap: 8, alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            const text = label.trim();
            patch.mutate(
              { mac: d.mac, patch: { label: text === '' ? null : text } },
              { onSuccess: () => setLabel(null) },
            );
          }}
        >
          <input
            aria-label={`Name for ${d.mac}`}
            value={label}
            maxLength={60}
            placeholder={name}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
          <button type="submit" className="pill pill--primary" disabled={patch.isPending}>
            Save
          </button>
          <button type="button" className="pill" onClick={() => setLabel(null)}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="small warn-text">{error.message}</p>}
    </li>
  );
}
