// Offline read-only reconciliation of frozen holder-exit evidence. This is a gate, not a forecast.
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { DIRECT_SUPPLIER_MARKETS } from '../lib/carry-direct-supplier-flow-summary.mjs'

import {
  historicalProcessingWithin24h,
  validateProcessingWithin24h,
} from './holder-exit-processing-bounds.mjs'
import { diagnoseSaturnQueueProcessing } from './saturn-queue-processing-backtest.mjs'
import { readSavedCell, validatePlan } from './carry-morpho-stable-exit-history.mjs'
import { readVerifiedProspectiveImpairment } from './apyusd-prospective-impairment-followup.mjs'

const identity = (routeKey, destination, asset) =>
  `${routeKey}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`
const routeDestination = (routeKey, destination) => `${routeKey}\0${destination.toLowerCase()}`
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0
const nonnegativeRaw = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0)
const DAY_SECONDS = 86_400
const SUPPLIER_MARKETS = ['aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc']
const SUPPLEMENTAL_SUPPLIER_MARKET = 'aaveV3Usde'

function directSupplierIdentity(marketKey) {
  const market = DIRECT_SUPPLIER_MARKETS[marketKey]
  const routes = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (route) => route.kind === market?.kind && route.routeKey === market.routeKey,
  )
  if (routes.length !== 1) throw Error('forceability_supplier_frozen_route_invalid')
  return routes[0]
}

function validHistoricalMaximum(value, coverage, countKey, allowUnclassified) {
  if (value?.status === 'unavailable')
    return [
      'coverage_under_24h',
      ...(allowUnclassified ? ['unclassified_withdrawals'] : []),
    ].includes(value.reason)
  return (
    value?.status === 'observed' &&
    nonnegativeRaw(value.amountRaw) &&
    nonnegative(value[countKey]) &&
    nonnegative(value.startMs) &&
    nonnegative(value.endMs) &&
    value.startMs >= coverage.startMs &&
    value.endMs <= coverage.endMs &&
    value.endMs - value.startMs === DAY_SECONDS * 1000
  )
}

/** Revalidates the compact evidence object before another boundary may promote it. */
export function validateHistoricalSupplierPayoutEvidence(
  value,
  { allowUnclassified = false, allowCometGross = false } = {},
) {
  if (value?.status === 'unavailable')
    return value.reason === 'no_sealed_segments' && value.coverage == null
  const coverage = value?.coverage
  if (
    value?.status !== 'observed' ||
    value.evidenceClass !== 'historical_other_holder_mined_payout' ||
    !nonnegative(coverage?.fromBlock) ||
    !nonnegative(coverage?.throughBlock) ||
    coverage.throughBlock < coverage.fromBlock ||
    !nonnegative(coverage?.startMs) ||
    !nonnegative(coverage?.endMs) ||
    coverage.endMs <= coverage.startMs ||
    coverage.durationMs !== coverage.endMs - coverage.startMs ||
    coverage.scope !== 'selected_bounded_contiguous_suffix' ||
    !Number.isSafeInteger(coverage.segmentCount) ||
    coverage.segmentCount < 1 ||
    !Array.isArray(coverage.segmentSha256) ||
    coverage.segmentSha256.length !== coverage.segmentCount ||
    coverage.segmentSha256.some((sha) => !/^[0-9a-f]{64}$/.test(sha)) ||
    !nonnegative(value.classifiedReceiptPayoutCount) ||
    !nonnegative(value.sameHolderPayoutCount) ||
    !nonnegative(value.otherReceiverPayoutCount) ||
    value.sameHolderPayoutCount + value.otherReceiverPayoutCount !==
      value.classifiedReceiptPayoutCount ||
    !nonnegativeRaw(value.sameHolderPayoutRaw) ||
    !nonnegative(value.unclassifiedWithdrawalCount) ||
    (!allowUnclassified && value.unclassifiedWithdrawalCount !== 0) ||
    !validHistoricalMaximum(
      value.historicalMax24hGrossWithdrawal,
      coverage,
      'payoutCount',
      allowUnclassified,
    ) ||
    value.sameEpisodeProspective !== false ||
    value.calibratedDuration !== false ||
    value.holderExecutableExit !== false ||
    value.forecastValidated !== false
  )
    return false
  return (
    !allowCometGross ||
    validHistoricalMaximum(
      value.historicalMax24hGrossCometWithdrawEvents,
      coverage,
      'eventCount',
      false,
    )
  )
}

function validatedSupplierPayouts(source, subjects) {
  if (source === null) return new Map()
  if (
    source?.scope !== 'offline_frozen_25_67_direct_supplier_payout_inventory' ||
    !Array.isArray(source.markets) ||
    source.markets.length !== 4
  )
    throw Error('forceability_supplier_payout_source_invalid')
  const bySubject = new Map()
  const seen = new Set()
  for (const market of source.markets) {
    const marketKey = market?.marketKey
    if (
      ![...SUPPLIER_MARKETS, SUPPLEMENTAL_SUPPLIER_MARKET].includes(marketKey) ||
      seen.has(marketKey)
    )
      throw Error('forceability_supplier_payout_market_invalid')
    seen.add(marketKey)
    const expected = directSupplierIdentity(marketKey)
    const key = identity(expected.routeKey, expected.destination, expected.asset)
    const supplemental = marketKey === SUPPLEMENTAL_SUPPLIER_MARKET
    if (
      market.routeKey !== expected.routeKey ||
      market.destination?.toLowerCase() !== expected.destination.toLowerCase() ||
      market.originalAsset?.toLowerCase() !== expected.asset.toLowerCase() ||
      market.cohort !== (supplemental ? 'supplemental_outside_frozen_25_67' : 'frozen_25_67') ||
      subjects.has(key) === supplemental ||
      market.sameEpisodeProspective !== false ||
      market.calibratedDuration !== false ||
      market.forecastValidated !== false
    )
      throw Error('forceability_supplier_payout_identity_invalid')
    if (market.status === 'unavailable') {
      if (market.reason !== 'no_sealed_segments' || market.coverage != null)
        throw Error('forceability_supplier_payout_unavailable_invalid')
      bySubject.set(key, { status: 'unavailable', reason: 'no_sealed_segments' })
      continue
    }
    const coverage = market.coverage
    if (
      market.status !== 'observed' ||
      market.evidenceClass !== 'historical_other_holder_mined_payout' ||
      !nonnegative(coverage?.fromBlock) ||
      !nonnegative(coverage?.throughBlock) ||
      coverage.throughBlock < coverage.fromBlock ||
      !nonnegative(coverage?.startMs) ||
      !nonnegative(coverage?.endMs) ||
      coverage.endMs <= coverage.startMs ||
      coverage.durationMs !== coverage.endMs - coverage.startMs ||
      coverage.scope !== 'selected_bounded_contiguous_suffix' ||
      !Number.isSafeInteger(coverage.segmentCount) ||
      coverage.segmentCount < 1 ||
      !Array.isArray(coverage.segmentSha256) ||
      coverage.segmentSha256.length !== coverage.segmentCount ||
      coverage.segmentSha256.some((sha) => !/^[0-9a-f]{64}$/.test(sha)) ||
      !nonnegative(market.classifiedReceiptPayoutCount) ||
      !nonnegative(market.sameHolderPayoutCount) ||
      !nonnegative(market.otherReceiverPayoutCount) ||
      market.sameHolderPayoutCount + market.otherReceiverPayoutCount !==
        market.classifiedReceiptPayoutCount ||
      !nonnegativeRaw(market.sameHolderPayoutRaw) ||
      !nonnegative(market.unclassifiedWithdrawalCount) ||
      (marketKey !== 'compoundV3Usdc' && market.unclassifiedWithdrawalCount !== 0) ||
      !validHistoricalMaximum(
        market.historicalMax24hGrossWithdrawal,
        coverage,
        'payoutCount',
        marketKey === 'compoundV3Usdc',
      ) ||
      (marketKey === 'compoundV3Usdc' &&
        market.unclassifiedWithdrawalCount > 0 &&
        (market.historicalMax24hGrossWithdrawal.status !== 'unavailable' ||
          market.historicalMax24hGrossWithdrawal.reason !== 'unclassified_withdrawals'))
    )
      throw Error('forceability_supplier_payout_observed_invalid')
    if (
      marketKey === 'compoundV3Usdc' &&
      !validHistoricalMaximum(
        market.historicalMax24hGrossCometWithdrawEvents,
        coverage,
        'eventCount',
        false,
      )
    )
      throw Error('forceability_supplier_comet_max_invalid')
    const normalized = {
      status: 'observed',
      evidenceClass: 'historical_other_holder_mined_payout',
      coverage: { ...coverage, segmentSha256: [...coverage.segmentSha256] },
      classifiedReceiptPayoutCount: market.classifiedReceiptPayoutCount,
      sameHolderPayoutCount: market.sameHolderPayoutCount,
      sameHolderPayoutRaw: market.sameHolderPayoutRaw,
      otherReceiverPayoutCount: market.otherReceiverPayoutCount,
      unclassifiedWithdrawalCount: market.unclassifiedWithdrawalCount,
      historicalMax24hGrossWithdrawal: { ...market.historicalMax24hGrossWithdrawal },
      ...(marketKey === 'compoundV3Usdc'
        ? {
            historicalMax24hGrossCometWithdrawEvents: {
              ...market.historicalMax24hGrossCometWithdrawEvents,
            },
          }
        : {}),
      sameEpisodeProspective: false,
      calibratedDuration: false,
      holderExecutableExit: false,
      forecastValidated: false,
    }
    if (
      !validateHistoricalSupplierPayoutEvidence(normalized, {
        allowUnclassified: marketKey === 'compoundV3Usdc',
        allowCometGross: marketKey === 'compoundV3Usdc',
      })
    )
      throw Error('forceability_supplier_payout_normalization_invalid')
    bySubject.set(key, normalized)
  }
  if (seen.size !== 4) throw Error('forceability_supplier_payout_market_missing')
  return bySubject
}

