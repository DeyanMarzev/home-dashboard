import {
  combineFreshness,
  freshness,
  freshnessPolicy,
  type Freshness,
  type FreshnessPolicy,
  type LatestPoint,
  type Registry,
} from '@home/shared';

/** Policy for a source no longer in the registry: treat it as live-capable with no cadence. */
const UNKNOWN_SOURCE: FreshnessPolicy = {
  expectedDelaySeconds: 0,
  cadenceSeconds: null,
  graceSeconds: null,
};

/** Freshness from the registry (CLAUDE.md rule 1: computed, never hardcoded). */
export class FreshnessService {
  private readonly policies: Map<string, FreshnessPolicy>;

  constructor(
    registry: Registry,
    private readonly now: () => Date,
  ) {
    this.policies = new Map(registry.sources.map((s) => [s.id, freshnessPolicy(s)]));
  }

  of(sourceId: string, latest: LatestPoint | null): Freshness {
    return freshness(this.policies.get(sourceId) ?? UNKNOWN_SOURCE, latest, this.now());
  }

  combine(list: readonly Freshness[]): Freshness | null {
    return combineFreshness(list);
  }
}
