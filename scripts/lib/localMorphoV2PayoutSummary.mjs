// Historical external-receiver payout evidence for one frozen VaultV2 route.
// A reconciled receipt is not a same-holder exit assay or a future forecast.
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  candidateTransactions,
  LOCAL_MORPHO_PAYOUT_ROOT,
  readLocalPayoutRecord,
} from '../reconcile-carry-morpho-v2-withdrawals-local.mjs'
import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'
import {
  LOCAL_MORPHO_ROOT,
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from './localMorphoV2FlowStore.mjs'

const PROOF_FILE = /^0x[0-9a-f]{64}\.json$/
const IN_PROGRESS_PROOF =
  /^(0x[0-9a-f]{64}\.json)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

/** A selected vault cannot hide an unknown or altered proof behind its counts. */
export function verifySelectedMorphoProofFiles(subject, candidates, root) {
  const directory = join(root, subject.vault)
  if (!existsSync(directory)) return
  if (!lstatSync(directory).isDirectory()) throw new Error('morpho_payout_unsafe_directory')
  const expected = new Set(candidates.map((candidate) => `${candidate.transactionHash}.json`))
  const files = readdirSync(directory)
  if (files.length > 100_000) throw new Error('morpho_payout_file_budget_exceeded')
  for (const file of files) {
    const inProgress = IN_PROGRESS_PROOF.exec(file)
    if (inProgress && expected.has(inProgress[1])) continue
    if (!PROOF_FILE.test(file) || !expected.has(file)) throw new Error('morpho_payout_orphan_proof')
  }
}

/** Keep transactions and Withdraw proof rows in separate denominators. */
export function summarizeVerifiedMorphoPayoutRoute(subject, routeKey, ranges, candidates, records) {
  if (!subject?.routeKeys?.includes(routeKey) || !/^0x[0-9a-f]{40}$/.test(subject.vault))
    throw new Error('morpho_payout_route_identity_invalid')
  if (candidates.length !== records.length) throw new Error('morpho_payout_record_count_invalid')
  let sealedTransactions = 0
  let receiptReconciledTransactions = 0
  let ambiguousTransactions = 0
  let externalPayoutProofRows = 0
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const record = records[index]
    if (candidate.vault !== subject.vault || candidate.asset !== subject.asset)
      throw new Error('morpho_payout_candidate_identity_invalid')
    if (!record) continue
    sealedTransactions++
    if (record.outcome.status === 'ambiguous') {
      ambiguousTransactions++
      continue
    }
    if (record.outcome.status !== 'receipt_reconciled')
      throw new Error('morpho_payout_outcome_invalid')
    const rows = record.outcome.proofs.filter(
      (proof) => proof.status === 'reconciled_external_supplier',
    )
    if (!rows.length) throw new Error('morpho_payout_empty_reconciliation')
    receiptReconciledTransactions++
    externalPayoutProofRows += rows.length
  }
  return {
    status: 'observed',
    routeKey,
    destination: subject.vault,
    underlying: subject.asset,
    sourceRangeCount: ranges.length,
    latestCoveredBlock: ranges.at(-1)?.toBlock ?? null,
    latestCoveredAt: ranges.at(-1)?.toObservedAt ?? null,
    sourceCompleteness: 'not_independently_proven',
    candidateTransactions: candidates.length,
    sealedTransactions,
    receiptReconciledTransactions,
    externalPayoutProofRows,
    ambiguousTransactions,
    pendingTransactions: candidates.length - sealedTransactions,
    payoutMeaning: 'historical_external_receiver_transfer',
    sameHolderExit: 'not_established',
    calibratedForecast: false,
  }
}

export async function readLocalMorphoV2PayoutSummary(routeKey, destination, options = {}) {
  const subjects = await loadMorphoFlowSubjects()
  const subject = subjects.find(
    (item) => item.vault === destination && item.routeKeys.includes(routeKey),
  )
  if (!subject) throw new Error('morpho_payout_route_not_tracked')
  const flowRoot = options.flowRoot ?? LOCAL_MORPHO_ROOT
  const payoutRoot = options.payoutRoot ?? LOCAL_MORPHO_PAYOUT_ROOT
  const enrollment = verifyLocalMorphoEnrollment(subjects, flowRoot)
  if (!enrollment) throw new Error('morpho_payout_enrollment_missing')
  const ranges = verifyLocalMorphoVault(subject, enrollment, flowRoot)
  const candidates = candidateTransactions(subject, ranges)
  verifySelectedMorphoProofFiles(subject, candidates, payoutRoot)
  const records = candidates.map((candidate) => readLocalPayoutRecord(candidate, payoutRoot))
  return summarizeVerifiedMorphoPayoutRoute(subject, routeKey, ranges, candidates, records)
}
