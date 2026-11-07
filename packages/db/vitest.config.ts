import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite (Postgres in WebAssembly) takes a few seconds to boot, more on a WSL /mnt/c checkout.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
