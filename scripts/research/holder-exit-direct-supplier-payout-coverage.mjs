// Offline historical payout inventory. A public other-holder receipt does not
// establish a prospective exit, an impairment duration, or a forecast.
import { lstatSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  DIRECT_SUPPLIER_FLOW_DIR,
  DIRECT_SUPPLIER_MARKETS,
  readDirectSupplierFlowDocuments,
  summarizeVerifiedDirectSupplierFlow,
} from '../lib/carry-direct-supplier-flow-summary.mjs'
import { verifyDirectSupplierFlowSegments } from './collect-carry-direct-supplier-flow.mjs'

const MARKETS = ['aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc', 'aaveV3Usde']
const ADDRESS = /^0x[0-9a-f]{40}$/i
const SHA = /^[0-9a-f]{64}$/
const positiveRaw = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
let canonicalManifestPromise
const canonicalManifest = () => {
  canonicalManifestPromise ??= import('../record-carry-cash-issues.mjs').then((module) =>
    module.buildSubjectManifest(),
  )
  return canonicalManifestPromise
}
const sameIdentity = (subject, route) =>
  subject?.route_key === route.routeKey &&
  lower(subject.destination) === lower(route.destination) &&
  lower(subject.asset) === lower(route.asset)

function frozenIdentity(marketKey, manifest) {
  const entry = DIRECT_SUPPLIER_MARKETS[marketKey]
  const matches = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (route) => route.kind === entry?.kind && route.routeKey === entry.routeKey,
  )
  if (matches.length !== 1) throw Error('direct_payout_frozen_route_mismatch')
  const route = matches[0]
  if (!ADDRESS.test(route.destination) || !ADDRESS.test(route.asset))
    throw Error('direct_payout_frozen_route_mismatch')
  const cohort = marketKey === 'aaveV3Usde' ? manifest.supplementalSubjects : manifest.subjects
  if (cohort.filter((subject) => sameIdentity(subject, route)).length !== 1)
    throw Error('direct_payout_manifest_identity_mismatch')
  if (
    marketKey === 'aaveV3Usde' &&
    manifest.subjects.some((subject) => sameIdentity(subject, route))
  )
    throw Error('direct_payout_supplemental_in_frozen_cohort')
  return {
    routeKey: route.routeKey,
    destination: lower(route.destination),
    originalAsset: lower(route.asset),
  }
}

async function assertManifest(manifest) {
  if (
    !Array.isArray(manifest?.subjects) ||
    manifest.subjects.length !== 67 ||
    new Set(manifest.subjects.map((subject) => subject.route_key)).size !== 25 ||
    !Array.isArray(manifest.supplementalSubjects)
  )
    throw Error('direct_payout_manifest_not_frozen_25_67')
  // Rebuild from the pinned source files, independently of caller-supplied
  // payload/hash/counts. One bounded 67-subject build is shared per process.
  const canonical = await canonicalManifest()
  if (
    !isDeepStrictEqual(manifest.subjects, canonical.subjects) ||
    !isDeepStrictEqual(manifest.supplementalSubjects, canonical.supplementalSubjects)
  )
    throw Error('direct_payout_manifest_not_canonical')
}

