import {
  addLondonDays,
  compassPoint,
  DAQI_LABELS,
  DAQI_POLLUTANT_NAMES,
  daqiLevel,
  daqiPollutantFromCode,
  describeWeather,
  formatLondonTime,
  formatLongDate,
  formatNumber,
  londonDateString,
  type DaqiPollutant,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { useLatest, useReadings, useSources } from '../api/hooks.js';
import { useForecast } from '../api/weather.js';
import { Empty, Panel, Skeleton, Value } from '../components/Cards.js';
import { TimeChart } from '../components/charts/TimeChart.js';
import { token } from '../components/charts/theme.js';
import { FreshnessBadge } from '../components/FreshnessBadge.js';
import { PageHeader } from '../components/PageHeader.js';
import { NotConnected, SourceBadge } from '../components/PageBits.js';
import { Status } from '../components/Status.js';
import { TemperaturePanel } from '../components/TemperaturePanel.js';
import { WindArrow } from '../components/WeatherBits.js';
import { WeatherIcon } from '../components/WeatherIcon.js';
import { useFreshnessNow } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, RANGE_SECONDS, useRange, type Range } from '../lib/range.js';
import { weekdayLabel } from '../model/energy.js';
import { pick, valueOf } from '../model/latest.js';
import { buildRooms } from '../model/rooms.js';
import {
  DAQI_TONE,
  daqiText,
  pressureTrend,
  PRESSURE_TREND_LABELS,
  type DayRow,
  type HourRow,
} from '../model/weather.js';

export function WeatherPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const sources = useSources();
  const weather = useLatest({ source: 'open_meteo' });
  const air = useLatest({ source: 'air_quality' });
  const sensors = useLatest({ source: 'room_sensors' });
  const nest = useLatest({ source: 'nest' });
  const forecast = useForecast();
  const source = (id: string) => sources.data?.find((s) => s.id === id);
  const rooms = buildRooms([...(sensors.data?.items ?? []), ...(nest.data?.items ?? [])]);

  return (
    <div className="page">
      <PageHeader title="Weather" subtitle={formatLongDate(now)} range={range} onRange={setRange} />
      <div className="row">
        <NowPanel
          weather={weather.data}
          today={forecast.days[0]}
          source={source('open_meteo')}
          loading={weather.isPending}
          range={range}
        />
        <AirQualityPanel
          air={air.data}
          outlook={forecast.daqiDays}
          source={source('air_quality')}
          loading={air.isPending}
        />
      </div>
      <HoursPanel hours={forecast.hours} loading={forecast.loading} source={source('open_meteo')} />
      <DaysPanel days={forecast.days} loading={forecast.loading} source={source('open_meteo')} />
      <div className="row">
        <TemperaturePanel rooms={rooms} weather={weather.data} nest={nest.data} range={range} />
      </div>
      <div className="row">
        <PressurePanel weather={weather.data} range={range} />
        <WindPanel weather={weather.data} range={range} />
      </div>
    </div>
  );
}

// --- Now ---------------------------------------------------------------------------------

