import { loadRegistryFile } from '@home/db';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectors } from './index.js';

/** Registry sources whose collector belongs to a later milestone (docs/07). */
const NOT_BUILT_YET = ['thames_water'];

describe('collector registration', () => {
  it('has a collector for every source in config/sources.yaml (except later milestones)', async () => {
    const registry = await loadRegistryFile(
      fileURLToPath(new URL('../../../../config/sources.yaml', import.meta.url)),
    );
    const ids = new Set(collectors.map((c) => c.id));
    expect(registry.sources.filter((s) => !ids.has(s.id)).map((s) => s.id)).toEqual(NOT_BUILT_YET);
  });

  it('has no collector missing from the registry, and no duplicates', async () => {
    const registry = await loadRegistryFile(
      fileURLToPath(new URL('../../../../config/sources.yaml', import.meta.url)),
    );
    expect(
      collectors.map((c) => c.id).filter((id) => !registry.sources.some((s) => s.id === id)),
    ).toEqual([]);
    expect(new Set(collectors.map((c) => c.id)).size).toBe(collectors.length);
  });
});
