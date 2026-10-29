import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test runs without network access: the ledger layer is driven by a
    // fake RPC that answers from fixtures, so there is nothing to skip and no
    // endpoint to rate-limit. A change to the real `getEvents` shapes should
    // come with a fixture, not with a live call.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
