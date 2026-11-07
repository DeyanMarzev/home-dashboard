import type { LatestItem, LatestResponse } from '@home/shared';

/** The latest item for a metric (and entity) in a /api/latest response. */
export function pick(
  response: LatestResponse | undefined,
  metric: string,
  entity?: string,
): LatestItem | undefined {
  return response?.items.find(
    (i) => i.series.metric === metric && (entity === undefined || i.series.entity === entity),
  );
}

export function valueOf(
  response: LatestResponse | undefined,
  metric: string,
  entity?: string,
): number | null {
  return pick(response, metric, entity)?.value ?? null;
}
