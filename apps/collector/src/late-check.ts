import {
  freshness,
  freshnessPolicy,
  type Freshness,
  type LatestPoint,
  type SourceConfig,
} from '@home/shared';
import type { Logger } from 'pino';

export const SOURCE_LATE = 'source_late';

export interface LateStore {
  latestBySource(): Promise<Map<string, LatestPoint>>;
  /** Opens a source_late event unless one is open. True if it opened one. */
  openLate(source: SourceConfig, freshness: Freshness): Promise<boolean>;
  /** Resolves the open source_late event, if any. True if it resolved one. */
  resolveLate(sourceId: string): Promise<boolean>;
}

/**
 * Turns freshness into events (docs/03 § Late → events): one open `source_late` warning per
 * Late source, resolved when data flows again. Disabled sources never stay Late.
 */
export async function checkLateSources(
  sources: readonly SourceConfig[],
  store: LateStore,
  log: Logger,
  now: Date = new Date(),
): Promise<{ opened: string[]; resolved: string[] }> {
  const latest = await store.latestBySource();
  const opened: string[] = [];
  const resolved: string[] = [];

  for (const source of sources) {
    const f = source.enabled
      ? freshness(freshnessPolicy(source), latest.get(source.id) ?? null, now)
      : null;
    if (f?.state === 'late') {
      if (await store.openLate(source, f)) {
        opened.push(source.id);
        log.warn({ source: source.id, label: f.label }, 'source is late');
      }
    } else if (await store.resolveLate(source.id)) {
      resolved.push(source.id);
      log.info({ source: source.id }, 'source recovered');
    }
  }
  return { opened, resolved };
}

export function lateMessage(source: SourceConfig, f: Freshness): string {
  return `${source.name}: ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}`;
}
