import {
  averageSeries,
  CO2_THRESHOLD_PPM,
  dewPoint,
  formatAgo,
  formatLongDate,
  formatMinutes,
  formatNumber,
  mouldRisk,
  MOULD_LABELS,
  pressureTrend,
  roomAdvice,
  secondsAbove,
  stats,
  type ReadingsResponse,
} from '@home/shared';
import { useLatest, useReadings } from '../api/hooks.js';
import { Empty, Skeleton } from '../components/Cards.js';
import { Sparkline } from '../components/charts/Sparkline.js';
import { token } from '../components/charts/theme.js';
import { PageHeader } from '../components/PageHeader.js';
import { PageFreshness } from '../components/PageBits.js';
import { Status } from '../components/Status.js';
import { useCombinedFreshness } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, useRange, type Range } from '../lib/range.js';
import { buildRooms, valuesOf, type Room } from '../model/rooms.js';

const BUCKET_SECONDS: Record<ReadingsResponse['bucket'], number> = {
  raw: 30,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};
const RANGE_SHORT: Record<Range, string> = { '24h': '24 h', '7d': '7 days', '30d': '30 days' };
const MOULD_TONE = { low: 'good', watch: 'warn', high: 'bad' } as const;

/** 24 h (or the chosen range) statistics for one room, from its readings. */
interface RoomHistory {
  temperature: [string, number][];
  humidity: [string, number][];
  co2: [string, number][];
  co2SecondsAbove: number | null;
  mould: ReturnType<typeof mouldRisk> | null;
}

function historyOf(room: Room, readings: ReadingsResponse | undefined): RoomHistory {
  const pts = (metric: 'temperature' | 'humidity' | 'co2'): [string, number][] => {
    const id = room.metrics[metric]?.seriesId;
    return (readings?.series.find((s) => s.meta.id === id)?.points ?? []).map(([t, v]) => [t, v]);
  };
  const temperature = pts('temperature');
  const humidity = pts('humidity');
  const co2 = pts('co2');
  const t = stats(temperature);
  const h = stats(humidity);
  return {
    temperature,
    humidity,
    co2,
    co2SecondsAbove:
      room.metrics.co2 && readings
        ? secondsAbove(co2, CO2_THRESHOLD_PPM, BUCKET_SECONDS[readings.bucket])
        : null,
    mould:
      t && h
        ? mouldRisk({ minTemperatureC: t.min, avgTemperatureC: t.avg, avgHumidityPercent: h.avg })
        : null,
  };
}

export function RoomsPage() {
  const { range, setRange } = useRange();
  const now = useNow();
  const combine = useCombinedFreshness();
  const sensors = useLatest({ source: 'room_sensors' });
  const nest = useLatest({ source: 'nest' });
  const rooms = buildRooms([...(sensors.data?.items ?? []), ...(nest.data?.items ?? [])]);

  const ids = rooms.flatMap((r) =>
    (['temperature', 'humidity', 'co2'] as const).flatMap((m) =>
      r.metrics[m] ? [r.metrics[m].seriesId] : [],
    ),
  );
  const readings = useReadings(ids, range);
  const pressureIds = rooms.flatMap((r) =>
    r.metrics.pressure ? [r.metrics.pressure.seriesId] : [],
  );
  const pressure3h = useReadings(pressureIds, '24h', {
    window: { fromOffsetSeconds: -3 * 3600, toOffsetSeconds: 0, key: '3h' },
  });

  const pageFreshness = combine(
    rooms.flatMap((r) =>
      Object.values(r.metrics).map((m) => ({ freshness: m.freshness, sourceId: m.sourceId })),
    ),
  );
  const histories = new Map(rooms.map((r) => [r, historyOf(r, readings.data)]));

  return (
    <div className="page">
      <PageHeader
        title="Rooms"
        subtitle={
          <>
            <PageFreshness freshness={pageFreshness} />
            {formatLongDate(now)}
          </>
        }
        range={range}
        onRange={setRange}
      />
      {sensors.isPending ? (
        <Skeleton height={200} />
      ) : rooms.length === 0 ? (
        <Empty>
          No room sensors have reported yet. They publish to MQTT on
          home/sensors/&lt;room&gt;/&lt;metric&gt; (docs/03).
        </Empty>
      ) : (
        <>
          <Summary rooms={rooms} pressure3h={pressure3h.data} />
          <div className="row">
            {rooms.map((room) => (
              <RoomCard
                key={`${room.kind}-${room.entity}`}
                room={room}
                history={histories.get(room)!}
                range={range}
                loading={readings.isPending}
              />
            ))}
          </div>
          <Comparison rooms={rooms} histories={histories} range={range} />
        </>
      )}
    </div>
  );
}

