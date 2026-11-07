import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fastify's first request loads many modules lazily; on a WSL /mnt/c checkout that
    // file I/O alone can take 15+ s. On a Linux filesystem it's milliseconds.
    testTimeout: 60_000,
  },
});
