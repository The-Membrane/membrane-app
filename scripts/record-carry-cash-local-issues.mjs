// Native local prospective cash baseline; no Neon or agent scheduler.
// node --import tsx scripts/record-carry-cash-local-issues.mjs --issue|--score|--verify
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import { LOCAL_CARRY_CASH_ROOT } from './lib/localCarryCashStore.mjs'
import {
  issueLocalCash,
  scoreLocalCash,
  verifyLocalCashIssueLedger,
} from './lib/localCarryCashIssueStore.mjs'

export async function run(mode, manifest, cashRoot = LOCAL_CARRY_CASH_ROOT) {
  if (mode === '--issue') return issueLocalCash(manifest, cashRoot)
  if (mode === '--score') return scoreLocalCash(manifest, cashRoot)
  if (mode === '--verify') {
    const ledger = verifyLocalCashIssueLedger(manifest, cashRoot)
    const scores = ledger.records.filter((row) => row.kind === 'score')
    return {
      count: ledger.count,
      lastSha256: ledger.last?.sha256 ?? null,
      issues: ledger.records.filter((row) => row.kind === 'issue').length,
      scores: scores.length,
      scoreRecords: scores.length,
      h1Scores: scores.filter((row) => row.horizonHours === 1 || row.horizonHours === undefined)
        .length,
      h24Scores: scores.filter((row) => row.horizonHours === 24 || row.horizonHours === undefined)
        .length,
    }
  }
  throw new Error('local_cash_issue_mode')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (process.argv.length !== 3) throw new Error('local_cash_issue_exactly_one_mode')
  const manifest = await buildSubjectManifest()
  try {
    process.stdout.write(`${JSON.stringify(await run(mode, manifest))}\n`)
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? 'local_cash_issue_failed').split(' ')[0]}\n`)
    process.exitCode = 1
  }
}