/** Inputs must be returned by the sealed segment verifier, not a summary API. */
export async function summarizeVerifiedDirectSupplierPayoutCoverage(
  marketKey,
  manifest,
  documents,
  verified,
) {
  await assertManifest(manifest)
  if (!MARKETS.includes(marketKey)) throw Error('unsupported_direct_payout_market')
  const identity = frozenIdentity(marketKey, manifest)
  if (!Array.isArray(documents) || !documents.length) throw Error('missing_direct_payout_segments')
  let nextBlock = documents[0].range?.fromBlock
  if (!Number.isSafeInteger(nextBlock) || nextBlock < 0)
    throw Error('direct_payout_segment_gap_or_identity_mismatch')
  const segmentSha256 = []
  for (const document of documents) {
    if (
      document.marketKey !== marketKey ||
      document.range?.fromBlock !== nextBlock ||
      !Number.isSafeInteger(document.range?.toBlock) ||
      document.range.toBlock < nextBlock ||
      !SHA.test(document.sha256 ?? '')
    )
      throw Error('direct_payout_segment_gap_or_identity_mismatch')
    segmentSha256.push(document.sha256)
    nextBlock = document.range.toBlock + 1
  }
  const coverage = verified?.coverage
  if (
    coverage?.marketKey !== marketKey ||
    !Number.isSafeInteger(coverage.startMs) ||
    !Number.isSafeInteger(coverage.endMs) ||
    coverage.endMs <= coverage.startMs ||
    !Array.isArray(coverage.intervals) ||
    coverage.intervals.length !== documents.length ||
    !Array.isArray(verified.withdrawals) ||
    !Array.isArray(verified.unclassifiedWithdrawals)
  )
    throw Error('direct_payout_coverage_invalid')
  let timeCursor = coverage.startMs
  for (const interval of coverage.intervals) {
    if (
      interval.startMs !== timeCursor ||
      !Number.isSafeInteger(interval.endMs) ||
      interval.endMs <= timeCursor ||
      interval.finalized !== true ||
      !Number.isSafeInteger(interval.ambiguousReceipts) ||
      interval.ambiguousReceipts < 0 ||
      interval.receiptsComplete !== (interval.ambiguousReceipts === 0)
    )
      throw Error('direct_payout_coverage_gap')
    timeCursor = interval.endMs
  }
  if (timeCursor !== coverage.endMs) throw Error('direct_payout_coverage_gap')
  let sameHolderPayoutCount = 0
  let otherReceiverPayoutCount = 0
  let sameHolderPayoutRaw = 0n
  for (const event of verified.withdrawals) {
    const reconciliation = event?.reconciliation
    const evidence = reconciliation?.evidence
    if (
      event.marketKey !== marketKey ||
      reconciliation.status !== 'reconciled_supplier_withdrawal' ||
      reconciliation.reason !== 'exact_receipt_payout' ||
      reconciliation.routeKey !== identity.routeKey ||
      lower(reconciliation.destination) !== identity.destination ||
      lower(reconciliation.underlying) !== identity.originalAsset ||
      !ADDRESS.test(evidence?.holder ?? '') ||
      !ADDRESS.test(evidence?.receiver ?? '') ||
      !positiveRaw(evidence?.amountRaw) ||
      !Number.isSafeInteger(event.timestampMs) ||
      event.timestampMs < coverage.startMs ||
      event.timestampMs >= coverage.endMs
    )
      throw Error('direct_payout_reconciliation_mismatch')
    if (lower(evidence.holder) === lower(evidence.receiver)) {
      sameHolderPayoutCount++
      sameHolderPayoutRaw += BigInt(evidence.amountRaw)
    } else otherReceiverPayoutCount++
  }
  if (
    verified.unclassifiedWithdrawals.some(
      (event) =>
        marketKey !== 'compoundV3Usdc' ||
        event.marketKey !== marketKey ||
        !positiveRaw(event.eventAmountRaw) ||
        !Number.isSafeInteger(event.timestampMs) ||
        event.timestampMs < coverage.startMs ||
        event.timestampMs >= coverage.endMs,
    ) ||
    coverage.intervals.reduce((sum, interval) => sum + interval.ambiguousReceipts, 0) !==
      verified.unclassifiedWithdrawals.length
  )
    throw Error('direct_payout_unclassified_mismatch')
  const historicalFlow = summarizeVerifiedDirectSupplierFlow(marketKey, verified)
  return {
    marketKey,
    ...identity,
    cohort: marketKey === 'aaveV3Usde' ? 'supplemental_outside_frozen_25_67' : 'frozen_25_67',
    evidenceClass: 'historical_other_holder_mined_payout',
    coverage: {
      fromBlock: documents[0].range.fromBlock,
      throughBlock: documents.at(-1).range.toBlock,
      startMs: coverage.startMs,
      endMs: coverage.endMs,
      durationMs: coverage.endMs - coverage.startMs,
      scope: 'selected_bounded_contiguous_suffix',
      segmentCount: documents.length,
      segmentSha256,
    },
    classifiedReceiptPayoutCount: verified.withdrawals.length,
    sameHolderPayoutCount,
    sameHolderPayoutRaw: sameHolderPayoutRaw.toString(),
    otherReceiverPayoutCount,
    unclassifiedWithdrawalCount: verified.unclassifiedWithdrawals.length,
    historicalMax24hGrossWithdrawal: historicalFlow.max24hGrossWithdrawal,
    ...(marketKey === 'compoundV3Usdc'
      ? {
          historicalMax24hGrossCometWithdrawEvents: historicalFlow.max24hGrossCometWithdrawEvents,
        }
      : {}),
    sameEpisodeProspective: false,
    calibratedDuration: false,
    forecastValidated: false,
  }
}

/** Reads only local sealed files. A missing market remains visibly unavailable. */
export async function readDirectSupplierPayoutCoverage(
  manifest,
  directory = DIRECT_SUPPLIER_FLOW_DIR,
  marketKeys = MARKETS,
) {
  await assertManifest(manifest)
  if (!Array.isArray(marketKeys) || marketKeys.some((key) => !MARKETS.includes(key)))
    throw Error('unsupported_direct_payout_market')
  let archiveMissing = false
  try {
    if (!lstatSync(directory).isDirectory()) throw Error('invalid_direct_payout_archive_directory')
  } catch (error) {
    if (error?.code === 'ENOENT') archiveMissing = true
    else throw error
  }
  const markets = []
  for (const marketKey of marketKeys) {
    const identity = frozenIdentity(marketKey, manifest)
    // Only a missing top-level archive is unavailable. A disappearing segment,
    // unreadable directory, malformed file, or verifier failure must propagate.
    const documents = archiveMissing ? [] : readDirectSupplierFlowDocuments(marketKey, directory)
    if (!documents.length) {
      markets.push({
        marketKey,
        ...identity,
        cohort: marketKey === 'aaveV3Usde' ? 'supplemental_outside_frozen_25_67' : 'frozen_25_67',
        status: 'unavailable',
        reason: 'no_sealed_segments',
        sameEpisodeProspective: false,
        calibratedDuration: false,
        forecastValidated: false,
      })
      continue
    }
    // Full replay binds hashes, paired logs, receipts, block links and market identity.
    const verified = verifyDirectSupplierFlowSegments(documents)
    markets.push({
      status: 'observed',
      ...(await summarizeVerifiedDirectSupplierPayoutCoverage(
        marketKey,
        manifest,
        documents,
        verified,
      )),
    })
  }
  return { scope: 'offline_frozen_25_67_direct_supplier_payout_inventory', markets }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requested = process.argv[2]
  if (requested && !MARKETS.includes(requested)) throw Error('unsupported_direct_payout_market')
  console.log(
    JSON.stringify(
      await readDirectSupplierPayoutCoverage(
        await canonicalManifest(),
        DIRECT_SUPPLIER_FLOW_DIR,
        requested ? [requested] : MARKETS,
      ),
      null,
      2,
    ),
  )
}
