import {
  EventsResponseSchema,
  HealthSchema,
  LatestResponseSchema,
  ReadingsResponseSchema,
  SourcesResponseSchema,
  type Bucket,
  type EventItem,
  type FreshnessPolicy,
  type LatestResponse,
  type ReadingsResponse,
  type SourceInfo,
} from '@home/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getJson } from './client.js';
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
}

/** Readings for the page's range (from = now - range), refreshed every 5 minutes. */
export function useReadings(ids: readonly number[], range: Range, options: ReadingsOptions = {}) {
  const sorted = [...ids];
  return useQuery({
    queryKey: ['readings', sorted, options.window?.key ?? range, options.bucket, options.agg],
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: 5 * MINUTE,
    queryFn: () => {
      const now = Date.now();
      const from = new Date(
        now + (options.window?.fromOffsetSeconds ?? -RANGE_SECONDS[range]) * 1000,
      );
      const to = new Date(now + (options.window?.toOffsetSeconds ?? 0) * 1000);
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

export function useEvents(limit = 20) {
  return useQuery({
    queryKey: ['events', limit],
    queryFn: () =>
      getJson<{ items: EventItem[] }>(`/api/events?limit=${limit}`, EventsResponseSchema),
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
