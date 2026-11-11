import { averageSeries, formatNumber, stateRuns, stats, type LatestResponse } from '@home/shared';
import { useReadings } from '../api/hooks.js';
import { useCombinedFreshness } from '../lib/freshness.js';
import { useNow } from '../lib/now-context.js';
import { RANGE_LABEL, RANGE_SECONDS, type Range } from '../lib/range.js';
import { pick } from '../model/latest.js';
import type { Room } from '../model/rooms.js';
import { Panel, Skeleton } from './Cards.js';
import { TimeChart } from './charts/TimeChart.js';
import { token } from './charts/theme.js';
import { FreshnessBadge } from './FreshnessBadge.js';
import { NotConnected } from './PageBits.js';

/** How long one point of the heating state holds, by the bucket the API used. */
const BUCKET_HOLD_SECONDS = { raw: 360, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 } as const;

/**
 * Indoor (average of the room sensors) against outdoor temperature, with the Nest target and
 * when the boiler was firing (docs/05 § Weather page; it was the Overview's main chart).
 */
export function TemperaturePanel({
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
