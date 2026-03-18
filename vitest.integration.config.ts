import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test-harness/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 60000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
