import {
  formatLondonTime,
  formatLongDate,
  formatNumber,
  formatPounds,
  formatWhen,
  londonDateString,
  nightLabel,
  relativeChange,
  type SourceInfo,
  type WaterSummary,
} from '@home/shared';
import { useSearchParams } from 'react-router';
import { useSources, useWaterSummary } from '../api/hooks.js';
import { Empty, Panel, Skeleton, StatTile } from '../components/Cards.js';
import { BarChart } from '../components/charts/BarChart.js';
import { token } from '../components/charts/theme.js';
import { FreshnessBadge } from '../components/FreshnessBadge.js';
import { ClockIcon } from '../components/icons.js';
import { PageHeader } from '../components/PageHeader.js';
import { NotConnected, PageFreshness, SourceBadge } from '../components/PageBits.js';
import { Status } from '../components/Status.js';
import { useFreshnessNow } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { dayLabel, weekdayLabel } from '../model/energy.js';
import { averageLitres, peakHour } from '../model/water.js';

const WATER_RANGES = ['7d', '28d', '1y'] as const;
type WaterRange = (typeof WATER_RANGES)[number];
const WATER_DAYS: Record<WaterRange, number> = { '7d': 7, '28d': 28, '1y': 365 };

const LEAK = {
  ok: { tone: 'good', title: 'Passed' },
  watch: { tone: 'warn', title: 'Watch' },
  leak: { tone: 'bad', title: 'Possible leak' },
  unknown: { tone: 'muted', title: '—' },
} as const;

export function WaterPage() {
  const now = useNow();
  const at = useFreshnessNow();
  const sources = useSources();
  const source = sources.data?.find((s) => s.id === 'thames_water');
  const [params, setParams] = useSearchParams();
  const range = (WATER_RANGES as readonly string[]).includes(params.get('range') ?? '')
    ? (params.get('range') as WaterRange)
    : '28d';
  const summary = useWaterSummary(
    range === '28d' ? undefined : WATER_DAYS[range],
    !!source?.enabled,
  );
  const setRange = (r: WaterRange) =>
    setParams(
      (p) => {
        if (r === '28d') p.delete('range');
        else p.set('range', r);
        return p;
      },
      { replace: true },
    );
  const s = summary.data;
  const freshness = s?.freshness ? at(s.freshness, 'thames_water') : null;

  return (
    <div className="page">
      <PageHeader
        title="Water"
        range={range}
        ranges={WATER_RANGES}
        onRange={setRange}
        subtitle={
          <>
            <PageFreshness freshness={freshness} />
            {formatLongDate(now)}
          </>
        }
      />
      <DelayBanner source={source} />
      {source && !source.enabled ? (
        <Panel id="water-off-h" title="Water" badge={<SourceBadge source={source} />}>
          <NotConnected source={source}>
            Thames Water isn&apos;t connected yet: the account scraper needs a sample of your
            account&apos;s data (docs/08). Volumes, costs (with a water tariff on the Energy page)
            and the leak check appear here once it runs.
          </NotConnected>
        </Panel>
      ) : summary.isPending ? (
        <Skeleton height={300} />
      ) : !s || s.days.every((d) => d.litres === null) ? (
        <Empty>No water data yet: Thames Water is collected daily at 06:00</Empty>
      ) : (
        <>
          <Tiles s={s} />
          <Hourly s={s} />
          <div className="row">
            <Daily s={s} />
            <LeakTable s={s} />
          </div>
        </>
      )}
    </div>
  );
}

function DelayBanner({ source }: { source: SourceInfo | undefined }) {
  const now = useNow();
  if (!source) return null;
  const days = Math.round(source.policy.expectedDelaySeconds / 86400);
  const lastOk = source.lastRun?.ok ? source.lastRun.finishedAt : null;
  return (
    <div className="alert" style={{ flex: 'none' }}>
      <ClockIcon size={20} />
      <p>
        {source.name} publishes hourly readings about {days} {days === 1 ? 'day' : 'days'} late, so
        this page always runs behind the others.
        {lastOk &&
          ` Last collected ${londonDateString(new Date(lastOk)) === londonDateString(now) ? `today at ${formatLondonTime(new Date(lastOk))}` : formatWhen(lastOk, now)}.`}
      </p>
    </div>
  );
}

