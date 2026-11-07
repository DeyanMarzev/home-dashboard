import {
  formatLongDate,
  formatNumber,
  formatWhen,
  londonDateString,
  SIGNAL_LABELS,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { useLatest, useReadings, useSources } from '../api/hooks.js';
import { AlertStrip } from '../components/AlertStrip.js';
import { Empty, Panel, Skeleton, StatTile } from '../components/Cards.js';
import { BarChart } from '../components/charts/BarChart.js';
import { TimeChart } from '../components/charts/TimeChart.js';
import { token } from '../components/charts/theme.js';
import { FreshnessBadge } from '../components/FreshnessBadge.js';
import { PageHeader } from '../components/PageHeader.js';
import { NotConnected, SourceBadge } from '../components/PageBits.js';
import { Status } from '../components/Status.js';
import { useCombinedFreshness, useFreshnessNow } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, RANGE_SECONDS, useRange, type Range } from '../lib/range.js';
import { weekdayLabel } from '../model/energy.js';
import { pick, valueOf } from '../model/latest.js';
import { qualitySummary, radioSignals, type RadioSignal } from '../model/wifi.js';

const QUALITY_TONE = { excellent: 'good', good: 'good', fair: 'warn', poor: 'bad' } as const;
const BANDS = [
  { entity: 'band_2_4ghz', name: '2.4 GHz' },
  { entity: 'band_5ghz', name: '5 GHz' },
  { entity: 'band_6ghz', name: '6 GHz' },
];

export function WifiPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const sources = useSources();
  const net = useLatest({ source: 'wifi' });
  const speed = useLatest({ source: 'speed_test' });
  const sensors = useLatest({ source: 'room_sensors', metric: 'wifi_rssi' });
  const source = (id: string) => sources.data?.find((s) => s.id === id);
  const signals = radioSignals(sensors.data?.items ?? [], net.data?.items ?? []);
  const weakest = signals[0];

  return (
    <div className="page">
      <PageHeader title="Wi-Fi" subtitle={formatLongDate(now)} range={range} onRange={setRange} />
      {weakest && (weakest.quality === 'fair' || weakest.quality === 'poor') && (
        <AlertStrip
          events={[
            {
              id: -1,
              ts: now.toISOString(),
              level: 'info',
              sourceId: null,
              kind: 'weak_signal',
              message: `${weakest.name} signal is ${SIGNAL_LABELS[weakest.quality].toLowerCase()} · ${formatNumber(weakest.dBm)} dBm, the weakest in the house`,
              data: null,
              resolvedAt: null,
            },
          ]}
        />
      )}
      <Tiles
        net={net.data}
        speed={speed.data}
        signals={signals}
        range={range}
        loading={net.isPending}
      />
      <div className="row">
        <DevicesChart net={net.data} source={source('wifi')} range={range} />
        <SignalByRoom signals={signals} />
      </div>
      <Panel id="list-h" title="Devices" badge={<SourceBadge source={source('wifi')} />}>
        <Empty>
          The device list (names, band, signal) comes from the Linksys router once its device data
          has been confirmed with a capture from your router (docs/08 question 6). Counts above
          already work.
        </Empty>
      </Panel>
      <div className="row">
        <Channels net={net.data} source={source('wifi')} />
        <SpeedHistory speed={speed.data} source={source('speed_test')} />
      </div>
    </div>
  );
}

