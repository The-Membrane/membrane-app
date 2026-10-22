// build-morpho-markets.mjs — the /position Morpho Blue reader's fallback market list.
//
// Morpho Blue cannot enumerate an address's markets on-chain, so the reader asks the Morpho
// API which markets an address holds. When the API fails it falls back to a KNOWN-MARKET
// LIST: the committed Oct 10 2025 list plus every Morpho Blue market id that curated vaults
// allocate to in the curator-feed exposure snapshot. This script writes the second half.
//
// Writes lib/position-sim/adapters/morphoMarkets.generated.json: market ids ONLY (public
// on-chain bytes32 identifiers), sorted, with the snapshot's block and sha256. No vault, no
// allocation, no USD figure leaves the datasets repo (board rule N18: exposure.json stays in
// the private triccs/membrane-datasets; the app keeps this generated aggregate).
//
// Run:  MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets node scripts/position/build-morpho-markets.mjs

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { datasetPath, datasetsDir } from '../lib/datasetsDir.mjs'

const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const SOURCE = 'curator-feed/exposure.json'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const out = join(root, 'lib', 'position-sim', 'adapters', 'morphoMarkets.generated.json')

const path = datasetPath(root, SOURCE)
const bytes = readFileSync(path)
const exposure = JSON.parse(bytes.toString('utf8'))
if (!Array.isArray(exposure.vaults)) throw new Error(`${SOURCE}: no vaults[]`)

// Morpho Blue market allocations only: a bytes32 target with scope 'market'. A Vault V2's
// 20-byte targets (vault-to-vault adapters) are not markets and are left out.
const ids = new Set()
for (const v of exposure.vaults) {
  for (const a of v.allocations ?? []) {
    if (a.scope === 'market' && typeof a.target === 'string' && BYTES32.test(a.target)) ids.add(a.target.toLowerCase())
  }
}
if (ids.size === 0) throw new Error(`${SOURCE}: no Morpho Blue market ids`)

let commit
try {
  commit = execFileSync('git', ['-C', datasetsDir(root), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {
  throw new Error(`could not read the datasets commit (git -C ${datasetsDir(root)} rev-parse HEAD)`)
}

const table = {
  schema: 1,
  method:
    'Morpho Blue market ids (bytes32, lowercased, sorted) that curated vaults allocate to in the curator-feed exposure snapshot. Ids only. The /position Morpho reader scans them, with the committed Oct 10 2025 list, when the Morpho API cannot be asked; every number is then read on-chain.',
  source: {
    repo: 'triccs/membrane-datasets',
    commit,
    path: SOURCE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    block: exposure.block,
    ts: exposure.ts,
  },
  generatedAt: new Date().toISOString(),
  markets: [...ids].sort(),
}

writeFileSync(out, `${JSON.stringify(table, null, 1)}\n`)
console.log(`wrote ${out}: ${table.markets.length} market ids from ${SOURCE} at block ${exposure.block}`)
