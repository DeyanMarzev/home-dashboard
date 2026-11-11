import {
  compassPoint,
  daqiLevel,
  describeWeather,
  formatLondonTime,
  formatNumber,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { Link } from 'react-router';
import { useLatest } from '../api/hooks.js';
import { useForecast } from '../api/weather.js';
import { useFreshnessNow } from '../lib/freshness.js';
import { pick, valueOf } from '../model/latest.js';
import { DAQI_TONE, daqiText } from '../model/weather.js';
import { Panel, Skeleton, Value } from './Cards.js';
import { FreshnessBadge } from './FreshnessBadge.js';
import { NotConnected, SourceBadge } from './PageBits.js';
import { Status } from './Status.js';
import { WindArrow } from './WeatherBits.js';
import { WeatherIcon } from './WeatherIcon.js';

/** The Overview's weather card: now, today, the next 12 hours, air quality (docs/05). */
export function WeatherSummary({
  weather,
  source,
  loading,
}: {
  weather: LatestResponse | undefined;
  source: SourceInfo | undefined;
  loading: boolean;
}) {
  const at = useFreshnessNow();
  const air = useLatest({ source: 'air_quality' });
  const { hours, days } = useForecast();
  const temp = pick(weather, 'temperature', 'outdoor');
  const v = (metric: string) => valueOf(weather, metric, 'outdoor');
  const code = v('weather_code');
  const direction = v('wind_direction');
  const daqi = valueOf(air.data, 'daqi', 'outdoor');
  const today = days[0];
  const next = hours.filter((_, i) => i > 0 && i % 3 === 0).slice(0, 4);

  return (
    <Panel
      id="weather-h"
      title="Weather"
      flex="999 1 620px"
      badge={
        temp ? (
          <FreshnessBadge freshness={at(temp.freshness, 'open_meteo')} compact />
        ) : (
          <SourceBadge source={source} compact />
        )
      }
      meta={<Link to="/weather">Forecast and history →</Link>}
    >
      {loading ? (
        <Skeleton height={150} />
      ) : !temp || temp.value === null ? (
        <NotConnected source={source}>No weather readings yet</NotConnected>
      ) : (
        <div className="weather-summary">
          <div className="now">
            {code !== null && <WeatherIcon code={code} isDay={v('is_day') !== 0} size={56} />}
            <div className="stack" style={{ gap: 2 }}>
              <Value value={formatNumber(temp.value, 1)} unit="°C" />
              <strong>{code === null ? '' : describeWeather(code)}</strong>
              {today && today.max !== null && today.min !== null && (
                <span className="small muted">
                  High {formatNumber(today.max)}° · low {formatNumber(today.min)}°
                  {today.rainChance !== null && ` · rain ${formatNumber(today.rainChance)} %`}
                </span>
              )}
            </div>
          </div>
          {next.length > 0 && (
            <ol className="hours hours--compact" aria-label="Next 12 hours">
              {next.map((h) => (
                <li key={h.ts} className="hour">
                  <time dateTime={h.ts} className="small muted">
                    {formatLondonTime(new Date(h.ts))}
                  </time>
                  {h.code !== null && (
                    <WeatherIcon code={h.code} isDay={h.isDay} size={26} labelled />
                  )}
                  <strong>{formatNumber(h.temperature)}°</strong>
                  <span className="small" style={{ color: 'var(--cool)' }}>
                    {h.rainChance === null ? '' : `${formatNumber(h.rainChance)} %`}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <dl className="facts weather-summary-facts">
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
                {v('wind_gust') !== null && (
                  <span className="small muted"> · gusts {formatNumber(v('wind_gust')!)}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Air quality</dt>
              <dd>
                {daqi === null ? (
                  '—'
                ) : (
                  <Status tone={DAQI_TONE[daqiLevel(daqi)]}>{daqiText(daqi)}</Status>
                )}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </Panel>
  );
}
