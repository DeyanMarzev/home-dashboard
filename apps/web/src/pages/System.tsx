import {
  daysUntilFull,
  decodeThrottle,
  describeDays,
  formatLondonTime,
  formatLongDate,
  formatMinutes,
  formatNumber,
  formatUptime,
  formatWhen,
  stats,
  throttleSummary,
  type EventItem,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { useEvents, useHealth, useLatest, useReadings, useSources } from '../api/hooks.js';
import { useLive } from '../api/live-context.js';
import { Empty, Panel, ProgressBar, Skeleton, StatTile } from '../components/Cards.js';
import { TimeChart } from '../components/charts/TimeChart.js';
import { token } from '../components/charts/theme.js';
import { PageHeader } from '../components/PageHeader.js';
import { PageFreshness, SourceBadge } from '../components/PageBits.js';
import { Chip, Status, type Tone } from '../components/Status.js';
import { useCombinedFreshness, useFreshnessNow } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, RANGE_SECONDS, useRange } from '../lib/range.js';
import { BACKUP_OVERDUE_SECONDS, backupStatus } from '../model/backup.js';
import { pick, valueOf } from '../model/latest.js';
import {
  COLLECTOR_STATUS_TEXT,
  collectorStatus,
  describePoll,
  type CollectorStatus,
} from '../model/sources.js';

/** The Pi 4 firmware starts throttling at 80 °C. */
const THROTTLE_C = 80;
const STATUS_TONE: Record<CollectorStatus, Tone> = {
  running: 'good',
  scheduled: 'good',
  failing: 'bad',
  late: 'bad',
  not_connected: 'muted',
};

const formatSize = (mb: number) =>
  mb >= 1000 ? `${formatNumber(mb / 1000, 1)} GB` : `${formatNumber(mb)} MB`;

