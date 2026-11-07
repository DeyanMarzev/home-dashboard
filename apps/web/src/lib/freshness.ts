import { combineFreshness, retick, type Freshness } from '@home/shared';
import { useCallback } from 'react';
import { usePolicies } from '../api/hooks.js';
import { useNow } from './now-context.js';

/**
 * Freshness as of the shared clock (CLAUDE.md rule 1: computed, never hardcoded). Returns a
 * function so a page can re-tick many series at once; falls back to the server's value
 * until the source's policy has loaded.
 */
export function useFreshnessNow(): (f: Freshness, sourceId: string) => Freshness {
  const now = useNow();
  const policies = usePolicies();
  return useCallback(
    (f, sourceId) => {
      const policy = policies.get(sourceId);
      return policy ? retick(f, policy, now) : f;
    },
    [now, policies],
  );
}

/** Re-ticks each item and combines them (worst wins). */
export function useCombinedFreshness(): (
  items: readonly { freshness: Freshness; sourceId: string }[],
) => Freshness | null {
  const at = useFreshnessNow();
  return useCallback(
    (items) => combineFreshness(items.map((i) => at(i.freshness, i.sourceId))),
    [at],
  );
}
