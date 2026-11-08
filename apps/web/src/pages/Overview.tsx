import {
  averageByWindow,
  formatPounds,
  londonDayBounds,
  CONDENSING_LIMIT_C,
  formatMinutes,
  stateRuns,
  averageSeries,
  co2Level,
  CO2_LABELS,
  CO2_THRESHOLD_PPM,
  describeWeather,
  dewPoint,
  formatAgo,
  formatLondonTime,
  formatLongDate,
  formatNumber,
  formatUptime,
  formatWhen,
  INTENSITY_INDEX,
  lowestWindow,
  mouldRisk,
  MOULD_LABELS,
  piStatus,
  powerState,
  stats,
  type LatestResponse,
  type SourceInfo,
  type WaterSummary,
} from '@home/shared';
import {
  useEnergySummary,
  useEvents,
  useHeatingSummary,
  useLatest,
  useReadings,
  useSources,
  useWaterSummary,
} from '../api/hooks.js';
import { useLive } from '../api/live-context.js';
import { AlertStrip } from '../components/AlertStrip.js';
import { Empty, Panel, ProgressBar, Skeleton, StatTile } from '../components/Cards.js';
import { BarChart } from '../components/charts/BarChart.js';
import { TimeChart } from '../components/charts/TimeChart.js';
import { token } from '../components/charts/theme.js';
import { FreshnessBadge } from '../components/FreshnessBadge.js';
import { PageHeader } from '../components/PageHeader.js';
import { FreshnessKey, NotConnected, SourceBadge } from '../components/PageBits.js';
import { Chip, Status } from '../components/Status.js';
import { useCombinedFreshness, useFreshnessNow } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, RANGE_SECONDS, useRange, type Range } from '../lib/range.js';
import { dayLabel, dayPence, weekdayLabel } from '../model/energy.js';
import { pick, valueOf } from '../model/latest.js';
import { buildRooms, valuesOf, type Room } from '../model/rooms.js';
import { COLLECTOR_STATUS_TEXT, collectorStatus, describePoll } from '../model/sources.js';

const MOULD_TONE = { low: 'good', watch: 'warn', high: 'bad' } as const;
/** How long one point of the heating state holds, by the bucket the API used. */
const BUCKET_HOLD_SECONDS = { raw: 360, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 } as const;
const CO2_TONE = { good: 'good', fair: 'good', high: 'warn', very_high: 'bad' } as const;

export function OverviewPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const live = useLive();
  const sources = useSources();
  const sensors = useLatest({ source: 'room_sensors' });
  const nest = useLatest({ source: 'nest' });
  const weather = useLatest({ source: 'open_meteo' });
  const grid = useLatest({ source: 'carbon_intensity' });
  const pi = useLatest({ source: 'pi_stats' });
  const events = useEvents(20);

  const source = (id: string) => sources.data?.find((s) => s.id === id);
  const rooms = buildRooms([...(sensors.data?.items ?? []), ...(nest.data?.items ?? [])]);
  const updated =
    live.lastMessageAt ?? (sensors.dataUpdatedAt ? new Date(sensors.dataUpdatedAt) : null);
  const openAlerts = (events.data?.items ?? [])
    .filter((e) => e.resolvedAt === null && e.level !== 'info')
    .slice(0, 4);

  return (
    <div className="page">
      <PageHeader
        title="Home"
        subtitle={`${formatLongDate(now)}${updated ? ` · updated ${formatLondonTime(updated)}` : ''}`}
        range={range}
        onRange={setRange}
      />
      <FreshnessKey />
      <AlertStrip events={openAlerts} />
      <Tiles
        rooms={rooms}
        weather={weather.data}
        nest={nest.data}
        source={source}
        loading={sensors.isPending}
      />
      <div className="row">
        <TemperaturePanel rooms={rooms} weather={weather.data} nest={nest.data} range={range} />
        <HeatingPanel source={source('nest')} />
      </div>
      <RoomsSection rooms={rooms} loading={sensors.isPending} />
      <div className="row">
        <ElectricityPanel source={source('smart_meters')} />
        <GasPanel source={source('smart_meters')} />
        <GridPanel latest={grid.data} source={source('carbon_intensity')} />
      </div>
      <div className="row">
        <WaterPanel source={source('thames_water')} />
        <PiPanel latest={pi.data} />
      </div>
      <SourcesTable sources={sources.data} />
    </div>
  );
}

// --- Tiles -------------------------------------------------------------------------------

