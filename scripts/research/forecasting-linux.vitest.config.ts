import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': path.resolve(__dirname, '../..') } },
  test: { environment: 'node', maxWorkers: 1, fileParallelism: false,
    // The runner ceiling is 192 MiB; test workers share the same heap ceiling with bounded nursery space.
    pool: 'threads', execArgv: ['--require', path.resolve(__dirname,'forecasting-heap-workers.cjs')],
    setupFiles: [path.resolve(__dirname, 'forecasting-offline-trap.ts')] },
})
