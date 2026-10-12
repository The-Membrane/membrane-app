// Separate full-app proposal only: never loaded by the 192 MiB recovery gate.
require('./forecasting-cloud-full-app-network-guard.cjs')
const v8 = require('node:v8')
if (v8.getHeapStatistics().heap_size_limit > 2368 * 1024 * 1024)
  throw new Error('full_app_node_heap_contract_exceeded')
const workerThreads = require('node:worker_threads')
const NativeWorker = workerThreads.Worker
workerThreads.Worker = class extends NativeWorker {
  constructor(file, options = {}) {
    const limits = options.resourceLimits || {}
    super(file, { ...options, resourceLimits: { ...limits,
      maxOldGenerationSizeMb: Math.min(limits.maxOldGenerationSizeMb || 2304, 2304) } })
  }
}
require('node:module').syncBuiltinESMExports()