function Summary({
  rooms,
  pressure3h,
}: {
  rooms: Room[];
  pressure3h: ReadingsResponse | undefined;
}) {
  const temps = valuesOf(rooms, 'temperature');
  const co2s = valuesOf(rooms, 'co2');
  const pressures = valuesOf(rooms, 'pressure');
  const warmest = temps.reduce<(typeof temps)[number] | null>(
    (a, b) => (!a || b.value > a.value ? b : a),
    null,
  );
  const coolest = temps.reduce<(typeof temps)[number] | null>(
    (a, b) => (!a || b.value < a.value ? b : a),
    null,
  );
  const highest = co2s.reduce<(typeof co2s)[number] | null>(
    (a, b) => (!a || b.value > a.value ? b : a),
    null,
  );
  const pressure = pressures.length
    ? pressures.reduce((s, p) => s + p.value, 0) / pressures.length
    : null;
  const line = averageSeries((pressure3h?.series ?? []).map((s) => s.points));
  const trend = line.length >= 2 ? pressureTrend(line[0]![1], line[line.length - 1]![1], 3) : null;

  const tile = (label: string, value: string, extra?: { warn?: boolean; context?: string }) => (
    <div className="tile" style={{ flex: '1 1 200px', gap: 4 }}>
      <span className="tile-label">{label}</span>
      <span className={`big big--sm${extra?.warn ? ' warn-text' : ''}`}>{value}</span>
      {extra?.context && <span className="context">{extra.context}</span>}
    </div>
  );
  return (
    <section aria-label="Summary" className="row">
      {tile(
        'Warmest now',
        warmest ? `${warmest.room.name} ${formatNumber(warmest.value, 1)} °C` : '—',
      )}
      {tile(
        'Coolest now',
        coolest ? `${coolest.room.name} ${formatNumber(coolest.value, 1)} °C` : '—',
      )}
      {tile(
        'Highest CO₂ now',
        highest ? `${highest.room.name} ${formatNumber(highest.value)} ppm` : '—',
        {
          warn: !!highest && highest.value >= CO2_THRESHOLD_PPM,
        },
      )}
      {tile('Air pressure', pressure === null ? '—' : `${formatNumber(pressure)} hPa`, {
        context: trend?.label,
      })}
    </section>
  );
}

