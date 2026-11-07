import {
  CONDENSING_LIMIT_C,
  formatLondonTime,
  formatLongDate,
  formatMinutes,
  formatNumber,
  type HeatingSummary,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { useHeatingSummary, useLatest, useReadings, useSources } from '../api/hooks.js';
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
import { hoursMinutes, setpointSegments } from '../model/heating.js';
import { pick, valueOf } from '../model/latest.js';

const MODES = ['Off', 'Heat', 'Cool', 'Heat-cool'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function HeatingPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const sources = useSources();
  const nest = useLatest({ source: 'nest' });
  const probes = useLatest({ source: 'boiler_probes' });
  const summary = useHeatingSummary();
  const source = (id: string) => sources.data?.find((s) => s.id === id);
  const nestSource = source('nest');

  return (
    <div className="page">
      <PageHeader title="Heating" subtitle={formatLongDate(now)} range={range} onRange={setRange} />
      {nestSource && !nestSource.enabled ? (
        <Panel id="heat-off-h" title="Heating" badge={<SourceBadge source={nestSource} />}>
          <NotConnected source={nestSource}>
            The Nest thermostat isn&apos;t connected yet. Set the NEST_* values in .env and enable{' '}
            <code className="code">nest</code> in config/sources.yaml (docs/06 § Nest).
          </NotConnected>
        </Panel>
      ) : (
        <>
          <Tiles
            nest={nest.data}
            summary={summary.data}
            loading={nest.isPending || summary.isPending}
          />
          <SchedulePanel summary={summary.data} />
          <div className="row">
            <PipesPanel latest={probes.data} source={source('boiler_probes')} range={range} />
            <TipsPanel summary={summary.data} />
          </div>
          <div className="row">
            <RuntimePanel summary={summary.data} />
            <Panel
              id="eff-h"
              title="Gas vs outdoor temperature"
              flex="1 1 440px"
              badge={<SourceBadge source={source('smart_meters')} />}
            >
              <NotConnected source={source('smart_meters')}>
                Needs daily gas use from the smart meters
              </NotConnected>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function Tiles({
  nest,
  summary,
  loading,
}: {
  nest: LatestResponse | undefined;
  summary: HeatingSummary | undefined;
  loading: boolean;
}) {
  const at = useFreshnessNow();
  if (loading) {
    return (
      <section aria-label="Heating now" className="row">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="tile">
            <Skeleton height={86} />
          </div>
        ))}
      </section>
    );
  }
  const temp = pick(nest, 'temperature');
  const target = valueOf(nest, 'target_temperature');
  const mode = valueOf(nest, 'thermostat_mode');
  const eco = valueOf(nest, 'eco_mode');
  const hvac = pick(nest, 'hvac_heating', 'boiler');
  const lastRun = summary?.boiler.runs.at(-1);
  const share = summary?.condensingShare ?? null;
  const badge = (item: typeof temp) =>
    item && <FreshnessBadge freshness={at(item.freshness, 'nest')} compact />;
  const summaryBadge = summary?.freshness && (
    <FreshnessBadge freshness={summary.freshness} compact />
  );

  return (
    <section aria-label="Heating now" className="row">
      <StatTile
        flex="1 1 200px"
        label={`${temp ? temp.series.entity.charAt(0).toUpperCase() + temp.series.entity.slice(1).replace(/_/g, ' ') : 'Thermostat'} now`}
        badge={badge(temp)}
        value={temp?.value == null ? '—' : formatNumber(temp.value, 1)}
        unit={temp?.value == null ? undefined : '°C'}
        context={[
          target !== null
            ? `Target ${formatNumber(target, 1)} °C`
            : eco === 1
              ? 'Eco temperature'
              : null,
          mode !== null ? `${MODES[mode] ?? 'Unknown'} mode` : null,
          eco !== null ? `Eco ${eco === 1 ? 'on' : 'off'}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <StatTile
        flex="1 1 200px"
        label="Boiler"
        badge={badge(hvac)}
        value={
          summary?.boiler.heatingNow == null ? '—' : summary.boiler.heatingNow ? 'Heating' : 'Idle'
        }
        context={
          lastRun
            ? `${summary?.boiler.heatingNow ? 'Firing since' : 'Last fired'} ${formatLondonTime(new Date(lastRun.from))}${summary?.boiler.heatingNow ? '' : `–${formatLondonTime(new Date(lastRun.to))}`}`
            : 'Not fired yet today'
        }
      />
      <StatTile
        flex="1 1 200px"
        label="Boiler on today"
        badge={summaryBadge}
        value={summary ? formatMinutes(summary.boiler.minutesOn * 60).replace(' min', '') : '—'}
        context={
          summary
            ? `${summary.boiler.cycles} ${summary.boiler.cycles === 1 ? 'cycle' : 'cycles'}`
            : undefined
        }
      />
      <StatTile
        flex="1 1 200px"
        label="Condensing today"
        badge={summaryBadge}
        value={share === null ? '—' : formatNumber(share * 100)}
        unit={share === null ? undefined : ' %'}
        context={
          share === null ? (
            'Needs the boiler pipe probes'
          ) : (
            <Status tone={share >= 0.9 ? 'good' : 'warn'}>
              of firing time with return below {CONDENSING_LIMIT_C} °C
            </Status>
          )
        }
      />
    </section>
  );
}

function SchedulePanel({ summary }: { summary: HeatingSummary | undefined }) {
  const now = useNow();
  if (!summary) return null;
  const segments = setpointSegments(summary.setpoints, summary.date, now);
  const nowPct = 100 - (segments.at(-1)?.value === null ? segments.at(-1)!.width : 0);
  return (
    <Panel
      id="sched-h"
      title="Today's target temperature"
      badge={summary.freshness && <FreshnessBadge freshness={summary.freshness} compact />}
      meta="As set so far today · the Nest API doesn't share its schedule"
    >
      <div className="schedule">
        <div
          className="schedule-bar"
          role="img"
          aria-label={`Target temperature today: ${
            segments
              .filter((s) => s.value !== null)
              .map((s) => `${formatNumber(s.value!, 1)} °C`)
              .join(', then ') || 'none yet'
          }`}
        >
          {segments.map((s, i) => (
            <div
              key={i}
              className={
                s.value === null ? 'schedule-unknown' : s.warm ? 'schedule-warm' : 'schedule-cool'
              }
              style={{ width: `${s.width}%` }}
            >
              {s.value === null
                ? s.width > 12
                  ? 'Not known yet'
                  : ''
                : s.width > 6
                  ? `${formatNumber(s.value, 1)} °C`
                  : formatNumber(s.value)}
            </div>
          ))}
        </div>
        {nowPct > 0 && nowPct < 100 && (
          <div className="schedule-now" style={{ left: `${nowPct}%` }} aria-hidden="true">
            <span>now</span>
          </div>
        )}
      </div>
      <div className="schedule-scale" aria-hidden="true">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
    </Panel>
  );
}

function PipesPanel({
  latest,
  source,
  range,
}: {
  latest: LatestResponse | undefined;
  source: SourceInfo | undefined;
  range: Range;
}) {
  const combine = useCombinedFreshness();
  const flowId = pick(latest, 'temperature', 'boiler_flow')?.series.id;
  const returnId = pick(latest, 'temperature', 'boiler_return')?.series.id;
  const ids = [flowId, returnId].filter((id): id is number => id !== undefined);
  const readings = useReadings(ids, range);
  const points = (id: number | undefined) =>
    readings.data?.series.find((s) => s.meta.id === id)?.points ?? [];
  const freshness = combine(
    (readings.data?.series ?? []).map((s) => ({
      freshness: s.freshness,
      sourceId: s.meta.sourceId,
    })),
  );
  const flow = points(flowId);
  const ret = points(returnId);
  const max = (p: typeof flow) => (p.length ? Math.max(...p.map(([, v]) => v)) : null);

  return (
    <Panel
      id="flow-h"
      title={`Boiler pipe temperatures, ${RANGE_LABEL[range]}`}
      flex="999 1 620px"
      badge={
        freshness ? (
          <FreshnessBadge freshness={freshness} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={
        ids.length > 0 && (
          <span className="legend">
            <span>
              <span className="swatch" style={{ background: 'var(--heat)' }} />
              Flow
            </span>
            <span>
              <span className="swatch" style={{ background: 'var(--cool)' }} />
              Return
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              <span className="swatch swatch--dashed" />
              {CONDENSING_LIMIT_C} °C condensing limit
            </span>
          </span>
        )
      }
    >
      {ids.length === 0 ? (
        <NotConnected source={source}>
          {source?.enabled ? 'No probe readings yet' : 'Boiler pipe probes aren’t fitted yet'}
        </NotConnected>
      ) : readings.isPending ? (
        <Skeleton height={232} />
      ) : (
        <TimeChart
          series={[
            ...(flow.length ? [{ name: 'Flow', points: flow, color: token('--heat') }] : []),
            ...(ret.length ? [{ name: 'Return', points: ret, color: token('--cool') }] : []),
          ]}
          unit="°C"
          digits={1}
          reference={{ value: CONDENSING_LIMIT_C, color: token('--text-secondary') }}
          spanSeconds={RANGE_SECONDS[range]}
          ariaLabel={`Line chart: flow peaked at ${formatNumber(max(flow) ?? 0)} °C and return at ${formatNumber(max(ret) ?? 0)} °C, against the ${CONDENSING_LIMIT_C} °C condensing limit.`}
        />
      )}
    </Panel>
  );
}

function TipsPanel({ summary }: { summary: HeatingSummary | undefined }) {
  return (
    <Panel id="tips-h" title="Worth trying" flex="1 1 300px">
      {!summary ? (
        <Skeleton height={120} />
      ) : summary.tips.length === 0 ? (
        <p className="meta">Nothing stands out today.</p>
      ) : (
        <div className="tips">
          {summary.tips.map((t) => (
            <div key={t.title} className="stack" style={{ gap: 4 }}>
              <p>{t.title}</p>
              <p>{t.detail}</p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function RuntimePanel({ summary }: { summary: HeatingSummary | undefined }) {
  const days = summary?.days ?? [];
  const longest = days.reduce<(typeof days)[number] | null>(
    (a, d) => (!a || d.minutesOn > a.minutesOn ? d : a),
    null,
  );
  return (
    <Panel
      id="rt-h"
      title="Boiler running time, last 7 days"
      flex="1 1 440px"
      badge={summary?.freshness && <FreshnessBadge freshness={summary.freshness} compact />}
      meta="Hours : minutes per day"
    >
      {!summary ? (
        <Skeleton height={180} />
      ) : days.every((d) => d.minutesOn === 0) ? (
        <Empty>No boiler running time recorded yet</Empty>
      ) : (
        <BarChart
          bars={days.map((d) => ({
            label: WEEKDAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()]!,
            value: d.minutesOn,
            valueLabel: hoursMinutes(d.minutesOn),
          }))}
          color={token('--heat')}
          ariaLabel={`Bar chart of boiler running time per day for the last 7 days${longest ? `, longest ${hoursMinutes(longest.minutesOn)} on ${longest.date}` : ''}.`}
        />
      )}
    </Panel>
  );
}
