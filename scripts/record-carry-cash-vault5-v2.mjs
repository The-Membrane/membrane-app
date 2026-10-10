// Native local cohort experiment. Registration is idempotent.
// node --import tsx scripts/record-carry-cash-vault5-v2.mjs --verify|--evaluate|--register|--tick|--score
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import {
  evaluateVault5V2,
  registerVault5V2,
  scoreVault5V2,
  tickVault5V2,
  verifyVault5V2Ledger,
} from './lib/localCarryCashVault5V2Store.mjs'

const MODES = new Set(['--verify', '--evaluate', '--register', '--tick', '--score'])

export async function run(mode, options = {}) {
  if (!MODES.has(mode)) throw new Error('vault5_mode')
  const manifest = options.manifest ?? (await buildSubjectManifest())
  const roots = { cashRoot: options.cashRoot, root: options.root }
  if (mode === '--register') return registerVault5V2(manifest, roots, options.now)
  if (mode === '--tick') return tickVault5V2(manifest, roots, options.now)
  if (mode === '--score') return scoreVault5V2(manifest, roots, options.now)
  if (mode === '--evaluate') return evaluateVault5V2(manifest, roots)
  const verified = verifyVault5V2Ledger(manifest, roots)
  return {
    status: 'verified',
    count: verified.count,
    lastSha256: verified.last?.sha256 ?? null,
    artifactSha256: verified.artifact?.sha256 ?? null,
    enrollmentSha256: verified.enrollment?.sha256 ?? null,
    ticks: verified.ticks.length,
    issues: verified.issues.length,
    scores: verified.scores.length,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !MODES.has(process.argv[2])) {
    process.stderr.write('vault5_exactly_one_mode\n')
    process.exitCode = 2
  } else {
    run(process.argv[2])
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${error?.message ?? 'vault5_failed'}\n`)
        process.exitCode = 1
      })
  }
}