function Tiles({
  rooms,
  weather,
  nest,
  source,
  loading,
}: {
  rooms: Room[];
  weather: LatestResponse | undefined;
  nest: LatestResponse | undefined;
  source: (id: string) => SourceInfo | undefined;
  loading: boolean;
}) {
  const at = useFreshnessNow();
  const combine = useCombinedFreshness();
  const sensorRooms = rooms.filter((r) => r.kind === 'sensor');
  const thermostat = rooms.find((r) => r.kind === 'thermostat');

  const temps = valuesOf(sensorRooms, 'temperature');
  const humidities = valuesOf(sensorRooms, 'humidity');
  const co2s = valuesOf(sensorRooms, 'co2');
  const pressures = valuesOf(sensorRooms, 'pressure');
  const avg = (xs: { value: number }[]) =>
    xs.length ? xs.reduce((s, x) => s + x.value, 0) / xs.length : null;
  const badgeFor = (metric: 'temperature' | 'humidity' | 'co2') => {
    const f = combine(
      sensorRooms.flatMap((r) =>
        r.metrics[metric]
          ? [{ freshness: r.metrics[metric].freshness, sourceId: r.metrics[metric].sourceId }]
          : [],
      ),
    );
    return f ? (
      <FreshnessBadge freshness={f} compact />
    ) : (
      <SourceBadge source={source('room_sensors')} compact />
    );
  };

  // Indoor: the Nest's reading when there is one (with its target), else the rooms' average.
  const nestTemp = thermostat?.metrics.temperature;
  const indoor = nestTemp?.value ?? avg(temps);
  const target = thermostat?.metrics.target_temperature?.value;
  const heating = valueOf(nest, 'hvac_heating', 'boiler');
  const avgTemp = avg(temps);
  const avgHumidity = avg(humidities);
  const coldest = temps.length ? Math.min(...temps.map((t) => t.value)) : null;
  const mould =
    avgTemp !== null && avgHumidity !== null && coldest !== null
      ? mouldRisk({
          minTemperatureC: coldest,
          avgTemperatureC: avgTemp,
          avgHumidityPercent: avgHumidity,
        }).risk
      : null;
  const highestCo2 = co2s.length ? co2s.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const outdoor = pick(weather, 'temperature', 'outdoor');
  const code = valueOf(weather, 'weather_code', 'outdoor');

  if (loading) {
    return (
      <section aria-label="Current readings" className="row">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="tile">
            <Skeleton height={86} />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section aria-label="Current readings" className="row">
      <StatTile
        label="Indoor temperature"
        badge={
          nestTemp ? (
            <FreshnessBadge freshness={at(nestTemp.freshness, 'nest')} compact />
          ) : (
            badgeFor('temperature')
          )
        }
        value={indoor === null ? '—' : formatNumber(indoor, 1)}
        unit={indoor === null ? undefined : '°C'}
        context={
          target != null
            ? `Target ${formatNumber(target, 1)} °C${heating === null ? '' : ` · heating ${heating === 1 ? 'on' : 'idle'}`}`
            : temps.length
              ? `Average of ${temps.length} rooms`
              : 'No room sensors yet'
        }
      />
      <StatTile
        label="Outdoor"
        badge={
          outdoor ? (
            <FreshnessBadge freshness={at(outdoor.freshness, 'open_meteo')} compact />
          ) : (
            <SourceBadge source={source('open_meteo')} compact />
          )
        }
        value={outdoor?.value == null ? '—' : formatNumber(outdoor.value, 1)}
        unit={outdoor?.value == null ? undefined : '°C'}
        context={code !== null ? `${describeWeather(code)} · Open-Meteo` : 'Open-Meteo'}
      />
      <StatTile
        label="Humidity (avg)"
        badge={badgeFor('humidity')}
        value={avgHumidity === null ? '—' : formatNumber(avgHumidity)}
        unit={avgHumidity === null ? undefined : '%'}
        context={
          avgTemp !== null && avgHumidity !== null && mould ? (
            <Status tone={MOULD_TONE[mould]}>
              Dew point {formatNumber(dewPoint(avgTemp, avgHumidity), 1)} °C · mould risk{' '}
              {MOULD_LABELS[mould].toLowerCase()}
            </Status>
          ) : (
            'No humidity readings yet'
          )
        }
      />
      <StatTile
        label={highestCo2 ? `CO₂ (${highestCo2.room.name.toLowerCase()})` : 'CO₂'}
        badge={badgeFor('co2')}
        value={highestCo2 ? formatNumber(highestCo2.value) : '—'}
        unit={highestCo2 ? ' ppm' : undefined}
        context={
          highestCo2 ? (
            <Status tone={CO2_TONE[co2Level(highestCo2.value)]}>
              {CO2_LABELS[co2Level(highestCo2.value)]}
              {pressures.length ? ` · pressure ${formatNumber(avg(pressures)!)} hPa` : ''}
            </Status>
          ) : (
            'No CO₂ readings yet'
          )
        }
      />
      <EnergyTile source={source('smart_meters')} />
      <WaterTile source={source('thames_water')} />
    </section>
  );
}

// --- Temperature chart -------------------------------------------------------------------

function TemperaturePanel({
  rooms,
  weather,
  nest,
  range,
}: {
  rooms: Room[];
  weather: LatestResponse | undefined;
  nest: LatestResponse | undefined;
  range: Range;
}) {
  const combine = useCombinedFreshness();
  const indoorIds = rooms
    .filter((r) => r.kind === 'sensor')
    .flatMap((r) => (r.metrics.temperature ? [r.metrics.temperature.seriesId] : []));
  const outdoorId = pick(weather, 'temperature', 'outdoor')?.series.id;
  const targetId = rooms.find((r) => r.kind === 'thermostat')?.metrics.target_temperature?.seriesId;
  const ids = [...indoorIds, ...(outdoorId ? [outdoorId] : []), ...(targetId ? [targetId] : [])];
  const readings = useReadings(ids, range);
  const now = useNow();
  // Boiler-firing bands, from the Nest's heating state (bucket averages above 0.5 count as on).
  const hvacId = pick(nest, 'hvac_heating', 'boiler')?.series.id;
  const hvac = useReadings(hvacId ? [hvacId] : [], range);
  const hvacData = hvac.data;
  const bands = hvacData?.series[0]
    ? stateRuns(hvacData.series[0].points, BUCKET_HOLD_SECONDS[hvacData.bucket], now).map(
        (r) => [r.from, r.to] as const,
      )
    : [];

  const byId = new Map((readings.data?.series ?? []).map((s) => [s.meta.id, s]));
  const indoor = averageSeries(indoorIds.map((id) => byId.get(id)?.points ?? []));
  const outdoor = outdoorId ? (byId.get(outdoorId)?.points ?? []) : [];
  const target = targetId ? (byId.get(targetId)?.points ?? []) : [];
  const freshness = combine(
    (readings.data?.series ?? []).map((s) => ({
      freshness: s.freshness,
      sourceId: s.meta.sourceId,
    })),
  );
  const indoorStats = stats(indoor);
  const outdoorStats = stats(outdoor);

  const series = [
    ...(indoor.length ? [{ name: 'Indoor', points: indoor, color: token('--heat') }] : []),
    ...(outdoor.length ? [{ name: 'Outdoor', points: outdoor, color: token('--cool') }] : []),
    ...(target.length
      ? [
          {
            name: 'Nest target',
            points: target,
            color: token('--text-secondary'),
            dashed: true,
            step: true,
          },
        ]
      : []),
  ];
  const describe = (name: string, s: ReturnType<typeof stats>) =>
    s ? `${name} between ${formatNumber(s.min, 1)} and ${formatNumber(s.max, 1)} °C` : null;

  return (
    <Panel
      id="temp-h"
      title={`Temperature, ${RANGE_LABEL[range]}`}
      flex="999 1 620px"
      badge={freshness && <FreshnessBadge freshness={freshness} compact />}
      meta={
        <span className="legend">
          {indoor.length > 0 && (
            <span>
              <span className="swatch" style={{ background: 'var(--heat)' }} />
              Indoor
            </span>
          )}
          {outdoor.length > 0 && (
            <span>
              <span className="swatch" style={{ background: 'var(--cool)' }} />
              Outdoor
            </span>
          )}
          {target.length > 0 && (
            <span style={{ color: 'var(--text-secondary)' }}>
              <span className="swatch swatch--dashed" />
              Nest target
            </span>
          )}
          {bands.length > 0 && (
            <span>
              <span className="swatch swatch--band" style={{ background: 'var(--heat-band)' }} />
              Boiler firing
            </span>
          )}
        </span>
      }
    >
      {readings.isPending && ids.length > 0 ? (
        <Skeleton height={232} />
      ) : series.length === 0 ? (
        <NotConnected source={undefined}>No temperature readings yet</NotConnected>
      ) : (
        <TimeChart
          series={series}
          unit="°C"
          bands={bands}
          spanSeconds={RANGE_SECONDS[range]}
          ariaLabel={`Line chart: ${[describe('indoor', indoorStats), describe('outdoor', outdoorStats)].filter(Boolean).join(', ')}.`}
        />
      )}
    </Panel>
  );
}

function HeatingPanel({ source }: { source: SourceInfo | undefined }) {
  if (source && !source.enabled) {
    return (
      <Panel id="heat-h" title="Heating" flex="1 1 300px" badge={<SourceBadge source={source} />}>
        <NotConnected source={source}>
          Nest thermostat and boiler probes aren&apos;t connected yet
        </NotConnected>
      </Panel>
    );
  }
  return <HeatingCard source={source} />;
}

function HeatingCard({ source }: { source: SourceInfo | undefined }) {
  const summary = useHeatingSummary();
  const nest = useLatest({ source: 'nest' });
  const probes = useLatest({ source: 'boiler_probes' });
  const flow = valueOf(probes.data, 'temperature', 'boiler_flow');
  const ret = valueOf(probes.data, 'temperature', 'boiler_return');
  const humidity = valueOf(nest.data, 'humidity');
  const mode = valueOf(nest.data, 'thermostat_mode');
  const s = summary.data;
  return (
    <Panel
      id="heat-h"
      title="Heating"
      flex="1 1 300px"
      badge={
        s?.freshness ? (
          <FreshnessBadge freshness={s.freshness} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={
        mode !== null && (
          <Chip>Nest · {['Off', 'Heat', 'Cool', 'Heat-cool'][mode] ?? 'Unknown'} mode</Chip>
        )
      }
    >
      {flow !== null || ret !== null ? (
        <>
          <div className="boxes">
            <div className="box">
              <span>Flow</span>
              <span>{flow === null ? '—' : `${formatNumber(flow)} °C`}</span>
            </div>
            <div className="box">
              <span>Return</span>
              <span>{ret === null ? '—' : `${formatNumber(ret)} °C`}</span>
            </div>
          </div>
          {ret !== null && (
            <p className="line">
              <span
                className={`dot dot--${ret < CONDENSING_LIMIT_C ? 'good' : 'warn'}`}
                aria-hidden="true"
              />
              {ret < CONDENSING_LIMIT_C
                ? `Condensing: return below ${CONDENSING_LIMIT_C} °C`
                : `Not condensing: return above ${CONDENSING_LIMIT_C} °C`}
            </p>
          )}
        </>
      ) : (
        <p className="meta">
          No boiler pipe probes yet: flow and return temperatures appear when they&apos;re fitted.
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>Boiler on today</dt>
          <dd>{s ? formatMinutes(s.boiler.minutesOn * 60) : '—'}</dd>
        </div>
        <div>
          <dt>Firing cycles</dt>
          <dd>{s ? s.boiler.cycles : '—'}</dd>
        </div>
        <div>
          <dt>Warm-up rate</dt>
          <dd>{s?.warmUp ? `${formatNumber(s.warmUp.ratePerHour, 1)} °C / h` : '—'}</dd>
        </div>
        <div>
          <dt>Nest humidity</dt>
          <dd>{humidity === null ? '—' : `${formatNumber(humidity)} %`}</dd>
        </div>
      </dl>
    </Panel>
  );
}

// --- Rooms -------------------------------------------------------------------------------

function RoomsSection({ rooms, loading }: { rooms: Room[]; loading: boolean }) {
  const now = useNow();
  const combine = useCombinedFreshness();
  const all = rooms.flatMap((r) =>
    Object.values(r.metrics).map((m) => ({ freshness: m.freshness, sourceId: m.sourceId })),
  );
  const freshness = combine(all);
  return (
    <section aria-labelledby="rooms-h" className="stack">
      <div className="section-title">
        <h2 id="rooms-h">Rooms</h2>
        {freshness && <FreshnessBadge freshness={freshness} compact />}
      </div>
      <div className="row">
        {loading && (
          <div className="tile" style={{ flex: '1 1 240px' }}>
            <Skeleton height={90} />
          </div>
        )}
        {!loading && rooms.length === 0 && (
          <div className="tile" style={{ flex: '1 1 100%' }}>
            <NotConnected source={undefined}>No room sensors have reported yet</NotConnected>
          </div>
        )}
        {rooms.map((room) => {
          const t = room.metrics.temperature?.value;
          const co2 = room.metrics.co2?.value;
          const high = co2 != null && co2 >= CO2_THRESHOLD_PPM;
          return (
            <article
              key={`${room.kind}-${room.entity}`}
              className={`card${high ? ' card--warn' : ''}`}
              style={{ flex: '1 1 240px', padding: '16px 18px', gap: 10 }}
            >
              <div className="card-head">
                <h3 style={{ fontSize: 15, fontWeight: 600 }}>
                  {room.kind === 'thermostat' ? `${room.name} (Nest)` : room.name}
                </h3>
                <span className="small muted">
                  {room.lastTs ? formatAgo(room.lastTs, now) : 'No data yet'}
                </span>
              </div>
              <span className="big" style={{ fontSize: 28 }}>
                {t == null ? '—' : `${formatNumber(t, 1)} °C`}
              </span>
              <div className="room-compact">
                {room.metrics.humidity?.value != null && (
                  <span>{formatNumber(room.metrics.humidity.value)} % RH</span>
                )}
                {co2 != null && (
                  <span
                    className={high ? 'warn-text' : undefined}
                    style={high ? { fontWeight: 600 } : undefined}
                  >
                    {formatNumber(co2)} ppm{high ? ' · high' : ''}
                  </span>
                )}
                {room.metrics.pressure?.value != null && (
                  <span>{formatNumber(room.metrics.pressure.value)} hPa</span>
                )}
                {room.metrics.target_temperature?.value != null && (
                  <span>Target {formatNumber(room.metrics.target_temperature.value, 1)} °C</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// --- Energy ------------------------------------------------------------------------------

function EnergyTile({ source }: { source: SourceInfo | undefined }) {
  const at = useFreshnessNow();
  const summary = useEnergySummary(undefined, !!source?.enabled);
  const s = summary.data;
  const day = s?.days.find((d) => d.date === s.latestDay);
  if (!source?.enabled || !s || !day) {
    return (
      <StatTile
        label="Energy"
        badge={<SourceBadge source={source} compact />}
        value="—"
        context={
          source && !source.enabled ? `${source.name}: not connected yet` : 'No complete day yet'
        }
      />
    );
  }
  const pence = dayPence(day, true);
  return (
    <StatTile
      label={`Energy · ${weekdayLabel(day.date)}`}
      badge={s.freshness && <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} compact />}
      value={
        pence === null
          ? `${formatNumber((day.electricity?.kwh ?? 0) + (day.gas?.kwh ?? 0))} kWh`
          : formatPounds(pence)
      }
      context={`${formatNumber(day.electricity?.kwh ?? 0, 1)} kWh elec · ${formatNumber(day.gas?.kwh ?? 0)} kWh gas`}
    />
  );
}

/** The latest complete day's electricity by hour, with the overnight baseload as a dashed line. */
function ElectricityPanel({ source }: { source: SourceInfo | undefined }) {
  const at = useFreshnessNow();
  const summary = useEnergySummary(undefined, !!source?.enabled);
  const meters = useLatest({ source: 'smart_meters' });
  const s = summary.data;
  const elecId = pick(meters.data, 'energy_import', 'electricity')?.series.id;
  const bounds = s?.latestDay ? londonDayBounds(s.latestDay) : null;
  const hourly = useReadings(elecId && bounds ? [elecId] : [], '24h', {
    bucket: '1h',
    agg: 'sum',
    between: bounds ? { from: bounds.from.toISOString(), to: bounds.to.toISOString() } : undefined,
  });
  const points = hourly.data?.series[0]?.points ?? [];
  const day = s?.days.find((d) => d.date === s.latestDay);
  const baseloadKwh = s?.baseload ? s.baseload.watts / 1000 : undefined;
  const peak = points.reduce<(typeof points)[number] | null>(
    (a, p) => (!a || p[1] > a[1] ? p : a),
    null,
  );

  return (
    <Panel
      id="elec-h"
      title={day ? `Electricity, ${weekdayLabel(day.date)}` : 'Electricity'}
      flex="1 1 420px"
      badge={
        s?.freshness && source?.enabled ? (
          <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={
        day?.electricity && (
          <>
            {formatNumber(day.electricity.kwh, 1)} kWh
            {day.electricity.energyPence !== null &&
              ` · ${formatPounds(day.electricity.energyPence)}`}
            {s?.baseload && ` · dashed line = baseload ${s.baseload.watts} W`}
          </>
        )
      }
    >
      {!source?.enabled ? (
        <NotConnected source={source} />
      ) : points.length === 0 ? (
        hourly.isPending && elecId ? (
          <Skeleton height={180} />
        ) : (
          <Empty>No complete day of meter data yet</Empty>
        )
      ) : (
        <BarChart
          labels={points.map(([t]) => formatLondonTime(new Date(t)).slice(0, 2))}
          series={[
            { name: 'Electricity', color: token('--cool'), values: points.map(([, v]) => v) },
          ]}
          reference={baseloadKwh}
          ariaLabel={`Bar chart of hourly electricity use${day ? ` on ${weekdayLabel(day.date)}` : ''}${peak ? `, highest at ${formatLondonTime(new Date(peak[0]))}` : ''}.`}
        />
      )}
    </Panel>
  );
}

/** Daily gas for the last 7 days, and kWh per heating degree-day. */
function GasPanel({ source }: { source: SourceInfo | undefined }) {
  const at = useFreshnessNow();
  const summary = useEnergySummary(undefined, !!source?.enabled);
  const days = (summary.data?.days ?? []).slice(-7).filter((d) => d.gas);
  const total = days.reduce((t, d) => t + (d.gas?.kwh ?? 0), 0);
  const degreeDays = days.reduce((t, d) => t + (d.degreeDays ?? 0), 0);
  const s = summary.data;
  return (
    <Panel
      id="gas-h"
      title={
        days.length ? `Gas, ${dayLabel(days[0]!.date)} – ${dayLabel(days.at(-1)!.date)}` : 'Gas'
      }
      flex="1 1 420px"
      badge={
        s?.freshness && source?.enabled ? (
          <FreshnessBadge freshness={at(s.freshness, 'smart_meters')} />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={
        days.length > 0 &&
        `${formatNumber(total)} kWh${degreeDays > 0 ? ` · ${formatNumber(total / degreeDays, 1)} kWh per degree-day` : ''}`
      }
    >
      {!source?.enabled ? (
        <NotConnected source={source} />
      ) : days.length === 0 ? (
        summary.isPending ? (
          <Skeleton height={180} />
        ) : (
          <Empty>No gas data yet</Empty>
        )
      ) : (
        <BarChart
          labels={days.map((d) => weekdayLabel(d.date).slice(0, 3))}
          series={[{ name: 'Gas', color: token('--heat'), values: days.map((d) => d.gas!.kwh) }]}
          valueLabels={days.map((d) => formatNumber(d.gas!.kwh))}
          ariaLabel={`Bar chart of daily gas use for the last ${days.length} days, ${formatNumber(total)} kWh in total.`}
        />
      )}
    </Panel>
  );
}

// --- Water -------------------------------------------------------------------------------

const LEAK_TONE = { ok: 'good', watch: 'warn', leak: 'bad', unknown: 'muted' } as const;

function leakLine(leak: WaterSummary['leak'], nights: WaterSummary['nights']): string {
  const lowest = nights.filter((n) => n.complete).at(-1)?.minLitres ?? 0;
  if (leak.state === 'ok') return `No leak · night minimum ${formatNumber(lowest)} L/h`;
  if (leak.state === 'leak')
    return `Possible leak · water flowing at night for ${leak.consecutive} nights`;
  if (leak.state === 'watch')
    return `Watch · water flowing last night (${formatNumber(lowest)} L/h)`;
  return 'Leak check needs a complete night';
}

function WaterTile({ source }: { source: SourceInfo | undefined }) {
  const at = useFreshnessNow();
  const summary = useWaterSummary(undefined, !!source?.enabled);
  const s = summary.data;
  const day = s?.days.find((d) => d.date === s.latestDay);
  if (!source?.enabled || !s || !day) {
    return (
      <StatTile
        label="Water"
        badge={<SourceBadge source={source} compact />}
        value="—"
        context={
          source && !source.enabled ? `${source.name}: not connected yet` : 'No complete day yet'
        }
      />
    );
  }
  return (
    <StatTile
      label={`Water · ${weekdayLabel(day.date)}`}
      badge={s.freshness && <FreshnessBadge freshness={at(s.freshness, 'thames_water')} compact />}
      value={day.litres === null ? '—' : formatNumber(day.litres)}
      unit=" L"
      context={<Status tone={LEAK_TONE[s.leak.state]}>{leakLine(s.leak, s.nights)}</Status>}
    />
  );
}

/** The last 7 days of water and the night-time leak check. */
function WaterPanel({ source }: { source: SourceInfo | undefined }) {
  const at = useFreshnessNow();
  const summary = useWaterSummary(undefined, !!source?.enabled);
  const s = summary.data;
  const days = (s?.days ?? []).slice(-7).filter((d) => d.litres !== null);
  const complete = days.filter((d) => d.complete);
  const avg = complete.length
    ? complete.reduce((t, d) => t + d.litres!, 0) / complete.length
    : null;
  return (
    <Panel
      id="water-h"
      title={
        days.length ? `Water, ${dayLabel(days[0]!.date)} – ${dayLabel(days.at(-1)!.date)}` : 'Water'
      }
      flex="1 1 440px"
      badge={
        s?.freshness && source?.enabled ? (
          <FreshnessBadge freshness={at(s.freshness, 'thames_water')} />
        ) : (
          <SourceBadge source={source} />
        )
      }
      meta={avg !== null && `avg ${formatNumber(avg)} L/day`}
    >
      {!source?.enabled ? (
        <NotConnected source={source} />
      ) : days.length === 0 ? (
        summary.isPending ? (
          <Skeleton height={180} />
        ) : (
          <Empty>No water data yet</Empty>
        )
      ) : (
        <>
          <BarChart
            labels={days.map((d) => weekdayLabel(d.date).slice(0, 3))}
            series={[
              { name: 'Water', color: token('--accent'), values: days.map((d) => d.litres) },
            ]}
            valueLabels={days.map((d) => formatNumber(d.litres!))}
            ariaLabel={`Bar chart of daily water use for the last ${days.length} days${avg !== null ? `, averaging ${formatNumber(avg)} litres` : ''}.`}
          />
          {s && (
            <p className="line">
              <span className={`dot dot--${LEAK_TONE[s.leak.state]}`} aria-hidden="true" />
              {s.leak.state === 'ok'
                ? `Leak check passed: usage reached 0 L/h between 00:00 and 05:00 every night for ${s.leak.nightsChecked} nights`
                : leakLine(s.leak, s.nights)}
            </p>
          )}
          <p className="note">
            {source.name} hourly data arrives about{' '}
            {Math.round(source.policy.expectedDelaySeconds / 86400)} days late
          </p>
        </>
      )}
    </Panel>
  );
}

// --- Grid carbon -------------------------------------------------------------------------

function GridPanel({
  latest,
  source,
}: {
  latest: LatestResponse | undefined;
  source: SourceInfo | undefined;
}) {
  const at = useFreshnessNow();
  const intensity = pick(latest, 'intensity', 'grid');
  const index = valueOf(latest, 'intensity_index', 'grid');
  const forecastId = pick(latest, 'forecast_intensity', 'grid')?.series.id;
  const forecast = useReadings(forecastId ? [forecastId] : [], '24h', {
    bucket: 'raw',
    window: { fromOffsetSeconds: 0, toOffsetSeconds: 86400, key: 'next24h' },
  });
  const points = forecast.data?.series[0]?.points ?? [];
  const bars = averageByWindow(points, 7200);
  const greenest = lowestWindow(points, 8, 1800);
  const max = Math.max(...bars.map(([, v]) => v), 1);
  const inWindow = (t: string) => !!greenest && t >= greenest.from && t < greenest.to;

  return (
    <Panel
      id="grid-h"
      title="Grid right now"
      flex="1 1 280px"
      badge={
        intensity ? (
          <FreshnessBadge freshness={at(intensity.freshness, 'carbon_intensity')} compact />
        ) : (
          <SourceBadge source={source} />
        )
      }
    >
      {intensity?.value == null ? (
        <NotConnected source={source}>
          {source?.enabled ? 'No grid readings yet' : undefined}
        </NotConnected>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="big">{formatNumber(intensity.value)}</span>
            <span className="muted" style={{ fontSize: 14 }}>
              gCO₂/kWh
              {index !== null && INTENSITY_INDEX[index] ? ` · ${INTENSITY_INDEX[index]}` : ''}
            </span>
          </div>
          {bars.length > 0 && (
            <div className="mini-bars" aria-hidden="true">
              {bars.map(([t, v]) => (
                <span
                  key={t}
                  className={inWindow(t) ? 'on' : undefined}
                  style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
                />
              ))}
            </div>
          )}
          {greenest && (
            <p style={{ fontSize: 14 }}>
              Greenest window:{' '}
              <strong>
                {formatLondonTime(new Date(greenest.from))}–
                {formatLondonTime(new Date(greenest.to))}
              </strong>
              , good for the washing machine or dishwasher
            </p>
          )}
          <p className="note">Regional forecast, next 24 h · NESO Carbon Intensity API</p>
        </>
      )}
    </Panel>
  );
}

// --- Raspberry Pi ------------------------------------------------------------------------

const PI_CHIP = {
  healthy: ['good', 'Healthy'],
  warning: ['warn', 'Check'],
  problem: ['bad', 'Problem'],
} as const;

function PiPanel({ latest }: { latest: LatestResponse | undefined }) {
  const combine = useCombinedFreshness();
  const wifi = useLatest({ source: 'wifi' });
  const piSignal = valueOf(wifi.data, 'wifi_rssi', 'pi');
  const cpu = pick(latest, 'cpu_temperature');
  const power = powerState(valueOf(latest, 'throttle_flags'), valueOf(latest, 'under_voltage'));
  const memTotal = valueOf(latest, 'memory_total');
  const memUsed = valueOf(latest, 'memory_used');
  const sdUsed = valueOf(latest, 'disk_used', 'sd_card');
  const sdFree = valueOf(latest, 'disk_free', 'sd_card');
  const dbSize = valueOf(latest, 'database_size');
  const uptime = valueOf(latest, 'uptime');
  const sdPercent = sdUsed !== null && sdFree !== null ? (sdUsed / (sdUsed + sdFree)) * 100 : null;
  const status = piStatus({
    cpuC: cpu?.value ?? null,
    power,
    diskUsedPercents: sdPercent === null ? [] : [sdPercent],
  });
  const reported = (latest?.items ?? []).filter((i) => i.ts !== null);
  const freshness = combine(
    reported.map((i) => ({ freshness: i.freshness, sourceId: 'pi_stats' })),
  );
  const [tone, text] = PI_CHIP[status];

  return (
    <Panel
      id="sys-h"
      title="Raspberry Pi"
      flex="1 1 440px"
      badge={freshness && <FreshnessBadge freshness={freshness} compact />}
      meta={reported.length > 0 && <Chip tone={tone}>{text}</Chip>}
    >
      {reported.length === 0 ? (
        <NotConnected source={undefined}>No Pi readings yet</NotConnected>
      ) : (
        <>
          <dl className="facts facts--3">
            <div>
              <dt>CPU temp</dt>
              <dd>{cpu?.value == null ? '—' : `${formatNumber(cpu.value)} °C`}</dd>
            </div>
            <div>
              <dt>Throttling</dt>
              <dd>{power?.word ?? '—'}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{uptime === null ? '—' : formatUptime(uptime)}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>
                {memTotal && memUsed !== null
                  ? `${formatNumber((memUsed / memTotal) * 100)} %`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Load (5 min)</dt>
              <dd>{valueOf(latest, 'load_5m')?.toFixed(2) ?? '—'}</dd>
            </div>
            {piSignal !== null ? (
              <div>
                <dt>Wi-Fi</dt>
                <dd>{formatNumber(piSignal)} dBm</dd>
              </div>
            ) : (
              <div>
                <dt>Database</dt>
                <dd>
                  {dbSize === null
                    ? '—'
                    : dbSize >= 1000
                      ? `${formatNumber(dbSize / 1000, 1)} GB`
                      : `${formatNumber(dbSize)} MB`}
                </dd>
              </div>
            )}
          </dl>
          {sdPercent !== null && (
            <ProgressBar
              label={`SD card · ${formatNumber(sdUsed!, 1)} of ${formatNumber(sdUsed! + sdFree!, 1)} GB`}
              right={`${formatNumber(sdFree!, 1)} GB free`}
              percent={sdPercent}
              ariaLabel={`SD card ${formatNumber(sdPercent)} percent used`}
            />
          )}
        </>
      )}
    </Panel>
  );
}

// --- Data sources ------------------------------------------------------------------------

function SourcesTable({ sources }: { sources: SourceInfo[] | undefined }) {
  const at = useFreshnessNow();
  const now = useNow();
  return (
    <section aria-labelledby="src-h" className="card">
      <div className="section-title">
        <h2 id="src-h">Data sources</h2>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Provides</th>
              <th scope="col">Polled</th>
              <th scope="col">Last reading</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {(sources ?? []).map((s) => {
              const f = at(s.freshness, s.id);
              const status = collectorStatus({ ...s, freshness: f });
              return (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.description ?? '—'}</td>
                  <td>{describePoll(s)}</td>
                  <td>
                    {f.dataTo
                      ? formatWhen(
                          new Date(Date.parse(f.dataTo) - (f.intervalSeconds ?? 0) * 1000),
                          now,
                        )
                      : '—'}
                  </td>
                  <td>
                    {status === 'not_connected' ? (
                      <SourceBadge source={s} />
                    ) : f.state === 'live' && status !== 'failing' ? (
                      <Status tone="good">OK</Status>
                    ) : f.state === 'delayed' ? (
                      <FreshnessBadge freshness={f} compact suffix="expected" />
                    ) : status === 'failing' ? (
                      <Status tone="bad">{COLLECTOR_STATUS_TEXT.failing}</Status>
                    ) : (
                      <FreshnessBadge freshness={f} />
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
