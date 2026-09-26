import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    // Unit tests only. The Playwright e2e suite lives in tests/e2e and must not
    // be picked up here — its `test`/`expect` come from @playwright/test and
    // would fail under vitest's runner.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // `next lint` and tsc already cover the app; this reports only on what the
    // unit tests actually exercise, so the number means something.
    coverage: {
      provider: 'v8',
      include: ['helpers/**/*.ts', 'services/**/*.ts', 'components/**/*.ts'],
      exclude: ['**/*.d.ts', '**/codegen/**'],
    },
  },
  resolve: {
    // Mirrors the `@/*` -> `./*` alias in tsconfig.json.
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