export function SystemPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const combine = useCombinedFreshness();
  const at = useFreshnessNow();
  const pi = useLatest({ source: 'pi_stats' });
  const sources = useSources();
  const events = useEvents(10);
  const backups = useEvents(1, 'backup');

  const cpuId = pick(pi.data, 'cpu_temperature')?.series.id;
  const cpu = useReadings(cpuId ? [cpuId] : [], range);
  const growthIds = [
    pick(pi.data, 'disk_used', 'sd_card')?.series.id,
    pick(pi.data, 'database_size')?.series.id,
  ].filter((id): id is number => id !== undefined);
  const growth = useReadings(growthIds, '7d', {
    bucket: '1d',
    window: { fromOffsetSeconds: -7 * 86400, toOffsetSeconds: 0, key: '7d-growth' },
  });

  const items = (pi.data?.items ?? []).filter((i) => i.ts !== null);
  const pageFreshness = combine(
    items.map((i) => ({ freshness: i.freshness, sourceId: 'pi_stats' })),
  );
  const cpuPoints = cpu.data?.series[0]?.points ?? [];
  const cpuStats = stats(cpuPoints);
  const peak = cpuPoints.reduce<readonly [string, number] | null>(
    (a, p) => (!a || p[1] > a[1] ? p : a),
    null,
  );
  const sdGrowth = growth.data?.series.find((s) => s.meta.metric === 'disk_used')?.points ?? [];
  const dbGrowth = growth.data?.series.find((s) => s.meta.metric === 'database_size')?.points ?? [];

  const cpuNow = valueOf(pi.data, 'cpu_temperature');
  const mask = valueOf(pi.data, 'throttle_flags');
  const uptime = valueOf(pi.data, 'uptime');
  const memTotal = valueOf(pi.data, 'memory_total');
  const memUsed = valueOf(pi.data, 'memory_used');
  const sdUsed = valueOf(pi.data, 'disk_used', 'sd_card');
  const sdFree = valueOf(pi.data, 'disk_free', 'sd_card');
  const sdPercent = sdUsed !== null && sdFree !== null ? (sdUsed / (sdUsed + sdFree)) * 100 : null;
  const sdDays = sdFree !== null ? daysUntilFull(sdGrowth, sdFree) : null;

  const enabled = (sources.data ?? []).filter((s) => s.enabled);
  const running = enabled.filter((s) =>
    ['running', 'scheduled'].includes(collectorStatus({ ...s, freshness: at(s.freshness, s.id) })),
  );
  const errors24h = enabled.reduce((n, s) => n + s.errors24h, 0);

  return (
    <div className="page">
      <PageHeader
        title="System"
        subtitle={
          <>
            <PageFreshness freshness={pageFreshness} />
            {formatLongDate(now)}
          </>
        }
        range={range}
        onRange={setRange}
      />

      <section aria-label="Pi health" className="row">
        {pi.isPending ? (
          <div className="tile">
            <Skeleton height={86} />
          </div>
        ) : (
          <>
            <StatTile
              flex="1 1 180px"
              label="CPU temperature"
              value={cpuNow === null ? '—' : formatNumber(cpuNow)}
              unit={cpuNow === null ? undefined : ' °C'}
              context={
                peak
                  ? `Peak ${formatNumber(peak[1])} °C at ${formatWhen(peak[0], now)}`
                  : 'No history yet'
              }
            />
            <StatTile
              flex="1 1 180px"
              label="Throttling"
              value={
                mask === null
                  ? '—'
                  : decodeThrottle(mask).some((f) => f.now)
                    ? 'Now'
                    : throttleSummary(mask) === 'None'
                      ? 'None'
                      : 'Earlier'
              }
              context={
                mask === null ? (
                  'Not available (not a Pi?)'
                ) : (
                  <Status
                    tone={
                      decodeThrottle(mask).some((f) => f.now)
                        ? 'bad'
                        : throttleSummary(mask) === 'None'
                          ? 'good'
                          : 'warn'
                    }
                  >
                    {throttleSummary(mask) === 'None' && uptime !== null
                      ? `Since boot ${formatUptime(uptime)} ago`
                      : throttleSummary(mask)}
                  </Status>
                )
              }
            />
            <StatTile
              flex="1 1 180px"
              label="SD card"
              value={sdPercent === null ? '—' : formatNumber(sdPercent)}
              unit={sdPercent === null ? undefined : ' % used'}
              context={
                sdFree === null
                  ? '—'
                  : `${formatNumber(sdFree, 1)} GB free${sdDays !== null ? ` · ${describeDays(sdDays)} at this rate` : ''}`
              }
            />
            <StatTile
              flex="1 1 180px"
              label="Memory"
              value={memTotal && memUsed !== null ? formatNumber((memUsed / memTotal) * 100) : '—'}
              unit={memTotal && memUsed !== null ? ' %' : undefined}
              context={
                memTotal && memUsed !== null
                  ? `${formatNumber(memUsed / 1000, 1)} of ${formatNumber(memTotal / 1000, 1)} GB · load ${valueOf(pi.data, 'load_5m')?.toFixed(2) ?? '—'}`
                  : '—'
              }
            />
            <StatTile
              flex="1 1 180px"
              label="Collectors"
              value={`${running.length} / ${enabled.length}`}
              context={
                <Status tone={running.length === enabled.length ? 'good' : 'bad'}>
                  {running.length === enabled.length
                    ? `All running · ${errors24h} ${errors24h === 1 ? 'error' : 'errors'} in 24 h`
                    : `${enabled.length - running.length} ${enabled.length - running.length === 1 ? 'needs' : 'need'} attention`}
                </Status>
              }
            />
          </>
        )}
      </section>

      <div className="row">
        <Panel
          id="cpu-h"
          title={`CPU temperature, ${RANGE_LABEL[range]}`}
          flex="999 1 620px"
          meta={
            <span className="legend">
              <span style={{ color: 'var(--warn-text)' }}>
                <span className="swatch swatch--dashed" />
                <span style={{ color: 'var(--text-secondary)' }}>
                  {THROTTLE_C} °C throttling starts
                </span>
              </span>
            </span>
          }
        >
          {cpu.isPending && cpuId ? (
            <Skeleton height={192} />
          ) : cpuPoints.length < 2 ? (
            <Empty>No CPU temperature history yet</Empty>
          ) : (
            <TimeChart
              series={[{ name: 'CPU', points: cpuPoints, color: token('--accent') }]}
              unit="°C"
              digits={0}
              reference={{ value: THROTTLE_C, color: token('--warn-text') }}
              spanSeconds={RANGE_SECONDS[range]}
              height={192}
              ariaLabel={`Line chart: CPU temperature between ${formatNumber(cpuStats!.min)} and ${formatNumber(cpuStats!.max)} °C, against the ${THROTTLE_C} °C throttling point.`}
            />
          )}
        </Panel>
        <ThrottlePanel mask={mask} />
      </div>

      <CollectorsTable sources={sources.data} />

      <div className="row">
        <StoragePanel
          latest={pi.data}
          sdPercent={sdPercent}
          dbGrowth={dbGrowth}
          backup={backups.data?.items[0]}
        />
        <ApiPanel />
        <EventsPanel events={events.data?.items} />
      </div>
    </div>
  );
}