function RoomCard({
  room,
  history,
  range,
  loading,
}: {
  room: Room;
  history: RoomHistory;
  range: Range;
  loading: boolean;
}) {
  const now = useNow();
  const t = room.metrics.temperature?.value ?? null;
  const rh = room.metrics.humidity?.value ?? null;
  const co2 = room.metrics.co2?.value ?? null;
  const target = room.metrics.target_temperature?.value ?? null;
  const highCo2 = co2 !== null && co2 >= CO2_THRESHOLD_PPM;
  const tStats = stats(history.temperature);
  const advice = roomAdvice({
    co2NowPpm: co2,
    co2SecondsAbove: history.co2SecondsAbove,
    humidityNowPercent: rh,
    mould: history.mould?.risk ?? null,
  });
  const id = `r-${room.kind}-${room.entity}`;
  const span = RANGE_SHORT[range];

  return (
    <article
      aria-labelledby={id}
      className={`card${highCo2 ? ' card--warn' : ''}`}
      style={{ flex: '1 1 520px', gap: 14 }}
    >
      <div className="card-head">
        <h2 id={id} style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600 }}>
          {room.name}
        </h2>
        <span className="small muted">
          {room.kind === 'thermostat' ? 'Nest thermostat' : 'Sensor'} ·{' '}
          {room.lastTs ? formatAgo(room.lastTs, now) : 'no data yet'}
        </span>
      </div>
      <div className="room-values">
        <span className="big" style={{ fontSize: 36 }}>
          {t === null ? '—' : `${formatNumber(t, 1)} °C`}
        </span>
        {rh !== null && (
          <span>
            <strong>{formatNumber(rh)} %</strong> RH
          </span>
        )}
        {co2 !== null && (
          <span className={highCo2 ? 'warn-text' : undefined}>
            <strong>{formatNumber(co2)}</strong> ppm CO₂
          </span>
        )}
        {target !== null && (
          <span>
            Target <strong>{formatNumber(target, 1)} °C</strong>
          </span>
        )}
        {t !== null && rh !== null && (
          <span>
            Dew point <strong>{formatNumber(dewPoint(t, rh), 1)} °C</strong>
          </span>
        )}
      </div>
      <div className="row" style={{ gap: 16 }}>
        <figure className="spark">
          <figcaption>
            Temperature, {span}
            {tStats ? ` · ${formatNumber(tStats.min, 1)}–${formatNumber(tStats.max, 1)} °C` : ''}
          </figcaption>
          {loading ? (
            <Skeleton height={56} />
          ) : history.temperature.length > 1 ? (
            <Sparkline
              points={history.temperature}
              color={token('--heat')}
              ariaLabel={`${room.name} temperature over ${span}`}
            />
          ) : (
            <Empty>Not enough data yet</Empty>
          )}
        </figure>
        {room.metrics.co2 ? (
          <figure className="spark">
            <figcaption>CO₂, {span} · dashed line 1,000 ppm</figcaption>
            {loading ? (
              <Skeleton height={56} />
            ) : history.co2.length > 1 ? (
              <Sparkline
                points={history.co2}
                color={token('--accent')}
                threshold={CO2_THRESHOLD_PPM}
                ariaLabel={`${room.name} CO₂ over ${span}, with the 1,000 ppm line`}
              />
            ) : (
              <Empty>Not enough data yet</Empty>
            )}
          </figure>
        ) : (
          <div className="spark">
            <span>CO₂</span>
            <Empty>No CO₂ sensor in this room</Empty>
          </div>
        )}
      </div>
      <p className={`line${advice.tone === 'warn' ? ' line--warn' : ''}`}>
        <span className={`dot dot--${advice.tone}`} aria-hidden="true" />
        {advice.text}
      </p>
    </article>
  );
}

function Comparison({
  rooms,
  histories,
  range,
}: {
  rooms: Room[];
  histories: Map<Room, RoomHistory>;
  range: Range;
}) {
  return (
    <section aria-labelledby="cmp-h" className="card">
      <div className="section-title">
        <h2 id="cmp-h">{RANGE_LABEL[range].replace(/^last/, 'Last')} compared</h2>
      </div>
      <div className="table-wrap">
        <table className="data" style={{ minWidth: 680 }}>
          <thead>
            <tr>
              <th scope="col">Room</th>
              <th scope="col">Temperature range</th>
              <th scope="col">Avg humidity</th>
              <th scope="col">CO₂ peak</th>
              <th scope="col">Time above 1,000 ppm</th>
              <th scope="col">Mould risk</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((room) => {
              const h = histories.get(room)!;
              const t = stats(h.temperature);
              const rh = stats(h.humidity);
              const co2 = stats(h.co2);
              const peakHigh = !!co2 && co2.max >= CO2_THRESHOLD_PPM;
              const longAbove = (h.co2SecondsAbove ?? 0) >= 3600;
              return (
                <tr key={`${room.kind}-${room.entity}`}>
                  <td>{room.name}</td>
                  <td>{t ? `${formatNumber(t.min, 1)}–${formatNumber(t.max, 1)} °C` : '—'}</td>
                  <td>{rh ? `${formatNumber(rh.avg)} %` : '—'}</td>
                  <td
                    className={peakHigh ? 'warn-text' : undefined}
                    style={peakHigh ? { fontWeight: 600 } : undefined}
                  >
                    {co2 ? `${formatNumber(co2.max)} ppm` : '—'}
                  </td>
                  <td
                    className={longAbove ? 'warn-text' : undefined}
                    style={longAbove ? { fontWeight: 600 } : undefined}
                  >
                    {h.co2SecondsAbove === null ? '—' : formatMinutes(h.co2SecondsAbove)}
                  </td>
                  <td>
                    {h.mould ? (
                      <Status tone={MOULD_TONE[h.mould.risk]}>{MOULD_LABELS[h.mould.risk]}</Status>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note">
        Mould risk combines humidity and how cold the room gets: the closer a room&apos;s coldest
        temperature is to its dew point, the higher the risk on cold walls and windows.
      </p>
    </section>
  );
}
