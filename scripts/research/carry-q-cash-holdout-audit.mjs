// Read-only historical Q-ratio audit over the sealed frozen 25/67 cash archive.
// The as-of clock is the last recorded current block, not wall time: this is
// retrospective research and never a live exit forecast.
// node --max-old-space-size=384 --import tsx scripts/research/carry-q-cash-holdout-audit.mjs
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import historicalContextModule from '../../lib/carry/historicalCashContext.ts'
import localScenarioModule from '../../lib/carry/localHistoricalCashScenario.ts'
import { readLocalCarryCashObservations } from '../lib/localCarryCashStore.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'

const { historicalCarryCashContext } = historicalContextModule
const { localHistoricalCashQHoldout } = localScenarioModule

export async function auditQCashHoldout() {
  const manifest = await buildSubjectManifest()
  const observations = readLocalCarryCashObservations(manifest)
  const current = observations
    .filter((entry) => entry.collectionMode === 'current')
    .sort((a, b) => b.source.blockAt.localeCompare(a.source.blockAt))[0]
  if (!current) throw new Error('cash_holdout_current_receipt_missing')

  const fractions = [10, 50, 90]
  const byFraction = fractions.map((percent) => {
    const reasons = {}
    let tested = 0
    let qualified = 0
    const qualifiedSubjects = []
    for (const subject of manifest.subjects) {
      const context = historicalCarryCashContext(
        observations,
        subject,
        Date.parse(current.source.blockAt),
      )
      if (context.status !== 'historical_context') {
        const reason = `context_${context.reason}`
        reasons[reason] = (reasons[reason] ?? 0) + 1
        continue
      }
      if (!context.current) {
        reasons.no_current_cash_receipt = (reasons.no_current_cash_receipt ?? 0) + 1
        continue
      }
      const q = (BigInt(context.current.cashRaw) * BigInt(percent)) / 100n
      if (q === 0n) {
        reasons.zero_or_subunit_current_cash = (reasons.zero_or_subunit_current_cash ?? 0) + 1
        continue
      }
      tested++
      const result = localHistoricalCashQHoldout(
        observations,
        subject,
        q.toString(),
        Date.parse(current.source.blockAt),
      )
      if (result.status === 'historical_backtest') {
        qualified++
        qualifiedSubjects.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          requestedFraction: result.backtest.evidence.requestedFraction,
          fitBreaches: result.backtest.evidence.fitBreaches,
          calibrationBreaches: result.backtest.evidence.calibrationBreaches,
          holdoutBreaches: result.backtest.evidence.holdoutBreaches,
          holdoutBrier: result.backtest.evidence.holdoutBrier,
          holdoutPersistenceBrier: result.backtest.evidence.holdoutPersistenceBrier,
        })
      } else {
        reasons[result.reason] = (reasons[result.reason] ?? 0) + 1
      }
    }
    return {
      percentOfCurrentCash: percent,
      tested,
      qualified,
      qualifiedSubjects,
      reasons,
    }
  })
  return {
    study: 'frozen25-aggregate-cash-q-ratio-h24-historical-holdout-v1',
    historicalBacktestOnly: true,
    prospectiveValidated: false,
    holderExecutableExit: false,
    subjectCount: manifest.subjects.length,
    routeGroupCount: new Set(manifest.subjects.map((row) => row.route_key)).size,
    manifestSha256: manifest.sha256,
    verifiedReceiptCount: observations.length,
    archiveTipReceiptSha256: observations.at(-1)?.receiptSha256 ?? null,
    currentBlock: current.source.block,
    currentBlockHash: current.source.blockHash,
    asOfBlockAt: current.source.blockAt,
    byFraction,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditQCashHoldout()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${String(error?.message ?? 'cash_holdout_audit_failed').split(' ')[0]}\n`,
      )
      process.exitCode = 1
    })
}
