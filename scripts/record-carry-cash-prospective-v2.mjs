// Local native recorder for the separately versioned two-subject H24 study.
// Native scheduler: node --import tsx scripts/record-carry-cash-prospective-v2.mjs --tick
// Also run --score after the receipt-grace deadline; --issue is read-only compatibility.
// Registration is an explicit one-time operation; scheduler ticks never refit.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { verifyLocalCarryCash } from './lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  verifyLocalSupplementalAaveUsdeCash,
} from './lib/localSupplementalAaveUsdeCashStore.mjs'
import { readPinnedDevelopmentSources } from './research/carry-cash-prospective-v2-policy.mjs'
import {
  evaluateCashProspectiveV2,
  issueCashProspectiveV2,
  registerCashProspectiveV2,
  scoreCashProspectiveV2,
  tickCashProspectiveV2,
  verifyCashProspectiveV2Ledger,
} from './lib/localCarryCashProspectiveV2Store.mjs'

const MODES = new Set(['--register', '--tick', '--issue', '--score', '--verify', '--evaluate'])

export async function loadCashV2Inputs(options = {}) {
  const frozenManifest = options.frozenManifest ?? (await buildSubjectManifest())
  const supplementalManifest =
    options.supplementalManifest ?? (await buildSupplementalAaveUsdeCashManifest())
  return {
    frozen: {
      manifest: frozenManifest,
      verified: verifyLocalCarryCash(frozenManifest, options.frozenRoot),
    },
    supplemental: {
      manifest: supplementalManifest,
      verified: verifyLocalSupplementalAaveUsdeCash(supplementalManifest, options.supplementalRoot),
    },
  }
}

export async function runCashProspectiveV2(mode, options = {}) {
  if (!MODES.has(mode)) throw Error('cash_v2_mode_invalid')
  const inputs = options.inputs ?? (await loadCashV2Inputs(options))
  const common = { root: options.root, now: options.now, minFreeBytes: options.minFreeBytes }
  if (mode === '--register') {
    const development =
      options.development ?? readPinnedDevelopmentSources(options.developmentRoots)
    return registerCashProspectiveV2(inputs, development, common)
  }
  if (mode === '--tick') return tickCashProspectiveV2(inputs, common)
  if (mode === '--issue') return issueCashProspectiveV2(inputs, common)
  if (mode === '--score') return scoreCashProspectiveV2(inputs, common)
  if (mode === '--evaluate') return evaluateCashProspectiveV2(inputs, common)
  const state = verifyCashProspectiveV2Ledger(inputs, options.root)
  return {
    status: 'verified',
    records: state.records.length,
    artifacts: state.artifacts.size,
    enrolled: Boolean(state.enrollment),
    ticks: state.ticks.length,
    issues: state.issues.length,
    scores: state.scores.length,
    lastSha256: state.records.at(-1)?.sha256 ?? null,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !MODES.has(process.argv[2])) {
    process.stderr.write('cash_v2_exactly_one_mode\n')
    process.exitCode = 2
  } else {
    runCashProspectiveV2(process.argv[2])
      .then((value) => process.stdout.write(`${JSON.stringify(value)}\n`))
      .catch((error) => {
        process.stderr.write(`${String(error?.message ?? 'cash_v2_failed').split(/\s+/)[0]}\n`)
        process.exitCode = 1
      })
  }
}
