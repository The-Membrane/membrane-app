// As-of diagnostic for the frozen receipt cohort. Payouts learned after the
// first holdout request cannot train a forecast for that holdout.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyEscrow } from './apyusd-receipt-cohort-escrow.mjs'
import { verifyPayouts } from './apyusd-receipt-cohort-payouts.mjs'

const DAY = 86_400
const HORIZONS = [3, 7, 14, 21, 28]
const safe = (value) => Number.isSafeInteger(value) && value >= 0

export function scorePaymentHorizon(rows, asOf, days) {
  if (!safe(asOf) || !safe(days) || days === 0) throw Error('apyusd_timing_horizon_invalid')
  const horizon = days * DAY
  let paid = 0
  let notPaid = 0
  let censored = 0
  for (const row of rows) {
    if (!safe(row.issuedAt) || row.issuedAt > asOf) throw Error('apyusd_timing_issue_invalid')
    if (row.paidAt != null && (!safe(row.paidAt) || row.paidAt <= row.issuedAt))
      throw Error('apyusd_timing_payout_invalid')
    if (row.paidAt != null && row.paidAt <= asOf && row.paidAt - row.issuedAt <= horizon) paid++
    else if (asOf - row.issuedAt >= horizon) notPaid++
    else censored++
  }
  return { days, paid, notPaid, censored, evaluable: paid + notPaid }
}

export function diagnoseApyUsdTiming(escrow, payouts) {
  if (
    !Array.isArray(escrow?.proofs) ||
    !Array.isArray(payouts?.proofs) ||
    !Array.isArray(payouts.openIds) ||
    escrow.payoutsSha256 !== payouts.sha256 ||
    escrow.proofs.length !== 96 ||
    payouts.proofs.length + payouts.openIds.length !== escrow.proofs.length
  )
    throw Error('apyusd_timing_source_invalid')
  const byId = new Map(payouts.proofs.map((proof) => [proof.tokenId, proof]))
  const open = new Set(payouts.openIds)
  const receiptIds = new Set(escrow.proofs.map((proof) => proof.tokenId))
  if (
    byId.size !== payouts.proofs.length ||
    open.size !== payouts.openIds.length ||
    receiptIds.size !== escrow.proofs.length
  )
    throw Error('apyusd_timing_duplicate_invalid')
  const rows = escrow.proofs.map((receipt) => {
    const payout = byId.get(receipt.tokenId)
    if (
      !safe(receipt.issuedAt) ||
      !/^0x[0-9a-fA-F]{40}$/.test(receipt.holder ?? '') ||
      (payout == null) === !open.has(receipt.tokenId) ||
      (payout &&
        (payout.holder.toLowerCase() !== receipt.holder.toLowerCase() ||
          payout.request.timestamp !== receipt.issuedAt ||
          payout.payout.timestamp <= receipt.issuedAt))
    )
      throw Error('apyusd_timing_subject_invalid')
    return {
      tokenId: receipt.tokenId,
      holder: receipt.holder.toLowerCase(),
      issuedAt: receipt.issuedAt,
      paidAt: payout?.payout.timestamp ?? null,
    }
  })
  if (byId.size + open.size !== rows.length) throw Error('apyusd_timing_subject_invalid')
  rows.sort((left, right) =>
    left.issuedAt === right.issuedAt
      ? BigInt(left.tokenId) < BigInt(right.tokenId)
        ? -1
        : BigInt(left.tokenId) > BigInt(right.tokenId)
          ? 1
          : 0
      : left.issuedAt - right.issuedAt,
  )
  const midpoint = rows.length / 2
  const train = rows.slice(0, midpoint)
  const holdout = rows.slice(midpoint)
  const splitAt = holdout[0].issuedAt
  const trainingAsOf = splitAt - 1
  if (train.at(-1).issuedAt > trainingAsOf) throw Error('apyusd_timing_split_tie_invalid')
  const observedThrough = Math.max(...rows.map((row) => row.paidAt ?? 0))
  if (observedThrough < rows.at(-1).issuedAt) throw Error('apyusd_timing_cutoff_invalid')
  const trainHolders = new Set(train.map((row) => row.holder))
  const holdoutHolders = new Set(holdout.map((row) => row.holder))
  return {
    scope: 'retrospective_request_to_holder_payment_as_of_split',
    cohort: rows.length,
    splitAtUtc: new Date(splitAt * 1000).toISOString(),
    trainingAsOfUtc: new Date(trainingAsOf * 1000).toISOString(),
    observedThroughUtc: new Date(observedThrough * 1000).toISOString(),
    train: {
      requests: train.length,
      holders: trainHolders.size,
      knownPayoutsAtSplit: train.filter((row) => row.paidAt != null && row.paidAt <= trainingAsOf)
        .length,
      horizons: HORIZONS.map((days) => scorePaymentHorizon(train, trainingAsOf, days)),
    },
    holdout: {
      requests: holdout.length,
      holders: holdoutHolders.size,
      holdersAlsoInTrain: [...holdoutHolders].filter((holder) => trainHolders.has(holder)).length,
      horizons: HORIZONS.map((days) => scorePaymentHorizon(holdout, observedThrough, days)),
    },
    forecastValidated: false,
    claimabilityAssessed: false,
  }
}

export async function readVerifiedApyUsdTimingDiagnostic() {
  const [escrow, payouts] = await Promise.all([verifyEscrow(), verifyPayouts()])
  return diagnoseApyUsdTiming(escrow, payouts)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--summary')
      throw Error('usage: --summary')
    process.stdout.write(JSON.stringify(await readVerifiedApyUsdTimingDiagnostic()) + '\n')
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
