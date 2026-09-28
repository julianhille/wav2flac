// SPDX-License-Identifier: 0BSD
import { defineConfig } from 'vitest/config';
import { tier } from './tests/helpers/tools.js';

// Quick-tier property tests draw random sizes, so their time varies; shared
// CI runners with coverage are several times slower than a workstation.
const timeout = tier === 'quick' ? 120_000 : 600_000;

export default defineConfig({
  test: {
    testTimeout: timeout,
    hookTimeout: timeout,
    reporters: process.env['CI'] ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      include: ['ts/**/*.ts'],
      // The worker entry only runs inside a real worker (pkg project).
      exclude: ['ts/worker.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage/js',
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 88 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/unit/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'pkg',
          include: ['tests/pkg/**/*.test.ts'],
          globalSetup: ['tests/pkg/global-setup.ts'],
          pool: 'forks',
          execArgv: ['--expose-gc'],
        },
      },
    ],
  },
});
