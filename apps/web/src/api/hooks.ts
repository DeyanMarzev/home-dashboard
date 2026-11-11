import {
  EventsResponseSchema,
  EnergySummarySchema,
  HealthSchema,
  HeatingSummarySchema,
  LatestResponseSchema,
  ReadingsResponseSchema,
  SeriesResponseSchema,
  SourcesResponseSchema,
  TariffsResponseSchema,
  WaterSummarySchema,
  type Bucket,
  type EnergySummary,
  type EventItem,
  type FreshnessPolicy,
  type HeatingSummary,
  type LatestResponse,
  type ReadingsResponse,
  type SeriesMeta,
  type SourceInfo,
  type Tariff,
  type TariffInput,
  type WaterSummary,
} from '@home/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getJson, putJson } from './client.js';
import { useLive } from './live-context.js';
import { RANGE_SECONDS, type Range } from '../lib/range.js';

const MINUTE = 60_000;

/** Poll every minute without the live stream, every 5 minutes as a safety net with it. */
function useLatestInterval(): number {
  return useLive().connected ? 5 * MINUTE : MINUTE;
}

export function useSources() {
  return useQuery({
    queryKey: ['sources'],
    queryFn: () => getJson<SourceInfo[]>('/api/sources', SourcesResponseSchema),
    staleTime: 30_000,
    refetchInterval: MINUTE,
  });
}

/** Freshness policy per source, for re-ticking badges on the client. */
export function usePolicies(): Map<string, FreshnessPolicy> {
  const { data } = useSources();
  return useMemo(() => new Map((data ?? []).map((s) => [s.id, s.policy])), [data]);
}

export function useSource(id: string): SourceInfo | undefined {
  return useSources().data?.find((s) => s.id === id);
}

/** Every series of a source, including `forecast_*` ones (which /api/latest leaves out). */
export function useSeriesList(source: string) {
  return useQuery({
    queryKey: ['series', source],
    queryFn: () => getJson<SeriesMeta[]>(`/api/series?source=${source}`, SeriesResponseSchema),
    staleTime: 10 * MINUTE,
  });
}

export interface LatestParams {
  source?: string;
  metric?: string;
  entity?: string;
}

export function useLatest(params: LatestParams) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  );
  return useQuery({
    queryKey: ['latest', params],
    queryFn: () => getJson<LatestResponse>(`/api/latest?${query.toString()}`, LatestResponseSchema),
    refetchInterval: useLatestInterval(),
  });
}

export interface ReadingsOptions {
  bucket?: Bucket;
  agg?: 'avg' | 'sum' | 'min' | 'max';
  /** A window relative to now instead of the page range, e.g. the next 24 h of forecasts. */
  window?: { fromOffsetSeconds: number; toOffsetSeconds: number; key: string };
  /** A fixed window instead (ISO instants), e.g. one London day. */
  between?: { from: string; to: string };
}

/** Readings for the page's range (from = now - range), refreshed every 5 minutes. */
export function useReadings(ids: readonly number[], range: Range, options: ReadingsOptions = {}) {
  const sorted = [...ids];
  return useQuery({
    queryKey: [
      'readings',
      sorted,
      options.between ?? options.window?.key ?? range,
      options.bucket,
      options.agg,
    ],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * MINUTE,
    queryFn: () => {
      const now = Date.now();
      const from = options.between
        ? new Date(options.between.from)
        : new Date(now + (options.window?.fromOffsetSeconds ?? -RANGE_SECONDS[range]) * 1000);
      const to = options.between
        ? new Date(options.between.to)
        : new Date(now + (options.window?.toOffsetSeconds ?? 0) * 1000);
      const q = new URLSearchParams({
        series: sorted.join(','),
        from: from.toISOString(),
        to: to.toISOString(),
      });
      if (options.bucket) q.set('bucket', options.bucket);
      if (options.agg) q.set('agg', options.agg);
      return getJson<ReadingsResponse>(`/api/readings?${q.toString()}`, ReadingsResponseSchema);
    },
  });
}

export function useEvents(limit = 20, kind?: string) {
  const q = `limit=${limit}${kind ? `&kind=${kind}` : ''}`;
  return useQuery({
    queryKey: ['events', limit, kind],
    queryFn: () => getJson<{ items: EventItem[] }>(`/api/events?${q}`, EventsResponseSchema),
    refetchInterval: 5 * MINUTE,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () =>
      getJson<{ ok: true; db: 'up' | 'down'; version: string }>('/api/health', HealthSchema),
    refetchInterval: MINUTE,
  });
}

export function useHeatingSummary(date?: string) {
  return useQuery({
    queryKey: ['heating', date ?? 'today'],
    queryFn: () =>
      getJson<HeatingSummary>(
        `/api/summary/heating${date ? `?date=${date}` : ''}`,
        HeatingSummarySchema,
      ),
    refetchInterval: MINUTE,
  });
}

/** Energy summary for London dates [from, to]; without them, the 14 days ending the latest day. */
export function useEnergySummary(
  range?: { from: string; to: string } | { days: number },
  enabled = true,
) {
  const q = !range
    ? ''
    : 'days' in range
      ? `?days=${range.days}`
      : `?from=${range.from}&to=${range.to}`;
  return useQuery({
    queryKey: ['energy', q],
    enabled,
    queryFn: () => getJson<EnergySummary>(`/api/summary/energy${q}`, EnergySummarySchema),
    refetchInterval: 5 * MINUTE,
  });
}

export function useTariffs() {
  return useQuery({
    queryKey: ['tariffs'],
    queryFn: () => getJson<{ items: Tariff[] }>('/api/tariffs', TariffsResponseSchema),
  });
}

/** Replaces every tariff row (PUT /api/tariffs); costs are recomputed on the next fetch. */
export function useSaveTariffs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: TariffInput[]) =>
      putJson<{ items: Tariff[] }>('/api/tariffs', { items }, TariffsResponseSchema),
    onSuccess: async (data) => {
      queryClient.setQueryData(['tariffs'], data);
      await queryClient.invalidateQueries({ queryKey: ['energy'] });
    },
  });
}

/** Water summary for the `days` ending the latest covered day (default 28). */
export function useWaterSummary(days?: number, enabled = true) {
  const q = days ? `?days=${days}` : '';
  return useQuery({
    queryKey: ['water', q],
    enabled,
    queryFn: () => getJson<WaterSummary>(`/api/summary/water${q}`, WaterSummarySchema),
    refetchInterval: 15 * MINUTE,
  });
}
