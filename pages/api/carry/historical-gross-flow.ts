import type { NextApiRequest, NextApiResponse } from 'next'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import frozenPins from '@/lib/carry/frozenGrossFlowPins'

const execFileAsync = promisify(execFile)
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SHA = /^[0-9a-f]{64}$/
const RAW = /^(0|[1-9]\d*)$/
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const CLOUD = [
  'VERCEL',
  'VERCEL_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'K_SERVICE',
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
]
const CACHE_MS = 30_000
type Query = { routeKey: string; destination: string; horizonHours: 24 | 168 }
type Report = {
  schema: string
  scope: string
  claimClass: string
  manifestSha256: string
  identitySetSha256: string
  horizonHours: number
  coverage: {
    routeGroups: number
    exactSubjects: number
    corroboratedGrossInflowSubjects: number
    corroboratedGrossOutflowSubjects: number
    ambiguousOutflowSubjects: number
    aggregateNetOnlySubjects: number
    morphoRecordedRangeSubjects: number
    secondaryRouteFlowSubjects: number
  }
  limits: {
    holderExecutableCapacity: false
    forecastValidated: false
    historicalDescriptiveOnly: true
    expectedFlowAvailable: false
  }
  subjects: Array<
    Record<string, unknown> & {
      routeKey: string
      destination: string
      asset: string
      assetDecimals: number | null
      horizonHours: number
    }
  >
}
let cached: { horizonHours: number; at: number; report: Report } | null = null

type Direction = {
  state?: string
  reason?: string | null
  sourceFailureCode?: string
  ambiguousEventCount?: number
  observedEventVolumeWithinRecordedCoverage?: {
    status?: string
    reason?: string
    amountRaw?: string
    eventCount?: number
    startMs?: number
    endMs?: number
  } | null
  observedMaximumWithinRecordedCoverage?: {
    amountRaw?: string
    startMs?: number
    endMs?: number
    horizonHours?: number
    eventCount?: number
  } | null
  historicalFlowDistribution?: {
    status?: string
    reason?: string
    method?: string
    intervalCount?: number
    lowRaw?: string
    middleRaw?: string
    highRaw?: string
  }
  corroboratedDisjointIntervalCount?: number
  zeroMeaning?: string
  directionBindingSha256?: string
  source?: {
    kind?: string
    completenessBasis?: string
    marketKey?: string
    flowKind?: string
    asset?: string
    assetDecimals?: number
    sourceSetSha256?: string
    evidenceBindingSha256?: string
    segmentSha256?: string[]
    coverageStartMs?: number
    coverageEndMs?: number
  }
}

const DIRECT = {
  'USDC → supply on Aave V3': {
    marketKey: 'aaveV3Usdc',
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    decimals: 6,
  },
  'USDT → supply on Spark': {
    marketKey: 'sparkLendUsdt',
    destination: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    decimals: 6,
  },
  'USDC → supply on Compound v3': {
    marketKey: 'compoundV3Usdc',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    decimals: 6,
  },
} as const

function validSource(
  source: Direction['source'],
  subject: Report['subjects'][number],
  flowKind: 'supply' | 'withdraw',
  horizonHours: number,
) {
  if (!source) return false
  const pinned = DIRECT[subject.routeKey as keyof typeof DIRECT]
  if (
    !pinned ||
    subject.destination.toLowerCase() !== pinned.destination ||
    source.marketKey !== pinned.marketKey ||
    source.flowKind !== flowKind ||
    source.kind !== 'sealed_public_receipt_replay' ||
    source.completenessBasis !== 'two_public_rpc_origins_agree_not_absolute_completeness' ||
    source.asset !== subject.asset ||
    source.assetDecimals !== subject.assetDecimals ||
    source.assetDecimals !== pinned.decimals ||
    !Number.isSafeInteger(source.coverageStartMs) ||
    !Number.isSafeInteger(source.coverageEndMs) ||
    typeof source.coverageStartMs !== 'number' ||
    typeof source.coverageEndMs !== 'number' ||
    source.coverageEndMs <= source.coverageStartMs ||
    !Array.isArray(source.segmentSha256) ||
    !source.segmentSha256.length ||
    source.segmentSha256.some((item) => !SHA.test(item)) ||
    source.sourceSetSha256 !== sha(JSON.stringify(source.segmentSha256))
  )
    return false
  const binding = {
    routeKey: subject.routeKey,
    destination: subject.destination.toLowerCase(),
    asset: subject.asset,
    assetDecimals: subject.assetDecimals,
    horizonHours,
    flowKind,
    coverageStartMs: source.coverageStartMs,
    coverageEndMs: source.coverageEndMs,
    segmentSha256: source.segmentSha256,
  }
  return source.evidenceBindingSha256 === sha(JSON.stringify(binding))
}

