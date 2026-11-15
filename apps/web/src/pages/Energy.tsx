import {
  formatLondonTime,
  formatLongDate,
  formatNumber,
  formatPounds,
  londonDayBounds,
  relativeChange,
  type EnergyDay,
  type EnergySummary,
} from '@home/shared';
import { useSearchParams } from 'react-router';
import { useEnergySummary, useLatest, useReadings, useSources } from '../api/hooks.js';
import { Empty, Panel, Skeleton, StatTile } from '../components/Cards.js';
import { BarChart } from '../components/charts/BarChart.js';
import { token } from '../components/charts/theme.js';
import { FreshnessBadge } from '../components/FreshnessBadge.js';
import { PageHeader } from '../components/PageHeader.js';
import { FreshnessKey, NotConnected, SourceBadge } from '../components/PageBits.js';
import { TariffPanel } from '../components/TariffPanel.js';
import { useFreshnessNow } from '../lib/freshness.js';
import { averageKwh, dayLabel, dayPence, sumDays as sum, weekdayLabel } from '../model/energy.js';
import { pick } from '../model/latest.js';
import { useNow } from '../lib/now-context.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const percent = (change: number | null) =>
  change === null ? null : `${change >= 0 ? '+' : '−'}${formatNumber(Math.abs(change) * 100)} %`;

export function EnergyPage() {
  const now = useNow();
  const sources = useSources();
  const meters = sources.data?.find((s) => s.id === 'smart_meters');
  const [params, setParams] = useSearchParams();
  const days = params.get('days') === '30' ? 30 : 14;
  const summary = useEnergySummary(days === 14 ? undefined : { days }, !!meters?.enabled);
  const s = summary.data;
  const setDays = (r: '14d' | '30d') =>
    setParams(
      (p) => {
        if (r === '30d') p.set('days', '30');
        else p.delete('days');
        return p;
      },
      { replace: true },
    );

  return (
    <div className="page">
      <PageHeader
        title="Energy"
        subtitle={`${formatLongDate(now)}${s?.latestDay ? ` · smart meter data to ${dayLabel(s.latestDay)}` : ''}`}
        range={`${days}d`}
        ranges={['14d', '30d'] as const}
        onRange={setDays}
      />
      <FreshnessKey delayedNote="smart meter readings arrive the next day, so today is not shown yet" />
      {meters && !meters.enabled ? (
        <Panel id="meters-h" title="Smart meters" badge={<SourceBadge source={meters} />}>
          <NotConnected source={meters}>
            Smart meters aren&apos;t connected yet: the data provider is still to be chosen (docs/08
            question 3). You can enter your tariff below now.
          </NotConnected>
        </Panel>
      ) : summary.isPending ? (
        <Skeleton height={300} />
      ) : !s || s.days.every((d) => !d.electricity && !d.gas) ? (
        <Empty>No meter data yet</Empty>
      ) : (
        <>
          <Tiles s={s} />
          <div className="row">
            <HourlyUse s={s} fuel="electricity" />
            <HourlyUse s={s} fuel="gas" />
          </div>
          <div className="row">
            <DailyUse s={s} fuel="electricity" />
            <DailyUse s={s} fuel="gas" />
          </div>
          <DailyCost s={s} />
          <div className="row">
            <Panel
              id="where-h"
              title="Where the electricity went"
              flex="999 1 560px"
              badge={<SourceBadge source={undefined} freshness={s.freshness} compact />}
            >
              <Empty>
                Needs smart plugs on the big appliances (docs/08 question 7): their use is then
                split out of the meter total.
              </Empty>
            </Panel>
            <div className="stack" style={{ flex: '1 1 320px', gap: 14 }}>
              <Baseload s={s} />
              <Carbon s={s} />
            </div>
          </div>
        </>
      )}
      <TariffPanel
        fuels={['electricity', 'gas']}
        empty="No rates yet. Add your electricity and gas rates to see costs."
      />
    </div>
  );
}