function ThrottlePanel({ mask }: { mask: number | null }) {
  return (
    <Panel id="flags-h" title="Power and throttling" flex="1 1 300px">
      {mask === null ? (
        <Empty>Throttle flags are only available on a Raspberry Pi</Empty>
      ) : (
        <>
          <p className="meta">
            From <code className="code">get_throttled</code> · 0x{mask.toString(16)}
          </p>
          <ul className="list">
            {decodeThrottle(mask).map((f) => (
              <li key={f.key}>
                <span>{f.label}</span>
                <Status tone={f.now ? 'bad' : f.sinceBoot ? 'warn' : 'good'}>
                  {f.now ? 'Now' : f.sinceBoot ? 'Since boot' : 'Never'}
                </Status>
              </li>
            ))}
          </ul>
          <p className="meta">
            Under-voltage is the usual cause of random gaps and SD card corruption, so it&apos;s
            worth an alert.
          </p>
        </>
      )}
    </Panel>
  );
}

function CollectorsTable({ sources }: { sources: SourceInfo[] | undefined }) {
  const at = useFreshnessNow();
  const now = useNow();
  return (
    <section aria-labelledby="col-h" className="card">
      <div className="section-title">
        <h2 id="col-h">Collectors</h2>
      </div>
      <div className="table-wrap">
        <table className="data" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th scope="col">Collector</th>
              <th scope="col">Runs every</th>
              <th scope="col">Last run</th>
              <th scope="col">Took</th>
              <th scope="col">Errors (24 h)</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {(sources ?? []).map((s) => {
              const status = collectorStatus({ ...s, freshness: at(s.freshness, s.id) });
              const run = s.lastRun;
              return (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{describePoll(s)}</td>
                  <td>{run ? formatWhen(run.startedAt, now) : '—'}</td>
                  <td>
                    {run?.durationMs == null
                      ? '—'
                      : run.durationMs < 60_000
                        ? `${formatNumber(run.durationMs / 1000, 1)} s`
                        : formatMinutes(run.durationMs / 1000)}
                  </td>
                  <td title={run?.ok === false && run.error ? run.error : undefined}>
                    {s.errors24h}
                    {run?.ok === false && run.error
                      ? ` · ${run.error.length > 48 ? `${run.error.slice(0, 47)}…` : run.error}`
                      : ''}
                  </td>
                  <td>
                    {status === 'not_connected' ? (
                      <SourceBadge source={s} />
                    ) : (
                      <Status tone={STATUS_TONE[status]}>{COLLECTOR_STATUS_TEXT[status]}</Status>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StoragePanel({
  latest,
  sdPercent,
  dbGrowth,
  backup: backupEvent,
}: {
  latest: LatestResponse | undefined;
  sdPercent: number | null;
  dbGrowth: readonly (readonly [string, number])[];
  backup: EventItem | undefined;
}) {
  const now = useNow();
  const sdUsed = valueOf(latest, 'disk_used', 'sd_card');
  const sdFree = valueOf(latest, 'disk_free', 'sd_card');
  const ssdUsed = valueOf(latest, 'disk_used', 'ssd');
  const ssdFree = valueOf(latest, 'disk_free', 'ssd');
  const db = valueOf(latest, 'database_size');
  const first = dbGrowth[0];
  const last = dbGrowth[dbGrowth.length - 1];
  const days = first && last ? (Date.parse(last[0]) - Date.parse(first[0])) / 86_400_000 : 0;
  const perDay = first && last && days >= 1 ? (last[1] - first[1]) / days : null;
  const backup = backupStatus(backupEvent);
  const overdue =
    backup !== null && (now.getTime() - Date.parse(backup.ts)) / 1000 > BACKUP_OVERDUE_SECONDS;

  return (
    <Panel id="db-h" title="Storage and backups" flex="1 1 300px">
      {sdPercent !== null && (
        <ProgressBar
          label={`SD card · ${formatNumber(sdUsed!, 1)} of ${formatNumber(sdUsed! + sdFree!, 1)} GB`}
          right={`${formatNumber(sdPercent)} %`}
          percent={sdPercent}
          ariaLabel={`SD card ${formatNumber(sdPercent)} percent used`}
        />
      )}
      {ssdUsed !== null && ssdFree !== null && (
        <ProgressBar
          label={`SSD · ${formatNumber(ssdUsed, 1)} of ${formatNumber(ssdUsed + ssdFree, 1)} GB`}
          right={`${formatNumber((ssdUsed / (ssdUsed + ssdFree)) * 100)} %`}
          percent={(ssdUsed / (ssdUsed + ssdFree)) * 100}
          ariaLabel={`SSD ${formatNumber((ssdUsed / (ssdUsed + ssdFree)) * 100)} percent used`}
        />
      )}
      <dl className="facts">
        <div>
          <dt>Database</dt>
          <dd>{db === null ? '—' : formatSize(db)}</dd>
        </div>
        <div>
          <dt>Growth</dt>
          <dd>
            {perDay === null
              ? 'Measuring…'
              : `${formatNumber(Math.max(perDay, 0), perDay < 10 ? 1 : 0)} MB / day`}
          </dd>
        </div>
        <div>
          <dt>Raw readings kept</dt>
          <dd>90 days</dd>
        </div>
        <div>
          <dt>Hourly averages kept</dt>
          <dd>Forever</dd>
        </div>
        <div>
          <dt>Last backup</dt>
          <dd>
            {!backup ? (
              'None yet'
            ) : (
              <Status tone={!backup.ok || overdue ? 'bad' : 'good'}>
                {backup.ok
                  ? `${formatWhen(backup.ts, now)}${backup.sizeMb === null ? '' : ` · ${formatSize(backup.sizeMb)}`}`
                  : `Failed ${formatWhen(backup.ts, now)}${backup.failedStep ? ` (${backup.failedStep})` : ''}`}
              </Status>
            )}
          </dd>
        </div>
        {backup?.ok && (
          <div>
            <dt>Copies</dt>
            <dd>
              {backup.keptLocal === null ? 'Nightly' : `${backup.keptLocal} nightly`} on the Pi
              {backup.offsite
                ? backup.keptRemoteDays === null
                  ? ' · off-site'
                  : ` · ${backup.keptRemoteDays} days off-site`
                : ' · no off-site copy'}
            </dd>
          </div>
        )}
      </dl>
    </Panel>
  );
}

function ApiPanel() {
  const health = useHealth();
  const live = useLive();
  const up = health.data?.ok === true;
  return (
    <Panel
      id="api-h"
      title="API server"
      flex="1 1 300px"
      meta={
        <Chip tone={up ? 'good' : 'bad'}>{up ? 'Up' : health.isPending ? 'Checking' : 'Down'}</Chip>
      }
    >
      <dl className="facts">
        <div>
          <dt>Version</dt>
          <dd>{health.data?.version ?? '—'}</dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>{health.data ? (health.data.db === 'up' ? 'Connected' : 'Unreachable') : '—'}</dd>
        </div>
        <div>
          <dt>Live updates</dt>
          <dd>{live.connected ? 'Streaming' : 'Polling every minute'}</dd>
        </div>
        <div>
          <dt>Last update</dt>
          <dd>{live.lastMessageAt ? formatLondonTime(live.lastMessageAt) : '—'}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function EventsPanel({ events }: { events: EventItem[] | undefined }) {
  const now = useNow();
  return (
    <Panel id="ev-h" title="Recent events" flex="1 1 360px">
      {!events ? (
        <Skeleton height={120} />
      ) : events.length === 0 ? (
        <Empty>No events yet</Empty>
      ) : (
        <ol className="list events">
          {events.slice(0, 8).map((e) => (
            <li key={e.id}>
              <time dateTime={e.ts}>{formatWhen(e.ts, now)}</time>
              <span>
                {e.message}
                {e.resolvedAt ? (
                  <span className="muted"> · resolved {formatWhen(e.resolvedAt, now)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
