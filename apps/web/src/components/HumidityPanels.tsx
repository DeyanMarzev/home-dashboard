import { byLondonHour, formatNumber, stats, type LatestResponse } from '@home/shared';
import { useReadings } from '../api/hooks.js';
import { useCombinedFreshness } from '../lib/freshness.js';
import { RANGE_LABEL, RANGE_SECONDS, type Range } from '../lib/range.js';
import { pick } from '../model/latest.js';
import type { Room } from '../model/rooms.js';
import { Panel, Skeleton } from './Cards.js';
import { HourChart } from './charts/HourChart.js';
import { TimeChart } from './charts/TimeChart.js';
import { token } from './charts/theme.js';
import { FreshnessBadge } from './FreshnessBadge.js';
import { NotConnected } from './PageBits.js';

/** Comfortable indoor humidity; above 60 % for long is the mould "watch" level (comfort.ts). */
const COMFORT = { from: 40, to: 60 } as const;
const SERIES_TOKENS = 6;

/**
 * The typical day needs hourly points over several days: a week for the 24 h and 7 day ranges,
 * three weeks for 30 days (the API allows 600 points per series, so 30 days of hours won't fit).
 */
const PROFILE_DAYS: Record<Range, number> = { '24h': 7, '7d': 7, '30d': 21 };
const PROFILE_LABEL: Record<Range, string> = {
  '24h': 'last 7 days',
  '7d': 'last 7 days',
  '30d': 'last 3 weeks',
};

interface Line {
  name: string;
  seriesId: number;
  /** CSS variable, so the legend and the chart share it. */
  cssVar: `--${string}`;
  dashed?: boolean;
}

/**
 * Humidity by room (docs/05 § Rooms): over the page range, and a typical day (average for each
 * London hour) to show daily patterns such as showers and cooking. Outdoor humidity is dashed
 * on the range chart for context; 40–60 % is shaded as comfortable.
 */
export function HumidityPanels({
  rooms,
  weather,
  range,
}: {
  rooms: Room[];
  weather: LatestResponse | undefined;
  range: Range;
}) {
  const combine = useCombinedFreshness();
  const outdoorId = pick(weather, 'humidity', 'outdoor')?.series.id;
  const lines: Line[] = [
    ...rooms
      .filter((r) => r.metrics.humidity)
      .map((r, i) => ({
        name: r.name,
        seriesId: r.metrics.humidity!.seriesId,
        cssVar: `--series-${(i % SERIES_TOKENS) + 1}` as const,
      })),
    ...(outdoorId
      ? [{ name: 'Outdoor', seriesId: outdoorId, cssVar: '--chart-muted' as const, dashed: true }]
      : []),
  ];
  const ids = lines.map((l) => l.seriesId);
  const days = PROFILE_DAYS[range];
  const readings = useReadings(ids, range);
  const profile = useReadings(ids, range, {
    bucket: '1h',
    window: { fromOffsetSeconds: -days * 86400, toOffsetSeconds: 0, key: `${days}d` },
  });

  const pointsOf = (data: typeof readings.data, id: number) =>
    data?.series.find((s) => s.meta.id === id)?.points ?? [];
  const freshness = combine(
    (readings.data?.series ?? []).map((s) => ({
      freshness: s.freshness,
      sourceId: s.meta.sourceId,
    })),
  );
  const badge = freshness && <FreshnessBadge freshness={freshness} compact />;
  const band = { ...COMFORT, color: token('--comfort-band') };

  const rangeSeries = lines
    .map((l) => ({
      name: l.name,
      points: pointsOf(readings.data, l.seriesId),
      color: token(l.cssVar),
      dashed: l.dashed,
    }))
    .filter((s) => s.points.length > 0);
  // Outdoor (75–95 % in winter) would stretch the axis and flatten the rooms, so rooms only.
  const hourSeries = lines
    .filter((l) => !l.dashed)
    .map((l) => ({
      name: l.name,
      values: byLondonHour(pointsOf(profile.data, l.seriesId)),
      color: token(l.cssVar),
      dashed: l.dashed,
    }))
    .filter((s) => s.values.some((v) => v !== null));

  // Each room's most humid hour of the typical day, e.g. "Bathroom 08:00 (71 %)".
  const peaks = hourSeries.flatMap((s) => {
    let best = -1;
    s.values.forEach((v, h) => {
      if (v !== null && (best < 0 || v > s.values[best]!)) best = h;
    });
    return best < 0
      ? []
      : [`${s.name} ${String(best).padStart(2, '0')}:00 (${formatNumber(s.values[best]!)} %)`];
  });

  const legend = (withOutdoor: boolean) => (
    <span className="legend">
      {lines
        .filter((l) => withOutdoor || !l.dashed)
        .map((l) => (
          <span key={l.seriesId} style={l.dashed ? { color: `var(${l.cssVar})` } : undefined}>
            <span
              className={`swatch${l.dashed ? ' swatch--dashed' : ''}`}
              style={l.dashed ? undefined : { background: `var(${l.cssVar})` }}
            />
            {l.name}
          </span>
        ))}
      <span>
        <span className="swatch swatch--band" style={{ background: 'var(--comfort-band)' }} />
        40–60 %
      </span>
    </span>
  );
  const describe = rangeSeries
    .map((s) => {
      const st = stats(s.points);
      return st ? `${s.name} ${formatNumber(st.min)} to ${formatNumber(st.max)} %` : null;
    })
    .filter(Boolean)
    .join(', ');

  if (lines.length === 0) return null;
  return (
    <div className="row">
      <Panel
        id="rh-range-h"
        title={`Humidity, ${RANGE_LABEL[range]}`}
        flex="3 1 560px"
        badge={badge}
        meta={legend(true)}
      >
        {readings.isPending ? (
          <Skeleton height={232} />
        ) : rangeSeries.length === 0 ? (
          <NotConnected source={undefined}>No humidity readings yet</NotConnected>
        ) : (
          <TimeChart
            series={rangeSeries}
            unit="%"
            digits={0}
            valueBand={band}
            spanSeconds={RANGE_SECONDS[range]}
            ariaLabel={`Line chart of humidity by room over the ${RANGE_LABEL[range]}: ${describe}.`}
          />
        )}
      </Panel>
      <Panel
        id="rh-day-h"
        title={`Typical day, ${PROFILE_LABEL[range]}`}
        flex="2 1 400px"
        badge={badge}
        meta={legend(false)}
      >
        {profile.isPending ? (
          <Skeleton height={232} />
        ) : hourSeries.length === 0 ? (
          <NotConnected source={undefined}>No humidity readings yet</NotConnected>
        ) : (
          <>
            <HourChart
              series={hourSeries}
              unit="%"
              valueBand={band}
              height={232}
              ariaLabel={`Line chart of average humidity by hour of the day over the ${PROFILE_LABEL[range]}.`}
            />
            {peaks.length > 0 && (
              <p className="note">Most humid hour on average: {peaks.join(', ')}.</p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
