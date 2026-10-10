// Retrospective gross underlying flow for the frozen August 25/67 cohort.
// All sources are local verified receipts. Market events are not holder exit capacity.
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import frozenPinsModule from '../../lib/carry/frozenGrossFlowPins.ts'
import { validateManifest } from '../backfill-carry-cash-archive.mjs'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { readLocalCarryCashObservations } from '../lib/localCarryCashStore.mjs'
import {
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from '../lib/localMorphoV2FlowStore.mjs'
import { localRouteFlowStore } from '../lib/localRouteFlowStore.mjs'
import { loadConfig } from '../lib/venue-reads.mjs'
import {
  DIRECT_SUPPLIER_MARKETS,
  readDirectSupplierFlowDocuments,
  summarizeVerifiedDirectSupplierFlow,
  summarizeVerifiedDirectSupplierSupply,
} from '../lib/carry-direct-supplier-flow-summary.mjs'
import {
  maxDirectSupplierSupplyWindow,
  maxDirectSupplierWithdrawalWindow,
} from '../lib/carry-direct-supplier-flow-window.mjs'
import {
  STUDY,
  STUDY_V2,
  SUPPLY_STUDY,
  SUPPLY_STUDY_V2,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'
import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'

export const GROSS_FLOW_OUTLOOK_SCHEMA = 'carry-historical-gross-flow-outlook-v3'
export const SUPPORTED_HORIZON_HOURS = Object.freeze([24, 168])
const HOUR_MS = 3_600_000
const SHA = /^[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const hash = (value) => createHash('sha256').update(value).digest('hex')
const frozenPins = frozenPinsModule.default
const key = (routeKey, destination) => `${routeKey}\0${destination.toLowerCase()}`

function frozenIdentityDigest(subjects) {
  return hash(JSON.stringify(subjects.map((row) => [row.route_key, row.destination, row.asset])))
}

function assertHorizon(horizonHours) {
  if (!SUPPORTED_HORIZON_HOURS.includes(horizonHours)) throw Error('gross_flow_horizon_unsupported')
}

function validSegmentHashes(documents) {
  if (
    !Array.isArray(documents) ||
    !documents.length ||
    documents.some((row) => !SHA.test(row?.sha256 ?? ''))
  )
    throw Error('gross_flow_segment_hashes_invalid')
  return documents.map((row) => row.sha256)
}

function completeCoverage(coverage, horizonMs) {
  if (
    !coverage ||
    coverage.endMs - coverage.startMs < horizonMs ||
    !Array.isArray(coverage.intervals) ||
    !coverage.intervals.length
  )
    return false
  let cursor = coverage.startMs
  for (const interval of coverage.intervals) {
    if (
      interval.startMs !== cursor ||
      interval.endMs <= cursor ||
      interval.finalized !== true ||
      interval.receiptsComplete !== true ||
      interval.ambiguousReceipts !== 0
    )
      return false
    cursor = interval.endMs
  }
  return cursor === coverage.endMs
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toString()
}

function intervalAmounts(coverage, events, horizonMs) {
  const count = Math.floor((coverage.endMs - coverage.startMs) / horizonMs)
  const values = Array.from({ length: count }, () => 0n)
  for (const event of events) {
    const offset = event.timestampMs - coverage.startMs
    const index = Math.floor(offset / horizonMs)
    if (index < 0 || event.timestampMs >= coverage.endMs || index >= count) continue
    const amount = event.reconciliation?.evidence?.amountRaw
    if (!RAW.test(amount ?? '')) throw Error('gross_flow_verified_amount_invalid')
    values[index] += BigInt(amount)
  }
  return values
}

function historicalDistribution(values) {
  if (values.length < 3)
    return {
      status: 'unavailable',
      reason: 'fewer_than_three_corroborated_disjoint_intervals',
      intervalCount: values.length,
    }
  return {
    status: 'historical_descriptive',
    method: 'p10_median_p90_of_nonoverlapping_corroborated_intervals',
    intervalCount: values.length,
    lowRaw: quantile(values, 0.1),
    middleRaw: quantile(values, 0.5),
    highRaw: quantile(values, 0.9),
  }
}

function failureCode(error, fallback) {
  const code = String(error instanceof Error ? error.message : fallback).split(/\s+/)[0]
  return /^[a-zA-Z0-9_:-]+$/.test(code) ? code : fallback
}

function checkedTimestampMs(value, reason) {
  const timestampMs = Date.parse(value)
  if (!Number.isSafeInteger(timestampMs)) throw Error(reason)
  return timestampMs
}

function rawTotal(events) {
  let amount = 0n
  for (const event of events) {
    if (!RAW.test(event.assets_raw ?? event.outputRaw ?? ''))
      throw Error('gross_flow_recorded_amount_invalid')
    amount += BigInt(event.assets_raw ?? event.outputRaw)
  }
  return { amountRaw: amount.toString(), eventCount: events.length }
}

function unavailableTimedDistribution(reason, intervalCount = 0) {
  return { status: 'unavailable', reason, intervalCount }
}

function singleProviderDistribution(values) {
  if (values.length < 3)
    return unavailableTimedDistribution(
      'fewer_than_three_single_provider_disjoint_intervals',
      values.length,
    )
  return {
    status: 'historical_descriptive_single_provider',
    method: 'p10_median_p90_of_nonoverlapping_single_provider_intervals',
    intervalCount: values.length,
    lowRaw: quantile(values, 0.1),
    middleRaw: quantile(values, 0.5),
    highRaw: quantile(values, 0.9),
  }
}

function timedIntervalAmounts(events, coverageStartMs, coverageEndMs, horizonMs) {
  const count = Math.floor((coverageEndMs - coverageStartMs) / horizonMs)
  const values = Array.from({ length: count }, () => 0n)
  for (const event of events) {
    const timestampMs = event.blockTime * 1_000
    if (
      !Number.isSafeInteger(timestampMs) ||
      timestampMs < coverageStartMs ||
      timestampMs > coverageEndMs
    )
      throw Error('gross_flow_route_event_time_invalid')
    const index = Math.max(0, Math.ceil((timestampMs - coverageStartMs) / horizonMs) - 1)
    if (index >= count) continue
    if (!RAW.test(event.outputRaw ?? '')) throw Error('gross_flow_recorded_amount_invalid')
    values[index] += BigInt(event.outputRaw)
  }
  return values
}

function timedMaximum(events, coverageStartMs, coverageEndMs, horizonMs) {
  if (coverageEndMs - coverageStartMs < horizonMs) return null
  const ordered = [...events].sort(
    (a, b) => a.blockTime - b.blockTime || a.block.localeCompare(b.block),
  )
  const firstEnd = coverageStartMs + horizonMs
  const ends = [
    ...new Set([
      firstEnd,
      coverageEndMs,
      ...ordered
        .map((event) => event.blockTime * 1_000)
        .filter((timestampMs) => timestampMs >= firstEnd && timestampMs <= coverageEndMs),
    ]),
  ].sort((a, b) => a - b)
  let left = 0
  let right = 0
  let amount = 0n
  let best = {
    amountRaw: '0',
    eventCount: 0,
    startMs: coverageStartMs,
    endMs: firstEnd,
  }
  for (const endMs of ends) {
    const startMs = endMs - horizonMs
    while (left < ordered.length && ordered[left].blockTime * 1_000 <= startMs) {
      if (left < right) amount -= BigInt(ordered[left].outputRaw)
      left++
      if (right < left) right = left
    }
    while (right < ordered.length && ordered[right].blockTime * 1_000 <= endMs) {
      amount += BigInt(ordered[right].outputRaw)
      right++
    }
    const eventCount = right - left
    if (amount > BigInt(best.amountRaw))
      best = { amountRaw: amount.toString(), eventCount, startMs, endMs }
  }
  return best
}

function recordedTimedFlow(events, coverageStartMs, coverageEndMs, horizonHours) {
  const horizonMs = horizonHours * HOUR_MS
  const intervalValues = timedIntervalAmounts(events, coverageStartMs, coverageEndMs, horizonMs)
  const maximum = timedMaximum(events, coverageStartMs, coverageEndMs, horizonMs)
  return {
    recordedTotalWithinCoverage: rawTotal(events),
    observedMaximumWithinRecordedCoverage: maximum ? { ...maximum, horizonHours } : null,
    historicalFlowDistribution: maximum
      ? singleProviderDistribution(intervalValues)
      : unavailableTimedDistribution('coverage_shorter_than_horizon', 0),
    zeroMeaning: 'zero_matching_events_returned_by_single_provider_within_recorded_coverage',
  }
}

function morphoBindingInput(context, routeKey, destination, asset) {
  return {
    schema: 'carry_morpho_recorded_range_binding_v1',
    routeKey,
    destination,
    asset,
    requestedHorizonHours: context.requestedHorizonHours,
    source: {
      enrollmentSha256: context.source.enrollmentSha256,
      rangeSha256: context.source.rangeSha256,
      sourceSetSha256: context.source.sourceSetSha256,
      coverageStartBlock: context.source.coverageStartBlock,
      coverageEndBlock: context.source.coverageEndBlock,
      coverageStartMs: context.source.coverageStartMs,
      coverageEndMs: context.source.coverageEndMs,
    },
    grossDeposit: context.grossDeposit,
    grossExternalReceiverWithdraw: context.grossExternalReceiverWithdraw,
    excludedInternalWithdrawals: context.excludedInternalWithdrawals,
  }
}

/** Whole-range totals only: the sealed Morpho rows do not carry per-event timestamps. */
export function morphoRecordedRangeFromVerified({
  routeKey,
  destination,
  asset,
  enrollment,
  records,
  horizonHours,
}) {
  assertHorizon(horizonHours)
  const morphoPins = frozenPins.morpho
  if (
    !morphoPins.routeKeys.includes(routeKey) ||
    !ADDRESS.test(destination ?? '') ||
    !ADDRESS.test(asset ?? '') ||
    enrollment?.sha256 !== morphoPins.enrollmentSha256 ||
    !RAW.test(enrollment?.block ?? '') ||
    !Array.isArray(records) ||
    !records.length ||
    records.length > 100_000
  )
    throw Error('gross_flow_morpho_source_invalid')
  const coverageStartMs = checkedTimestampMs(
    enrollment.observedAt,
    'gross_flow_morpho_enrollment_time_invalid',
  )
  const deposits = []
  const externalWithdrawals = []
  const internalWithdrawals = []
  let prior = enrollment
  for (const [index, record] of records.entries()) {
    const fromBlock = BigInt(record.fromBlock ?? '-1')
    const toBlock = BigInt(record.toBlock ?? '-1')
    if (
      record.sequence !== index + 1 ||
      record.previousSha256 !== prior.sha256 ||
      record.enrollmentSha256 !== enrollment.sha256 ||
      record.vault !== destination ||
      record.asset !== asset ||
      record.providerCompleteness !== 'not_independently_proven' ||
      record.holderPayout !== 'not_measured' ||
      !SHA.test(record.sha256 ?? '') ||
      fromBlock !== BigInt(prior.toBlock ?? prior.block) + 1n ||
      toBlock < fromBlock ||
      !Array.isArray(record.events) ||
      record.events.length > 10_000
    )
      throw Error('gross_flow_morpho_range_invalid')
    checkedTimestampMs(record.toObservedAt, 'gross_flow_morpho_range_time_invalid')
    for (const event of record.events) {
      if (event.event_kind === 'deposit' && event.flow_class === 'deposit_observed')
        deposits.push(event)
      else if (
        event.event_kind === 'withdraw' &&
        event.flow_class === 'external_receiver_unreconciled'
      )
        externalWithdrawals.push(event)
      else if (
        event.event_kind === 'withdraw' &&
        ['internal_force_deallocate', 'internal_vault_receiver'].includes(event.flow_class)
      )
        internalWithdrawals.push(event)
      else throw Error('gross_flow_morpho_event_class_invalid')
    }
    prior = record
  }
  const rangeSha256 = records.map((record) => record.sha256)
  const coverageEndMs = checkedTimestampMs(
    records.at(-1).toObservedAt,
    'gross_flow_morpho_range_time_invalid',
  )
  if (coverageEndMs <= coverageStartMs) throw Error('gross_flow_morpho_coverage_invalid')
  const unavailableDistribution = unavailableTimedDistribution('per_event_timestamps_not_recorded')
  const context = {
    state: 'single_provider_recorded_range',
    reason: null,
    requestedHorizonHours: horizonHours,
    source: {
      kind: 'sealed_local_morpho_v2_range_replay',
      completenessBasis: 'single_provider_rpc_returned_not_independently_proven',
      eventTimeResolution: 'range_boundaries_only',
      enrollmentSha256: enrollment.sha256,
      rangeSha256,
      sourceSetSha256: hash(JSON.stringify(rangeSha256)),
      coverageStartBlock: enrollment.block,
      coverageEndBlock: records.at(-1).toBlock,
      coverageStartMs,
      coverageEndMs,
    },
    grossDeposit: {
      recordedTotalWithinCoverage: rawTotal(deposits),
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: unavailableDistribution,
    },
    grossExternalReceiverWithdraw: {
      recordedTotalWithinCoverage: rawTotal(externalWithdrawals),
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: unavailableDistribution,
      reconciliation: 'receiver_not_vault_only_holder_payout_unreconciled',
    },
    excludedInternalWithdrawals: {
      ...rawTotal(internalWithdrawals),
      reason: 'vault_receiver_or_force_deallocation_internal_flow',
    },
    holderPayoutMeasured: false,
    holderExecutableCapacity: false,
    forecastValidated: false,
  }
  context.evidenceBindingSha256 = hash(
    JSON.stringify(morphoBindingInput(context, routeKey, destination, asset)),
  )
  return context
}

function routeBindingInput(context, routeKey, destination, asset) {
  return {
    schema: 'carry_secondary_route_flow_binding_v1',
    routeKey,
    destination,
    asset,
    requestedHorizonHours: context.requestedHorizonHours,
    venue: context.venue,
    attribution: context.attribution,
    source: {
      genesisSha256: context.source.genesisSha256,
      recordSha256: context.source.recordSha256,
      sourceSetSha256: context.source.sourceSetSha256,
      coverageStartBlock: context.source.coverageStartBlock,
      coverageEndBlock: context.source.coverageEndBlock,
      coverageStartMs: context.source.coverageStartMs,
      coverageEndMs: context.source.coverageEndMs,
      windowBoundaryConvention: context.source.windowBoundaryConvention,
    },
    legs: context.legs,
  }
}

/** Secondary route use stays in output-token units and separate from vault underlying flow. */
export function secondaryRouteFlowFromVerified({ pin, venue, records, horizonHours }) {
  assertHorizon(horizonHours)
  if (
    !pin ||
    venue?.name !== pin.venue ||
    !Array.isArray(records) ||
    !records.length ||
    records.length > 100_000 ||
    records[0]?.sha256 !== pin.genesisSha256
  )
    throw Error('gross_flow_secondary_route_source_invalid')
  const first = records[0]
  const last = records.at(-1)
  const coverageStartMs = Number(first.anchor?.timestamp) * 1_000
  const coverageEndMs = Number(last.end?.timestamp) * 1_000
  if (
    !Number.isSafeInteger(coverageStartMs) ||
    !Number.isSafeInteger(coverageEndMs) ||
    coverageEndMs <= coverageStartMs
  )
    throw Error('gross_flow_secondary_route_coverage_invalid')
  const recordSha256 = []
  let previous = null
  for (const [index, record] of records.entries()) {
    if (
      record.study !== 'venue-route-flow-v3' ||
      record.venue !== pin.venue ||
      record.sequence !== index + 1 ||
      record.previousSha256 !== (previous?.sha256 ?? null) ||
      !SHA.test(record.sha256 ?? '') ||
      !Array.isArray(record.events) ||
      !Array.isArray(record.before) ||
      !Array.isArray(record.after) ||
      record.before.length !== pin.legs.length ||
      record.after.length !== pin.legs.length
    )
      throw Error('gross_flow_secondary_route_record_invalid')
    for (const [legIndex, leg] of pin.legs.entries()) {
      if (
        record.before[legIndex].address !== leg.market ||
        record.after[legIndex].address !== leg.market ||
        record.before[legIndex].outputToken !== leg.outputAsset ||
        record.after[legIndex].outputToken !== leg.outputAsset ||
        record.before[legIndex].outputDecimals !== leg.outputDecimals ||
        record.after[legIndex].outputDecimals !== leg.outputDecimals
      )
        throw Error('gross_flow_secondary_route_leg_identity_invalid')
    }
    recordSha256.push(record.sha256)
    previous = record
  }
  const allEvents = records.flatMap((record) => record.events)
  if (
    allEvents.some(
      (event) =>
        !Number.isSafeInteger(event?.marketIndex) ||
        event.marketIndex < 0 ||
        event.marketIndex >= pin.legs.length,
    )
  )
    throw Error('gross_flow_secondary_route_event_index_invalid')
  const legs = pin.legs.map((leg, marketIndex) => {
    const events = allEvents.filter((event) => event.marketIndex === marketIndex)
    if (
      events.some(
        (event) =>
          event.market !== leg.market ||
          event.outputToken !== leg.outputAsset ||
          event.outputDecimals !== leg.outputDecimals ||
          event.scope !== leg.scope ||
          ![leg.exitDirection, leg.entryDirection].includes(event.direction),
      )
    )
      throw Error('gross_flow_secondary_route_event_identity_invalid')
    return {
      market: leg.market,
      outputAsset: leg.outputAsset,
      outputSymbol: leg.outputSymbol,
      outputDecimals: leg.outputDecimals,
      scope: leg.scope,
      exitDirection: leg.exitDirection,
      entryDirection: leg.entryDirection,
      grossExit: recordedTimedFlow(
        events.filter((event) => event.direction === leg.exitDirection),
        coverageStartMs,
        coverageEndMs,
        horizonHours,
      ),
      grossEntry: recordedTimedFlow(
        events.filter((event) => event.direction === leg.entryDirection),
        coverageStartMs,
        coverageEndMs,
        horizonHours,
      ),
    }
  })
  const context = {
    state: 'single_provider_recorded_range',
    reason: null,
    requestedHorizonHours: horizonHours,
    venue: pin.venue,
    attribution: pin.attribution,
    source: {
      kind: 'sealed_local_route_flow_v3_replay',
      completenessBasis: 'single_provider_rpc_returned_not_independently_proven',
      genesisSha256: pin.genesisSha256,
      recordSha256,
      sourceSetSha256: hash(JSON.stringify(recordSha256)),
      coverageStartBlock: first.fromBlock,
      coverageEndBlock: last.toBlock,
      coverageStartMs,
      coverageEndMs,
      windowBoundaryConvention: 'open_start_closed_end_utc_ms',
    },
    legs,
    subjectUnderlyingGrossFlowMeasured: false,
    holderAttributionAvailable: false,
    holderExecutableCapacity: false,
    forecastValidated: false,
  }
  context.evidenceBindingSha256 = hash(
    JSON.stringify(routeBindingInput(context, pin.routeKey, pin.destination, pin.subjectAsset)),
  )
  return context
}

function unavailable(reason, context = {}) {
  return {
    state: 'unavailable',
    reason,
    observedMaximumWithinRecordedCoverage: null,
    historicalFlowDistribution: { status: 'unavailable', reason },
    ...context,
  }
}

function unavailableRecordedContext(reason, sourceFailureCode = null) {
  return {
    state: 'unavailable',
    reason,
    ...(sourceFailureCode ? { sourceFailureCode } : {}),
    holderExecutableCapacity: false,
    forecastValidated: false,
  }
}

const morphoRouteKeys = new Set(frozenPins.morpho.routeKeys)
const secondaryRoutePins = Object.values(frozenPins.secondaryRouteFlows)
const secondaryRoutePinBySubject = new Map(
  secondaryRoutePins.map((pin) => [key(pin.routeKey, pin.destination), pin]),
)

function canonicalDirectDistribution(distribution) {
  if (distribution.status === 'historical_descriptive')
    return {
      status: distribution.status,
      method: distribution.method,
      intervalCount: distribution.intervalCount,
      lowRaw: distribution.lowRaw,
      middleRaw: distribution.middleRaw,
      highRaw: distribution.highRaw,
    }
  return {
    status: distribution.status,
    reason: distribution.reason,
    intervalCount: distribution.intervalCount ?? null,
  }
}

function canonicalDirectMaximum(maximum) {
  return maximum
    ? {
        amountRaw: maximum.amountRaw,
        startMs: maximum.startMs,
        endMs: maximum.endMs,
        horizonHours: maximum.horizonHours,
        eventCount: maximum.eventCount,
      }
    : null
}

function canonicalDirectEventVolume(event) {
  if (!event) return null
  if (event.status === 'unavailable') return { status: event.status, reason: event.reason }
  return {
    status: event.status,
    amountRaw: event.amountRaw,
    eventCount: event.eventCount,
    startMs: event.startMs,
    endMs: event.endMs,
  }
}

function directDirectionBindingInput(direction, horizonHours) {
  return {
    schema: 'carry_direct_flow_direction_binding_v1',
    routeKey: direction.routeKey,
    destination: direction.destination,
    horizonHours,
    source: {
      kind: direction.source.kind,
      completenessBasis: direction.source.completenessBasis,
      marketKey: direction.source.marketKey,
      flowKind: direction.source.flowKind,
      segmentSha256: direction.source.segmentSha256,
      sourceSetSha256: direction.source.sourceSetSha256,
      coverageStartMs: direction.source.coverageStartMs,
      coverageEndMs: direction.source.coverageEndMs,
      asset: direction.source.asset,
      assetDecimals: direction.source.assetDecimals,
      evidenceBindingSha256: direction.source.evidenceBindingSha256,
    },
    state: direction.state,
    reason: direction.reason,
    observedMaximumWithinRecordedCoverage: canonicalDirectMaximum(
      direction.observedMaximumWithinRecordedCoverage,
    ),
    historicalFlowDistribution: canonicalDirectDistribution(direction.historicalFlowDistribution),
    ambiguousEventCount: direction.ambiguousEventCount ?? null,
    observedEventVolumeWithinRecordedCoverage: canonicalDirectEventVolume(
      direction.observedEventVolumeWithinRecordedCoverage,
    ),
    corroboratedDisjointIntervalCount: direction.corroboratedDisjointIntervalCount ?? null,
    zeroMeaning: direction.zeroMeaning ?? null,
  }
}

function bindDirectDirection(direction, horizonHours) {
  return {
    ...direction,
    directionBindingSha256: hash(
      JSON.stringify(directDirectionBindingInput(direction, horizonHours)),
    ),
  }
}

/** Verify the exact documents passed to the projection; no detached summary input. */
export function directFlowDirection({ marketKey, flowKind, documents, horizonHours }) {
  const verified = verifyDirectSupplierFlowSegments(documents)
  const studies = flowKind === 'supply' ? [SUPPLY_STUDY, SUPPLY_STUDY_V2] : [STUDY, STUDY_V2]
  if (documents.some((row) => row.marketKey !== marketKey || !studies.includes(row.study)))
    throw Error('gross_flow_document_kind_mismatch')
  return directFlowDirectionFromVerified({ marketKey, flowKind, verified, documents, horizonHours })
}

/** Pure projection boundary for synthetic tests; the report never accepts this input directly. */
export function directFlowDirectionFromVerified({
  marketKey,
  flowKind,
  verified,
  documents,
  horizonHours,
}) {
  assertHorizon(horizonHours)
  if (!DIRECT_SUPPLIER_MARKETS[marketKey] || !['supply', 'withdraw'].includes(flowKind))
    throw Error('gross_flow_direct_source_invalid')
  const segmentSha256 = validSegmentHashes(documents)
  const horizonMs = horizonHours * HOUR_MS
  const coverage = verified?.coverage
  if (
    coverage?.marketKey !== marketKey ||
    !Number.isSafeInteger(coverage.startMs) ||
    !Number.isSafeInteger(coverage.endMs) ||
    coverage.endMs <= coverage.startMs
  )
    throw Error('gross_flow_direct_coverage_invalid')
  const market = DIRECT_SUPPLIER_MARKETS[marketKey]
  const routes = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (row) => row.kind === market.kind && row.routeKey === market.routeKey,
  )
  if (routes.length !== 1) throw Error('gross_flow_direct_identity_invalid')
  const route = routes[0]
  const events = flowKind === 'supply' ? verified.supplies : verified.withdrawals
  const source = {
    kind: 'sealed_public_receipt_replay',
    completenessBasis: 'two_public_rpc_origins_agree_not_absolute_completeness',
    marketKey,
    flowKind,
    segmentSha256,
    sourceSetSha256: hash(JSON.stringify(segmentSha256)),
    coverageStartMs: coverage.startMs,
    coverageEndMs: coverage.endMs,
    asset: route.asset.toLowerCase(),
    assetDecimals: market.decimals,
    evidenceBindingSha256: hash(
      JSON.stringify({
        routeKey: route.routeKey,
        destination: route.destination.toLowerCase(),
        asset: route.asset.toLowerCase(),
        assetDecimals: market.decimals,
        horizonHours,
        flowKind,
        coverageStartMs: coverage.startMs,
        coverageEndMs: coverage.endMs,
        segmentSha256,
      }),
    ),
  }
  const identity = {
    routeKey: route.routeKey,
    destination: route.destination.toLowerCase(),
    source,
  }
  // A verified but short or incomplete source can still identify the market;
  // it contributes no complete-horizon maximum or flow band.
  const ambiguousComet =
    flowKind === 'withdraw' &&
    marketKey === 'compoundV3Usdc' &&
    verified.unclassifiedWithdrawals?.length > 0
  if (!completeCoverage(coverage, horizonMs) && !ambiguousComet) {
    return bindDirectDirection(
      {
        ...identity,
        state: 'partial_corroborated_range',
        reason:
          coverage.endMs - coverage.startMs < horizonMs
            ? 'coverage_shorter_than_horizon'
            : 'coverage_not_complete',
        observedMaximumWithinRecordedCoverage: null,
        historicalFlowDistribution: {
          status: 'unavailable',
          reason: 'no_corroborated_horizon_interval',
        },
      },
      horizonHours,
    )
  }
  const summary =
    flowKind === 'supply'
      ? summarizeVerifiedDirectSupplierSupply(marketKey, verified)
      : summarizeVerifiedDirectSupplierFlow(marketKey, verified)
  // Comet Withdraw logs may be a mix of supplier payouts and debt borrows.
  // The event volume is useful context, but cannot enter supplier outflow bands.
  if (flowKind === 'withdraw' && summary.unclassifiedWithdrawalCount > 0) {
    return bindDirectDirection(
      {
        ...identity,
        state: 'ambiguous_event_volume',
        reason: 'unclassified_compound_withdraw_events',
        ambiguousEventCount: summary.unclassifiedWithdrawalCount,
        observedEventVolumeWithinRecordedCoverage:
          horizonHours === 24 ? summary.max24hGrossCometWithdrawEvents : null,
        observedMaximumWithinRecordedCoverage: null,
        historicalFlowDistribution: {
          status: 'unavailable',
          reason: 'unclassified_compound_withdraw_events',
        },
      },
      horizonHours,
    )
  }
  const maximum =
    horizonHours === 24
      ? flowKind === 'supply'
        ? summary.max24hGrossUnderlyingInflow
        : summary.max24hGrossWithdrawal
      : flowKind === 'supply'
        ? maxDirectSupplierSupplyWindow({
            marketKey,
            coverage,
            supplies: events,
            durationMs: horizonMs,
          })
        : maxDirectSupplierWithdrawalWindow({
            marketKey,
            coverage,
            withdrawals: events,
            durationMs: horizonMs,
          })
  if (maximum?.status === 'unavailable' || !RAW.test(maximum?.amountRaw ?? ''))
    throw Error('gross_flow_complete_maximum_invalid')
  const disjoint = intervalAmounts(coverage, events, horizonMs)
  return bindDirectDirection(
    {
      ...identity,
      state: 'two_provider_corroborated_sample',
      reason: null,
      observedMaximumWithinRecordedCoverage: {
        amountRaw: maximum.amountRaw,
        startMs: maximum.startMs,
        endMs: maximum.endMs,
        horizonHours,
        eventCount: maximum.eventCount ?? maximum.payoutCount,
      },
      historicalFlowDistribution: historicalDistribution(disjoint),
      corroboratedDisjointIntervalCount: disjoint.length,
      zeroMeaning: 'zero_matching_events_returned_within_recorded_coverage',
    },
    horizonHours,
  )
}

function cashContext(subject, observations) {
  const matched = []
  for (const receipt of observations) {
    if (
      receipt.metric !== 'aggregate_underlying_cash_raw_proxy' ||
      receipt.competingFlow !== 'not_measured'
    )
      throw Error('gross_flow_cash_metric_invalid')
    const row = receipt.subjects.find(
      (candidate) =>
        candidate.routeKey === subject.route_key &&
        candidate.destination?.toLowerCase() === subject.destination,
    )
    if (
      row?.state === 'observed' &&
      row.asset?.toLowerCase() === subject.asset &&
      Number.isInteger(row.assetDecimals) &&
      row.assetDecimals >= 0 &&
      row.assetDecimals <= 36 &&
      SHA.test(receipt.receiptSha256 ?? '')
    )
      matched.push({ sha256: receipt.receiptSha256, decimals: row.assetDecimals })
  }
  if (matched.length < 2 || new Set(matched.map((row) => row.decimals)).size !== 1) return null
  return {
    state: 'aggregate_net_only_context',
    metric: 'aggregate_underlying_cash_raw_proxy',
    snapshotCount: matched.length,
    assetDecimals: matched[0].decimals,
    firstReceiptSha256: matched[0].sha256,
    latestReceiptSha256: matched.at(-1).sha256,
    sourceSetSha256: hash(JSON.stringify(matched.map((row) => row.sha256))),
    grossFlowMeasured: false,
  }
}

/** Full frozen manifest; every subject has an explicit flow state. */
export function buildHistoricalGrossFlowReport({
  manifest,
  cashObservations = [],
  direct = {},
  morpho = {},
  secondaryRouteFlows = {},
  horizonHours,
  cashFailure = null,
}) {
  assertHorizon(horizonHours)
  validateManifest(manifest)
  if (
    manifest.sha256 !== frozenPins.manifestSha256 ||
    frozenIdentityDigest(manifest.subjects) !== frozenPins.identitySetSha256
  )
    throw Error('gross_flow_frozen_identity_set_mismatch')
  if (!Array.isArray(cashObservations)) throw Error('gross_flow_cash_source_invalid')
  const directByKey = new Map()
  for (const [marketKey, record] of Object.entries(direct)) {
    const pinned = DIRECT_SUPPLIER_MARKETS[marketKey]
    if (!pinned || marketKey === 'aaveV3Usde') throw Error('gross_flow_direct_market_not_frozen')
    for (const flowKind of ['supply', 'withdraw']) {
      const value = record?.[flowKind]
      if (!value) continue
      const expectedSubjects = manifest.subjects.filter(
        (row) => row.route_key === pinned.routeKey && row.source_kind === 'market',
      )
      if (expectedSubjects.length !== 1) throw Error('gross_flow_direct_subject_unknown')
      const expected = expectedSubjects[0]
      let measured
      try {
        if (value.failure) throw Error(value.failure)
        measured = directFlowDirection({
          marketKey,
          flowKind,
          documents: value.documents,
          horizonHours,
        })
      } catch (error) {
        const code = String(error instanceof Error ? error.message : 'source_replay_failed').split(
          /\s+/,
        )[0]
        measured = unavailable('source_replay_failed', {
          sourceFailureCode: /^[a-zA-Z0-9_:-]+$/.test(code) ? code : 'source_replay_failed',
        })
      }
      if (
        measured.source &&
        (measured.routeKey !== expected.route_key ||
          measured.destination !== expected.destination ||
          measured.source.asset !== expected.asset)
      )
        throw Error('gross_flow_direct_identity_mismatch')
      const subjectKey = key(expected.route_key, expected.destination)
      const entry = directByKey.get(subjectKey) ?? {}
      if (entry[flowKind]) throw Error('gross_flow_duplicate_direct_source')
      entry[flowKind] = measured
      directByKey.set(subjectKey, entry)
    }
  }
  const morphoByKey = new Map()
  for (const entry of morpho.entries ?? []) {
    const routeKey = entry?.subject?.routeKeys?.[0]
    const destination = entry?.subject?.vault
    const asset = entry?.subject?.asset
    if (
      entry?.subject?.routeKeys?.length !== 1 ||
      !morphoRouteKeys.has(routeKey) ||
      !ADDRESS.test(destination ?? '') ||
      !ADDRESS.test(asset ?? '')
    )
      throw Error('gross_flow_morpho_subject_invalid')
    const expected = manifest.subjects.find(
      (row) => row.route_key === routeKey && row.destination === destination,
    )
    if (!expected || expected.asset !== asset) throw Error('gross_flow_morpho_identity_mismatch')
    const subjectKey = key(routeKey, destination)
    if (morphoByKey.has(subjectKey)) throw Error('gross_flow_duplicate_morpho_source')
    let context
    try {
      if (entry.failure) throw Error(entry.failure)
      context = morphoRecordedRangeFromVerified({
        routeKey,
        destination,
        asset,
        enrollment: entry.enrollment,
        records: entry.records,
        horizonHours,
      })
    } catch (error) {
      context = unavailableRecordedContext(
        'source_replay_failed',
        failureCode(error, 'morpho_source_replay_failed'),
      )
    }
    morphoByKey.set(subjectKey, context)
  }
  const secondaryByKey = new Map()
  for (const entry of secondaryRouteFlows.entries ?? []) {
    const pin = frozenPins.secondaryRouteFlows[entry?.venue?.name]
    if (!pin) throw Error('gross_flow_secondary_route_pin_invalid')
    const expected = manifest.subjects.find(
      (row) => row.route_key === pin.routeKey && row.destination === pin.destination,
    )
    if (!expected || expected.asset !== pin.subjectAsset)
      throw Error('gross_flow_secondary_route_identity_mismatch')
    const subjectKey = key(pin.routeKey, pin.destination)
    if (secondaryByKey.has(subjectKey)) throw Error('gross_flow_duplicate_secondary_route_source')
    let context
    try {
      if (entry.failure) throw Error(entry.failure)
      context = secondaryRouteFlowFromVerified({
        pin,
        venue: entry.venue,
        records: entry.records,
        horizonHours,
      })
    } catch (error) {
      context = unavailableRecordedContext(
        'source_replay_failed',
        failureCode(error, 'secondary_route_source_replay_failed'),
      )
    }
    secondaryByKey.set(subjectKey, context)
  }
  const morphoFailure = morpho.failure
    ? failureCode(Error(morpho.failure), 'morpho_source_replay_failed')
    : null
  const secondaryRouteFailure = secondaryRouteFlows.failure
    ? failureCode(Error(secondaryRouteFlows.failure), 'secondary_route_source_replay_failed')
    : null
  const subjects = manifest.subjects.map((subject) => {
    const subjectKey = key(subject.route_key, subject.destination)
    const directEntry = directByKey.get(subjectKey) ?? {}
    const cash = cashContext(subject, cashObservations)
    const directions = {}
    for (const [name, flowKind] of [
      ['inflow', 'supply'],
      ['outflow', 'withdraw'],
    ]) {
      const candidate = directEntry[flowKind]
      if (candidate?.source && candidate.source.asset !== subject.asset)
        throw Error('gross_flow_direct_asset_mismatch')
      directions[name] =
        candidate ??
        (cash
          ? unavailable('gross_flow_not_integrated_in_this_report', {
              state: 'aggregate_net_only_context',
            })
          : unavailable('no_integrated_gross_flow_source'))
    }
    const decimals =
      directEntry.supply?.source?.assetDecimals ??
      directEntry.withdraw?.source?.assetDecimals ??
      cash?.assetDecimals ??
      null
    if (cash && decimals !== cash.assetDecimals) throw Error('gross_flow_cash_decimals_mismatch')
    return {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: decimals,
      horizonHours,
      inflow: directions.inflow,
      outflow: directions.outflow,
      aggregateCashContext: cash,
      morphoRecordedRange: morphoRouteKeys.has(subject.route_key)
        ? (morphoByKey.get(subjectKey) ??
          unavailableRecordedContext(
            morphoFailure ? 'source_replay_failed' : 'no_integrated_morpho_recorded_source',
            morphoFailure,
          ))
        : null,
      secondaryRouteFlow: secondaryRoutePinBySubject.has(subjectKey)
        ? (secondaryByKey.get(subjectKey) ??
          unavailableRecordedContext(
            secondaryRouteFailure ? 'source_replay_failed' : 'no_integrated_secondary_route_source',
            secondaryRouteFailure,
          ))
        : null,
      holderExecutableCapacity: false,
      forecastValidated: false,
    }
  })
  for (const subjectKey of directByKey.keys()) {
    if (!manifest.subjects.some((row) => key(row.route_key, row.destination) === subjectKey))
      throw Error('gross_flow_direct_subject_unknown')
  }
  return {
    schema: GROSS_FLOW_OUTLOOK_SCHEMA,
    scope: 'frozen_august_25_route_67_subjects',
    claimClass: 'retrospective_recorded_gross_flow_only',
    manifestSha256: manifest.sha256,
    identitySetSha256: frozenPins.identitySetSha256,
    horizonHours,
    cashSource: cashFailure
      ? { status: 'unavailable', reason: cashFailure }
      : { status: 'verified', receiptCount: cashObservations.length },
    coverage: {
      routeGroups: new Set(subjects.map((row) => row.routeKey)).size,
      exactSubjects: subjects.length,
      corroboratedGrossInflowSubjects: subjects.filter(
        (row) => row.inflow.state === 'two_provider_corroborated_sample',
      ).length,
      corroboratedGrossOutflowSubjects: subjects.filter(
        (row) => row.outflow.state === 'two_provider_corroborated_sample',
      ).length,
      ambiguousOutflowSubjects: subjects.filter(
        (row) => row.outflow.state === 'ambiguous_event_volume',
      ).length,
      aggregateNetOnlySubjects: subjects.filter(
        (row) =>
          row.inflow.state === 'aggregate_net_only_context' &&
          row.outflow.state === 'aggregate_net_only_context',
      ).length,
      morphoRecordedRangeSubjects: subjects.filter(
        (row) => row.morphoRecordedRange?.state === 'single_provider_recorded_range',
      ).length,
      secondaryRouteFlowSubjects: subjects.filter(
        (row) => row.secondaryRouteFlow?.state === 'single_provider_recorded_range',
      ).length,
    },
    limits: {
      holderExecutableCapacity: false,
      forecastValidated: false,
      historicalDescriptiveOnly: true,
      expectedFlowAvailable: false,
    },
    subjects,
  }
}

export async function readOfflineHistoricalGrossFlow({ horizonHours = 24, readers = {} } = {}) {
  assertHorizon(horizonHours)
  const manifest = await (readers.manifest ?? buildSubjectManifest)()
  let cashObservations = []
  let cashFailure = null
  try {
    cashObservations = (readers.cash ?? readLocalCarryCashObservations)(manifest)
  } catch (error) {
    const code = String(error instanceof Error ? error.message : 'cash_source_failed').split(
      /\s+/,
    )[0]
    cashFailure = /^[a-zA-Z0-9_:-]+$/.test(code) ? code : 'cash_source_failed'
  }
  const direct = {}
  for (const marketKey of ['aaveV3Usdc', 'sparkLendUsdt', 'compoundV3Usdc']) {
    direct[marketKey] = {}
    for (const flowKind of ['supply', 'withdraw']) {
      try {
        const documents = (readers.documents ?? readDirectSupplierFlowDocuments)(
          marketKey,
          undefined,
          flowKind,
        )
        if (!documents.length) continue
        direct[marketKey][flowKind] = { documents }
      } catch (error) {
        const code = String(error instanceof Error ? error.message : 'source_replay_failed').split(
          /\s+/,
        )[0]
        direct[marketKey][flowKind] = {
          failure: /^[a-zA-Z0-9_:-]+$/.test(code) ? code : 'source_replay_failed',
        }
      }
    }
  }
  const morpho = { entries: [] }
  try {
    const morphoSubjects = await (readers.morphoSubjects ?? loadMorphoFlowSubjects)()
    if (!Array.isArray(morphoSubjects) || morphoSubjects.length !== frozenPins.morpho.exactVaults)
      throw Error('gross_flow_morpho_subject_count_invalid')
    const enrollment = await (readers.morphoEnrollment ?? verifyLocalMorphoEnrollment)(
      morphoSubjects,
    )
    if (!enrollment || enrollment.sha256 !== frozenPins.morpho.enrollmentSha256)
      throw Error('gross_flow_morpho_enrollment_pin_mismatch')
    for (const subject of morphoSubjects) {
      try {
        const records = await (readers.morphoVault ?? verifyLocalMorphoVault)(subject, enrollment)
        morpho.entries.push({ subject, enrollment, records })
      } catch (error) {
        morpho.entries.push({
          subject,
          failure: failureCode(error, 'morpho_source_replay_failed'),
        })
      }
    }
  } catch (error) {
    morpho.failure = failureCode(error, 'morpho_source_replay_failed')
  }
  const secondaryRouteFlows = { entries: [] }
  try {
    const venues = await (readers.routeVenues ?? loadConfig)()
    if (!Array.isArray(venues)) throw Error('gross_flow_secondary_route_config_invalid')
    const store = readers.routeStore ?? localRouteFlowStore()
    for (const pin of secondaryRoutePins) {
      const matched = venues.filter((venue) => venue.name === pin.venue && venue.enabled === true)
      if (matched.length !== 1) throw Error('gross_flow_secondary_route_config_missing')
      const venue = matched[0]
      try {
        const records = await (readers.routeRecords ?? ((selected) => store.read(selected)))(venue)
        secondaryRouteFlows.entries.push({ venue, records })
      } catch (error) {
        secondaryRouteFlows.entries.push({
          venue,
          failure: failureCode(error, 'secondary_route_source_replay_failed'),
        })
      }
    }
  } catch (error) {
    secondaryRouteFlows.failure = failureCode(error, 'secondary_route_source_replay_failed')
  }
  return buildHistoricalGrossFlowReport({
    manifest,
    cashObservations,
    direct,
    morpho,
    secondaryRouteFlows,
    horizonHours,
    cashFailure,
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const hours = Number(process.argv[2] ?? '24')
  readOfflineHistoricalGrossFlow({ horizonHours: hours })
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${String(error?.message ?? 'gross_flow_report_failed').split(' ')[0]}\n`,
      )
      process.exitCode = 1
    })
}