function Tiles({ s }: { s: WaterSummary }) {
  const latest = s.days.find((d) => d.date === s.latestDay);
  const peak = peakHour(s.hourly);
  const last7 = s.days.slice(-7);
  const prev7 = s.days.slice(-14, -7);
  const avg7 = averageLitres(last7);
  const avgPrev = prev7.length === 7 ? averageLitres(prev7) : null;
  const change = avg7 !== null && avgPrev !== null ? relativeChange(avgPrev, avg7) : null;
  const total = s.days.reduce((t, d) => t + (d.litres ?? 0), 0);
  const totalCost = s.days.every((d) => d.litres === null || d.costPence !== null)
    ? s.days.reduce((t, d) => t + (d.costPence ?? 0), 0)
    : null;
  const leak = LEAK[s.leak.state];
  const nightsClear = s.leak.state === 'ok' ? s.leak.nightsChecked : 0;

  return (
    <section aria-label="Water totals" className="row">
      <StatTile
        flex="1 1 200px"
        label={latest ? `Latest day · ${weekdayLabel(latest.date)}` : 'Latest day'}
        value={latest?.litres == null ? '—' : formatNumber(latest.litres)}
        unit={latest?.litres == null ? undefined : ' L'}
        context={[
          peak && `Peak ${formatNumber(peak.litres)} L at ${peak.at}`,
          latest?.costPence != null && formatPounds(latest.costPence),
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <StatTile
        flex="1 1 200px"
        label="7-day average"
        value={avg7 === null ? '—' : formatNumber(avg7)}
        unit={avg7 === null ? undefined : ' L/day'}
        context={
          change === null
            ? 'No previous week to compare'
            : `${change >= 0 ? '+' : '−'}${formatNumber(Math.abs(change) * 100)} % on the week before`
        }
      />
      <StatTile
        flex="1 1 200px"
        label={`Last ${s.days.length} days`}
        value={formatNumber(total / 1000, 1)}
        unit=" m³"
        context={
          [
            totalCost !== null && totalCost > 0 && formatPounds(totalCost),
            s.meterReadingM3 !== null && `Meter reading ${formatNumber(s.meterReadingM3, 1)} m³`,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      />
      <StatTile
        flex="1 1 200px"
        label="Leak check"
        value={leak.title}
        context={
          <Status tone={leak.tone}>
            {s.leak.state === 'ok'
              ? `Zero flow every night for ${nightsClear} ${nightsClear === 1 ? 'night' : 'nights'}`
              : s.leak.state === 'unknown'
                ? 'Needs a complete night of data'
                : `Water flowing at night for ${s.leak.consecutive} ${s.leak.consecutive === 1 ? 'night' : 'nights'} in a row`}
          </Status>
        }
      />
    </section>
  );
}

function Hourly({ s }: { s: WaterSummary }) {
  const at = useFreshnessNow();
  return (
    <Panel
      id="hour-h"
      title={
        s.latestDay
          ? `Hour by hour, ${formatLongDate(new Date(`${s.latestDay}T12:00:00Z`))}`
          : 'Hour by hour'
      }
      badge={s.freshness && <FreshnessBadge freshness={at(s.freshness, 'thames_water')} compact />}
      meta="Litres per hour"
    >
      {s.hourly.length === 0 ? (
        <Empty>No complete day yet</Empty>
      ) : (
        <BarChart
          labels={s.hourly.map(([t]) => formatLondonTime(new Date(t)).slice(0, 2))}
          series={[{ name: 'Water', color: token('--accent'), values: s.hourly.map(([, v]) => v) }]}
          formatAxis={(v) => `${v}`}
          ariaLabel={`Bar chart of water use per hour on ${s.latestDay ?? 'the latest day'}${peakHour(s.hourly) ? `, highest ${peakHour(s.hourly)!.litres} litres at ${peakHour(s.hourly)!.at}` : ''}.`}
        />
      )}
    </Panel>
  );
}

function Daily({ s }: { s: WaterSummary }) {
  const avg = averageLitres(s.days);
  const shown = s.days.filter((d) => d.litres !== null);
  return (
    <Panel
      id="days-h"
      title={`Daily use, ${dayLabel(s.from)} – ${dayLabel(s.to)}`}
      flex="999 1 620px"
      meta={avg !== null && `Average ${formatNumber(avg)} L`}
    >
      <BarChart
        labels={shown.map((d) => dayLabel(d.date))}
        series={[{ name: 'Water', color: token('--accent'), values: shown.map((d) => d.litres) }]}
        reference={avg ?? undefined}
        ariaLabel={`Bar chart of daily water use over ${shown.length} days${avg !== null ? `, averaging ${formatNumber(avg)} litres` : ''}.`}
      />
    </Panel>
  );
}

function LeakTable({ s }: { s: WaterSummary }) {
  const nights = s.nights
    .filter((n) => n.complete)
    .slice(-5)
    .reverse();
  return (
    <Panel id="leak-h" title="Night-time leak check" flex="1 1 340px">
      {nights.length === 0 ? (
        <Empty>Needs a complete night of data</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th scope="col">Night</th>
                <th scope="col">Lowest hour</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {nights.map((n) => (
                <tr key={n.night}>
                  <td>{nightLabel(n.night)}</td>
                  <td>{formatNumber(n.minLitres)} L</td>
                  <td>
                    <Status tone={n.minLitres > 0 ? 'warn' : 'good'}>
                      {n.minLitres > 0 ? 'Flow' : 'OK'}
                    </Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note">
        If the lowest hour between midnight and 05:00 is above zero for 3 nights in a row, you get
        an alert: water is flowing when nobody is using it.
      </p>
    </Panel>
  );
}