function Tiles({ s }: { s: EnergySummary }) {
  const at = useFreshnessNow();
  const badge = s.freshness && (
    <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} compact />
  );
  const latest = s.days.find((d) => d.date === s.latestDay);
  const last7 = s.days.slice(-7);
  const prev7 = s.days.length >= 14 ? s.days.slice(-14, -7) : [];
  const elec = sum(last7, (d) => d.electricity?.kwh);
  const gas = sum(last7, (d) => d.gas?.kwh);
  const elecChange = prev7.length
    ? relativeChange(
        sum(prev7, (d) => d.electricity?.kwh),
        elec,
      )
    : null;
  const gasChange = prev7.length
    ? relativeChange(
        sum(prev7, (d) => d.gas?.kwh),
        gas,
      )
    : null;
  const avgOut = (days: EnergyDay[]) => {
    const xs = days.flatMap((d) => (d.outdoorC === null ? [] : [d.outdoorC]));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const outNow = avgOut(last7);
  const outBefore = avgOut(prev7);
  const outDiff = outNow !== null && outBefore !== null ? outNow - outBefore : null;
  const range = last7.length ? `${dayLabel(last7[0]!.date)}–${dayLabel(last7.at(-1)!.date)}` : '';
  const latestCost = latest ? dayPence(latest, true) : null;
  const month = MONTHS[Number(s.month.to.slice(5, 7)) - 1];

  return (
    <section aria-label="Energy totals" className="row">
      <StatTile
        flex="1 1 200px"
        label={latest ? `Latest day · ${weekdayLabel(latest.date)}` : 'Latest day'}
        badge={badge}
        value={latestCost === null ? '—' : formatPounds(latestCost)}
        context={
          latest
            ? `${formatNumber(latest.electricity?.kwh ?? 0, 1)} kWh elec · ${formatNumber(latest.gas?.kwh ?? 0)} kWh gas`
            : 'No complete day yet'
        }
      />
      <StatTile
        flex="1 1 200px"
        label={`${month} · ${Number(s.month.from.slice(8))}–${dayLabel(s.month.to)}`}
        badge={badge}
        value={formatPounds(s.month.costPence)}
        context={
          s.month.projectedPence === null
            ? 'Add a tariff to see costs'
            : `On track for about ${formatPounds(Math.round(s.month.projectedPence / 1000) * 1000, 0)} this month`
        }
      />
      <StatTile
        flex="1 1 200px"
        label={`Electricity · ${range}`}
        badge={badge}
        value={formatNumber(elec, 1)}
        unit=" kWh"
        context={
          elecChange === null
            ? 'No previous week to compare'
            : `${percent(elecChange)} on last week`
        }
      />
      <StatTile
        flex="1 1 200px"
        label={`Gas · ${range}`}
        badge={badge}
        value={formatNumber(gas)}
        unit=" kWh"
        context={
          gasChange === null
            ? 'No previous week to compare'
            : `${percent(gasChange)}${outDiff !== null && Math.abs(outDiff) >= 0.5 ? ` · outdoors ${formatNumber(Math.abs(outDiff))} °C ${outDiff < 0 ? 'colder' : 'warmer'}` : ''}`
        }
      />
    </section>
  );
}

const FUEL = {
  electricity: { name: 'Electricity', colour: '--cool' },
  gas: { name: 'Gas', colour: '--heat' },
} as const;
type Fuel = keyof typeof FUEL;

/** kWh per hour on the newest complete day, like the Water page's hour by hour. */
function HourlyUse({ s, fuel }: { s: EnergySummary; fuel: Fuel }) {
  const at = useFreshnessNow();
  const meters = useLatest({ source: 'smart_meters' });
  const id = pick(meters.data, 'energy_import', fuel)?.series.id;
  const bounds = s.latestDay ? londonDayBounds(s.latestDay) : null;
  const hourly = useReadings(id && bounds ? [id] : [], '24h', {
    bucket: '1h',
    agg: 'sum',
    between: bounds ? { from: bounds.from.toISOString(), to: bounds.to.toISOString() } : undefined,
  });
  const points = hourly.data?.series[0]?.points ?? [];
  const day = s.days.find((d) => d.date === s.latestDay)?.[fuel];
  const peak = points.reduce<(typeof points)[number] | null>(
    (a, p) => (!a || p[1] > a[1] ? p : a),
    null,
  );
  const baseloadKwh = fuel === 'electricity' && s.baseload ? s.baseload.watts / 1000 : undefined;
  const { name, colour } = FUEL[fuel];
  return (
    <Panel
      id={`${fuel}-hour-h`}
      title={s.latestDay ? `${name} by hour, ${weekdayLabel(s.latestDay)}` : `${name} by hour`}
      flex="1 1 420px"
      badge={s.freshness && <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} compact />}
      meta={
        day && (
          <>
            {formatNumber(day.kwh, 1)} kWh
            {day.energyPence !== null && ` · ${formatPounds(day.energyPence)}`}
            {peak && ` · peak ${formatLondonTime(new Date(peak[0]))}`}
          </>
        )
      }
    >
      {!s.latestDay ? (
        <Empty>No complete day yet</Empty>
      ) : hourly.isPending && id ? (
        <Skeleton height={180} />
      ) : points.length === 0 ? (
        <Empty>No {name.toLowerCase()} readings that day</Empty>
      ) : (
        <BarChart
          labels={points.map(([t]) => formatLondonTime(new Date(t)).slice(0, 2))}
          series={[{ name, color: token(colour), values: points.map(([, v]) => v) }]}
          reference={baseloadKwh}
          formatAxis={(v) => formatNumber(v, Number.isInteger(v) ? 0 : 1)}
          ariaLabel={`Bar chart of ${name.toLowerCase()} kWh per hour on ${weekdayLabel(s.latestDay)}${peak ? `, highest ${formatNumber(peak[1], 2)} kWh at ${formatLondonTime(new Date(peak[0]))}` : ''}${baseloadKwh ? `; dashed line is the ${s.baseload!.watts} W baseload` : ''}.`}
        />
      )}
    </Panel>
  );
}