function NowPanel({
  weather,
  today,
  source,
  loading,
  range,
}: {
  weather: LatestResponse | undefined;
  today: DayRow | undefined;
  source: SourceInfo | undefined;
  loading: boolean;
  range: Range;
}) {
  const at = useFreshnessNow();
  const temp = pick(weather, 'temperature', 'outdoor');
  const v = (metric: string) => valueOf(weather, metric, 'outdoor');
  const code = v('weather_code');
  const direction = v('wind_direction');
  const pressureId = pick(weather, 'pressure', 'outdoor')?.series.id;
  // The trend needs the last few hours whatever the page range.
  const pressure = useReadings(pressureId ? [pressureId] : [], range, {
    window: { fromOffsetSeconds: -4 * 3600, toOffsetSeconds: 0, key: 'pressure-4h' },
  });
  const trend = pressureTrend(pressure.data?.series[0]?.points ?? []);

  return (
    <Panel
      id="now-h"
      title="Now"
      flex="2 1 440px"
      badge={
        temp ? (
          <FreshnessBadge freshness={at(temp.freshness, 'open_meteo')} compact />
        ) : (
          <SourceBadge source={source} compact />
        )
      }
      meta="Open-Meteo"
    >
      {loading ? (
        <Skeleton height={180} />
      ) : !temp || temp.value === null ? (
        <NotConnected source={source}>
          No weather readings yet (set HOME_LAT and HOME_LON)
        </NotConnected>
      ) : (
        <div className="stack">
          <div className="now">
            {code !== null && <WeatherIcon code={code} isDay={v('is_day') !== 0} size={64} />}
            <div className="stack" style={{ gap: 2 }}>
              <Value value={formatNumber(temp.value, 1)} unit="°C" />
              <span>
                <strong>{code === null ? '' : describeWeather(code)}</strong>
                {v('apparent_temperature') !== null &&
                  ` · feels like ${formatNumber(v('apparent_temperature')!)} °C`}
              </span>
              {today && today.max !== null && today.min !== null && (
                <span className="muted">
                  Today: high {formatNumber(today.max)}° · low {formatNumber(today.min)}°
                  {today.rainChance !== null &&
                    ` · ${formatNumber(today.rainChance)} % chance of rain`}
                </span>
              )}
            </div>
          </div>
          <dl className="facts facts--4">
            <div>
              <dt>Wind</dt>
              <dd>
                {v('wind_speed') === null ? '—' : `${formatNumber(v('wind_speed')!)} km/h`}
                {direction !== null && (
                  <>
                    {' '}
                    <WindArrow degrees={direction} /> {compassPoint(direction)}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>Gusts</dt>
              <dd>{v('wind_gust') === null ? '—' : `${formatNumber(v('wind_gust')!)} km/h`}</dd>
            </div>
            <div>
              <dt>Pressure</dt>
              <dd>
                {v('pressure') === null ? '—' : `${formatNumber(v('pressure')!)} hPa`}
                {trend && (
                  <span className="small muted">
                    {' '}
                    · {PRESSURE_TREND_LABELS[trend.trend].toLowerCase()}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Humidity</dt>
              <dd>{v('humidity') === null ? '—' : `${formatNumber(v('humidity')!)} %`}</dd>
            </div>
            <div>
              <dt>Rain now</dt>
              <dd>
                {v('precipitation') === null ? '—' : `${formatNumber(v('precipitation')!, 1)} mm`}
              </dd>
            </div>
            <div>
              <dt>Cloud</dt>
              <dd>{v('cloud_cover') === null ? '—' : `${formatNumber(v('cloud_cover')!)} %`}</dd>
            </div>
            <div>
              <dt>Sunrise</dt>
              <dd>{today?.sunrise ? formatLondonTime(new Date(today.sunrise)) : '—'}</dd>
            </div>
            <div>
              <dt>Sunset</dt>
              <dd>{today?.sunset ? formatLondonTime(new Date(today.sunset)) : '—'}</dd>
            </div>
          </dl>
        </div>
      )}
    </Panel>
  );
}

// --- Air quality ---------------------------------------------------------------------------

const POLLUTANT_ORDER: DaqiPollutant[] = ['pm2_5', 'pm10', 'no2', 'o3', 'so2'];
const POLLUTANT_SHORT: Record<DaqiPollutant, string> = {
  pm2_5: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO₂',
  o3: 'O₃',
  so2: 'SO₂',
};

function AirQualityPanel({
  air,
  outlook,
  source,
  loading,
}: {
  air: LatestResponse | undefined;
  outlook: Map<string, number>;
  source: SourceInfo | undefined;
  loading: boolean;
}) {
  const at = useFreshnessNow();
  const now = useNow();
  const daqi = pick(air, 'daqi', 'outdoor');
  const main = valueOf(air, 'daqi_pollutant', 'outdoor');
  const mainPollutant = main === null ? null : daqiPollutantFromCode(main);
  const today = londonDateString(now);
  const later = [...outlook].filter(([day]) => day >= today).slice(0, 2);

  return (
    <Panel
      id="air-h"
      title="Air quality"
      flex="1 1 300px"
      badge={
        daqi ? (
          <FreshnessBadge freshness={at(daqi.freshness, 'air_quality')} compact />
        ) : (
          <SourceBadge source={source} compact />
        )
      }
      meta="UK DAQI"
    >
      {loading ? (
        <Skeleton height={180} />
      ) : !daqi || daqi.value === null ? (
        <NotConnected source={source}>No air quality readings yet</NotConnected>
      ) : (
        <div className="stack">
          <div>
            <Value value={daqi.value} unit=" of 10" />
            <div>
              <Status tone={DAQI_TONE[daqiLevel(daqi.value)]}>
                {DAQI_LABELS[daqiLevel(daqi.value)]}
                {mainPollutant && ` · set by ${DAQI_POLLUTANT_NAMES[mainPollutant]}`}
              </Status>
            </div>
          </div>
          {later.length > 0 && (
            <p className="small" style={{ margin: 0 }}>
              {later
                .map(
                  ([day, index]) =>
                    `${day === today ? 'Rest of today' : day === addLondonDays(today, 1) ? 'Tomorrow' : weekdayLabel(day)}: up to ${daqiText(index)}`,
                )
                .join(' · ')}
            </p>
          )}
          <ul className="list">
            {POLLUTANT_ORDER.map((p) => {
              const value = valueOf(air, p, 'outdoor');
              return (
                <li key={p}>
                  <span>{POLLUTANT_SHORT[p]}</span>
                  <span className="muted">
                    {value === null ? '—' : `${formatNumber(value, 1)} µg/m³`}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="note">
            DEFRA&apos;s Daily Air Quality Index (1–10) worked out from Open-Meteo&apos;s CAMS model
            for your area (about 10 km across), not a monitor in your street. Hourly figures.
          </p>
        </div>
      )}
    </Panel>
  );
}

// --- Forecasts ---------------------------------------------------------------------------

function HoursPanel({
  hours,
  loading,
  source,
}: {
  hours: HourRow[];
  loading: boolean;
  source: SourceInfo | undefined;
}) {
  return (
    <Panel
      id="hours-h"
      title="Next 24 hours"
      badge={<SourceBadge source={source} compact />}
      meta="Rain chance · wind / gusts km/h"
    >
      {loading ? (
        <Skeleton height={130} />
      ) : hours.length === 0 ? (
        <Empty>No hourly forecast yet</Empty>
      ) : (
        <ol className="hours" aria-label="Hourly forecast">
          {hours.map((h, i) => (
            <li key={h.ts} className="hour">
              <time dateTime={h.ts} className="small muted">
                {i === 0 ? 'Now' : formatLondonTime(new Date(h.ts))}
              </time>
              {h.code !== null && <WeatherIcon code={h.code} isDay={h.isDay} size={28} labelled />}
              <strong>{formatNumber(h.temperature)}°</strong>
              <span className="small" style={{ color: 'var(--cool)' }}>
                {h.rainChance === null ? '' : `${formatNumber(h.rainChance)} %`}
              </span>
              <span className="small muted">
                {h.wind === null ? '' : formatNumber(h.wind)}
                {h.gust === null ? '' : `/${formatNumber(h.gust)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function DaysPanel({
  days,
  loading,
  source,
}: {
  days: DayRow[];
  loading: boolean;
  source: SourceInfo | undefined;
}) {
  const now = useNow();
  const today = londonDateString(now);
  const lows = days.flatMap((d) => (d.min === null ? [] : [d.min]));
  const highs = days.flatMap((d) => (d.max === null ? [] : [d.max]));
  const floor = Math.min(...lows);
  const ceiling = Math.max(...highs);
  const span = Math.max(1, ceiling - floor);
  const label = (date: string) =>
    date === today ? 'Today' : date === addLondonDays(today, 1) ? 'Tomorrow' : weekdayLabel(date);

  return (
    <Panel id="days-h" title="Next 7 days" badge={<SourceBadge source={source} compact />}>
      {loading ? (
        <Skeleton height={260} />
      ) : days.length === 0 ? (
        <Empty>No daily forecast yet</Empty>
      ) : (
        <ul className="days">
          {days.map((d) => (
            <li key={d.date}>
              <strong>{label(d.date)}</strong>
              <span className="days-sky">
                {d.code !== null && <WeatherIcon code={d.code} size={26} />}
                <span>{d.code === null ? '' : describeWeather(d.code)}</span>
              </span>
              <span className="small" style={{ color: 'var(--cool)' }}>
                {d.rainChance === null ? '' : `${formatNumber(d.rainChance)} %`}
                {d.rainMm !== null && d.rainMm >= 0.1 ? ` · ${formatNumber(d.rainMm, 1)} mm` : ''}
              </span>
              <span className="small muted days-wind">
                {d.gust === null ? '' : `Gusts ${formatNumber(d.gust)} km/h`}
              </span>
              <span className="days-temps">
                <span className="muted">{d.min === null ? '—' : `${formatNumber(d.min)}°`}</span>
                <span className="temp-range" aria-hidden="true">
                  {d.min !== null && d.max !== null && (
                    <span
                      style={{
                        left: `${((d.min - floor) / span) * 100}%`,
                        width: `${Math.max(4, ((d.max - d.min) / span) * 100)}%`,
                      }}
                    />
                  )}
                </span>
                <strong>{d.max === null ? '—' : `${formatNumber(d.max)}°`}</strong>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --- History -----------------------------------------------------------------------------

function HistoryPanel({
  id,
  title,
  weather,
  metrics,
  unit,
  digits,
  range,
}: {
  id: string;
  title: string;
  weather: LatestResponse | undefined;
  metrics: { metric: string; name: string; color: string; dashed?: boolean }[];
  unit: string;
  digits: number;
  range: Range;
}) {
  const at = useFreshnessNow();
  const items = metrics.flatMap((m) => {
    const item = pick(weather, m.metric, 'outdoor');
    return item ? [{ ...m, id: item.series.id, item }] : [];
  });
  const readings = useReadings(
    items.map((i) => i.id),
    range,
  );
  const byId = new Map((readings.data?.series ?? []).map((s) => [s.meta.id, s.points]));
  const series = items.map((i) => ({
    name: i.name,
    color: i.color,
    dashed: i.dashed,
    points: byId.get(i.id) ?? [],
  }));
  return (
    <Panel
      id={id}
      title={`${title}, ${RANGE_LABEL[range]}`}
      flex="1 1 420px"
      badge={
        items[0] && <FreshnessBadge freshness={at(items[0].item.freshness, 'open_meteo')} compact />
      }
      meta={
        items.length > 1 && (
          <span className="legend">
            {items.map((i) => (
              <span key={i.metric}>
                <span
                  className={`swatch${i.dashed ? ' swatch--dashed' : ''}`}
                  style={{ background: i.dashed ? undefined : i.color }}
                />
                {i.name}
              </span>
            ))}
          </span>
        )
      }
    >
      {items.length === 0 ? (
        <Empty>No readings yet</Empty>
      ) : readings.isPending ? (
        <Skeleton height={200} />
      ) : (
        <TimeChart
          series={series}
          unit={unit}
          digits={digits}
          height={200}
          spanSeconds={RANGE_SECONDS[range]}
          ariaLabel={`Line chart of ${title.toLowerCase()} over the ${RANGE_LABEL[range]}.`}
        />
      )}
    </Panel>
  );
}

function PressurePanel({ weather, range }: { weather: LatestResponse | undefined; range: Range }) {
  return (
    <HistoryPanel
      id="pressure-h"
      title="Pressure"
      weather={weather}
      metrics={[{ metric: 'pressure', name: 'Pressure', color: token('--accent') }]}
      unit="hPa"
      digits={0}
      range={range}
    />
  );
}

function WindPanel({ weather, range }: { weather: LatestResponse | undefined; range: Range }) {
  return (
    <HistoryPanel
      id="wind-h"
      title="Wind"
      weather={weather}
      metrics={[
        { metric: 'wind_speed', name: 'Wind', color: token('--cool') },
        { metric: 'wind_gust', name: 'Gusts', color: token('--text-secondary'), dashed: true },
      ]}
      unit="km/h"
      digits={0}
      range={range}
    />
  );
}
