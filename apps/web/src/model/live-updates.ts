import type { LatestResponse, SourceInfo, StreamFreshness, StreamReading } from '@home/shared';

/**
 * Applies a streamed reading to a cached /api/latest response: newer value, and freshness
 * moved forward (its state is re-ticked at render with the source's policy).
 */
export function applyReading(
  response: LatestResponse | undefined,
  r: StreamReading,
): LatestResponse | undefined {
  if (!response?.items.some((i) => i.series.id === r.seriesId)) return response;
  return {
    ...response,
    items: response.items.map((item) => {
      if (item.series.id !== r.seriesId || (item.ts && item.ts >= r.ts)) return item;
      const intervalMs = (item.freshness.intervalSeconds ?? 0) * 1000;
      return {
        ...item,
        ts: r.ts,
        value: r.value,
        freshness: {
          ...item.freshness,
          dataTo: new Date(Date.parse(r.ts) + intervalMs).toISOString(),
        },
      };
    }),
  };
}

/** Applies a streamed freshness change to the cached /api/sources list. */
export function applySourceFreshness(
  sources: SourceInfo[] | undefined,
  f: StreamFreshness,
): SourceInfo[] | undefined {
  return sources?.map((s) => (s.id === f.sourceId ? { ...s, freshness: f.freshness } : s));
}
