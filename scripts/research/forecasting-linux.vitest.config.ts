import { defineConfig } from 'vitest/config'
import path from 'node:path'
const gateTemporaryDirectory = process.env.TMPDIR
if (!gateTemporaryDirectory || !path.isAbsolute(gateTemporaryDirectory) ||
    !gateTemporaryDirectory.startsWith('/workspace/membrane-datasets/forecasting-cloud/linux-recovery/'))
  throw new Error('forecasting_gate_private_cache_directory_required')
export default defineConfig({
  cacheDir: path.join(gateTemporaryDirectory, 'vite-cache'),
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': path.resolve(__dirname, '../..') } },
  test: { environment: 'node', maxWorkers: 1, fileParallelism: false,
    // The runner ceiling is 192 MiB; test workers share the same heap ceiling with bounded nursery space.
    pool: 'threads', execArgv: ['--require', path.resolve(__dirname,'forecasting-heap-workers.cjs')],
    setupFiles: [path.resolve(__dirname, 'forecasting-offline-trap.ts')] },
})