function canonicalDirectDistribution(distribution: Direction['historicalFlowDistribution']) {
  if (distribution?.status === 'historical_descriptive')
    return {
      status: distribution.status,
      method: distribution.method,
      intervalCount: distribution.intervalCount,
      lowRaw: distribution.lowRaw,
      middleRaw: distribution.middleRaw,
      highRaw: distribution.highRaw,
    }
  return {
    status: distribution?.status,
    reason: distribution?.reason,
    intervalCount: distribution?.intervalCount ?? null,
  }
}

function canonicalDirectMaximum(maximum: Direction['observedMaximumWithinRecordedCoverage']) {
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

function canonicalDirectEventVolume(event: Direction['observedEventVolumeWithinRecordedCoverage']) {
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

function validDirectDirectionBinding(
  direction: Direction,
  source: NonNullable<Direction['source']>,
  subject: Report['subjects'][number],
  horizonHours: number,
) {
  const binding = {
    schema: 'carry_direct_flow_direction_binding_v1',
    routeKey: subject.routeKey,
    destination: subject.destination,
    horizonHours,
    source: {
      kind: source.kind,
      completenessBasis: source.completenessBasis,
      marketKey: source.marketKey,
      flowKind: source.flowKind,
      segmentSha256: source.segmentSha256,
      sourceSetSha256: source.sourceSetSha256,
      coverageStartMs: source.coverageStartMs,
      coverageEndMs: source.coverageEndMs,
      asset: source.asset,
      assetDecimals: source.assetDecimals,
      evidenceBindingSha256: source.evidenceBindingSha256,
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
  return direction.directionBindingSha256 === sha(JSON.stringify(binding))
}

function validDirection(
  value: unknown,
  subject: Report['subjects'][number],
  flowKind: 'supply' | 'withdraw',
  horizonHours: number,
) {
  if (!value || typeof value !== 'object') return false
  const direction = value as Direction
  const state = direction.state
  const distribution = direction.historicalFlowDistribution
  const source = direction.source
  const maximum = direction.observedMaximumWithinRecordedCoverage
  if (state === 'unavailable' || state === 'aggregate_net_only_context') {
    const reason =
      state === 'unavailable'
        ? ['source_replay_failed', 'no_integrated_gross_flow_source'].includes(
            direction.reason ?? '',
          )
        : direction.reason === 'gross_flow_not_integrated_in_this_report'
    return (
      reason &&
      !source &&
      maximum === null &&
      distribution?.status === 'unavailable' &&
      distribution.reason === direction.reason &&
      (direction.reason === 'source_replay_failed'
        ? typeof direction.sourceFailureCode === 'string' &&
          /^[a-zA-Z0-9_:-]+$/.test(direction.sourceFailureCode)
        : direction.sourceFailureCode === undefined)
    )
  }
  if (
    !validSource(source, subject, flowKind, horizonHours) ||
    !source ||
    maximum === undefined ||
    !validDirectDirectionBinding(direction, source, subject, horizonHours)
  )
    return false
  if (state === 'partial_corroborated_range') {
    const shorter = source.coverageEndMs! - source.coverageStartMs! < horizonHours * 3_600_000
    return (
      direction.reason === (shorter ? 'coverage_shorter_than_horizon' : 'coverage_not_complete') &&
      maximum === null &&
      distribution?.status === 'unavailable' &&
      distribution.reason === 'no_corroborated_horizon_interval'
    )
  }
  if (state === 'ambiguous_event_volume') {
    if (
      flowKind !== 'withdraw' ||
      source.marketKey !== 'compoundV3Usdc' ||
      direction.reason !== 'unclassified_compound_withdraw_events' ||
      !Number.isSafeInteger(direction.ambiguousEventCount) ||
      (direction.ambiguousEventCount ?? 0) < 1 ||
      maximum !== null ||
      distribution?.status !== 'unavailable' ||
      distribution.reason !== direction.reason
    )
      return false
    const event = direction.observedEventVolumeWithinRecordedCoverage
    if (event === null) return horizonHours === 168
    if (!event || horizonHours !== 24) return false
    if (event.status === 'unavailable') return event.reason === 'coverage_under_24h'
    return (
      event.status === 'observed' &&
      RAW.test(event.amountRaw ?? '') &&
      Number.isSafeInteger(event.eventCount) &&
      typeof event.startMs === 'number' &&
      typeof event.endMs === 'number' &&
      event.startMs >= source.coverageStartMs! &&
      event.endMs <= source.coverageEndMs! &&
      event.endMs - event.startMs === horizonHours * 3_600_000
    )
  }
  if (
    state !== 'two_provider_corroborated_sample' ||
    direction.reason !== null ||
    !maximum ||
    !RAW.test(maximum.amountRaw ?? '') ||
    !Number.isSafeInteger(maximum.eventCount) ||
    maximum.horizonHours !== horizonHours ||
    typeof maximum.startMs !== 'number' ||
    typeof maximum.endMs !== 'number' ||
    maximum.startMs < source.coverageStartMs! ||
    maximum.endMs > source.coverageEndMs! ||
    maximum.endMs - maximum.startMs !== horizonHours * 3_600_000 ||
    direction.zeroMeaning !== 'zero_matching_events_returned_within_recorded_coverage'
  )
    return false
  const bins = Math.floor(
    (source.coverageEndMs! - source.coverageStartMs!) / (horizonHours * 3_600_000),
  )
  if (
    !Number.isSafeInteger(direction.corroboratedDisjointIntervalCount) ||
    direction.corroboratedDisjointIntervalCount !== bins ||
    bins < 1
  )
    return false
  if (distribution?.status === 'unavailable')
    return (
      bins < 3 &&
      distribution.intervalCount === bins &&
      distribution.reason === 'fewer_than_three_corroborated_disjoint_intervals'
    )
  if (
    distribution?.status !== 'historical_descriptive' ||
    bins < 3 ||
    distribution.method !== 'p10_median_p90_of_nonoverlapping_corroborated_intervals' ||
    distribution.intervalCount !== bins ||
    ![distribution.lowRaw, distribution.middleRaw, distribution.highRaw].every((raw) =>
      RAW.test(raw ?? ''),
    )
  )
    return false
  return (
    BigInt(distribution.lowRaw!) <= BigInt(distribution.middleRaw!) &&
    BigInt(distribution.middleRaw!) <= BigInt(distribution.highRaw!)
  )
}

function localRequest(req: NextApiRequest) {
  if (CLOUD.some((name) => process.env[name])) return false
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return false
  const host = req.headers.host
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false
  const port = host.match(/:(\d+)$/)?.[1]
  if (port && Number(port) > 65_535) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (!req.headers.origin) return true
  try {
    const origin = new URL(req.headers.origin)
    return (
      ['http:', 'https:'].includes(origin.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) &&
      origin.host.toLowerCase() === host.toLowerCase()
    )
  } catch {
    return false
  }
}

export function parseGrossFlowQuery(query: NextApiRequest['query']): Query | null {
  if (Object.keys(query).length !== 3) return null
  const { routeKey, destination, horizonHours } = query
  if (
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 200 ||
    routeKey !== routeKey.trim() ||
    /[\x00-\x1f\x7f]/.test(routeKey) ||
    typeof destination !== 'string' ||
    !ADDRESS.test(destination) ||
    !['24', '168'].includes(String(horizonHours)) ||
    typeof horizonHours !== 'string'
  )
    return null
  return {
    routeKey,
    destination: destination.toLowerCase(),
    horizonHours: Number(horizonHours) as 24 | 168,
  }
}

function validCashContext(value: unknown, subject: Report['subjects'][number]) {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const cash = value as Record<string, unknown>
  return (
    cash.state === 'aggregate_net_only_context' &&
    cash.metric === 'aggregate_underlying_cash_raw_proxy' &&
    cash.grossFlowMeasured === false &&
    Number.isSafeInteger(cash.snapshotCount) &&
    (cash.snapshotCount as number) >= 2 &&
    cash.assetDecimals === subject.assetDecimals &&
    [cash.firstReceiptSha256, cash.latestReceiptSha256, cash.sourceSetSha256].every(
      (value) => typeof value === 'string' && SHA.test(value),
    )
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validCount(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validRecordedTotal(value: unknown) {
  const total = asRecord(value)
  return Boolean(total && RAW.test(String(total.amountRaw ?? '')) && validCount(total.eventCount))
}

function validUnavailableRecordedContext(value: Record<string, unknown>) {
  if (
    value.state !== 'unavailable' ||
    value.holderExecutableCapacity !== false ||
    value.forecastValidated !== false
  )
    return false
  if (value.reason === 'source_replay_failed')
    return (
      typeof value.sourceFailureCode === 'string' &&
      /^[a-zA-Z0-9_:-]+$/.test(value.sourceFailureCode)
    )
  return (
    ['no_integrated_morpho_recorded_source', 'no_integrated_secondary_route_source'].includes(
      String(value.reason ?? ''),
    ) && value.sourceFailureCode === undefined
  )
}

function canonicalMorphoGross(value: Record<string, unknown>, reconciliation = false) {
  const distribution = asRecord(value.historicalFlowDistribution)!
  return {
    recordedTotalWithinCoverage: {
      amountRaw: (value.recordedTotalWithinCoverage as Record<string, unknown>).amountRaw,
      eventCount: (value.recordedTotalWithinCoverage as Record<string, unknown>).eventCount,
    },
    observedMaximumWithinRecordedCoverage: null,
    historicalFlowDistribution: {
      status: distribution.status,
      reason: distribution.reason,
      intervalCount: distribution.intervalCount,
    },
    ...(reconciliation ? { reconciliation: value.reconciliation } : {}),
  }
}

function validMorphoGross(value: unknown, reconciliation = false) {
  const flow = asRecord(value)
  const distribution = asRecord(flow?.historicalFlowDistribution)
  return Boolean(
    flow &&
    validRecordedTotal(flow.recordedTotalWithinCoverage) &&
    flow.observedMaximumWithinRecordedCoverage === null &&
    distribution?.status === 'unavailable' &&
    distribution.reason === 'per_event_timestamps_not_recorded' &&
    distribution.intervalCount === 0 &&
    (reconciliation
      ? flow.reconciliation === 'receiver_not_vault_only_holder_payout_unreconciled'
      : flow.reconciliation === undefined),
  )
}

function validMorphoRecordedRange(
  value: unknown,
  subject: Report['subjects'][number],
  horizonHours: number,
) {
  const applicable = frozenPins.morpho.routeKeys.includes(
    subject.routeKey as (typeof frozenPins.morpho.routeKeys)[number],
  )
  if (!applicable) return value === null
  const context = asRecord(value)
  if (!context) return false
  if (context.state === 'unavailable') return validUnavailableRecordedContext(context)
  const source = asRecord(context.source)
  const deposit = asRecord(context.grossDeposit)
  const external = asRecord(context.grossExternalReceiverWithdraw)
  const internal = asRecord(context.excludedInternalWithdrawals)
  const ranges = source?.rangeSha256
  if (
    context.state !== 'single_provider_recorded_range' ||
    context.reason !== null ||
    context.requestedHorizonHours !== horizonHours ||
    context.holderPayoutMeasured !== false ||
    context.holderExecutableCapacity !== false ||
    context.forecastValidated !== false ||
    !source ||
    source.kind !== 'sealed_local_morpho_v2_range_replay' ||
    source.completenessBasis !== 'single_provider_rpc_returned_not_independently_proven' ||
    source.eventTimeResolution !== 'range_boundaries_only' ||
    source.enrollmentSha256 !== frozenPins.morpho.enrollmentSha256 ||
    !Array.isArray(ranges) ||
    ranges.length < 1 ||
    ranges.length > 100_000 ||
    ranges.some((value) => typeof value !== 'string' || !SHA.test(value)) ||
    source.sourceSetSha256 !== sha(JSON.stringify(ranges)) ||
    !RAW.test(String(source.coverageStartBlock ?? '')) ||
    !RAW.test(String(source.coverageEndBlock ?? '')) ||
    BigInt(source.coverageEndBlock as string) < BigInt(source.coverageStartBlock as string) ||
    !Number.isSafeInteger(source.coverageStartMs) ||
    !Number.isSafeInteger(source.coverageEndMs) ||
    (source.coverageEndMs as number) <= (source.coverageStartMs as number) ||
    !deposit ||
    !external ||
    !internal ||
    !validMorphoGross(deposit) ||
    !validMorphoGross(external, true) ||
    !validRecordedTotal(internal) ||
    internal.reason !== 'vault_receiver_or_force_deallocation_internal_flow'
  )
    return false
  const binding = {
    schema: 'carry_morpho_recorded_range_binding_v1',
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    requestedHorizonHours: context.requestedHorizonHours,
    source: {
      enrollmentSha256: source.enrollmentSha256,
      rangeSha256: ranges,
      sourceSetSha256: source.sourceSetSha256,
      coverageStartBlock: source.coverageStartBlock,
      coverageEndBlock: source.coverageEndBlock,
      coverageStartMs: source.coverageStartMs,
      coverageEndMs: source.coverageEndMs,
    },
    grossDeposit: canonicalMorphoGross(deposit),
    grossExternalReceiverWithdraw: canonicalMorphoGross(external, true),
    excludedInternalWithdrawals: {
      amountRaw: internal.amountRaw,
      eventCount: internal.eventCount,
      reason: internal.reason,
    },
  }
  return context.evidenceBindingSha256 === sha(JSON.stringify(binding))
}

function canonicalTimedFlow(value: Record<string, unknown>) {
  const total = value.recordedTotalWithinCoverage as Record<string, unknown>
  const maximum = asRecord(value.observedMaximumWithinRecordedCoverage)
  const distribution = asRecord(value.historicalFlowDistribution)!
  return {
    recordedTotalWithinCoverage: {
      amountRaw: total.amountRaw,
      eventCount: total.eventCount,
    },
    observedMaximumWithinRecordedCoverage: maximum
      ? {
          amountRaw: maximum.amountRaw,
          eventCount: maximum.eventCount,
          startMs: maximum.startMs,
          endMs: maximum.endMs,
          horizonHours: maximum.horizonHours,
        }
      : null,
    historicalFlowDistribution:
      distribution.status === 'historical_descriptive_single_provider'
        ? {
            status: distribution.status,
            method: distribution.method,
            intervalCount: distribution.intervalCount,
            lowRaw: distribution.lowRaw,
            middleRaw: distribution.middleRaw,
            highRaw: distribution.highRaw,
          }
        : {
            status: distribution.status,
            reason: distribution.reason,
            intervalCount: distribution.intervalCount,
          },
    zeroMeaning: value.zeroMeaning,
  }
}

function validTimedFlow(
  value: unknown,
  coverageStartMs: number,
  coverageEndMs: number,
  horizonHours: number,
) {
  const flow = asRecord(value)
  const total = asRecord(flow?.recordedTotalWithinCoverage)
  const maximum = asRecord(flow?.observedMaximumWithinRecordedCoverage)
  const distribution = asRecord(flow?.historicalFlowDistribution)
  if (
    !flow ||
    !total ||
    !validRecordedTotal(total) ||
    !distribution ||
    flow.zeroMeaning !== 'zero_matching_events_returned_by_single_provider_within_recorded_coverage'
  )
    return false
  const horizonMs = horizonHours * 3_600_000
  const bins = Math.floor((coverageEndMs - coverageStartMs) / horizonMs)
  if (bins === 0)
    return (
      maximum === null &&
      distribution.status === 'unavailable' &&
      distribution.reason === 'coverage_shorter_than_horizon' &&
      distribution.intervalCount === 0
    )
  if (
    !maximum ||
    !RAW.test(String(maximum.amountRaw ?? '')) ||
    !validCount(maximum.eventCount) ||
    maximum.horizonHours !== horizonHours ||
    !Number.isSafeInteger(maximum.startMs) ||
    !Number.isSafeInteger(maximum.endMs) ||
    (maximum.startMs as number) < coverageStartMs ||
    (maximum.endMs as number) > coverageEndMs ||
    (maximum.endMs as number) - (maximum.startMs as number) !== horizonMs ||
    BigInt(maximum.amountRaw as string) > BigInt(total.amountRaw as string) ||
    (maximum.eventCount as number) > (total.eventCount as number) ||
    distribution.intervalCount !== bins
  )
    return false
  if (bins < 3)
    return (
      distribution.status === 'unavailable' &&
      distribution.reason === 'fewer_than_three_single_provider_disjoint_intervals'
    )
  if (
    distribution.status !== 'historical_descriptive_single_provider' ||
    distribution.method !== 'p10_median_p90_of_nonoverlapping_single_provider_intervals' ||
    ![distribution.lowRaw, distribution.middleRaw, distribution.highRaw].every((raw) =>
      RAW.test(String(raw ?? '')),
    )
  )
    return false
  return (
    BigInt(distribution.lowRaw as string) <= BigInt(distribution.middleRaw as string) &&
    BigInt(distribution.middleRaw as string) <= BigInt(distribution.highRaw as string) &&
    BigInt(distribution.highRaw as string) <= BigInt(maximum.amountRaw as string)
  )
}

function validSecondaryRouteFlow(
  value: unknown,
  subject: Report['subjects'][number],
  horizonHours: number,
) {
  const pin = Object.values(frozenPins.secondaryRouteFlows).find(
    (candidate) =>
      candidate.routeKey === subject.routeKey && candidate.destination === subject.destination,
  )
  if (!pin) return value === null
  const context = asRecord(value)
  if (!context) return false
  if (context.state === 'unavailable') return validUnavailableRecordedContext(context)
  const source = asRecord(context.source)
  const records = source?.recordSha256
  const legs = context.legs
  if (
    subject.asset !== pin.subjectAsset ||
    context.state !== 'single_provider_recorded_range' ||
    context.reason !== null ||
    context.requestedHorizonHours !== horizonHours ||
    context.venue !== pin.venue ||
    context.attribution !== pin.attribution ||
    context.subjectUnderlyingGrossFlowMeasured !== false ||
    context.holderAttributionAvailable !== false ||
    context.holderExecutableCapacity !== false ||
    context.forecastValidated !== false ||
    !source ||
    source.kind !== 'sealed_local_route_flow_v3_replay' ||
    source.completenessBasis !== 'single_provider_rpc_returned_not_independently_proven' ||
    source.genesisSha256 !== pin.genesisSha256 ||
    !Array.isArray(records) ||
    records.length < 1 ||
    records.length > 100_000 ||
    records[0] !== pin.genesisSha256 ||
    records.some((value) => typeof value !== 'string' || !SHA.test(value)) ||
    source.sourceSetSha256 !== sha(JSON.stringify(records)) ||
    !RAW.test(String(source.coverageStartBlock ?? '')) ||
    !RAW.test(String(source.coverageEndBlock ?? '')) ||
    BigInt(source.coverageEndBlock as string) < BigInt(source.coverageStartBlock as string) ||
    !Number.isSafeInteger(source.coverageStartMs) ||
    !Number.isSafeInteger(source.coverageEndMs) ||
    (source.coverageEndMs as number) <= (source.coverageStartMs as number) ||
    source.windowBoundaryConvention !== 'open_start_closed_end_utc_ms' ||
    !Array.isArray(legs) ||
    legs.length !== pin.legs.length
  )
    return false
  const canonicalLegs = []
  for (const [index, expected] of pin.legs.entries()) {
    const leg = asRecord(legs[index])
    if (
      !leg ||
      leg.market !== expected.market ||
      leg.outputAsset !== expected.outputAsset ||
      leg.outputSymbol !== expected.outputSymbol ||
      leg.outputDecimals !== expected.outputDecimals ||
      leg.scope !== expected.scope ||
      leg.exitDirection !== expected.exitDirection ||
      leg.entryDirection !== expected.entryDirection ||
      !validTimedFlow(
        leg.grossExit,
        source.coverageStartMs as number,
        source.coverageEndMs as number,
        horizonHours,
      ) ||
      !validTimedFlow(
        leg.grossEntry,
        source.coverageStartMs as number,
        source.coverageEndMs as number,
        horizonHours,
      )
    )
      return false
    canonicalLegs.push({
      market: leg.market,
      outputAsset: leg.outputAsset,
      outputSymbol: leg.outputSymbol,
      outputDecimals: leg.outputDecimals,
      scope: leg.scope,
      exitDirection: leg.exitDirection,
      entryDirection: leg.entryDirection,
      grossExit: canonicalTimedFlow(leg.grossExit as Record<string, unknown>),
      grossEntry: canonicalTimedFlow(leg.grossEntry as Record<string, unknown>),
    })
  }
  const binding = {
    schema: 'carry_secondary_route_flow_binding_v1',
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.asset,
    requestedHorizonHours: context.requestedHorizonHours,
    venue: context.venue,
    attribution: context.attribution,
    source: {
      genesisSha256: source.genesisSha256,
      recordSha256: records,
      sourceSetSha256: source.sourceSetSha256,
      coverageStartBlock: source.coverageStartBlock,
      coverageEndBlock: source.coverageEndBlock,
      coverageStartMs: source.coverageStartMs,
      coverageEndMs: source.coverageEndMs,
      windowBoundaryConvention: source.windowBoundaryConvention,
    },
    legs: canonicalLegs,
  }
  return context.evidenceBindingSha256 === sha(JSON.stringify(binding))
}

export function selectGrossFlowSubject(report: Report, query: Query) {
  if (
    report?.schema !== 'carry-historical-gross-flow-outlook-v3' ||
    report.scope !== 'frozen_august_25_route_67_subjects' ||
    report.claimClass !== 'retrospective_recorded_gross_flow_only' ||
    report.manifestSha256 !== frozenPins.manifestSha256 ||
    report.identitySetSha256 !== frozenPins.identitySetSha256 ||
    report.horizonHours !== query.horizonHours ||
    report.coverage?.routeGroups !== frozenPins.routeGroups ||
    report.coverage?.exactSubjects !== frozenPins.exactSubjects ||
    report.limits?.holderExecutableCapacity !== false ||
    report.limits?.forecastValidated !== false ||
    report.limits?.historicalDescriptiveOnly !== true ||
    report.limits?.expectedFlowAvailable !== false ||
    !Array.isArray(report.subjects) ||
    report.subjects.length !== frozenPins.exactSubjects
  )
    throw Error('gross_flow_report_invalid')
  const seen = new Set<string>()
  const routes = new Set<string>()
  for (const [index, subject] of report.subjects.entries()) {
    if (
      !subject ||
      typeof subject.routeKey !== 'string' ||
      !ADDRESS.test(subject.destination ?? '') ||
      !ADDRESS.test(subject.asset ?? '') ||
      subject.destination !== subject.destination.toLowerCase() ||
      subject.asset !== subject.asset.toLowerCase() ||
      subject.horizonHours !== report.horizonHours ||
      !validCashContext(subject.aggregateCashContext, subject) ||
      (((subject.inflow as Direction | undefined)?.state === 'aggregate_net_only_context' ||
        (subject.outflow as Direction | undefined)?.state === 'aggregate_net_only_context') &&
        subject.aggregateCashContext === null) ||
      !validDirection(subject.inflow, subject, 'supply', report.horizonHours) ||
      !validDirection(subject.outflow, subject, 'withdraw', report.horizonHours) ||
      !validMorphoRecordedRange(subject.morphoRecordedRange, subject, report.horizonHours) ||
      !validSecondaryRouteFlow(subject.secondaryRouteFlow, subject, report.horizonHours) ||
      subject.holderExecutableCapacity !== false ||
      subject.forecastValidated !== false
    )
      throw Error('gross_flow_subject_invalid')
    const key = `${subject.routeKey}\0${subject.destination.toLowerCase()}`
    if (seen.has(key)) throw Error('gross_flow_duplicate_subject')
    seen.add(key)
    routes.add(subject.routeKey)
    const prior = report.subjects[index - 1]
    if (
      prior &&
      (prior.routeKey.localeCompare(subject.routeKey) > 0 ||
        (prior.routeKey === subject.routeKey &&
          prior.destination.localeCompare(subject.destination) >= 0))
    )
      throw Error('gross_flow_subject_order_invalid')
  }
  if (routes.size !== frozenPins.routeGroups) throw Error('gross_flow_route_count_invalid')
  const identityDigest = sha(
    JSON.stringify(
      report.subjects.map((subject) => [subject.routeKey, subject.destination, subject.asset]),
    ),
  )
  if (identityDigest !== frozenPins.identitySetSha256)
    throw Error('gross_flow_frozen_identity_set_mismatch')
  const summary = {
    routeGroups: routes.size,
    exactSubjects: report.subjects.length,
    corroboratedGrossInflowSubjects: report.subjects.filter(
      (row) => (row.inflow as Direction).state === 'two_provider_corroborated_sample',
    ).length,
    corroboratedGrossOutflowSubjects: report.subjects.filter(
      (row) => (row.outflow as Direction).state === 'two_provider_corroborated_sample',
    ).length,
    ambiguousOutflowSubjects: report.subjects.filter(
      (row) => (row.outflow as Direction).state === 'ambiguous_event_volume',
    ).length,
    aggregateNetOnlySubjects: report.subjects.filter(
      (row) =>
        (row.inflow as Direction).state === 'aggregate_net_only_context' &&
        (row.outflow as Direction).state === 'aggregate_net_only_context',
    ).length,
    morphoRecordedRangeSubjects: report.subjects.filter(
      (row) =>
        (row.morphoRecordedRange as Record<string, unknown> | null)?.state ===
        'single_provider_recorded_range',
    ).length,
    secondaryRouteFlowSubjects: report.subjects.filter(
      (row) =>
        (row.secondaryRouteFlow as Record<string, unknown> | null)?.state ===
        'single_provider_recorded_range',
    ).length,
  }
  if (
    Object.entries(summary).some(
      ([name, count]) => report.coverage[name as keyof typeof summary] !== count,
    )
  )
    throw Error('gross_flow_coverage_summary_mismatch')
  const exact = report.subjects.filter(
    (subject) =>
      subject.routeKey === query.routeKey &&
      subject.destination.toLowerCase() === query.destination,
  )
  return exact.length === 1 ? exact[0] : null
}

async function loadReport(horizonHours: Query['horizonHours']) {
  if (cached?.horizonHours === horizonHours && Date.now() - cached.at < CACHE_MS)
    return cached.report
  const script = resolve(process.cwd(), 'scripts/research/carry-historical-gross-flow-outlook.mjs')
  if (!existsSync(script)) throw Error('gross_flow_script_missing')
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--max-old-space-size=384', '--import', 'tsx', script, String(horizonHours)],
    { cwd: process.cwd(), timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  )
  const report = JSON.parse(stdout) as Report
  cached = { horizonHours, at: Date.now(), report }
  return report
}

export function validatedGrossFlowResponse(report: Report, query: Query) {
  const subject = selectGrossFlowSubject(report, query)
  if (!subject) return null
  return {
    schema: report.schema,
    claimClass: 'retrospective_recorded_gross_flow_only',
    manifestSha256: report.manifestSha256,
    identitySetSha256: frozenPins.identitySetSha256,
    coverage: report.coverage,
    subject,
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  if (!localRequest(req)) return res.status(403).json({ error: 'local_development_only' })
  const query = parseGrossFlowQuery(req.query)
  if (!query) return res.status(400).json({ error: 'invalid_exact_subject_or_horizon' })
  try {
    const report = await loadReport(query.horizonHours)
    const response = validatedGrossFlowResponse(report, query)
    if (!response) return res.status(404).json({ error: 'unknown_exact_subject' })
    return res.status(200).json(response)
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : 'gross_flow_unavailable').split(
      /\s+/,
    )[0]
    return res.status(503).json({ error: 'historical_gross_flow_unavailable', reason })
  }
}