/** Retrospective mined payments; open receipts are right-censored at the last verified payment. */
export function summarizeHistoricalReceiptTiming(escrow, payouts) {
  const proofs = payouts?.proofs
  const receipts = escrow?.proofs
  if (
    !Array.isArray(proofs) ||
    !Array.isArray(receipts) ||
    !proofs.length ||
    escrow.payoutsSha256 !== payouts.sha256 ||
    escrow.cohortSize !== receipts.length ||
    payouts.cohortSize !== receipts.length ||
    payouts.paidCount !== proofs.length ||
    !Array.isArray(payouts.openIds) ||
    proofs.length + payouts.openIds.length !== receipts.length
  )
    throw Error('forceability_historical_receipt_timing_invalid')
  const receiptById = new Map(receipts.map((receipt) => [receipt.tokenId, receipt]))
  const paidIds = new Set()
  const durations = []
  let censorTimestamp = 0
  for (const proof of proofs) {
    const receipt = receiptById.get(proof.tokenId)
    const seconds = proof.requestToPayoutSeconds
    if (
      !receipt ||
      paidIds.has(proof.tokenId) ||
      !nonnegative(seconds) ||
      seconds !== proof.payout?.timestamp - proof.request?.timestamp ||
      receipt.issuedAt !== proof.request.timestamp
    )
      throw Error('forceability_historical_receipt_timing_invalid')
    paidIds.add(proof.tokenId)
    durations.push(seconds)
    censorTimestamp = Math.max(censorTimestamp, proof.payout.timestamp)
  }
  const openIds = new Set(payouts.openIds)
  if (openIds.size !== payouts.openIds.length || receiptById.size !== receipts.length)
    throw Error('forceability_historical_receipt_timing_invalid')
  const censoredDurations = []
  for (const receipt of receipts) {
    if (paidIds.has(receipt.tokenId)) continue
    if (!openIds.has(receipt.tokenId) || !nonnegative(receipt.issuedAt))
      throw Error('forceability_historical_receipt_timing_invalid')
    const duration = censorTimestamp - receipt.issuedAt
    if (!nonnegative(duration)) throw Error('forceability_historical_receipt_timing_invalid')
    censoredDurations.push(duration)
  }
  durations.sort((a, b) => a - b)
  censoredDurations.sort((a, b) => a - b)
  // Kaplan-Meier: events at a tied time precede censoring at that time.
  let atRisk = receipts.length
  let survivalNumerator = 1n
  let survivalDenominator = 1n
  let medianRequestToMinedPayoutSeconds = null
  let eventIndex = 0
  let censorIndex = 0
  while (eventIndex < durations.length) {
    const time = durations[eventIndex]
    while (censorIndex < censoredDurations.length && censoredDurations[censorIndex] < time) {
      atRisk--
      censorIndex++
    }
    let events = 0
    while (durations[eventIndex] === time) {
      events++
      eventIndex++
    }
    survivalNumerator *= BigInt(atRisk - events)
    survivalDenominator *= BigInt(atRisk)
    atRisk -= events
    if (medianRequestToMinedPayoutSeconds === null && 2n * survivalNumerator <= survivalDenominator)
      medianRequestToMinedPayoutSeconds = time
    while (censoredDurations[censorIndex] === time) {
      atRisk--
      censorIndex++
    }
  }
  return {
    scope: 'historical_holder_action_influenced_request_to_mined_payment',
    denominator: receipts.length,
    paidWithin7Days: durations.filter((seconds) => seconds <= 7 * DAY_SECONDS).length,
    paidWithin21Days: durations.filter((seconds) => seconds <= 21 * DAY_SECONDS).length,
    paidWithin28Days: durations.filter((seconds) => seconds <= 28 * DAY_SECONDS).length,
    medianRequestToMinedPayoutSeconds,
    openRightCensored: censoredDurations.length,
    censorTimestamp,
  }
}

function validProcessingDiagnostic(value, cohort) {
  const episodes = cohort.processingEvidenceEpisodes
  if (!Array.isArray(episodes) || episodes.length !== cohort.requests) return false
  const pending = episodes.find((episode) => episode.waitCensored)
  if (!pending) return false
  const cutoff = pending.requestTimestamp + pending.waitSeconds
  try {
    const recomputed = diagnoseSaturnQueueProcessing(episodes, cutoff)
    const aggregate = historicalProcessingWithin24h({
      episodes,
      summary: {
        counts: {
          requested: cohort.requests,
          processed: cohort.processed,
          pendingCensored: cohort.pendingCensored,
        },
      },
    })
    return (
      isDeepStrictEqual(value, {
        sourceEpisodeSha256: cohort.episodeEvidenceSha256,
        ...recomputed,
      }) && isDeepStrictEqual(cohort.processingWithin24h, aggregate)
    )
  } catch {
    return false
  }
}
const STABLE_HISTORY_DIRECTORY = resolve(
  process.cwd(),
  'lib/carry/research/morpho-stable-exit-history-v1',
)

const coveredRevert = (probe) =>
  probe?.class === 'evm_revert' &&
  probe.call?.status === 'evm_revert' &&
  probe.state?.status === 'measured' &&
  probe.state.eoa === true &&
  /^[1-9]\d*$/.test(probe.state.sharesRaw ?? '') &&
  /^[1-9]\d*$/.test(probe.state.previewSharesRaw ?? '') &&
  BigInt(probe.state.sharesRaw) >= BigInt(probe.state.previewSharesRaw)

