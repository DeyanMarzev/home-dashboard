import { addLondonDays, londonDateString, londonMidnight, type SeriesMeta } from '@home/shared';
import { useReadings, useSeriesList } from './hooks.js';
import { daqiByDay, dailyRows, hourlyRows } from '../model/weather.js';

const ids = (metas: readonly SeriesMeta[], keep: (m: SeriesMeta) => boolean) =>
  metas.filter(keep).map((m) => m.id);

/**
 * Open-Meteo's forecasts (the next 24 hours, the next 7 days) and the air quality outlook, for
 * the Weather page and the Overview's weather card (docs/05 § Weather page).
 */
export function useForecast() {
  const weather = useSeriesList('open_meteo');
  const air = useSeriesList('air_quality');
  const w = weather.data ?? [];
  const today = londonDateString(new Date());

  const hourly = useReadings(
    ids(w, (m) => m.metric.startsWith('forecast_') && !m.metric.startsWith('forecast_day_')),
    '24h',
    {
      bucket: 'raw',
      window: { fromOffsetSeconds: -1800, toOffsetSeconds: 25 * 3600, key: 'forecast-hours' },
    },
  );
  // One point per London day, at its midnight: hourly buckets pass them through unchanged.
  const daily = useReadings(
    ids(w, (m) => m.metric.startsWith('forecast_day_')),
    '7d',
    {
      bucket: '1h',
      agg: 'max',
      between: {
        from: londonMidnight(today).toISOString(),
        to: londonMidnight(addLondonDays(today, 8)).toISOString(),
      },
    },
  );
  const daqi = useReadings(
    ids(air.data ?? [], (m) => m.metric === 'forecast_daqi'),
    '24h',
    {
      bucket: 'raw',
      window: { fromOffsetSeconds: 0, toOffsetSeconds: 40 * 3600, key: 'forecast-daqi' },
    },
  );

  return {
    hours: hourlyRows(hourly.data?.series ?? []),
    days: dailyRows(daily.data?.series ?? []),
    daqiDays: daqiByDay(daqi.data?.series[0]?.points ?? []),
    // isLoading, not isPending: a query with no series to ask for stays pending forever.
    loading: weather.isPending || hourly.isLoading || daily.isLoading,
  };
}
