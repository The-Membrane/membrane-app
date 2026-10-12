// Worker execArgv forbids V8 heap flags. Enforce the same ceiling through resourceLimits.
const threads = require('node:worker_threads')
const OriginalWorker = threads.Worker
threads.Worker = class BoundedWorker extends OriginalWorker {
  constructor(filename, options = {}) {
    super(filename, {...options,resourceLimits:{...options.resourceLimits,
      maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:2}})
  }
}
require('node:module').syncBuiltinESMExports()
