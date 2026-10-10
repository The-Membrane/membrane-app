// Native local aggregate-cash model ledger; no Neon and no agent scheduler.
// node --import tsx scripts/record-carry-cash-local-model.mjs \
//   --register|--issue|--score|--verify|--evaluate
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSubjectManifest } from './record-carry-cash-issues.mjs'
import {
  buildLocalCashModelScorecard,
  evaluateLocalCarryCashModels,
  issueLocalCashModels,
  registerLocalCashModels,
  scoreLocalCashModels,
  verifyLocalCarryCashModelLedger,
} from './lib/localCarryCashModelStore.mjs'

const MODES = new Set(['--register', '--issue', '--score', '--verify', '--evaluate'])

export async function run(mode, manifest = null) {
  if (!MODES.has(mode)) throw new Error('local_cash_model_mode')
  const exactManifest = manifest ?? (await buildSubjectManifest())
  if (mode === '--register') return registerLocalCashModels(exactManifest)
  if (mode === '--issue') return issueLocalCashModels(exactManifest)
  if (mode === '--score') return scoreLocalCashModels(exactManifest)
  if (mode === '--evaluate') {
    const evaluation = evaluateLocalCarryCashModels(exactManifest)
    return {
      status: 'evaluated',
      evaluatedAt: evaluation.evaluationAt,
      recorderFresh: evaluation.recorderFresh,
      enrolledModels: evaluation.bySubject.length,
      validatedSubjects: evaluation.validatedSubjects,
      scheduledOpportunities: evaluation.bySubject.reduce(
        (total, row) => total + row.scheduleExpected,
        0,
      ),
      issuedPredictions: evaluation.bySubject.reduce((total, row) => total + row.scheduleIssued, 0),
      overdueScores: evaluation.bySubject.reduce((total, row) => total + row.pendingOverdue, 0),
      records: evaluation.records,
      artifacts: evaluation.artifacts,
      enrollments: evaluation.enrollments,
      ticks: evaluation.ticks,
      issues: evaluation.issues,
      scores: evaluation.scores,
    }
  }
  const ledger = verifyLocalCarryCashModelLedger(exactManifest)
  const scorecard = buildLocalCashModelScorecard(ledger.records, {
    asOf: new Date().toISOString(),
    baselineRecords: ledger.baseline.records,
  })
  return {
    status: 'verified',
    records: ledger.count,
    lastSha256: ledger.last?.sha256 ?? null,
    artifacts: ledger.artifacts.size,
    enrollments: ledger.enrollments.length,
    ticks: ledger.ticks.length,
    issues: ledger.issues.length,
    scores: ledger.scores.length,
    validatedSubjects: scorecard.validatedSubjects,
    recorderFresh: scorecard.recorderFresh,
    evaluatedAt: scorecard.evaluationAt,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write('local_cash_model_exactly_one_mode\n')
    process.exitCode = 2
  } else {
    run(process.argv[2])
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        const code = String(error?.message ?? 'local_cash_model_failed').split(/\s/)[0]
        process.stderr.write(`${code}\n`)
        process.exitCode = 1
      })
  }
}
