import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fastify's first request loads many modules lazily, and PGlite (Postgres in WebAssembly)
    // takes a few seconds to boot; on a WSL /mnt/c checkout that file I/O alone can take 15+ s.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