/** SHA-checked saved bytes only; no independent historical RPC replay. */
export function readSavedMorphoStableReverts(directory = STABLE_HISTORY_DIRECTORY) {
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const plans = names.filter((name) => /^plan-[0-9a-f]{64}\.json$/.test(name))
  if (plans.length !== 1) throw Error('forceability_stable_history_plan_invalid')
  const planBytes = readFileSync(join(directory, plans[0]))
  const plan = JSON.parse(planBytes.toString('utf8'))
  validatePlan(plan)
  if (
    plans[0] !== `plan-${plan.planSha256}.json` ||
    planBytes.toString('utf8') !== `${JSON.stringify(plan, null, 2)}\n`
  )
    throw Error('forceability_stable_history_plan_provenance_invalid')
  const prefix = `cell-${plan.planSha256}-`
  const cellNames = names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
  const planned = new Set(plan.cells.map((cell) => `${cell.anchorBlock}:${cell.vault}`))
  const seen = new Set()
  const result = []
  for (const name of cellNames) {
    const match = name.match(/^cell-[0-9a-f]{64}-(\d+)-(0x[0-9a-f]{40})-[0-9a-f]{64}\.json$/)
    if (!match || !planned.has(`${Number(match[1])}:${match[2]}`))
      throw Error('forceability_stable_history_cell_provenance_invalid')
    const key = `${Number(match[1])}:${match[2]}`
    if (seen.has(key)) throw Error('forceability_stable_history_cell_duplicate')
    seen.add(key)
    const saved = readSavedCell(plan, Number(match[1]), match[2], directory)
    if (!saved || saved.sourceRevalidated !== false)
      throw Error('forceability_stable_history_cell_provenance_invalid')
    const cell = saved.cell
    const frozen = plan.cells.find(
      (item) => item.anchorBlock === cell.anchorBlock && item.vault === cell.vault,
    )
    if (
      cell.status !== 'measured' ||
      frozen?.routeKey !== cell.routeKey ||
      frozen.asset !== cell.row.asset
    )
      continue
    const size = cell.row.sizes.find((item) => item.label === 'fixed_10k')
    if (
      !size?.eligible ||
      size.assetsRaw !== '10000000000' ||
      BigInt(cell.row.anchorClaimRaw) <= BigInt(size.assetsRaw) ||
      !coveredRevert(size.baseline)
    )
      continue
    const anchorTimestamp = plan.schedule.anchors.find(
      (entry) => entry.anchor.number === cell.anchorBlock,
    )?.anchor.timestamp
    if (!Number.isSafeInteger(anchorTimestamp) || anchorTimestamp <= 0)
      throw Error('forceability_stable_history_anchor_provenance_invalid')
    const anchorAtUtc = new Date(anchorTimestamp * 1000).toISOString()
    const sampledHours = [0]
    for (const horizon of size.horizons) {
      if (
        horizon.identity?.status === 'confirmed' &&
        horizon.identity.shareDecimals === 18 &&
        horizon.identity.assetDecimals === 6 &&
        coveredRevert(horizon)
      )
        sampledHours.push(horizon.hours)
    }
    result.push({
      routeKey: cell.routeKey,
      destination: cell.vault,
      asset: cell.row.asset,
      anchorBlock: cell.anchorBlock,
      anchorAtUtc,
      qLabel: 'fixed_10k',
      sampledHours,
      planSha256: plan.planSha256,
      cellSha256: cell.cellSha256,
      provenance: 'saved_cell_disk_integrity_only',
    })
  }
  return result
}

export function abstainUntrackedSubject(subject) {
  if (!subject?.route_key || !subject?.destination || !subject?.asset)
    throw Error('forceability_subject_identity_invalid')
  return {
    routeKey: subject.route_key,
    destination: subject.destination,
    originalAsset: subject.asset,
    scope: 'outside_frozen_25_67',
    mechanism: 'unassessed',
    directIssueBaseline: false,
    stageIssue: false,
    terminalSameEpisodeFinalAssetPaidProof: false,
    calibratedImpairmentDuration: false,
    prospectiveCalibration: false,
    holderExecutableExit: false,
    forecastValidated: false,
    reasons: ['outside_frozen_cohort', 'requires_verified_route_mechanism_and_evidence'],
  }
}

