import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': path.resolve(__dirname, '../..') } },
  test: { environment: 'node', maxWorkers: 1, fileParallelism: false,
    // The runner ceiling is 192 MiB; test workers share the same heap ceiling with bounded nursery space.
    pool: 'forks', execArgv: ['--max-old-space-size=192', '--max-semi-space-size=8'],
    setupFiles: [path.resolve(__dirname, 'forecasting-offline-trap.ts')] },
})
