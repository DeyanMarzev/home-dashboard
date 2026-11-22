import { formatAgo, formatWhen, type NetworkDevice } from '@home/shared';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useNetworkDeviceActions, useNetworkDevices } from '../api/settings.js';
import { useNow } from '../lib/now-context.js';
import { Empty, Panel, Skeleton } from './Cards.js';
import { Chip } from './Status.js';
import { Switch } from './Switch.js';

/** netprobe scans every 5 minutes: seen in about the last two scans = on the network now. */
const NOW_MS = 11 * 60_000;

/** The admin's label, else the router's name, else the maker. */
const nameOf = (d: NetworkDevice) =>
  d.label ?? d.hostname ?? (d.vendor ? `${d.vendor} device` : 'Unknown device');

/**
 * Wi-Fi page → Devices on the network (admins; docs/10 §5): one line per device (name, first
 * seen, last seen), new ones first; tap for everything known about it, the actions and your
 * own "tell me when it connects / leaves" reminders. A notification links to `/wifi#<mac>`,
 * which opens that device.
 */
export function NetworkDevicesPanel() {
  const devices = useNetworkDevices(true);
  const [showAll, setShowAll] = useState(false);
  const items = devices.data?.items ?? [];
  const fresh = items.filter((d) => !d.known);
  const shown = showAll ? items : [...fresh, ...items.filter((d) => d.known).slice(0, 10)];

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
              <DeviceRow key={d.mac} device={d} awayMinutes={devices.data.awayMinutes} />
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
            included. Tap one for details.
          </p>
        </div>
      )}
    </Panel>
  );
}

function DeviceRow({ device: d, awayMinutes }: { device: NetworkDevice; awayMinutes: number }) {
  const now = useNow();
  const { hash } = useLocation();
  const [open, setOpen] = useState(() => decodeURIComponent(hash.slice(1)) === d.mac);
  const onNow = d.present && now.getTime() - Date.parse(d.lastSeen) < NOW_MS;
  const detailsId = `dev-${d.mac.replace(/:/g, '')}`;

  return (
    <li className="rule" id={d.mac}>
      <button
        type="button"
        className="rule-name device-line"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
      >
        <span className="rule-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="stack" style={{ gap: 2 }}>
          <strong>
            {!d.known && (
              <>
                <Chip tone="warn">New</Chip>{' '}
              </>
            )}
            {nameOf(d)}
          </strong>
          <span className="small muted">
            First seen {formatWhen(d.firstSeen, now)} · last seen{' '}
            {onNow ? <strong className="now-text">now</strong> : formatAgo(d.lastSeen, now)}
          </span>
        </span>
      </button>
      {open && <DeviceDetails id={detailsId} device={d} awayMinutes={awayMinutes} />}
    </li>
  );
}

function DeviceDetails({
  id,
  device: d,
  awayMinutes,
}: {
  id: string;
  device: NetworkDevice;
  awayMinutes: number;
}) {
  const now = useNow();
  const { patch, forget, watch } = useNetworkDeviceActions();
  const [label, setLabel] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const error = patch.error ?? forget.error ?? watch.error;
  const facts: [string, string | null][] = [
    ['Your name for it', d.label],
    ["Router's name", d.hostname],
    ['Maker', d.vendor ?? (d.randomised ? 'Hidden (private address)' : 'Unknown')],
    ['IP address', d.lastIp],
    ['Connection', d.wired === true ? 'Wired' : d.wired === false ? 'Wi-Fi' : 'Not known'],
    ['MAC address', `${d.mac}${d.randomised ? ' (private, set by the phone)' : ''}`],
    ['First seen', formatWhen(d.firstSeen, now)],
    ['Last seen', formatWhen(d.lastSeen, now)],
    [
      'Status',
      d.known
        ? `Ours${d.markedKnownBy ? `, marked by ${d.markedKnownBy}` : ''}${d.markedKnownAt ? ` on ${formatWhen(d.markedKnownAt, now)}` : ''}`
        : 'New: not marked as ours yet',
    ],
  ];
  const setWatch = (change: { onConnect?: boolean; onLeave?: boolean }) =>
    watch.mutate({
      mac: d.mac,
      watch: { onConnect: d.watchConnect, onLeave: d.watchLeave, ...change },
    });

  return (
    <div id={id} className="rule-body">
      <dl className="facts-list">
        {facts
          .filter(([, v]) => v !== null)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      <div className="stack" style={{ gap: 0 }}>
        <Switch checked={d.watchConnect} onChange={(on) => setWatch({ onConnect: on })}>
          Tell me when it connects
        </Switch>
        <Switch checked={d.watchLeave} onChange={(on) => setWatch({ onLeave: on })}>
          Tell me when it leaves
        </Switch>
        <span className="small muted">
          Just for you. Away for{' '}
          {awayMinutes >= 60 && awayMinutes % 60 === 0
            ? `${awayMinutes / 60} h`
            : `${awayMinutes} min`}{' '}
          counts as left, so a phone dozing on the Wi-Fi doesn&apos;t keep triggering it.
        </span>
      </div>

      {label === null ? (
        <div className="row" style={{ gap: 6 }}>
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
            placeholder={nameOf(d)}
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
    </div>
  );
}