/** All inputs are outputs of verified readers plus the pinned mechanism catalog. */
export function buildHolderExitForceabilityMatrix({
  manifest,
  support,
  stages,
  mechanismCatalog,
  directPayouts = [],
  historicalSupplierPayoutCoverage = null,
  sampledConditions = [],
  historicalStagedCohorts = [],
  currentOpenReceiptCohorts = [],
  historicalIntermediateQueues = [],
  historicalPublicConversionQuotes = [],
  currentPendingTicketCohorts = [],
  historicalStableReverts = [],
  prospectiveReceiptImpairment = null,
}) {
  const roster = manifest?.subjects
  if (!Array.isArray(roster) || roster.length !== 67 || !mechanismCatalog)
    throw Error('forceability_manifest_invalid')
  if (
    mechanismCatalog.subjects !== 67 ||
    mechanismCatalog.routes?.length !== 25 ||
    mechanismCatalog.subjectSpecs?.length !== 67 ||
    support?.denominator?.routeGroups !== 25 ||
    support?.denominator?.exactSubjects !== 67 ||
    !Array.isArray(support.cells) ||
    !Array.isArray(support.groups) ||
    !Array.isArray(stages?.subjects) ||
    stages.frozenGroups !== 25 ||
    stages.frozenSubjects !== 67
  )
    throw Error('forceability_audit_shape_invalid')

  const subjects = new Map()
  const pairs = new Map()
  for (const row of roster) {
    const key = identity(row.route_key, row.destination, row.asset)
    if (subjects.has(key)) throw Error('forceability_manifest_duplicate')
    subjects.set(key, row)
    pairs.set(routeDestination(row.route_key, row.destination), key)
  }
  if (new Set(roster.map((row) => row.route_key)).size !== 25)
    throw Error('forceability_manifest_not_frozen_25_67')
  const supplierPayoutByKey = validatedSupplierPayouts(historicalSupplierPayoutCoverage, subjects)
  const impairment = prospectiveReceiptImpairment
  const impairmentSummary = impairment?.summary ?? null
  if (
    impairment &&
    (impairment.scope !== 'apyusd_receipt_claim_stage_only' ||
      typeof impairment.routeKey !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(impairment.destination ?? '') ||
      !/^0x[0-9a-f]{40}$/.test(impairment.asset ?? '') ||
      impairment.prospectiveValidated !== false ||
      impairment.fullRouteExitAssessed !== false ||
      !Array.isArray(impairment.episodes) ||
      ![
        impairmentSummary?.failedFirstEligibleEpisodes,
        impairmentSummary?.recoveredIntervals,
        impairmentSummary?.rightCensoredEpisodes,
        impairmentSummary?.stillImpairedEpisodes,
        impairmentSummary?.awaitingFollowupEpisodes,
      ].every(nonnegative) ||
      impairment.episodes.length !== impairmentSummary.failedFirstEligibleEpisodes ||
      impairmentSummary.recoveredIntervals +
        impairmentSummary.rightCensoredEpisodes +
        impairmentSummary.stillImpairedEpisodes +
        impairmentSummary.awaitingFollowupEpisodes !==
        impairmentSummary.failedFirstEligibleEpisodes ||
      (impairmentSummary.failedFirstEligibleEpisodes > 0 &&
        !/^[0-9a-f]{64}$/.test(impairment.intakeAnchorSha256 ?? '')))
  )
    throw Error('forceability_receipt_impairment_invalid')
  const impairmentKey = impairment
    ? identity(impairment.routeKey, impairment.destination, impairment.asset)
    : null
  if (!Array.isArray(historicalStableReverts)) throw Error('forceability_stable_history_invalid')
  const stableRevertsByKey = new Map()
  const stableEpisodeKeys = new Set()
  for (const episode of historicalStableReverts) {
    const key = identity(episode.routeKey, episode.destination, episode.asset)
    const episodeKey = `${key}\0${episode.anchorBlock}\0${episode.qLabel}`
    if (
      !subjects.has(key) ||
      !nonnegative(episode.anchorBlock) ||
      typeof episode.anchorAtUtc !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(episode.anchorAtUtc) ||
      !Number.isFinite(Date.parse(episode.anchorAtUtc)) ||
      episode.qLabel !== 'fixed_10k' ||
      !Array.isArray(episode.sampledHours) ||
      episode.sampledHours[0] !== 0 ||
      episode.sampledHours.some(
        (hour, index) =>
          index > 0 &&
          (hour <= episode.sampledHours[index - 1] || ![1, 4, 24, 48, 168].includes(hour)),
      ) ||
      !/^[0-9a-f]{64}$/.test(episode.planSha256) ||
      !/^[0-9a-f]{64}$/.test(episode.cellSha256) ||
      episode.provenance !== 'saved_cell_disk_integrity_only' ||
      stableEpisodeKeys.has(episodeKey)
    )
      throw Error('forceability_stable_history_invalid')
    stableEpisodeKeys.add(episodeKey)
    const values = stableRevertsByKey.get(key) ?? []
    values.push(episode)
    stableRevertsByKey.set(key, values)
  }

  const mechanismByRoute = new Map()
  for (const route of mechanismCatalog.routes) {
    if (mechanismByRoute.has(route.routeKey) || !['atomic', 'staged'].includes(route.mechanism))
      throw Error('forceability_mechanism_invalid')
    mechanismByRoute.set(route.routeKey, route.mechanism)
  }
  const mechanismKeys = new Set()
  for (const spec of mechanismCatalog.subjectSpecs) {
    const key = pairs.get(routeDestination(spec.routeKey, spec.destinationAddress))
    if (!key || mechanismKeys.has(key) || !mechanismByRoute.has(spec.routeKey))
      throw Error('forceability_mechanism_identity_mismatch')
    mechanismKeys.add(key)
  }
  if (
    mechanismKeys.size !== 67 ||
    [...subjects.values()].some((s) => !mechanismByRoute.has(s.route_key))
  )
    throw Error('forceability_mechanism_identity_mismatch')

  const stageByKey = new Map()
  for (const row of stages.subjects) {
    const key = identity(row.routeKey, row.destination, row.originalAsset)
    if (!subjects.has(key) || stageByKey.has(key))
      throw Error('forceability_stage_identity_mismatch')
    stageByKey.set(key, row)
  }
  if (stageByKey.size !== 67) throw Error('forceability_stage_subject_missing')
  if (!Array.isArray(directPayouts)) throw Error('forceability_direct_payouts_invalid')
  const directPayoutByKey = new Map()
  for (const payout of directPayouts) {
    const key = identity(payout.routeKey, payout.destination, payout.asset)
    if (
      !subjects.has(key) ||
      mechanismByRoute.get(payout.routeKey) !== 'atomic' ||
      directPayoutByKey.has(key) ||
      !nonnegative(payout.reconciledTransactions)
    )
      throw Error('forceability_direct_payout_identity_invalid')
    directPayoutByKey.set(key, payout.reconciledTransactions)
  }
  if (!Array.isArray(sampledConditions)) throw Error('forceability_conditions_invalid')
  const conditionByKey = new Map()
  for (const condition of sampledConditions) {
    const key = identity(condition.routeKey, condition.destination, condition.asset)
    if (
      !subjects.has(key) ||
      mechanismByRoute.get(condition.routeKey) !== 'atomic' ||
      conditionByKey.has(key) ||
      !Array.isArray(condition.observations) ||
      !condition.observations.length ||
      condition.observations.some(
        (sample, index) =>
          !nonnegative(sample.block) ||
          sample.block === 0 ||
          (index > 0 && sample.block <= condition.observations[index - 1].block) ||
          !Number.isFinite(Date.parse(sample.blockTime)) ||
          (index > 0 &&
            Date.parse(sample.blockTime) <=
              Date.parse(condition.observations[index - 1].blockTime)) ||
          !['zero_assets_positive_shares', 'zero_supply', 'nonzero_assets'].includes(
            sample.status,
          ) ||
          !/^(0|[1-9]\d*)$/.test(sample.assetsRaw ?? '') ||
          !/^(0|[1-9]\d*)$/.test(sample.supplyRaw ?? '') ||
          !/^[0-9a-f]{64}$/.test(sample.evidenceSha256 ?? '') ||
          sample.status !==
            (sample.assetsRaw === '0' && sample.supplyRaw !== '0'
              ? 'zero_assets_positive_shares'
              : sample.supplyRaw === '0'
                ? 'zero_supply'
                : 'nonzero_assets'),
      )
    )
      throw Error('forceability_condition_identity_invalid')
    conditionByKey.set(key, condition)
  }
  if (!Array.isArray(historicalStagedCohorts)) throw Error('forceability_historical_stage_invalid')
  const historicalStageByKey = new Map()
  for (const cohort of historicalStagedCohorts) {
    const key = identity(cohort.routeKey, cohort.destination, cohort.asset)
    if (
      !subjects.has(key) ||
      mechanismByRoute.get(cohort.routeKey) !== 'staged' ||
      historicalStageByKey.has(key) ||
      !nonnegative(cohort.mintedReceipts) ||
      !nonnegative(cohort.firstEligibleHolderClaimSuccesses) ||
      (cohort.mechanicalClaimGateSeconds != null &&
        (!nonnegative(cohort.mechanicalClaimGateSeconds) ||
          cohort.mechanicalClaimGateSeconds === 0 ||
          cohort.firstEligibleHolderClaimSuccesses !== cohort.mintedReceipts)) ||
      !nonnegative(cohort.sameReceiptHolderPaidClaims) ||
      !nonnegative(cohort.openCensoredReceipts) ||
      cohort.mintedReceipts === 0 ||
      cohort.firstEligibleHolderClaimSuccesses > cohort.mintedReceipts ||
      cohort.sameReceiptHolderPaidClaims + cohort.openCensoredReceipts !== cohort.mintedReceipts ||
      !/^[0-9a-f]{64}$/.test(cohort.escrowEvidenceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(cohort.boundaryEvidenceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(cohort.payoutEvidenceSha256 ?? '') ||
      (cohort.historicalRequestToMinedPaymentTiming != null &&
        (cohort.historicalRequestToMinedPaymentTiming.scope !==
          'historical_holder_action_influenced_request_to_mined_payment' ||
          cohort.historicalRequestToMinedPaymentTiming.denominator !== cohort.mintedReceipts ||
          cohort.historicalRequestToMinedPaymentTiming.openRightCensored !==
            cohort.openCensoredReceipts ||
          !nonnegative(cohort.historicalRequestToMinedPaymentTiming.censorTimestamp) ||
          ![
            cohort.historicalRequestToMinedPaymentTiming.paidWithin7Days,
            cohort.historicalRequestToMinedPaymentTiming.paidWithin21Days,
            cohort.historicalRequestToMinedPaymentTiming.paidWithin28Days,
          ].every(nonnegative) ||
          cohort.historicalRequestToMinedPaymentTiming.paidWithin7Days >
            cohort.historicalRequestToMinedPaymentTiming.paidWithin21Days ||
          cohort.historicalRequestToMinedPaymentTiming.paidWithin21Days >
            cohort.historicalRequestToMinedPaymentTiming.paidWithin28Days ||
          cohort.historicalRequestToMinedPaymentTiming.paidWithin28Days >
            cohort.sameReceiptHolderPaidClaims ||
          (cohort.historicalRequestToMinedPaymentTiming.medianRequestToMinedPayoutSeconds !==
            null &&
            !nonnegative(
              cohort.historicalRequestToMinedPaymentTiming.medianRequestToMinedPayoutSeconds,
            ))))
    )
      throw Error('forceability_historical_stage_invalid')
    historicalStageByKey.set(key, cohort)
  }
  if (impairmentKey && !historicalStageByKey.has(impairmentKey))
    throw Error('forceability_receipt_impairment_identity_invalid')
  if (!Array.isArray(currentOpenReceiptCohorts)) throw Error('forceability_current_receipt_invalid')
  const currentOpenReceiptByKey = new Map()
  for (const current of currentOpenReceiptCohorts) {
    const key = identity(current.routeKey, current.destination, current.asset)
    const historical = historicalStageByKey.get(key)
    if (
      !historical ||
      currentOpenReceiptByKey.has(key) ||
      !nonnegative(current.block) ||
      !nonnegative(current.blockTime) ||
      !nonnegative(current.cohort) ||
      !nonnegative(current.sameHolder) ||
      !nonnegative(current.claimCallable) ||
      !nonnegative(current.fullEscrowClaimable) ||
      !nonnegative(current.noCurrentOwner) ||
      !nonnegative(current.holderChanged) ||
      current.cohort !== historical.openCensoredReceipts ||
      current.sameHolder + current.noCurrentOwner + current.holderChanged !== current.cohort ||
      current.claimCallable > current.sameHolder ||
      current.fullEscrowClaimable > current.claimCallable ||
      current.sourceEscrowSha256 !== historical.escrowEvidenceSha256 ||
      current.sourceBoundarySha256 !== historical.boundaryEvidenceSha256 ||
      !/^[0-9a-f]{64}$/.test(current.evidenceSha256 ?? '')
    )
      throw Error('forceability_current_receipt_invalid')
    currentOpenReceiptByKey.set(key, current)
  }
  if (!Array.isArray(historicalIntermediateQueues))
    throw Error('forceability_intermediate_queue_invalid')
  const intermediateQueueByKey = new Map()
  for (const cohort of historicalIntermediateQueues) {
    if (cohort?.processingWithin24h != null) {
      try {
        validateProcessingWithin24h(cohort.processingWithin24h, {
          requests: cohort.requests,
          processed: cohort.processed,
          pendingCensored: cohort.pendingCensored,
        })
        if (
          !Array.isArray(cohort.processingEvidenceEpisodes) ||
          !isDeepStrictEqual(
            cohort.processingWithin24h,
            historicalProcessingWithin24h({
              episodes: cohort.processingEvidenceEpisodes,
              summary: {
                counts: {
                  requested: cohort.requests,
                  processed: cohort.processed,
                  pendingCensored: cohort.pendingCensored,
                },
              },
            }),
          )
        )
          throw Error('forceability_processing_replay_mismatch')
      } catch {
        throw Error('forceability_intermediate_queue_invalid')
      }
    }
    if (
      cohort?.processingRegimeDiagnostic != null &&
      !validProcessingDiagnostic(cohort.processingRegimeDiagnostic, cohort)
    )
      throw Error('forceability_intermediate_queue_invalid')
    const key = identity(cohort.routeKey, cohort.destination, cohort.asset)
    if (
      !subjects.has(key) ||
      mechanismByRoute.get(cohort.routeKey) !== 'staged' ||
      intermediateQueueByKey.has(key) ||
      cohort.intermediateAsset?.toLowerCase() !== cohort.asset?.toLowerCase() ||
      !nonnegative(cohort.cutoffBlock) ||
      !nonnegative(cohort.requests) ||
      !nonnegative(cohort.processed) ||
      !nonnegative(cohort.paidIntermediate) ||
      !nonnegative(cohort.processedUnclaimed) ||
      !nonnegative(cohort.pendingCensored) ||
      !nonnegative(cohort.pendingAboveCurrentLimit) ||
      !nonnegative(cohort.pendingBeforeUpgrade) ||
      !nonnegative(cohort.pendingAfterUpgrade) ||
      cohort.requests === 0 ||
      cohort.processed + cohort.pendingCensored !== cohort.requests ||
      cohort.paidIntermediate + cohort.processedUnclaimed !== cohort.processed ||
      cohort.pendingAboveCurrentLimit > cohort.pendingCensored ||
      cohort.pendingBeforeUpgrade + cohort.pendingAfterUpgrade !== cohort.pendingCensored ||
      !/^[0-9a-f]{64}$/.test(cohort.episodeEvidenceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(cohort.payoutEvidenceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(cohort.pendingEvidenceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(cohort.upgradeEvidenceSha256 ?? '')
    )
      throw Error('forceability_intermediate_queue_invalid')
    // Replay-only episode rows stay out of the public forceability matrix.
    const publicCohort = { ...cohort }
    delete publicCohort.processingEvidenceEpisodes
    intermediateQueueByKey.set(key, publicCohort)
  }
  if (!Array.isArray(currentPendingTicketCohorts))
    throw Error('forceability_current_pending_invalid')
  const currentPendingByKey = new Map()
  for (const cohort of currentPendingTicketCohorts) {
    const key = identity(cohort.routeKey, cohort.destination, cohort.asset)
    const historical = intermediateQueueByKey.get(key)
    if (
      !historical ||
      currentPendingByKey.has(key) ||
      !nonnegative(cohort.block) ||
      cohort.block <= historical.cutoffBlock ||
      !Number.isSafeInteger(cohort.blockTime) ||
      cohort.blockTime <= 0 ||
      cohort.sourceCutoffBlock !== historical.cutoffBlock ||
      cohort.cohort !== historical.pendingCensored ||
      !nonnegative(cohort.stillRequested) ||
      !nonnegative(cohort.noLongerRequested) ||
      !nonnegative(cohort.priceGated) ||
      !nonnegative(cohort.quoteEligible) ||
      !nonnegative(cohort.atLeastSevenDays) ||
      cohort.atLeastSevenDays > cohort.priceGated ||
      (cohort.priceGated === 0
        ? cohort.medianElapsedSeconds !== null || cohort.atLeastSevenDays !== 0
        : !nonnegative(cohort.medianElapsedSeconds) ||
          cohort.medianElapsedSeconds > cohort.blockTime) ||
      cohort.stillRequested + cohort.noLongerRequested !== cohort.cohort ||
      cohort.priceGated + cohort.quoteEligible !== cohort.stillRequested ||
      (cohort.gateChange != null &&
        (!nonnegative(cohort.gateChange.previousBlock) ||
          cohort.gateChange.previousBlock >= cohort.block ||
          !/^[0-9a-f]{64}$/.test(cohort.gateChange.previousEvidenceSha256 ?? '') ||
          !nonnegative(cohort.gateChange.newlyGated) ||
          !nonnegative(cohort.gateChange.newlyQuoteEligible) ||
          !nonnegative(cohort.gateChange.stillGatedDeeper) ||
          cohort.gateChange.newlyGated + cohort.gateChange.stillGatedDeeper > cohort.priceGated ||
          cohort.gateChange.newlyQuoteEligible > cohort.quoteEligible)) ||
      !/^[0-9a-f]{64}$/.test(cohort.evidenceSha256 ?? '')
    )
      throw Error('forceability_current_pending_invalid')
    currentPendingByKey.set(key, cohort)
  }
  if (!Array.isArray(historicalPublicConversionQuotes))
    throw Error('forceability_public_conversion_invalid')
  const publicConversionByKey = new Map()
  for (const quote of historicalPublicConversionQuotes) {
    const key = identity(quote.routeKey, quote.destination, quote.asset)
    const queue = intermediateQueueByKey.get(key)
    if (
      !queue ||
      publicConversionByKey.has(key) ||
      quote.intermediateAsset?.toLowerCase() !== queue.intermediateAsset.toLowerCase() ||
      !/^0x[0-9a-f]{40}$/.test(quote.finalAsset ?? '') ||
      quote.finalAsset === quote.intermediateAsset ||
      quote.cutoffBlock !== queue.cutoffBlock ||
      !/^\d+$/.test(quote.curveCashUsdcRaw ?? '') ||
      !Array.isArray(quote.sizes) ||
      quote.sizes.length === 0 ||
      quote.sizes.some(
        (size) =>
          !/^\d+$/.test(size.usdatRaw ?? '') ||
          !/^\d+$/.test(size.usdcQuotedRaw ?? '') ||
          !/^\d+$/.test(size.ausdQuotedRaw ?? '') ||
          BigInt(size.usdatRaw) === 0n ||
          BigInt(size.usdcQuotedRaw) === 0n ||
          BigInt(size.ausdQuotedRaw) === 0n,
      ) ||
      !/^[0-9a-f]{64}$/.test(quote.evidenceSha256 ?? '')
    )
      throw Error('forceability_public_conversion_invalid')
    publicConversionByKey.set(key, quote)
  }
  const supportGroups = new Map()
  for (const group of support.groups) {
    if (!mechanismByRoute.has(group.routeKey) || supportGroups.has(group.routeKey))
      throw Error('forceability_support_group_mismatch')
    supportGroups.set(group.routeKey, group)
  }
  if (supportGroups.size !== 25) throw Error('forceability_support_group_missing')
  for (const group of supportGroups.values()) {
    const expectedSubjects = roster.filter((row) => row.route_key === group.routeKey).length
    if (
      !nonnegative(group.total) ||
      group.total !== expectedSubjects ||
      !nonnegative(group.withIssue)
    )
      throw Error('forceability_support_group_counts_invalid')
  }
  const directByKey = new Map()
  for (const cell of support.cells) {
    const key = identity(cell.routeKey, cell.destination, cell.asset)
    if (!subjects.has(key)) throw Error('forceability_support_identity_mismatch')
    if (
      !nonnegative(cell.issueRecords) ||
      !nonnegative(cell.baseline?.impaired) ||
      !nonnegative(cell.baseline?.control) ||
      !nonnegative(cell.impaired?.recovery) ||
      !nonnegative(cell.control?.newRevert) ||
      !nonnegative(cell.control?.entitlementGap ?? 0) ||
      !nonnegative(cell.impaired?.entitlementGap ?? 0)
    )
      throw Error('forceability_support_cell_invalid')
    const row = directByKey.get(key) ?? {
      issueCellObservations: 0,
      baselineCellObservations: 0,
      recoveryCellObservations: 0,
      lossCellObservations: 0,
      entitlementGapCellObservations: 0,
      exactCells: 0,
    }
    row.issueCellObservations += cell.issueRecords
    row.baselineCellObservations += cell.baseline.impaired + cell.baseline.control
    row.recoveryCellObservations += cell.impaired.recovery
    row.lossCellObservations += cell.control.newRevert
    row.entitlementGapCellObservations +=
      (cell.control.entitlementGap ?? 0) + (cell.impaired.entitlementGap ?? 0)
    row.exactCells++
    directByKey.set(key, row)
  }
  for (const group of supportGroups.values()) {
    const observed = [...directByKey].filter(
      ([key, row]) =>
        subjects.get(key).route_key === group.routeKey && row.issueCellObservations > 0,
    ).length
    if (observed !== group.withIssue) throw Error('forceability_support_group_counts_invalid')
  }

  const rows = roster.map((subject) => {
    const key = identity(subject.route_key, subject.destination, subject.asset)
    const stage = stageByKey.get(key)
    const direct = directByKey.get(key) ?? {
      issueCellObservations: 0,
      baselineCellObservations: 0,
      recoveryCellObservations: 0,
      lossCellObservations: 0,
      entitlementGapCellObservations: 0,
      exactCells: 0,
    }
    const mechanism = mechanismByRoute.get(subject.route_key)
    const stageIssue = stage.verifiedIssues > 0
    const directIssueBaseline = direct.baselineCellObservations > 0
    const paidProofs = stage.sameEpisodePaidExitProofs ?? 0
    const calibratedDurations = stage.calibratedImpairmentDurations ?? 0
    const observedRequestToPayoutSeconds = stage.observedRequestToPayoutSeconds ?? []
    // Verified transactions in bounded archives, not an exhaustive historical total.
    const historicalDirectFinalAssetPayoutTransactions = directPayoutByKey.get(key) ?? 0
    const historicalSupplierPayoutEvidence = supplierPayoutByKey.get(key) ?? null
    const condition = conditionByKey.get(key)
    const historicalReceiptCohort = historicalStageByKey.get(key) ?? null
    const latestOpenReceiptObservation = currentOpenReceiptByKey.get(key) ?? null
    const historicalIntermediateQueue = intermediateQueueByKey.get(key) ?? null
    const latestPendingTicketObservation = currentPendingByKey.get(key) ?? null
    const historicalPublicConversionQuote = publicConversionByKey.get(key) ?? null
    const latestCondition = condition?.observations.at(-1)
    const sampledZeroAssetsPositiveShares =
      latestCondition?.status === 'zero_assets_positive_shares'
    const observations = condition?.observations ?? []
    const firstZeroInLatestSampleRun = sampledZeroAssetsPositiveShares
      ? [...observations]
          .reverse()
          .findIndex((sample) => sample.status !== 'zero_assets_positive_shares')
      : -1
    const firstZeroSample = sampledZeroAssetsPositiveShares
      ? observations[
          firstZeroInLatestSampleRun === -1 ? 0 : observations.length - firstZeroInLatestSampleRun
        ]
      : null
    const lastPriorNonzeroSample = firstZeroSample
      ? observations
          .filter(
            (sample) => sample.block < firstZeroSample.block && sample.status === 'nonzero_assets',
          )
          .at(-1)
      : null
    if (
      !nonnegative(stage.verifiedIssues) ||
      !nonnegative(paidProofs) ||
      !nonnegative(calibratedDurations) ||
      !nonnegative(stage.minedDeliveryAttestations) ||
      !stage.stages ||
      typeof stage.stages !== 'object' ||
      Array.isArray(stage.stages) ||
      paidProofs > stage.verifiedIssues ||
      paidProofs > stage.minedDeliveryAttestations ||
      calibratedDurations > paidProofs ||
      !Array.isArray(observedRequestToPayoutSeconds) ||
      observedRequestToPayoutSeconds.length > paidProofs ||
      observedRequestToPayoutSeconds.some((seconds) => !nonnegative(seconds))
    )
      throw Error('forceability_stage_counts_invalid')
    if (mechanism === 'atomic' && (stageIssue || paidProofs))
      throw Error('forceability_atomic_stage_conflict')
    if (mechanism === 'staged' && direct.issueCellObservations)
      throw Error('forceability_staged_direct_conflict')
    const reasons = []
    if (mechanism === 'staged') {
      if (!stageIssue) reasons.push('no_verified_stage_issue')
      if (!paidProofs)
        reasons.push(
          historicalReceiptCohort?.sameReceiptHolderPaidClaims
            ? 'no_prospective_same_episode_final_asset_paid_proof'
            : 'no_same_episode_final_asset_paid_proof',
        )
      if (stage.minedDeliveryAttestations > paidProofs)
        reasons.push('mined_delivery_episode_unresolved')
    } else {
      if (!direct.issueCellObservations) reasons.push('no_verified_direct_issue')
      else if (!directIssueBaseline) reasons.push('no_measured_exact_holder_q_baseline')
    }
    if (sampledZeroAssetsPositiveShares) reasons.push('sampled_zero_assets_positive_shares')
    if (!calibratedDurations) reasons.push('impairment_duration_uncalibrated')
    reasons.push('prospective_holder_forecast_uncalibrated')
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      originalAsset: subject.asset,
      scope: 'frozen_25_67',
      mechanism,
      directIssueBaseline,
      directIssueCellObservations: direct.issueCellObservations,
      measuredDirectBaselineCellObservations: direct.baselineCellObservations,
      historicalDirectFinalAssetPayoutTransactions,
      historicalSupplierPayoutEvidence,
      historicalStableSimulatedReverts: stableRevertsByKey.get(key) ?? [],
      sampledZeroAssetsPositiveShares,
      latestSampledCondition: latestCondition
        ? {
            block: latestCondition.block,
            blockTime: latestCondition.blockTime,
            status: latestCondition.status,
            evidenceSha256: latestCondition.evidenceSha256,
          }
        : null,
      sampledConditionObservations: condition?.observations.length ?? 0,
      sampledZeroAssetHistory: firstZeroSample
        ? {
            firstZeroSampleAt: firstZeroSample.blockTime,
            latestZeroSampleAt: latestCondition.blockTime,
            zeroSampleCount: observations.filter((sample) => sample.block >= firstZeroSample.block)
              .length,
            spanBetweenZeroSamplesSeconds:
              (Date.parse(latestCondition.blockTime) - Date.parse(firstZeroSample.blockTime)) /
              1000,
            lastPriorNonzeroSampleAt: lastPriorNonzeroSample?.blockTime ?? null,
            continuityProven: false,
          }
        : null,
      directExactCells: direct.exactCells,
      correlatedLossCellObservations: direct.lossCellObservations,
      correlatedEntitlementGapCellObservations: direct.entitlementGapCellObservations,
      correlatedRecoveryCellObservations: direct.recoveryCellObservations,
      stageIssue,
      stageIssueObservations: stage.verifiedIssues,
      stageNames: Object.keys(stage.stages).sort(),
      minedDeliveryAttestations: stage.minedDeliveryAttestations,
      terminalSameEpisodeFinalAssetPaidProof: paidProofs > 0,
      terminalSameEpisodeFinalAssetPaidProofs: paidProofs,
      historicalReceiptCohort,
      prospectiveReceiptImpairment:
        historicalReceiptCohort && key === impairmentKey ? impairmentSummary : null,
      latestOpenReceiptObservation,
      historicalIntermediateQueue,
      latestPendingTicketObservation,
      historicalPublicConversionQuote,
      observedRequestToPayoutSeconds,
      calibratedImpairmentDuration: calibratedDurations > 0,
      prospectiveCalibration: false,
      holderExecutableExit: false,
      forecastValidated: false,
      reasons,
    }
  })
  const routeGroups = new Set(rows.map((row) => row.routeKey))
  return {
    scope: 'offline_frozen_holder_exit_forceability_gate',
    manifestSha256: manifest.sha256 ?? null,
    mechanismVersion: mechanismCatalog.version ?? null,
    forecastValidated: false,
    holderExecutableExit: false,
    summary: {
      routeGroups: routeGroups.size,
      exactSubjects: rows.length,
      atomicGroups: new Set(rows.filter((r) => r.mechanism === 'atomic').map((r) => r.routeKey))
        .size,
      stagedGroups: new Set(rows.filter((r) => r.mechanism === 'staged').map((r) => r.routeKey))
        .size,
      subjectsWithMeasuredDirectBaseline: rows.filter((r) => r.directIssueBaseline).length,
      subjectsWithLatestSampledZeroAssetsPositiveShares: rows.filter(
        (r) => r.sampledZeroAssetsPositiveShares,
      ).length,
      subjectsWithHistoricalDirectFinalAssetPayout: rows.filter(
        (r) => r.historicalDirectFinalAssetPayoutTransactions > 0,
      ).length,
      historicalDirectFinalAssetPayoutTransactions: sum(
        rows,
        (r) => r.historicalDirectFinalAssetPayoutTransactions,
      ),
      subjectsWithHistoricalSupplierPayoutEvidence: rows.filter(
        (r) => r.historicalSupplierPayoutEvidence?.status === 'observed',
      ).length,
      historicalSupplierSameHolderPayoutCount: sum(
        rows,
        (r) => r.historicalSupplierPayoutEvidence?.sameHolderPayoutCount ?? 0,
      ),
      subjectsWithStageIssue: rows.filter((r) => r.stageIssue).length,
      subjectsWithSameEpisodeFinalAssetPaidProof: rows.filter(
        (r) => r.terminalSameEpisodeFinalAssetPaidProof,
      ).length,
      sameEpisodeFinalAssetPaidProofs: sum(rows, (r) => r.terminalSameEpisodeFinalAssetPaidProofs),
      subjectsWithHistoricalReceiptCohort: rows.filter((r) => r.historicalReceiptCohort).length,
      historicalSameReceiptHolderPaidClaims: sum(
        rows,
        (r) => r.historicalReceiptCohort?.sameReceiptHolderPaidClaims ?? 0,
      ),
      prospectiveReceiptFailedFirstEligibleEpisodes:
        impairmentSummary?.failedFirstEligibleEpisodes ?? 0,
      prospectiveReceiptRecoveredIntervals: impairmentSummary?.recoveredIntervals ?? 0,
      subjectsWithHistoricalIntermediateQueue: rows.filter((r) => r.historicalIntermediateQueue)
        .length,
      historicalIntermediatePaidClaims: sum(
        rows,
        (r) => r.historicalIntermediateQueue?.paidIntermediate ?? 0,
      ),
      historicalPendingAboveCurrentLimit: sum(
        rows,
        (r) => r.historicalIntermediateQueue?.pendingAboveCurrentLimit ?? 0,
      ),
      subjectsWithHistoricalPublicConversionQuote: rows.filter(
        (r) => r.historicalPublicConversionQuote,
      ).length,
      subjectsWithCalibratedImpairmentDuration: rows.filter((r) => r.calibratedImpairmentDuration)
        .length,
      subjectsWithProspectiveCalibration: 0,
      correlatedLossCellObservations: sum(rows, (r) => r.correlatedLossCellObservations),
      correlatedEntitlementGapCellObservations: sum(
        rows,
        (r) => r.correlatedEntitlementGapCellObservations,
      ),
      correlatedRecoveryCellObservations: sum(rows, (r) => r.correlatedRecoveryCellObservations),
    },
    subjects: rows,
    supplemental: (manifest.supplementalSubjects ?? []).map((subject) => ({
      ...abstainUntrackedSubject(subject),
      historicalSupplierPayoutEvidence:
        supplierPayoutByKey.get(identity(subject.route_key, subject.destination, subject.asset)) ??
        null,
    })),
  }
}

export async function readVerifiedHolderExitForceabilityMatrix() {
  const [
    manifestModule,
    supportModule,
    stageModule,
    registryModule,
    mechanismModule,
    fixtures,
    seed,
    config,
    markets,
    rates,
    payoutModule,
    morphoPayoutModule,
    morphoConditionModule,
    apyUsdExitModule,
    apyUsdEscrowModule,
    apyUsdPayoutModule,
    apyUsdBoundaryModule,
    apyUsdCurrentModule,
    stakedUsdatModule,
    saturnEpisodesModule,
    saturnPayoutsModule,
    saturnPendingModule,
    saturnCurrentModule,
    saturnSeriesModule,
    saturnUpgradeModule,
    saturnRouteQuoteModule,
  ] = await Promise.all([
    import('../record-carry-cash-issues.mjs'),
    import('./holder-exit-support-audit.mjs'),
    import('./holder-exit-stage-coverage.mjs'),
    import('../../lib/carry/forecastRegistry.ts'),
    import('../../lib/carry/holderExitMechanisms.ts'),
    import('../../components/Carry/fixtures.ts'),
    import('../route-cohort/aug-2026-ab-vault-seed.json', { with: { type: 'json' } }),
    import('../../tools/venue-recorder.config.json', { with: { type: 'json' } }),
    import('../../lib/carry/forecastRegistryMarkets.ts'),
    import('../route-rates/exact-leg-spread.mjs'),
    import('./carry-fluid-ftoken-payout.mjs'),
    import('../reconcile-carry-morpho-v2-withdrawals-local.mjs'),
    import('./carry-morpho-zero-asset-condition.mjs'),
    import('../../lib/carry/apyUsdExit.ts'),
    import('./apyusd-receipt-cohort-escrow.mjs'),
    import('./apyusd-receipt-cohort-payouts.mjs'),
    import('./apyusd-receipt-cohort-boundaries.mjs'),
    import('./apyusd-open-receipt-current.mjs'),
    import('../../lib/carry/stakedUsdatExit.ts'),
    import('./saturn-queue-episode-cohort.mjs'),
    import('./saturn-queue-claim-payouts.mjs'),
    import('./saturn-queue-pending-terms.mjs'),
    import('./saturn-queue-pending-current.mjs'),
    import('./saturn-queue-pending-series.mjs'),
    import('./saturn-queue-upgrade-boundary.mjs'),
    import('./saturn-ausd-public-route-quote.mjs'),
  ])
  const registry = registryModule.buildCarryForecastRegistry(
    fixtures.ROUTES,
    seed.default,
    config.default.venues,
    rates.GHO_SGHO.destination,
    markets.verifiedDirectSupplyDestinations(),
  )
  const mechanismCatalog = mechanismModule.buildFrozenHolderExitMechanisms(registry)
  const [manifest, support, stages] = await Promise.all([
    manifestModule.buildSubjectManifest(),
    supportModule.readVerifiedSupportAudit(),
    stageModule.readVerifiedHolderExitStageCoverage(),
  ])
  const verifiedPayouts = payoutModule.verify()
  if (
    verifiedPayouts.byRoute.length !== payoutModule.ROUTES.length ||
    verifiedPayouts.byRoute.some((row, index) => row.route !== payoutModule.ROUTES[index].key)
  )
    throw Error('forceability_direct_payout_audit_invalid')
  const morphoPayouts = await morphoPayoutModule.readVerifiedMorphoPayoutsByExactSubject()
  const sampledConditions = await morphoConditionModule.readVerifiedMorphoZeroAssetConditions()
  const historicalStableReverts = readSavedMorphoStableReverts()
  const [
    apyUsdEscrow,
    apyUsdPayouts,
    apyUsdBoundaries,
    apyUsdCurrent,
    saturnEpisodes,
    saturnPayouts,
    saturnPending,
    saturnCurrent,
    saturnUpgrade,
    saturnRouteQuote,
  ] = await Promise.all([
    apyUsdEscrowModule.verifyEscrow(),
    apyUsdPayoutModule.verifyPayouts(),
    apyUsdBoundaryModule.verifyBoundaries(),
    apyUsdCurrentModule.verifyCurrent().catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    }),
    saturnEpisodesModule.verifyEpisodes(),
    saturnPayoutsModule.verifyPayouts(),
    saturnPendingModule.verifyPending(),
    saturnCurrentModule.verify().catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    }),
    saturnUpgradeModule.verifyBoundary(),
    saturnRouteQuoteModule.verifySaved(),
  ])
  if (
    saturnEpisodes.summary.counts.claimed !== saturnPayouts.claimedTickets ||
    saturnEpisodes.summary.counts.pendingCensored !== saturnPending.summary.pending ||
    saturnPending.summary.pending !==
      saturnUpgrade.classification.pendingBeforeUpgrade +
        saturnUpgrade.classification.pendingAfterUpgrade +
        saturnUpgrade.classification.pendingAtUpgradeBlock ||
    saturnUpgrade.classification.pendingAtUpgradeBlock !== 0
  )
    throw Error('forceability_saturn_evidence_inconsistent')
  const saturnSeries = saturnCurrent
    ? await saturnSeriesModule.verifySeries(undefined, {
        baseline: saturnCurrent,
        cohort: saturnPending,
        episodes: saturnEpisodes,
      })
    : null
  const newestSaturnSample = saturnSeries?.records.at(-1) ?? null
  const previousSaturnSample = saturnSeries?.records.at(-2)?.snapshot ?? saturnCurrent
  const saturnLatest = newestSaturnSample?.snapshot ?? saturnCurrent
  const historicalStagedCohorts = [
    {
      routeKey: apyUsdExitModule.APYUSD_ROUTE,
      destination: apyUsdExitModule.APYUSD_VAULT,
      asset: apyUsdExitModule.APXUSD_ASSET,
      mintedReceipts: apyUsdEscrow.cohortSize,
      firstEligibleHolderClaimSuccesses: apyUsdBoundaries.summary.firstEligibleSucceeded,
      mechanicalClaimGateSeconds:
        apyUsdBoundaries.summary.scheduled72h === apyUsdEscrow.cohortSize &&
        apyUsdBoundaries.summary.beforeReverted === apyUsdEscrow.cohortSize &&
        apyUsdBoundaries.summary.firstEligibleSucceeded === apyUsdEscrow.cohortSize &&
        apyUsdBoundaries.summary.sameImplementation === apyUsdEscrow.cohortSize
          ? 259_200
          : null,
      sameReceiptHolderPaidClaims: apyUsdEscrow.summary.paidCrosschecked,
      openCensoredReceipts: apyUsdEscrow.cohortSize - apyUsdEscrow.summary.paidCrosschecked,
      escrowEvidenceSha256: apyUsdEscrow.sha256,
      boundaryEvidenceSha256: apyUsdBoundaries.sha256,
      payoutEvidenceSha256: apyUsdEscrow.payoutsSha256,
      historicalRequestToMinedPaymentTiming: summarizeHistoricalReceiptTiming(
        apyUsdEscrow,
        apyUsdPayouts,
      ),
    },
  ]
  const currentOpenReceiptCohorts = apyUsdCurrent
    ? [
        {
          routeKey: apyUsdExitModule.APYUSD_ROUTE,
          destination: apyUsdExitModule.APYUSD_VAULT,
          asset: apyUsdExitModule.APXUSD_ASSET,
          block: apyUsdCurrent.block.number,
          blockTime: apyUsdCurrent.block.timestamp,
          cohort: apyUsdCurrent.subjects.length,
          sameHolder: apyUsdCurrent.proofs.filter((proof) => proof.status === 'same_holder').length,
          claimCallable: apyUsdCurrent.proofs.filter((proof) => proof.claimStatus === 'success')
            .length,
          fullEscrowClaimable: apyUsdCurrent.proofs.filter(
            (proof, index) =>
              proof.claimStatus === 'success' &&
              proof.claimAmountRaw === apyUsdCurrent.subjects[index].receiptEscrowRaw,
          ).length,
          noCurrentOwner: apyUsdCurrent.proofs.filter(
            (proof) => proof.status === 'no_current_owner',
          ).length,
          holderChanged: apyUsdCurrent.proofs.filter((proof) => proof.status === 'holder_changed')
            .length,
          sourceEscrowSha256: apyUsdCurrent.source.escrowSha256,
          sourceBoundarySha256: apyUsdCurrent.source.boundariesSha256,
          evidenceSha256: apyUsdCurrent.sha256,
        },
      ]
    : []
  const historicalIntermediateQueues = [
    {
      routeKey: stakedUsdatModule.STAKED_USDAT_ROUTE,
      destination: stakedUsdatModule.STAKED_USDAT_VAULT,
      asset: stakedUsdatModule.USDAT_ASSET,
      intermediateAsset: stakedUsdatModule.USDAT_ASSET,
      cutoffBlock: saturnPending.cutoffBlock,
      requests: saturnEpisodes.summary.counts.requested,
      processed: saturnEpisodes.summary.counts.processed,
      paidIntermediate: saturnPayouts.claimedTickets,
      processedUnclaimed: saturnEpisodes.summary.counts.processedUnclaimed,
      pendingCensored: saturnPending.summary.pending,
      pendingAboveCurrentLimit: saturnPending.summary.belowCurrentMin,
      pendingBeforeUpgrade: saturnUpgrade.classification.pendingBeforeUpgrade,
      pendingAfterUpgrade: saturnUpgrade.classification.pendingAfterUpgrade,
      processingWithin24h: historicalProcessingWithin24h(saturnEpisodes),
      processingEvidenceEpisodes: saturnEpisodes.episodes,
      processingRegimeDiagnostic: {
        sourceEpisodeSha256: saturnEpisodes.sha256,
        ...diagnoseSaturnQueueProcessing(
          saturnEpisodes.episodes,
          saturnEpisodes.headers.find((header) => header.number === saturnPending.cutoffBlock)
            ?.timestamp,
        ),
      },
      episodeEvidenceSha256: saturnEpisodes.sha256,
      payoutEvidenceSha256: saturnPayouts.sha256,
      pendingEvidenceSha256: saturnPending.sha256,
      upgradeEvidenceSha256: saturnUpgrade.sha256,
    },
  ]
  const historicalPublicConversionQuotes = [
    {
      routeKey: stakedUsdatModule.STAKED_USDAT_ROUTE,
      destination: stakedUsdatModule.STAKED_USDAT_VAULT,
      asset: stakedUsdatModule.USDAT_ASSET,
      intermediateAsset: saturnRouteQuote.usdat,
      finalAsset: saturnRouteQuote.ausd,
      cutoffBlock: saturnRouteQuote.blockNumber,
      curveCashUsdcRaw: saturnRouteQuote.curveCashUsdcRaw,
      sizes: saturnRouteQuote.sizes,
      evidenceSha256: saturnRouteQuote.sha256,
    },
  ]
  const currentPendingTicketCohorts = saturnLatest
    ? [
        {
          routeKey: stakedUsdatModule.STAKED_USDAT_ROUTE,
          destination: stakedUsdatModule.STAKED_USDAT_VAULT,
          asset: stakedUsdatModule.USDAT_ASSET,
          sourceCutoffBlock: saturnPending.cutoffBlock,
          block: saturnLatest.block.number,
          blockTime: saturnLatest.block.timestamp,
          cohort: saturnLatest.summary.cohort,
          stillRequested: saturnLatest.summary.stillRequested,
          noLongerRequested: saturnLatest.summary.noLongerRequested,
          priceGated: saturnLatest.summary.requestedPriceGated,
          quoteEligible: saturnLatest.summary.requestedQuoteEligible,
          ...saturnCurrentModule.summarizeElapsedPriceGate(
            saturnLatest.rows,
            saturnLatest.block.timestamp,
          ),
          ...(newestSaturnSample
            ? {
                gateChange: saturnSeriesModule.summarizeGateChange(
                  previousSaturnSample,
                  saturnLatest,
                ),
              }
            : {}),
          evidenceSha256: saturnLatest.sha256,
        },
      ]
    : []
  const directPayouts = [
    ...payoutModule.ROUTES.map((route, index) => ({
      routeKey: route.key,
      destination: route.vault,
      asset: route.asset,
      reconciledTransactions: verifiedPayouts.byRoute[index].eventIdentityReconciled,
    })),
    ...morphoPayouts,
  ]
  const prospectiveReceiptImpairment = {
    routeKey: apyUsdExitModule.APYUSD_ROUTE,
    destination: apyUsdExitModule.APYUSD_VAULT,
    asset: apyUsdExitModule.APXUSD_ASSET,
    ...(await readVerifiedProspectiveImpairment()),
  }
  const { readDirectSupplierPayoutCoverage } =
    await import('./holder-exit-direct-supplier-payout-coverage.mjs')
  const historicalSupplierPayoutCoverage = await readDirectSupplierPayoutCoverage(manifest)
  return buildHolderExitForceabilityMatrix({
    manifest,
    support,
    stages,
    mechanismCatalog,
    directPayouts,
    historicalSupplierPayoutCoverage,
    sampledConditions,
    historicalStableReverts,
    historicalStagedCohorts,
    currentOpenReceiptCohorts,
    historicalIntermediateQueues,
    historicalPublicConversionQuotes,
    currentPendingTicketCohorts,
    prospectiveReceiptImpairment,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3 || !['--summary', '--json'].includes(process.argv[2]))
    throw Error(
      'usage: node --import tsx scripts/research/holder-exit-forceability-matrix.mjs --summary|--json',
    )
  readVerifiedHolderExitForceabilityMatrix()
    .then((matrix) => {
      process.stdout.write(
        `${JSON.stringify(process.argv[2] === '--summary' ? matrix.summary : matrix)}\n`,
      )
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