function Tiles({
  net,
  speed,
  signals,
  range,
  loading,
}: {
  net: LatestResponse | undefined;
  speed: LatestResponse | undefined;
  signals: RadioSignal[];
  range: Range;
  loading: boolean;
}) {
  const at = useFreshnessNow();
  const now = useNow();
  const devices = pick(net, 'devices_connected', 'network');
  const wifiCount = valueOf(net, 'devices_wifi', 'network');
  const wiredCount = valueOf(net, 'devices_wired', 'network');
  const history = useReadings(devices ? [devices.series.id] : [], range);
  const points = history.data?.series[0]?.points ?? [];
  const peak = points.reduce<(typeof points)[number] | null>(
    (a, p) => (!a || p[1] > a[1] ? p : a),
    null,
  );
  const internet = pick(net, 'latency', 'internet');
  const router = valueOf(net, 'latency', 'router');
  const loss = valueOf(net, 'packet_loss', 'internet');
  const down = pick(speed, 'download', 'internet');
  const up = valueOf(speed, 'upload', 'internet');
  const q = qualitySummary(signals);
  const badge = (item: typeof devices, sourceId: string) =>
    item && <FreshnessBadge freshness={at(item.freshness, sourceId)} compact />;

  if (loading) {
    return (
      <section aria-label="Current network readings" className="row">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile">
            <Skeleton height={86} />
          </div>
        ))}
      </section>
    );
  }
  return (
    <section aria-label="Current network readings" className="row">
      <StatTile
        flex="1 1 200px"
        label="Connected devices"
        badge={badge(devices, 'wifi')}
        value={devices?.value == null ? '—' : formatNumber(devices.value)}
        context={[
          wifiCount !== null && wiredCount !== null
            ? `${wifiCount} Wi-Fi · ${wiredCount} wired`
            : devices
              ? 'Counted by network scan'
              : 'No measurement yet',
          peak && `peak ${formatNumber(peak[1])} at ${formatWhen(peak[0], now)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <StatTile
        flex="1 1 200px"
        label="Wi-Fi quality"
        value={q.overall === null ? '—' : SIGNAL_LABELS[q.overall]}
        context={
          signals.length
            ? `${q.goodOrBetter} good or better · ${q.fair} fair · ${q.poor} poor`
            : 'No Wi-Fi signal readings yet'
        }
      />
      <StatTile
        flex="1 1 200px"
        label="Latency to internet"
        badge={badge(internet, 'wifi')}
        value={internet?.value == null ? '—' : formatNumber(internet.value)}
        unit={internet?.value == null ? undefined : ' ms'}
        context={
          [
            router !== null && `Router ${formatNumber(router)} ms`,
            loss !== null && `packet loss ${formatNumber(loss)} %`,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      />
      <StatTile
        flex="1 1 200px"
        label="Broadband speed"
        badge={badge(down, 'speed_test')}
        value={down?.value == null ? '—' : formatNumber(down.value)}
        unit={down?.value == null ? undefined : ' Mbps'}
        context={
          down?.ts
            ? `Upload ${up === null ? '—' : formatNumber(up)} Mbps · tested ${formatWhen(down.ts, now)}`
            : 'Tested daily at 12:00'
        }
      />
    </section>
  );
}

function DevicesChart({
  net,
  source,
  range,
}: {
  net: LatestResponse | undefined;
  source: SourceInfo | undefined;
  range: Range;
}) {
  const combine = useCombinedFreshness();
  const id = pick(net, 'devices_connected', 'network')?.series.id;
  const readings = useReadings(id ? [id] : [], range);
  const series = readings.data?.series[0];
  const values = series?.points.map(([, v]) => v) ?? [];
  const freshness = combine(series ? [{ freshness: series.freshness, sourceId: 'wifi' }] : []);
  return (
    <Panel
      id="dev-h"
      title={`Connected devices, ${RANGE_LABEL[range]}`}
      flex="999 1 620px"
      badge={
        freshness ? (
          <FreshnessBadge freshness={freshness} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={
        values.length > 0 &&
        `Low ${formatNumber(Math.min(...values))} · high ${formatNumber(Math.max(...values))}`
      }
    >
      {!id ? (
        <NotConnected source={source}>
          No device counts yet: they come from the netprobe container every 5 minutes
        </NotConnected>
      ) : readings.isPending ? (
        <Skeleton height={200} />
      ) : (
        <TimeChart
          series={[{ name: 'Devices', points: series?.points ?? [], color: token('--accent') }]}
          unit="devices"
          digits={0}
          height={200}
          spanSeconds={RANGE_SECONDS[range]}
          ariaLabel={`Line chart of connected devices over the ${RANGE_LABEL[range]}${values.length ? `, between ${Math.min(...values)} and ${Math.max(...values)}` : ''}.`}
        />
      )}
    </Panel>
  );
}

function SignalByRoom({ signals }: { signals: RadioSignal[] }) {
  return (
    <Panel id="room-h" title="Signal by room" flex="1 1 320px">
      {signals.length === 0 ? (
        <Empty>No Wi-Fi signal readings yet</Empty>
      ) : (
        <div className="stack">
          {[...signals].reverse().map((s) => (
            <div key={s.key} className="progress">
              <div className="progress-label">
                <span>{s.name}</span>
                <span>
                  <strong>{formatNumber(s.dBm)} dBm</strong> · {SIGNAL_LABELS[s.quality]}
                </span>
              </div>
              {/* −90 dBm (unusable) to −30 dBm (next to the router) */}
              <div className="progress-track" aria-hidden="true">
                <div
                  className={`progress-fill progress-fill--${QUALITY_TONE[s.quality]}`}
                  style={{ width: `${Math.max(4, Math.min(100, ((s.dBm + 90) / 60) * 100))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="note">
        Measured by each room sensor&apos;s own Wi-Fi radio, and the Pi&apos;s. Excellent ≥ −55 ·
        Good to −67 · Fair to −75 · Poor below
      </p>
    </Panel>
  );
}

function Channels({
  net,
  source,
}: {
  net: LatestResponse | undefined;
  source: SourceInfo | undefined;
}) {
  const at = useFreshnessNow();
  const bands = BANDS.flatMap((b) => {
    const neighbours = pick(net, 'neighbour_networks', b.entity);
    if (!neighbours || neighbours.value === null) return [];
    return [
      {
        ...b,
        neighbours,
        channel: valueOf(net, 'wifi_channel', b.entity),
        onChannel: valueOf(net, 'neighbours_on_channel', b.entity) ?? 0,
      },
    ];
  });
  return (
    <Panel
      id="chan-h"
      title="Channels and neighbours"
      flex="1 1 420px"
      badge={
        bands[0] ? (
          <FreshnessBadge freshness={at(bands[0].neighbours.freshness, 'wifi')} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
    >
      {bands.length === 0 ? (
        <Empty>No channel scan yet (every 30 minutes, needs the Pi&apos;s Wi-Fi)</Empty>
      ) : (
        <div className="boxes boxes--rich" style={{ flexWrap: 'wrap' }}>
          {bands.map((b) => (
            <div key={b.entity} className="box stack" style={{ gap: 4, minWidth: 160 }}>
              <span className="small muted">
                {b.name}
                {b.channel !== null && ` · channel ${b.channel}`}
              </span>
              <span className="big big--sm">
                {b.neighbours.value} {b.neighbours.value === 1 ? 'neighbour' : 'neighbours'}
              </span>
              <Status tone={b.onChannel >= 2 ? 'warn' : 'good'}>
                {b.onChannel >= 2
                  ? `Crowded · ${b.onChannel} on your channel`
                  : b.onChannel === 1
                    ? 'Shared with 1 network'
                    : 'Clear'}
              </Status>
            </div>
          ))}
        </div>
      )}
      <p className="note">
        From the Pi&apos;s own scan of nearby networks, every 30 minutes. Networks with your name
        (other mesh nodes) aren&apos;t counted.
      </p>
    </Panel>
  );
}

function SpeedHistory({
  speed,
  source,
}: {
  speed: LatestResponse | undefined;
  source: SourceInfo | undefined;
}) {
  const at = useFreshnessNow();
  const down = pick(speed, 'download', 'internet');
  const readings = useReadings(down ? [down.series.id] : [], '7d', {
    bucket: '1d',
    window: { fromOffsetSeconds: -7 * 86400, toOffsetSeconds: 0, key: 'speed-7d' },
  });
  const points = (readings.data?.series[0]?.points ?? []).filter(([, v]) => v > 0);
  return (
    <Panel
      id="speed-h"
      title="Download speed, last 7 days"
      flex="1 1 420px"
      badge={
        down ? (
          <FreshnessBadge freshness={at(down.freshness, 'speed_test')} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta="Daily at 12:00 · Mbps"
    >
      {points.length === 0 ? (
        <Empty>No speed tests yet (daily at 12:00)</Empty>
      ) : (
        <BarChart
          labels={points.map(([t]) => weekdayLabel(londonDateString(new Date(t))).slice(0, 3))}
          series={[
            { name: 'Download', color: token('--accent'), values: points.map(([, v]) => v) },
          ]}
          valueLabels={points.map(([, v]) => formatNumber(v))}
          ariaLabel={`Bar chart of daily download speed for the last ${points.length} days.`}
        />
      )}
    </Panel>
  );
}
