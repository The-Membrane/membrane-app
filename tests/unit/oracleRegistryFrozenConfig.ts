// The frozen config-card data for the tests that pin MEASURED values (a count, a block, a D, a
// label). The CI re-collect (first run 2026-10-11) re-commits data/oracle-registry/config on every
// run, so those tests read this copy instead: commit 1c94be6e's state / changes / queues for all
// 8 subjects plus lz-metadata.json, byte-for-byte, in the loader's own layout. Not a test file.

import { join } from 'node:path'

/** A config dir for loadConfigInputs / getConfigIndex / getConfigCard (wsteth head 26,158,320). */
export const FROZEN = join(process.cwd(), 'tests/fixtures/oracle-registry/config/1c94be6e')