/** kWh per day over the page's range, with the average dashed. */
function DailyUse({ s, fuel }: { s: EnergySummary; fuel: Fuel }) {
  const { name, colour } = FUEL[fuel];
  const shown = s.days.filter((d) => d[fuel]);
  const avg = averageKwh(s.days, fuel);
  return (
    <Panel
      id={`${fuel}-days-h`}
      title={`${name} per day, ${dayLabel(s.from)} – ${dayLabel(s.to)}`}
      flex="1 1 420px"
      meta={avg !== null && `Average ${formatNumber(avg, 1)} kWh a day`}
    >
      {shown.length === 0 ? (
        <Empty>No {name.toLowerCase()} readings yet</Empty>
      ) : (
        <BarChart
          labels={shown.map((d) => dayLabel(d.date))}
          series={[{ name, color: token(colour), values: shown.map((d) => d[fuel]!.kwh) }]}
          reference={avg ?? undefined}
          formatAxis={(v) => `${formatNumber(v)}`}
          ariaLabel={`Bar chart of daily ${name.toLowerCase()} use over ${shown.length} days${avg !== null ? `, averaging ${formatNumber(avg, 1)} kWh` : ''}.`}
        />
      )}
    </Panel>
  );
}

function DailyCost({ s }: { s: EnergySummary }) {
  const at = useFreshnessNow();
  const priced = s.days.some(
    (d) => d.electricity?.energyPence != null || d.gas?.energyPence != null,
  );
  const total = sum(s.days, (d) => dayPence(d, false));
  return (
    <Panel
      id="cost-h"
      title={`Daily cost, ${dayLabel(s.from)} – ${dayLabel(s.to)}`}
      badge={s.freshness && <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} />}
      meta={
        priced && (
          <span className="legend">
            <span>
              <span className="swatch swatch--band" style={{ background: 'var(--cool)' }} />
              Electricity
            </span>
            <span>
              <span className="swatch swatch--band" style={{ background: 'var(--heat)' }} />
              Gas
            </span>
            <span>{formatPounds(total)} total · excl. standing charges</span>
          </span>
        )
      }
    >
      {!priced ? (
        <Empty>Add your tariff below to see daily costs</Empty>
      ) : (
        <BarChart
          labels={s.days.map((d) => dayLabel(d.date))}
          series={[
            {
              name: 'Electricity',
              color: token('--cool'),
              values: s.days.map((d) => (d.electricity?.energyPence ?? 0) / 100),
            },
            {
              name: 'Gas',
              color: token('--heat'),
              values: s.days.map((d) => (d.gas?.energyPence ?? 0) / 100),
            },
          ]}
          formatAxis={(v) => formatPounds(Math.round(v * 100), Number.isInteger(v) ? 0 : 2)}
          height={220}
          ariaLabel={`Stacked bar chart of daily electricity and gas cost from ${dayLabel(s.from)} to ${dayLabel(s.to)}, ${formatPounds(total)} in total excluding standing charges.`}
        />
      )}
    </Panel>
  );
}

function Baseload({ s }: { s: EnergySummary }) {
  const b = s.baseload;
  return (
    <Panel
      id="base-h"
      title="Baseload"
      badge={s.freshness && <FreshnessBadge freshness={s.freshness} compact />}
    >
      {!b ? (
        <Empty>Needs a complete day of meter data</Empty>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span className="big">
              {b.watts}
              <span className="unit"> W</span>
            </span>
            <span className="meta">lowest use, night of {dayLabel(b.night)}</span>
          </div>
          <p style={{ fontSize: 14 }}>
            Always-on devices use about {formatNumber((b.watts * 24) / 1000, 1)} kWh a day
            {b.yearlyPence !== null && (
              <>
                , roughly{' '}
                <strong>{formatPounds(Math.round(b.yearlyPence / 1000) * 1000, 0)} a year</strong>
              </>
            )}
            .
          </p>
          {b.previousWatts !== null && b.previousWatts !== b.watts && (
            <p className="meta">
              {b.watts > b.previousWatts ? 'Up' : 'Down'} from {b.previousWatts} W four weeks ago
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function Carbon({ s }: { s: EnergySummary }) {
  return (
    <Panel
      id="co2-h"
      title={`Carbon, ${dayLabel(s.from)} – ${dayLabel(s.to)}`}
      badge={s.freshness && <FreshnessBadge freshness={s.freshness} compact />}
    >
      <dl className="facts">
        <div>
          <dt>Electricity</dt>
          <dd>
            {s.carbon.electricityKg === null
              ? '—'
              : `${formatNumber(s.carbon.electricityKg, 1)} kg CO₂`}
          </dd>
        </div>
        <div>
          <dt>Gas</dt>
          <dd>{s.carbon.gasKg === null ? '—' : `${formatNumber(s.carbon.gasKg, 1)} kg CO₂`}</dd>
        </div>
      </dl>
      <p className="note">
        {s.carbon.electricityKg === null
          ? 'Electricity needs the grid intensity for most half-hours of the period (recorded from now on).'
          : "Electricity uses the grid's recorded half-hourly intensity; gas the UK conversion factor."}
      </p>
    </Panel>
  );
}
