import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
          pool: 'threads',
          // Property suites run hundreds of cases; under a loaded shared host the
          // 5 s default produced spurious timeouts, not failures.
          testTimeout: 30_000,
        },
      },
      {
        // Manual only: spawns the app, Chromium and the sandbox. Run it with scripts/run-discrimination.sh.
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          pool: 'forks',
          maxConcurrency: 3,
          testTimeout: 240_000,
        },
      },
    ],
  },
});
