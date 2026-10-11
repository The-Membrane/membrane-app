import React, { useMemo } from 'react'
import { Box, HStack, Link, SimpleGrid, Text, Tooltip, VStack } from '@chakra-ui/react'
import { sha256, stringToHex } from 'viem'

import { Card } from '@/components/ui/Card'
import {
  conditionalEventImpactIssuedAt,
  selectedConditionalEventImpact,
} from '@/lib/carry/conditionalEventImpact'
import { selectedSusdeHolderForecast } from '@/lib/carry/susdeHolderForecastBinding'
import {
  buildConditionalStockBoundaryOutlook,
  conditionalStockBoundaryHours,
} from '@/lib/venueForecast/conditionalStockBoundaryOutlook'
import type {
  SusdeHolderForecastEnvelope,
  SusdeHolderTimeProcessModel,
} from '@/lib/carry/susdeHolderForecastEnvelope'
import {
  initialDepositQuestion,
  issuedInitialDepositScenario,
  initialDepositRenderWindow,
  type CarryScenarioMode,
  type InitialDepositScenarioIssue,
} from '@/components/Carry/initialDepositScenario'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { decodeStusdsProtocolEvidence } from '@/lib/carry/stusdsProtocolEvidenceCodec'
import {
  buildStusdsHistoricalHolderCapacityProjection,
  selectedStusdsHistoricalHolderCapacityProjection,
} from '@/lib/carry/stusdsHistoricalHolderCapacityProjection'
import {
  buildStusdsHolderTimeProcess,
  selectedStusdsHolderTimeProcess,
} from '@/lib/carry/stusdsHolderTimeProcess'
import { stusdsPinnedProtocolHistory } from '@/lib/carry/stusdsProtocolCapacityHistoryPins'
import {
  replayStusdsCurrentProtocolCapacityEvidence,
  acceptStusdsCurrentProtocolCapacityEvidence,
} from '@/lib/carry/stusdsCurrentProtocolCapacityEvidence'
import {
  buildConditionalCashHolderTimeProcess,
  selectedConditionalCashHolderTimeProcess,
  type CashHolderTimeProcessInput,
} from '@/lib/carry/conditionalCashHolderTimeProcess'
import frozenGrossFlowPins from '@/lib/carry/frozenGrossFlowPins'
import {
  matchesPairedWindowDuration,
  type TranslatedPairedFlowWindow,
} from '@/lib/carry/historicalGrossFlowStress'
import { historicalDurationLabel } from '@/lib/carry/historicalFlowDuration'
import {
  CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS,
  selectedConditionalGrossFlowHeadroom,
  type ConditionalGrossFlowProjection,
} from '@/lib/carry/conditionalGrossFlowHeadroom'
import {
  selectedConditionalSampledCashPathProjection,
  type ConditionalSampledCashProjection,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import { selectedConditionalHolderSampledCashProjection } from '@/lib/carry/conditionalHolderSampledCashProjection'
import {
  selectedAnalogCashScenarioForPresentation,
  type AnalogCashScenarioIssue,
} from '@/lib/carry/analogCashScenarioPresentation'
import type { AnalogCashScenario } from '@/lib/carry/venueForecastAnalogPrior'
import {
  buildSghoHolderCapacityProjection,
  selectedSghoHolderCapacityProjection,
} from '@/lib/carry/sghoHolderCapacityProjection'
import {
  buildUsd3HolderCapacityProjection,
  selectedUsd3HolderCapacityProjection,
  type Usd3HolderCapacityInput,
} from '@/lib/carry/usd3HolderCapacityProjection'
import {
  selectedAaveSparkCapacityProjection,
  buildAaveSparkCapacityProjection,
  type AaveSparkCapacitySource,
} from '@/lib/carry/aaveSparkCapacityProjection'
import {
  buildSusdsHistoricalHolderCapacityProjection,
  selectedSusdsHistoricalHolderCapacityProjection,
  susdsPinnedIndexHistory,
} from '@/lib/carry/susdsHistoricalHolderCapacityProjection'
import {
  buildCometHolderCapacityProjection,
  selectedCometHolderCapacityProjection,
} from '@/lib/carry/cometHolderCapacityProjection'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { selectedHolderExitCapacity } from '@/lib/carry/holderExitCapacity'
import {
  issuedMorphoV2HolderForecast,
  morphoV2HolderForecastRenderWindow,
  type MorphoV2HolderForecastIssue,
} from '@/lib/carry/morphoV2HolderForecastBinding'
import {
  selectedMorphoV2JointHolderForecastFromIssue,
  selectedMorphoV2JointHolderForecast,
  type MorphoV2JointHolderForecast,
} from '@/lib/carry/morphoV2JointHolderForecastBinding'
import {
  selectedMorphoV2IdleJointHolderForecastFromIssue,
  type MorphoV2IdleJointHolderForecast,
  type MorphoV2IdleJointHolderForecastIssue,
  type MorphoV2IdleJointHolderForecastQuestion,
} from '@/lib/carry/morphoV2IdleJointHolderForecastBinding'
import {
  selectedMorphoV2IdleJointHolderForecastV2FromIssue,
  type MorphoV2IdleJointHolderForecastV2,
  type MorphoV2IdleJointHolderForecastV2Issue,
} from '@/lib/carry/morphoV2IdlePanelHolderForecastBinding'
import {
  selectedUsd3JointHolderForecastFromIssue,
  type Usd3JointHolderForecastIssue,
  type Usd3JointHolderForecastQuestion,
} from '@/lib/carry/usd3JointHolderForecastBinding'
import {
  selectedFluidUsdcBridgeJointHolderForecastFromIssue,
  type FluidUsdcBridgeJointHolderForecastIssue,
  type FluidUsdcBridgeJointHolderForecastQuestion,
} from '@/lib/carry/fluidUsdcBridgeJointHolderForecastBinding'
import {
  selectedFluidUsdtBridgeJointHolderForecastFromIssue,
  FLUID_USDT_BRIDGE_JOINT_ROUTE,
  FLUID_USDT_BRIDGE_JOINT_VAULT,
  type FluidUsdtBridgeJointHolderForecastIssue,
  type FluidUsdtBridgeJointHolderForecastQuestion,
} from '@/lib/carry/fluidUsdtBridgeJointHolderForecastBinding'
import {
  selectedUmbrellaGhoJointHolderForecastFromIssue,
  type UmbrellaGhoJointHolderForecastIssue,
  type UmbrellaGhoJointHolderForecastQuestion,
} from '@/lib/carry/umbrellaGhoJointHolderForecastBinding'
import {
  selectedApyUsdJointHolderForecastFromIssue,
  type ApyUsdJointHolderForecastIssue,
  type ApyUsdJointHolderForecastQuestion,
} from '@/lib/carry/apyUsdJointHolderForecastBinding'
import { APY_USD_JOINT_NATIVE_SUBJECT } from '@/lib/carry/apyUsdJointNativeEvidence'
import { UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'
import {
  buildFluidProtocolCapacityProjection,
  selectedFluidProtocolCapacityProjection,
} from '@/lib/carry/fluidProtocolCapacityProjection'
import { selectedConditionalHolderFlowProjection } from '@/lib/carry/conditionalHolderFlowProjection'
import { selectedHistoricalCompetingFlowEstimate } from '@/lib/carry/historicalCompetingFlowEstimate'
import {
  matchingRouteEventContext,
  type ExpectedRouteEventEnrollment,
  type RouteEventContextResponse,
  type RouteEventQuestion,
} from '@/lib/carry/routeEventContext'
import { deriveRouteProxyExitProjection } from '@/lib/carry/routeProxyExitProjection'
import type {
  HistoricalSampledCashPathsResult,
  SampledCashPathExample,
} from '@/lib/carry/historicalSampledCashPaths'
import {
  holderMechanicalRow,
  matchingHolderExitViewAssessment,
  selectedHolderExitMechanicalOutlook,
  type HolderExitAssessmentView,
} from '@/lib/carry/holderExitMechanicalOutlookView'
import type { ExitImpactForecast } from '@/lib/forecast/exitImpactForecast'
import { selectedSaturnAppForecastFromIssue, type SaturnAppForecastIssue, type SaturnAppForecast } from '@/lib/carry/saturnAppForecastEvidence'

const RAW = /^(0|[1-9]\d*)$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const sha = (value: unknown) => sha256(stringToHex(JSON.stringify(value))).slice(2)
const DIRECT_GROSS_MARKETS = {
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

const labelStyle = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

type ScopedEvidence = {
  routeKey: string
  destination: string
}

export type ExitPressureHistoricalBacktest = Extract<
  ExitImpactForecast,
  { status: 'historical_backtest' }
>

export type ExitPressureCurrentCash = ScopedEvidence & {
  cashRaw: string
  assetDecimals: number
  assetSymbol: string
  assetAddress?: string
  observedAt: string
  block?: string
  blockHash?: string
  freshness: 'fresh' | 'stale'
  label: 'Market cash' | 'Vault cash' | 'Direct buffer'
  readAtUtc?: string
  sourceKind?: 'live_read_only_two_origin_finalized' | 'manifest_bound_ledger'
  firstLocalReceiptAt?: string
  manifestSha256?: string
  receiptSha256?: string
}

export type ExitPressureProspectiveCashIssue = {
  issuedAtUtc: string
  sourceAtUtc: string
  targetAtUtc: string
  targetLowUtc: string
  targetHighUtc: string
  outcomeDueByUtc: string
  projection:
    | {
        sourceCashRaw: string
        pointRaw: string
        lowRaw: string
        highRaw: string
        persistenceRaw: string
      }
    | {
        sourceCashRaw: string
        pointRaw: string
        lowRaw: string
        highRaw: string
        baselinePointRaw: string
        baselineLowRaw: string
        baselineHighRaw: string
      }
}

type ExitPressureProspectiveCashAvailable = ScopedEvidence & {
  status: 'collecting' | 'validated'
  asset: string
  horizonHours: 24
  claim: 'aggregate_cash_proxy_only'
  holderExecutableExit: false
  prospectiveValidated: boolean
  schedule: {
    scheduled: number
    onTime: number
    missed: number
    coveragePercent: number
    current?: boolean
  }
  outcome: {
    issued: number
    observed: number
    censored: number
    pending: number
    availabilityPercent: number
  }
  interval: {
    observed: number
    covered: number
    missed: number
    coveragePercent: number
  }
  source: {
    opportunities: number
    available: number
    unavailable: number
    ineligible: number
    unassessed: number
    availabilityPercent: number | null
  }
  latestActiveIssue: ExitPressureProspectiveCashIssue | null
}

export type ExitPressureProspectiveCashModel =
  | (ExitPressureProspectiveCashAvailable & {
      status: 'collecting'
      prospectiveValidated: false
    })
  | (ExitPressureProspectiveCashAvailable & {
      status: 'validated'
      prospectiveValidated: true
    })
  | {
      status: 'unavailable'
      routeKey: string | null
      destination: string | null
      asset: string | null
      horizonHours: 24 | null
      claim: 'aggregate_cash_proxy_only'
      holderExecutableExit: false
      prospectiveValidated: false
      schedule: null
      outcome: null
      interval: null
      source: null
      latestActiveIssue: null
      reason:
        | 'no_exact_model_match'
        | 'prospective_ledger_unavailable'
        | 'local_evidence_unavailable'
        | 'invalid_response'
    }

export type ExitPressureHistoricalScenario = ScopedEvidence & {
  horizonHours: 24
  claim: 'aggregate_underlying_cash_proxy_only' | 'aggregate_cash_proxy_only'
  prospectiveValidated: false
  holderExecutableExit: false
  pointRaw: string
  bandLowRaw: string
  bandHighRaw: string
  assetDecimals: number
  assetSymbol: string
  assetAddress: string
  currentBlockAt: string
  currentBlock: string
  currentBlockHash: string
  targetAt: string
  sampleCount: number
  method: 'learned_delta' | 'persistence_band' | 'historical_net_change'
  requestedRaw: string
  requestedAssetAddress: string
  requestedAssetSymbol: string
  requestScope: 'route_exit' | 'first_leg'
  currentCashRaw: string
  validation: {
    fit: number
    calibration: number
    holdout: number
    covered: number
    coveragePassed: boolean
    pointBeatsPersistence: boolean | null
  } | null
}

export type ExitPressureGrossDirection = ScopedEvidence & {
  direction: 'withdrawal' | 'inflow'
  amountRaw: string
  assetDecimals: number
  assetSymbol: string
  window: 'maximum_24h' | 'observed_span'
  eventCount: number
  eventCountScope: 'window' | 'source'
  windowStartAt: string
  windowEndAt: string
  interpretation: 'gross_withdrawal' | 'gross_underlying_inflow_not_net_replenishment'
  includesBorrowing?: boolean
  mayIncludeDebtRepayment?: boolean
}

export type ExitPressureHistoricalGrossFlow = ScopedEvidence & {
  requestedRaw: string
  archiveVerification: 'full_sealed_replay'
  validation: 'not_validated'
  holderExecutableExit: false
  horizonBlocks: number
  windowCount: number
  assetDecimals: number
  assetSymbol: string
  assetAddress: string
  startingCashRaw: string
  source: { fromBlock: number; toBlock: number; joinContentSha256?: string }
  startingBlock: number
  startingBlockHash: string
  startingAt: string
  requestedAmountRaw: string
  currentMarginAfterQRaw: string
  pairedScenarios: {
    sampleCount: number
    p10Trough: TranslatedPairedFlowWindow
    worstTrough: TranslatedPairedFlowWindow
    highestGrossOutflow: TranslatedPairedFlowWindow
  }
}

type HistoricalMarketGrossDirection = {
  state:
    | 'two_provider_corroborated_sample'
    | 'partial_corroborated_range'
    | 'ambiguous_event_volume'
    | 'aggregate_net_only_context'
    | 'unavailable'
  reason: string | null
  sourceFailureCode?: string
  directionBindingSha256?: string
  corroboratedDisjointIntervalCount?: number
  ambiguousEventCount?: number
  observedMaximumWithinRecordedCoverage?: {
    amountRaw: string
    horizonHours: number
    startMs: number
    endMs: number
  } | null
  historicalFlowDistribution: {
    status: 'historical_descriptive' | 'unavailable'
    reason?: string
    method?: string
    intervalCount?: number
    lowRaw?: string
    middleRaw?: string
    highRaw?: string
  }
  source?: {
    coverageStartMs: number
    coverageEndMs: number
    marketKey: string
    flowKind: 'supply' | 'withdraw'
    kind: string
    completenessBasis: string
    asset: string
    assetDecimals: number
    segmentSha256: string[]
    sourceSetSha256: string
    evidenceBindingSha256: string
  }
  zeroMeaning?: string
  observedEventVolumeWithinRecordedCoverage?: {
    status: string
    reason?: string
    amountRaw?: string
    eventCount?: number
    startMs?: number
    endMs?: number
  } | null
}

export type HistoricalMarketGrossFlowResponse = {
  schema: 'carry-historical-gross-flow-outlook-v3'
  claimClass: 'retrospective_recorded_gross_flow_only'
  manifestSha256: string
  identitySetSha256: string
  coverage: {
    routeGroups: 25
    exactSubjects: 67
    corroboratedGrossInflowSubjects: number
    corroboratedGrossOutflowSubjects: number
    ambiguousOutflowSubjects?: number
    aggregateNetOnlySubjects?: number
    morphoRecordedRangeSubjects?: number
    secondaryRouteFlowSubjects?: number
  }
  subject: ScopedEvidence & {
    asset: string
    assetDecimals: number | null
    horizonHours: 24 | 168
    holderExecutableCapacity: false
    forecastValidated: false
    aggregateCashContext: unknown
    morphoRecordedRange: HistoricalMorphoRecordedRange | HistoricalRecordedUnavailable | null
    secondaryRouteFlow: HistoricalSecondaryRouteFlow | HistoricalRecordedUnavailable | null
    inflow: HistoricalMarketGrossDirection
    outflow: HistoricalMarketGrossDirection
  }
}

type HistoricalRecordedUnavailable = {
  state: 'unavailable'
  reason: string
  sourceFailureCode?: string
  holderExecutableCapacity: false
  forecastValidated: false
}

type HistoricalRecordedTotal = { amountRaw: string; eventCount: number }
type HistoricalMorphoGross = {
  recordedTotalWithinCoverage: HistoricalRecordedTotal
  observedMaximumWithinRecordedCoverage: null
  historicalFlowDistribution: {
    status: 'unavailable'
    reason: 'per_event_timestamps_not_recorded'
    intervalCount: 0
  }
  reconciliation?: 'receiver_not_vault_only_holder_payout_unreconciled'
}
type HistoricalMorphoRecordedRange = {
  state: 'single_provider_recorded_range'
  requestedHorizonHours: 24 | 168
  grossDeposit: HistoricalMorphoGross
  grossExternalReceiverWithdraw: HistoricalMorphoGross
  excludedInternalWithdrawals: HistoricalRecordedTotal & { reason: string }
  source: { coverageStartMs: number; coverageEndMs: number }
  holderPayoutMeasured: false
  holderExecutableCapacity: false
  forecastValidated: false
}
type HistoricalTimedFlow = {
  recordedTotalWithinCoverage: HistoricalRecordedTotal
  observedMaximumWithinRecordedCoverage: {
    amountRaw: string
    eventCount: number
    startMs: number
    endMs: number
    horizonHours: number
  } | null
  historicalFlowDistribution: {
    status: 'historical_descriptive_single_provider' | 'unavailable'
    reason?: string
    method?: string
    intervalCount: number
    lowRaw?: string
    middleRaw?: string
    highRaw?: string
  }
  zeroMeaning: string
}
type HistoricalSecondaryRouteFlow = {
  state: 'single_provider_recorded_range'
  venue: string
  attribution: string
  requestedHorizonHours: 24 | 168
  legs: Array<{
    outputAsset: string
    outputSymbol: string
    outputDecimals: number
    scope: string
    exitDirection: string
    entryDirection: string
    grossExit: HistoricalTimedFlow
    grossEntry: HistoricalTimedFlow
  }>
  source: { coverageStartMs: number; coverageEndMs: number }
  subjectUnderlyingGrossFlowMeasured: false
  holderAttributionAvailable: false
  holderExecutableCapacity: false
  forecastValidated: false
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function validHistoricalMarketSource(
  source: Record<string, unknown> | null,
  subject: Record<string, unknown>,
  horizonHours: number,
  flowKind: 'inflow' | 'outflow',
): source is Record<string, unknown> {
  const market = DIRECT_GROSS_MARKETS[subject.routeKey as keyof typeof DIRECT_GROSS_MARKETS]
  const segments = source?.segmentSha256
  if (
    !source ||
    !market ||
    subject.destination !== market.destination ||
    subject.assetDecimals !== market.decimals ||
    source.marketKey !== market.marketKey ||
    source.flowKind !== (flowKind === 'inflow' ? 'supply' : 'withdraw') ||
    source.kind !== 'sealed_public_receipt_replay' ||
    source.completenessBasis !== 'two_public_rpc_origins_agree_not_absolute_completeness' ||
    source.asset !== subject.asset ||
    source.assetDecimals !== subject.assetDecimals ||
    !Number.isSafeInteger(source.coverageStartMs) ||
    !Number.isSafeInteger(source.coverageEndMs) ||
    (source.coverageEndMs as number) <= (source.coverageStartMs as number) ||
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.some((segment) => typeof segment !== 'string' || !SHA.test(segment)) ||
    source.sourceSetSha256 !== sha(segments)
  )
    return false
  return (
    source.evidenceBindingSha256 ===
    sha({
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: subject.assetDecimals,
      horizonHours,
      flowKind: flowKind === 'inflow' ? 'supply' : 'withdraw',
      coverageStartMs: source.coverageStartMs,
      coverageEndMs: source.coverageEndMs,
      segmentSha256: segments,
    })
  )
}

function validHistoricalMarketCashContext(value: unknown, assetDecimals: unknown): boolean {
  if (value === null) return true
  const context = record(value)
  return Boolean(
    context &&
    context.state === 'aggregate_net_only_context' &&
    context.metric === 'aggregate_underlying_cash_raw_proxy' &&
    context.grossFlowMeasured === false &&
    Number.isSafeInteger(context.snapshotCount) &&
    (context.snapshotCount as number) >= 2 &&
    context.assetDecimals === assetDecimals &&
    [context.firstReceiptSha256, context.latestReceiptSha256, context.sourceSetSha256].every(
      (hash) => typeof hash === 'string' && SHA.test(hash),
    ),
  )
}

const validRecordedCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const validTotal = (value: unknown) => {
  const total = record(value)
  return Boolean(
    total &&
    typeof total.amountRaw === 'string' &&
    validRaw(total.amountRaw) &&
    validRecordedCount(total.eventCount),
  )
}
const validHashArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 100_000 &&
  value.every((hash) => typeof hash === 'string' && SHA.test(hash))
const validBlockRange = (source: Record<string, unknown>) =>
  typeof source.coverageStartBlock === 'string' &&
  validRaw(source.coverageStartBlock) &&
  typeof source.coverageEndBlock === 'string' &&
  validRaw(source.coverageEndBlock) &&
  BigInt(source.coverageEndBlock) >= BigInt(source.coverageStartBlock) &&
  Number.isSafeInteger(source.coverageStartMs) &&
  Number.isSafeInteger(source.coverageEndMs) &&
  (source.coverageEndMs as number) > (source.coverageStartMs as number)

function validRecordedUnavailable(value: Record<string, unknown>, kind: 'morpho' | 'route') {
  return (
    value.state === 'unavailable' &&
    value.holderExecutableCapacity === false &&
    value.forecastValidated === false &&
    (value.reason === 'source_replay_failed'
      ? typeof value.sourceFailureCode === 'string' &&
        /^[a-zA-Z0-9_:-]+$/.test(value.sourceFailureCode)
      : value.reason ===
          (kind === 'morpho'
            ? 'no_integrated_morpho_recorded_source'
            : 'no_integrated_secondary_route_source') && value.sourceFailureCode === undefined)
  )
}

function canonicalMorphoGross(value: Record<string, unknown>, reconciliation: boolean) {
  const total = record(value.recordedTotalWithinCoverage)!
  const distribution = record(value.historicalFlowDistribution)!
  return {
    recordedTotalWithinCoverage: { amountRaw: total.amountRaw, eventCount: total.eventCount },
    observedMaximumWithinRecordedCoverage: null,
    historicalFlowDistribution: {
      status: distribution.status,
      reason: distribution.reason,
      intervalCount: distribution.intervalCount,
    },
    ...(reconciliation ? { reconciliation: value.reconciliation } : {}),
  }
}

function validMorphoGross(value: unknown, reconciliation: boolean) {
  const flow = record(value)
  const distribution = record(flow?.historicalFlowDistribution)
  return Boolean(
    flow &&
    validTotal(flow.recordedTotalWithinCoverage) &&
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
  subject: Record<string, unknown>,
  horizonHours: number,
) {
  const applicable = frozenGrossFlowPins.morpho.routeKeys.some(
    (route) => route === subject.routeKey,
  )
  if (!applicable) return value === null
  const context = record(value)
  if (!context) return false
  if (context.state === 'unavailable') return validRecordedUnavailable(context, 'morpho')
  const source = record(context.source)
  const deposit = record(context.grossDeposit)
  const external = record(context.grossExternalReceiverWithdraw)
  const internal = record(context.excludedInternalWithdrawals)
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
    source.enrollmentSha256 !== frozenGrossFlowPins.morpho.enrollmentSha256 ||
    !validHashArray(ranges) ||
    source.sourceSetSha256 !== sha(ranges) ||
    !validBlockRange(source) ||
    !deposit ||
    !external ||
    !internal ||
    !validMorphoGross(deposit, false) ||
    !validMorphoGross(external, true) ||
    !validTotal(internal) ||
    internal.reason !== 'vault_receiver_or_force_deallocation_internal_flow'
  )
    return false
  return (
    context.evidenceBindingSha256 ===
    sha({
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
      grossDeposit: canonicalMorphoGross(deposit, false),
      grossExternalReceiverWithdraw: canonicalMorphoGross(external, true),
      excludedInternalWithdrawals: {
        amountRaw: internal.amountRaw,
        eventCount: internal.eventCount,
        reason: internal.reason,
      },
    })
  )
}

function canonicalTimedFlow(value: Record<string, unknown>) {
  const total = record(value.recordedTotalWithinCoverage)!
  const maximum = record(value.observedMaximumWithinRecordedCoverage)
  const distribution = record(value.historicalFlowDistribution)!
  return {
    recordedTotalWithinCoverage: { amountRaw: total.amountRaw, eventCount: total.eventCount },
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

function validTimedFlow(value: unknown, startMs: number, endMs: number, horizonHours: number) {
  const flow = record(value)
  const total = record(flow?.recordedTotalWithinCoverage)
  const maximum = record(flow?.observedMaximumWithinRecordedCoverage)
  const distribution = record(flow?.historicalFlowDistribution)
  if (
    !flow ||
    !total ||
    !validTotal(total) ||
    !distribution ||
    flow.zeroMeaning !== 'zero_matching_events_returned_by_single_provider_within_recorded_coverage'
  )
    return false
  const horizonMs = horizonHours * 3_600_000
  const bins = Math.floor((endMs - startMs) / horizonMs)
  if (bins === 0)
    return (
      maximum === null &&
      distribution.status === 'unavailable' &&
      distribution.reason === 'coverage_shorter_than_horizon' &&
      distribution.intervalCount === 0
    )
  if (
    !maximum ||
    typeof maximum.amountRaw !== 'string' ||
    !validRaw(maximum.amountRaw) ||
    !validRecordedCount(maximum.eventCount) ||
    maximum.horizonHours !== horizonHours ||
    !Number.isSafeInteger(maximum.startMs) ||
    !Number.isSafeInteger(maximum.endMs) ||
    (maximum.startMs as number) < startMs ||
    (maximum.endMs as number) > endMs ||
    (maximum.endMs as number) - (maximum.startMs as number) !== horizonMs ||
    BigInt(maximum.amountRaw) > BigInt(total.amountRaw as string) ||
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
    ![distribution.lowRaw, distribution.middleRaw, distribution.highRaw].every(
      (raw) => typeof raw === 'string' && validRaw(raw),
    )
  )
    return false
  return (
    BigInt(distribution.lowRaw as string) <= BigInt(distribution.middleRaw as string) &&
    BigInt(distribution.middleRaw as string) <= BigInt(distribution.highRaw as string) &&
    BigInt(distribution.highRaw as string) <= BigInt(maximum.amountRaw)
  )
}

function validSecondaryRouteFlow(
  value: unknown,
  subject: Record<string, unknown>,
  horizonHours: number,
) {
  const pin = Object.values(frozenGrossFlowPins.secondaryRouteFlows).find(
    (candidate) =>
      candidate.routeKey === subject.routeKey && candidate.destination === subject.destination,
  )
  if (!pin) return value === null
  const context = record(value)
  if (!context) return false
  if (context.state === 'unavailable') return validRecordedUnavailable(context, 'route')
  const source = record(context.source)
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
    !validHashArray(records) ||
    records[0] !== pin.genesisSha256 ||
    source.sourceSetSha256 !== sha(records) ||
    !validBlockRange(source) ||
    source.windowBoundaryConvention !== 'open_start_closed_end_utc_ms' ||
    !Array.isArray(legs) ||
    legs.length !== pin.legs.length
  )
    return false
  const canonicalLegs = []
  for (const [index, expected] of pin.legs.entries()) {
    const leg = record(legs[index])
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
      grossExit: canonicalTimedFlow(record(leg.grossExit)!),
      grossEntry: canonicalTimedFlow(record(leg.grossEntry)!),
    })
  }
  return (
    context.evidenceBindingSha256 ===
    sha({
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
    })
  )
}

function validDirectDirectionBinding(
  direction: Record<string, unknown>,
  source: Record<string, unknown>,
  subject: Record<string, unknown>,
  horizonHours: number,
) {
  const distribution = record(direction.historicalFlowDistribution)!
  const maximum = record(direction.observedMaximumWithinRecordedCoverage)
  const event = record(direction.observedEventVolumeWithinRecordedCoverage)
  const canonicalDistribution =
    distribution.status === 'historical_descriptive'
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
          intervalCount: distribution.intervalCount ?? null,
        }
  const canonicalEvent = event
    ? event.status === 'unavailable'
      ? { status: event.status, reason: event.reason }
      : {
          status: event.status,
          amountRaw: event.amountRaw,
          eventCount: event.eventCount,
          startMs: event.startMs,
          endMs: event.endMs,
        }
    : null
  return (
    direction.directionBindingSha256 ===
    sha({
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
      observedMaximumWithinRecordedCoverage: maximum
        ? {
            amountRaw: maximum.amountRaw,
            startMs: maximum.startMs,
            endMs: maximum.endMs,
            horizonHours: maximum.horizonHours,
            eventCount: maximum.eventCount,
          }
        : null,
      historicalFlowDistribution: canonicalDistribution,
      ambiguousEventCount: direction.ambiguousEventCount ?? null,
      observedEventVolumeWithinRecordedCoverage: canonicalEvent,
      corroboratedDisjointIntervalCount: direction.corroboratedDisjointIntervalCount ?? null,
      zeroMeaning: direction.zeroMeaning ?? null,
    })
  )
}

function validHistoricalMarketDirection(
  value: unknown,
  horizonHours: number,
  flowKind: 'inflow' | 'outflow',
  subject: Record<string, unknown>,
): boolean {
  const direction = record(value)
  const distribution = record(direction?.historicalFlowDistribution)
  if (!direction || !distribution) return false
  if (direction.state === 'unavailable' || direction.state === 'aggregate_net_only_context')
    return (
      distribution.status === 'unavailable' &&
      direction.observedMaximumWithinRecordedCoverage === null &&
      direction.source === undefined &&
      distribution.reason === direction.reason &&
      (direction.state === 'aggregate_net_only_context'
        ? direction.reason === 'gross_flow_not_integrated_in_this_report'
        : ['source_replay_failed', 'no_integrated_gross_flow_source'].includes(
            direction.reason as string,
          )) &&
      (direction.reason === 'source_replay_failed'
        ? typeof direction.sourceFailureCode === 'string' &&
          /^[a-zA-Z0-9_:-]+$/.test(direction.sourceFailureCode)
        : direction.sourceFailureCode === undefined)
    )
  const source = record(direction.source)
  if (
    !validHistoricalMarketSource(source, subject, horizonHours, flowKind) ||
    !validDirectDirectionBinding(direction, source, subject, horizonHours)
  )
    return false
  if (direction.state === 'partial_corroborated_range')
    return (
      distribution.status === 'unavailable' &&
      distribution.reason === 'no_corroborated_horizon_interval' &&
      direction.observedMaximumWithinRecordedCoverage === null &&
      direction.reason ===
        ((source.coverageEndMs as number) - (source.coverageStartMs as number) <
        horizonHours * 3_600_000
          ? 'coverage_shorter_than_horizon'
          : 'coverage_not_complete')
    )
  if (direction.state === 'ambiguous_event_volume')
    return (
      flowKind === 'outflow' &&
      source.marketKey === 'compoundV3Usdc' &&
      direction.reason === 'unclassified_compound_withdraw_events' &&
      distribution.status === 'unavailable' &&
      distribution.reason === direction.reason &&
      direction.observedMaximumWithinRecordedCoverage === null &&
      Number.isSafeInteger(direction.ambiguousEventCount) &&
      (direction.ambiguousEventCount as number) > 0 &&
      (horizonHours === 168
        ? direction.observedEventVolumeWithinRecordedCoverage === null
        : (() => {
            const event = record(direction.observedEventVolumeWithinRecordedCoverage)
            if (!event) return false
            if (event.status === 'unavailable') return event.reason === 'coverage_under_24h'
            return (
              event.status === 'observed' &&
              typeof event.amountRaw === 'string' &&
              validRaw(event.amountRaw) &&
              Number.isSafeInteger(event.eventCount) &&
              (event.eventCount as number) >= 0 &&
              Number.isSafeInteger(event.startMs) &&
              Number.isSafeInteger(event.endMs) &&
              (event.startMs as number) >= (source.coverageStartMs as number) &&
              (event.endMs as number) <= (source.coverageEndMs as number) &&
              (event.endMs as number) - (event.startMs as number) === 86_400_000
            )
          })())
    )
  if (direction.state !== 'two_provider_corroborated_sample') return false
  const maximum = record(direction.observedMaximumWithinRecordedCoverage)
  if (
    !maximum ||
    direction.reason !== null ||
    typeof maximum.amountRaw !== 'string' ||
    !validRaw(maximum.amountRaw) ||
    maximum.horizonHours !== horizonHours ||
    !Number.isSafeInteger(maximum.startMs) ||
    !Number.isSafeInteger(maximum.endMs) ||
    (maximum.startMs as number) < (source.coverageStartMs as number) ||
    (maximum.endMs as number) > (source.coverageEndMs as number) ||
    (maximum.endMs as number) - (maximum.startMs as number) !== horizonHours * 3_600_000 ||
    !Number.isSafeInteger(maximum.eventCount) ||
    (maximum.eventCount as number) < 0 ||
    direction.zeroMeaning !== 'zero_matching_events_returned_within_recorded_coverage' ||
    !Number.isSafeInteger(direction.corroboratedDisjointIntervalCount) ||
    (direction.corroboratedDisjointIntervalCount as number) < 1 ||
    direction.corroboratedDisjointIntervalCount !==
      Math.floor(
        ((source.coverageEndMs as number) - (source.coverageStartMs as number)) /
          (horizonHours * 3_600_000),
      ) ||
    distribution.intervalCount !== direction.corroboratedDisjointIntervalCount
  )
    return false
  if (distribution.status === 'unavailable')
    return (
      (direction.corroboratedDisjointIntervalCount as number) < 3 &&
      distribution.reason === 'fewer_than_three_corroborated_disjoint_intervals'
    )
  if (distribution.status !== 'historical_descriptive') return false
  const raws = [distribution.lowRaw, distribution.middleRaw, distribution.highRaw]
  return (
    (direction.corroboratedDisjointIntervalCount as number) >= 3 &&
    distribution.method === 'p10_median_p90_of_nonoverlapping_corroborated_intervals' &&
    raws.every((raw) => typeof raw === 'string' && validRaw(raw)) &&
    BigInt(raws[0] as string) <= BigInt(raws[1] as string) &&
    BigInt(raws[1] as string) <= BigInt(raws[2] as string) &&
    BigInt(raws[2] as string) <= BigInt(maximum.amountRaw as string)
  )
}

export function selectHistoricalMarketGrossFlow(
  value: unknown,
  routeKey: string,
  destination: string,
  horizonHours: number,
  activeAssetAddress: string | null,
  activeAssetDecimals: number | null,
): HistoricalMarketGrossFlowResponse | null {
  const response = record(value)
  const coverage = record(response?.coverage)
  const subject = record(response?.subject)
  if (
    response?.schema !== 'carry-historical-gross-flow-outlook-v3' ||
    response.claimClass !== 'retrospective_recorded_gross_flow_only' ||
    response.manifestSha256 !== frozenGrossFlowPins.manifestSha256 ||
    response.identitySetSha256 !== frozenGrossFlowPins.identitySetSha256 ||
    !coverage ||
    coverage.routeGroups !== frozenGrossFlowPins.routeGroups ||
    coverage.exactSubjects !== frozenGrossFlowPins.exactSubjects ||
    ![coverage.corroboratedGrossInflowSubjects, coverage.corroboratedGrossOutflowSubjects].every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 67,
    ) ||
    ![
      coverage.ambiguousOutflowSubjects,
      coverage.aggregateNetOnlySubjects,
      coverage.morphoRecordedRangeSubjects,
      coverage.secondaryRouteFlowSubjects,
    ].every(
      (count) =>
        count === undefined ||
        (Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 67),
    ) ||
    !subject ||
    subject.routeKey !== routeKey ||
    typeof subject.destination !== 'string' ||
    subject.destination !== destination.toLowerCase() ||
    !ADDRESS.test(subject.destination) ||
    ![24, 168].includes(horizonHours) ||
    subject.horizonHours !== horizonHours ||
    typeof subject.asset !== 'string' ||
    !ADDRESS.test(subject.asset) ||
    (subject.assetDecimals !== null &&
      (typeof subject.assetDecimals !== 'number' || !validDecimals(subject.assetDecimals))) ||
    (subject.assetDecimals === null &&
      [record(subject.inflow)?.state, record(subject.outflow)?.state].includes(
        'two_provider_corroborated_sample',
      )) ||
    (Boolean(
      record(subject.inflow)?.source ||
      record(subject.outflow)?.source ||
      record(subject.morphoRecordedRange)?.state === 'single_provider_recorded_range' ||
      record(subject.secondaryRouteFlow)?.state === 'single_provider_recorded_range',
    ) &&
      (typeof activeAssetAddress !== 'string' ||
        subject.asset !== activeAssetAddress.toLowerCase() ||
        subject.assetDecimals !== activeAssetDecimals)) ||
    subject.holderExecutableCapacity !== false ||
    subject.forecastValidated !== false ||
    !validHistoricalMarketCashContext(subject.aggregateCashContext, subject.assetDecimals) ||
    ((record(subject.inflow)?.state === 'aggregate_net_only_context' ||
      record(subject.outflow)?.state === 'aggregate_net_only_context') &&
      subject.aggregateCashContext === null) ||
    !validHistoricalMarketDirection(subject.inflow, horizonHours, 'inflow', subject) ||
    !validHistoricalMarketDirection(subject.outflow, horizonHours, 'outflow', subject) ||
    !validMorphoRecordedRange(subject.morphoRecordedRange, subject, horizonHours) ||
    !validSecondaryRouteFlow(subject.secondaryRouteFlow, subject, horizonHours) ||
    (record(subject.morphoRecordedRange)?.state === 'single_provider_recorded_range' &&
      (!validDecimals(subject.assetDecimals as number) ||
        !validRecordedCount(coverage.morphoRecordedRangeSubjects) ||
        coverage.morphoRecordedRangeSubjects === 0)) ||
    (record(subject.secondaryRouteFlow)?.state === 'single_provider_recorded_range' &&
      (!validRecordedCount(coverage.secondaryRouteFlowSubjects) ||
        coverage.secondaryRouteFlowSubjects === 0))
  )
    return null
  return value as HistoricalMarketGrossFlowResponse
}

function historicalMarketDirectionMetric(
  direction: HistoricalMarketGrossDirection,
  label: string,
  coverage: number,
  decimals: number | null,
  symbol: string,
) {
  const distribution = direction.historicalFlowDistribution
  const maximum = direction.observedMaximumWithinRecordedCoverage
  const amount = (raw: string) => (decimals === null ? null : formatExitPressureRaw(raw, decimals))
  const band =
    direction.state === 'two_provider_corroborated_sample' &&
    distribution.status === 'historical_descriptive' &&
    distribution.lowRaw &&
    distribution.middleRaw &&
    distribution.highRaw
      ? [distribution.lowRaw, distribution.middleRaw, distribution.highRaw]
          .map((raw) => amount(raw))
          .join(' / ')
      : null
  return (
    <Box>
      <Text {...labelStyle}>
        {label} · {coverage}/67
      </Text>
      {direction.state === 'two_provider_corroborated_sample' ? (
        <>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textPrimary}
            mt={SPACING.xs}
          >
            CORROBORATED HISTORY · {direction.corroboratedDisjointIntervalCount} DISJOINT INTERVALS
          </Text>
          {band && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
            >
              P10 / MEDIAN / P90 {band} {symbol}
            </Text>
          )}
          {maximum && decimals !== null && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
            >
              RECORDED COVERAGE MAX {amount(maximum.amountRaw)} {symbol}
            </Text>
          )}
        </>
      ) : (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
          mt={SPACING.xs}
        >
          {direction.state === 'partial_corroborated_range'
            ? 'PARTIAL RECORDED RANGE · NO FULL-HORIZON INTERVAL'
            : direction.state === 'ambiguous_event_volume'
              ? 'UNCLASSIFIED EVENT VOLUME · NO SUPPLIER OUTFLOW BAND'
              : direction.state === 'aggregate_net_only_context'
                ? 'AGGREGATE CASH CONTEXT · GROSS FLOW NOT MEASURED'
                : 'GROSS FLOW UNAVAILABLE'}
        </Text>
      )}
    </Box>
  )
}

export type ExitPressureMorphoPayout = ScopedEvidence & {
  receiptMatchedTransactions: number
  externalPayoutRows: number
  pendingTransactions: number
  ambiguousTransactions: number
  sourceCompleteness: 'not_independently_proven'
  sameHolderExit: 'not_established'
  calibratedForecast: false
}

export type ExitPressureLocalExactQEvidence = {
  status: 'collecting' | 'unavailable'
  routeKey: string
  destination: string
  asset: string | null
  decimals: number | null
  assetsRaw: string | null
  horizonH: number
  claim: 'local_exact_q_observation_only'
  provenance: 'local_operator_clock'
  independentTimestamp: false
  independentWitness: false
  externalMonotonicCheckpoint: false
  rollbackProof: false
  minedPayoutProven: false
  prospectiveValidated: false
  calibratedForecast: false
  measurementValidatorId: string | null
  forecastValidated: false
  holderExecutableExit: false
  evidence: {
    issued: number
    pending: number
    recordedUnverified: number
    measured: number
    missing: number
    censored: number
    unavailable: number
    due: number
    localReadbacks: number
    latest: {
      targetAtUtc: string
      deadlineAtUtc: string
      status:
        | 'pending'
        | 'recorded_unverified'
        | 'measured'
        | 'missing'
        | 'censored'
        | 'unavailable'
      due: boolean
      localReadback: boolean
    }
  } | null
}

export type ExitPressureUsd3JointIssue = {
  question: Usd3JointHolderForecastQuestion
  issue: Usd3JointHolderForecastIssue
  capacityAgreement: unknown
  historicalEvidence: unknown
}

export type ExitPressureFluidUsdcBridgeJointIssue = {
  question: FluidUsdcBridgeJointHolderForecastQuestion
  issue: FluidUsdcBridgeJointHolderForecastIssue
  capacityAgreement: unknown
  historicalEvidence: unknown
}

export type ExitPressureFluidUsdtBridgeJointIssue = {
  question: FluidUsdtBridgeJointHolderForecastQuestion
  issue: FluidUsdtBridgeJointHolderForecastIssue
}

export type ExitPressureUmbrellaGhoJointIssue = {
  question: UmbrellaGhoJointHolderForecastQuestion
  issue: UmbrellaGhoJointHolderForecastIssue
  nativeCapacity: unknown
  historicalEvidence: unknown
}

export type ExitPressureApyUsdJointIssue = {
  question: ApyUsdJointHolderForecastQuestion
  issue: ApyUsdJointHolderForecastIssue
}

export type ExitPressureMorphoV2IdleJointIssue = {
  question: MorphoV2IdleJointHolderForecastQuestion
  issue: MorphoV2IdleJointHolderForecastIssue | MorphoV2IdleJointHolderForecastV2Issue
}

export type ExitPressureCardProps = {
  scenarioMode?: CarryScenarioMode
  depositAmount?: string
  initialDepositIssue?: InitialDepositScenarioIssue | null
  routeKey: string
  destination: string
  requestedAmount: string
  requestedRaw: string | null
  requestedAssetSymbol: string
  requestedAssetAddress: string | null
  requestedAssetDecimals: number | null
  horizonHours: number
  asOfMs: number
  currentCash: ExitPressureCurrentCash | null
  prospectiveCashModel: ExitPressureProspectiveCashModel | null
  localCarryExitV2Evidence?: ExitPressureLocalExactQEvidence | null
  conditionalGrossFlowHeadroom?: unknown
  conditionalSampledCashPathProjection?: unknown
  conditionalEventImpact?: unknown
  analogCashScenario?: AnalogCashScenario | null
  analogCashIssue?: AnalogCashScenarioIssue | null
  analogCashSourceConflict?: boolean
  aaveSparkCapacityProjection?: unknown
  aaveSparkCapacitySource?: unknown
  fluidProtocolCapacityProjection?: unknown
  fluidProtocolCapacityProngs?: unknown
  sampledCashPaths?: HistoricalSampledCashPathsResult | null
  historicalBacktest?: ExitImpactForecast | null
  historicalScenario: ExitPressureHistoricalScenario | null
  grossWithdrawals: ExitPressureGrossDirection | null
  grossInflows: ExitPressureGrossDirection | null
  historicalGrossFlow: ExitPressureHistoricalGrossFlow | null
  historicalMarketGrossFlow?: HistoricalMarketGrossFlowResponse | null
  morphoPayout: ExitPressureMorphoPayout | null
  holderTimeProcessIssue?: HolderTimeProcessIssue | null
  saturnRequestTokenId?: string | null
  holderSaturnForecastIssue?: SaturnAppForecastIssue | null
  holderMorphoV2IdleJointIssue?: ExitPressureMorphoV2IdleJointIssue | null
  holderCapacityAgreement?: unknown
  holderStusdsProtocolCapacityEvidence?: unknown
  holderMorphoV2ProtocolCapacityEvidence?: unknown
  holderMorphoV2CurrentHolderPositionEvidence?: unknown
  holderMorphoV2HistoricalHolderEaEvidence?: unknown
  holderUsd3JointIssue?: ExitPressureUsd3JointIssue | null
  holderFluidUsdcBridgeJointIssue?: ExitPressureFluidUsdcBridgeJointIssue | null
  holderFluidUsdtBridgeJointIssue?: ExitPressureFluidUsdtBridgeJointIssue | null
  holderUmbrellaGhoJointIssue?: ExitPressureUmbrellaGhoJointIssue | null
  holderApyUsdJointIssue?: ExitPressureApyUsdJointIssue | null
  holderCometFactsAgreement?: unknown
  holderAssessment: HolderExitAssessmentView | null
  requestedHolderAddress?: string | null
  expectedEventEnrollment: ExpectedRouteEventEnrollment | null
  eventContext: RouteEventContextResponse | null
  historicalOutlook: React.ReactNode
}

/** Exact Q and the currently displayed source must agree before replay examples render. */
export function selectedSampledCashPaths(
  value: HistoricalSampledCashPathsResult | null | undefined,
  question: Pick<
    ExitPressureCardProps,
    | 'routeKey'
    | 'destination'
    | 'requestedRaw'
    | 'requestedAssetAddress'
    | 'requestedAssetDecimals'
    | 'horizonHours'
    | 'asOfMs'
  >,
  current: ExitPressureCurrentCash | null,
): Extract<
  HistoricalSampledCashPathsResult,
  { status: 'conditional_historical_sampled_cash_paths' }
> | null {
  try {
    if (
      !value ||
      value.status !== 'conditional_historical_sampled_cash_paths' ||
      !current ||
      question.horizonHours !== 24 ||
      value.horizonHours !== 168 ||
      current.freshness !== 'fresh' ||
      value.claim !== 'aggregate_endpoint_cash_proxy_only' ||
      value.forwardProbability !== false ||
      value.holderExecutableExit !== false ||
      value.prospectiveValidated !== false ||
      value.method !== 'sampled_historical_net_cash_change_replay' ||
      value.partition !== 'oldest_sample_8_observations_advance_7' ||
      !Number.isSafeInteger(value.counts.eligibleEpisodes) ||
      value.counts.eligibleEpisodes < 1 ||
      !Number.isSafeInteger(value.counts.gapRejectedEpisodes) ||
      value.counts.gapRejectedEpisodes < 0 ||
      value.selection !== 'retrospective_empirical_examples_not_forecast_probability' ||
      value.identity.routeKey !== question.routeKey ||
      current.routeKey !== question.routeKey ||
      value.identity.destination.toLowerCase() !== question.destination.toLowerCase() ||
      current.destination.toLowerCase() !== question.destination.toLowerCase() ||
      value.identity.asset.toLowerCase() !== question.requestedAssetAddress?.toLowerCase() ||
      current.assetAddress?.toLowerCase() !== value.identity.asset.toLowerCase() ||
      value.identity.assetDecimals !== question.requestedAssetDecimals ||
      current.assetDecimals !== value.identity.assetDecimals ||
      value.requestedRaw !== question.requestedRaw ||
      !validRaw(value.requestedRaw) ||
      value.current.subjectKey !==
        `${value.identity.routeKey}\0${value.identity.destination}\0${value.identity.asset}` ||
      value.current.asset !== value.identity.asset ||
      value.current.assetDecimals !== value.identity.assetDecimals ||
      value.current.cashRaw !== current.cashRaw ||
      value.current.blockAt !== current.observedAt ||
      value.current.block !== current.block ||
      value.current.blockHash !== current.blockHash ||
      !validRaw(value.current.cashRaw) ||
      !validRaw(value.current.block) ||
      !HASH.test(value.current.blockHash) ||
      !validUtc(value.current.blockAt) ||
      !validUtc(value.asOfAt) ||
      !Number.isSafeInteger(question.asOfMs) ||
      Date.parse(value.current.blockAt) > question.asOfMs ||
      question.asOfMs - Date.parse(value.current.blockAt) > 2 * 60 * 60_000 ||
      Date.parse(value.asOfAt) > question.asOfMs ||
      Date.parse(value.asOfAt) < Date.parse(value.current.blockAt) ||
      !validUtc(value.history.toAt) ||
      Date.parse(value.history.toAt) > Date.parse(value.asOfAt)
    )
      return null
    const q = BigInt(value.requestedRaw)
    for (const example of [
      value.examples.worstTrough,
      value.examples.p10Trough,
      value.examples.worstEndpoint,
    ]) {
      if (
        !validRaw(example.endpointCashRaw) ||
        !validRaw(example.troughCashRaw) ||
        BigInt(example.endpointMarginAfterQRaw) !== BigInt(example.endpointCashRaw) - q ||
        BigInt(example.troughMarginAfterQRaw) !== BigInt(example.troughCashRaw) - q ||
        !validUtc(example.originAt) ||
        !validUtc(example.endpointAt) ||
        !validUtc(example.troughAt) ||
        Date.parse(example.endpointAt) > Date.parse(value.history.toAt) ||
        !example.sampledBelowQ
      )
        return null
    }
    return value
  } catch {
    return null
  }
}

function sampledPathTiming(example: SampledCashPathExample): string {
  const offset = (at: string) =>
    `${((Date.parse(at) - Date.parse(example.originAt)) / 86_400_000).toFixed(1)}d`
  const range = (bracket: { afterAt: string; byAt: string }) =>
    `${offset(bracket.afterAt)}–${offset(bracket.byAt)}`
  const below = example.sampledBelowQ
  if (!below.firstBelowAt)
    return example.selectedTarget === 'endpoint' && BigInt(example.endpointMarginAfterQRaw) >= 0n
      ? 'Ending cash covers Q'
      : 'No sampled shortfall'
  const onset = below.onsetBracket ? `Below Q ${range(below.onsetBracket)}` : 'Below Q at start'
  const next = below.recoveryBracket ? range(below.recoveryBracket) : 'unobserved'
  return `${onset} · Next sampled above Q ${next}${below.gapCensored ? ' · sample gap' : ''}`
}

function sampledMargin(raw: string, decimals: number): string {
  const negative = raw.startsWith('-')
  const magnitude = formatExitPressureRaw(negative ? raw.slice(1) : raw, decimals)
  return magnitude === null ? 'UNAVAILABLE' : `${negative ? '−' : ''}${magnitude}`
}

function validRaw(value: string): boolean {
  return RAW.test(value) && value.length <= 78
}

function validDecimals(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 36
}

function validUtc(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
}

function sameScope(value: ScopedEvidence | null, routeKey: string, destination: string): boolean {
  return Boolean(
    value &&
    value.routeKey === routeKey &&
    value.destination.toLowerCase() === destination.toLowerCase(),
  )
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validCountFraction(value: unknown, denominator: number): boolean {
  const fraction = record(value)
  return (
    Boolean(fraction) &&
    validCount(fraction!.numerator as number) &&
    validCount(fraction!.denominator as number) &&
    fraction!.denominator === denominator &&
    (fraction!.numerator as number) <= (fraction!.denominator as number)
  )
}

function validDurationEvidence(
  value: unknown,
  requestedRaw: string,
  expectedObservations: number,
): boolean {
  const duration = record(value)
  if (!duration) return false
  if (duration.status === 'unavailable')
    return [
      'endpoint_history_has_no_crossing_or_recovery_time',
      'verified_daily_duration_timeline_unavailable',
      'no_completed_sampled_below_q_runs',
    ].includes(duration.reason as string)
  if (duration.status !== 'historical_interval_outlook') return false
  const completed = record(duration.completedSampledRunDurationSeconds)
  const censored = record(duration.censoredRunObservedSpanLowerBoundSeconds)
  const median = record(completed?.median)
  const p90 = record(completed?.p90)
  const longest = record(completed?.longest)
  const interval = (candidate: Record<string, unknown> | null) =>
    Boolean(
      candidate &&
      validCount(candidate.low as number) &&
      validCount(candidate.high as number) &&
      (candidate.low as number) <= (candidate.high as number),
    )
  const observations = duration.observations as number
  const observedBelowQSamples = duration.observedBelowQSamples as number
  const timelineSegments = duration.timelineSegments as number
  const verifiedTimelineCoverageSeconds = duration.verifiedTimelineCoverageSeconds as number
  const completedSampledRuns = duration.completedSampledRuns as number
  const leftCensoredRuns = duration.leftCensoredRuns as number
  const rightCensoredRuns = duration.rightCensoredRuns as number
  const bothBoundaryCensoredRuns = duration.bothBoundaryCensoredRuns as number
  const sampledRuns = duration.sampledRuns as number
  const contiguousEdges = observations - timelineSegments
  const maximumSampleGapSeconds = 86_400 + 5_400
  const maximumObservedRunSpanSeconds =
    Math.max(0, observedBelowQSamples - 1) * maximumSampleGapSeconds
  const maximumCompletedRunHighSeconds = (observedBelowQSamples + 1) * maximumSampleGapSeconds
  const intervalWithinBounds = (
    candidate: Record<string, unknown> | null,
    maximumLow: number,
    maximumHigh: number,
  ) =>
    interval(candidate) &&
    (candidate!.low as number) <= maximumLow &&
    (candidate!.high as number) <= maximumHigh &&
    (candidate!.high as number) <= verifiedTimelineCoverageSeconds
  return Boolean(
    duration.claim === 'aggregate_endpoint_cash_proxy_only' &&
    duration.intervalCensored === true &&
    duration.prospectiveValidated === false &&
    duration.holderExecutableExit === false &&
    duration.requestedRaw === requestedRaw &&
    observations === expectedObservations &&
    validCount(observedBelowQSamples) &&
    observedBelowQSamples > 0 &&
    observedBelowQSamples <= observations &&
    validCount(timelineSegments) &&
    timelineSegments > 0 &&
    timelineSegments <= observations &&
    contiguousEdges >= 0 &&
    validCount(verifiedTimelineCoverageSeconds) &&
    verifiedTimelineCoverageSeconds >= contiguousEdges * (86_400 - 5_400) &&
    verifiedTimelineCoverageSeconds <= contiguousEdges * maximumSampleGapSeconds &&
    duration.samplingCadenceSeconds === 86_400 &&
    duration.samplingToleranceSeconds === 5_400 &&
    duration.interpretation === 'completed_sampled_below_q_runs_with_censored_observed_spans' &&
    validCount(sampledRuns) &&
    sampledRuns > 0 &&
    sampledRuns <= observedBelowQSamples &&
    validCount(completedSampledRuns) &&
    validCount(leftCensoredRuns) &&
    validCount(rightCensoredRuns) &&
    validCount(bothBoundaryCensoredRuns) &&
    bothBoundaryCensoredRuns <= leftCensoredRuns &&
    bothBoundaryCensoredRuns <= rightCensoredRuns &&
    leftCensoredRuns <= timelineSegments &&
    rightCensoredRuns <= timelineSegments &&
    sampledRuns ===
      completedSampledRuns + leftCensoredRuns + rightCensoredRuns - bothBoundaryCensoredRuns &&
    completedSampledRuns <= observedBelowQSamples &&
    ((completedSampledRuns === 0 && duration.completedSampledRunDurationSeconds === null) ||
      (completedSampledRuns > 0 &&
        completed != null &&
        intervalWithinBounds(
          median,
          maximumObservedRunSpanSeconds,
          maximumCompletedRunHighSeconds,
        ) &&
        intervalWithinBounds(p90, maximumObservedRunSpanSeconds, maximumCompletedRunHighSeconds) &&
        intervalWithinBounds(
          longest,
          maximumObservedRunSpanSeconds,
          maximumCompletedRunHighSeconds,
        ) &&
        (median!.low as number) <= (p90!.low as number) &&
        (p90!.low as number) <= (longest!.low as number) &&
        (median!.high as number) <= (p90!.high as number) &&
        (p90!.high as number) <= (longest!.high as number))) &&
    censored != null &&
    ((leftCensoredRuns === 0 && censored.leftLongest === null) ||
      (leftCensoredRuns > 0 &&
        validCount(censored.leftLongest as number) &&
        (censored.leftLongest as number) <= maximumObservedRunSpanSeconds &&
        (censored.leftLongest as number) <= verifiedTimelineCoverageSeconds)) &&
    ((rightCensoredRuns === 0 && censored.rightLongest === null) ||
      (rightCensoredRuns > 0 &&
        validCount(censored.rightLongest as number) &&
        (censored.rightLongest as number) <= maximumObservedRunSpanSeconds &&
        (censored.rightLongest as number) <= verifiedTimelineCoverageSeconds)),
  )
}

export function selectedHistoricalBacktest(
  value: unknown,
  routeKey: string,
  destination: string,
  requestedRaw: string | null,
  horizonHours: number,
  requestedAssetAddress: string | null,
  requestedAssetDecimals: number | null,
): ExitPressureHistoricalBacktest | null {
  const response = record(value)
  const identity = record(response?.identity)
  const question = record(response?.question)
  const alert = record(response?.alert)
  const normalizedDestination = destination.toLowerCase()
  const normalizedRequestedAsset = requestedAssetAddress?.toLowerCase() ?? null
  if (
    !response ||
    !identity ||
    !question ||
    !alert ||
    !requestedRaw ||
    !validRaw(requestedRaw) ||
    !validRaw(requestedRaw) ||
    !normalizedRequestedAsset ||
    !ADDRESS.test(normalizedRequestedAsset) ||
    requestedAssetDecimals === null ||
    !validDecimals(requestedAssetDecimals) ||
    response.schemaVersion !== 1 ||
    response.status !== 'historical_backtest' ||
    response.analysisKind !== 'retrospective_backtest' ||
    response.claimClass !== 'route_proxy' ||
    identity.routeKey !== routeKey ||
    typeof identity.destination !== 'string' ||
    !ADDRESS.test(identity.destination.toLowerCase()) ||
    identity.destination.toLowerCase() !== normalizedDestination ||
    typeof identity.asset !== 'string' ||
    !ADDRESS.test(identity.asset.toLowerCase()) ||
    identity.asset.toLowerCase() !== normalizedRequestedAsset ||
    identity.assetDecimals !== requestedAssetDecimals ||
    question.requestedRaw !== requestedRaw ||
    question.horizonHours !== horizonHours ||
    response.holderExecutableExit !== false ||
    response.prospectiveValidated !== false ||
    response.forecastValidated !== false ||
    alert.status !== 'unavailable' ||
    alert.reason !== 'retrospective_only'
  )
    return null

  const evidence = record(response.absoluteQBacktest)
  const counts = record(evidence?.counts)
  const outcomes = record(evidence?.outcomes)
  const cashBand = record(response.cashBand)
  const total = counts?.total as number
  const fit = counts?.fit as number
  const calibration = counts?.calibration as number
  const holdout = counts?.holdout as number
  if (
    !evidence ||
    !counts ||
    !outcomes ||
    !cashBand ||
    evidence.status !== 'historical_backtest' ||
    evidence.claim !== 'aggregate_endpoint_cash_proxy_only' ||
    evidence.historicalBacktestOnly !== true ||
    evidence.prospectiveValidated !== false ||
    evidence.holderExecutableExit !== false ||
    evidence.requestedRaw !== requestedRaw ||
    !validCount(total) ||
    !validCount(fit) ||
    !validCount(calibration) ||
    !validCount(holdout) ||
    fit === 0 ||
    calibration === 0 ||
    holdout === 0 ||
    total !== fit + calibration + holdout ||
    !validCountFraction(outcomes.fitBelowQ, fit) ||
    !validCountFraction(outcomes.calibrationBelowQ, calibration) ||
    !validCountFraction(outcomes.holdoutBelowQ, holdout) ||
    !validDurationEvidence(response.duration, requestedRaw, total * 2) ||
    (cashBand.status === 'available' &&
      (cashBand.evidence !== 'retrospective_backtest' ||
        cashBand.modelKind !== 'endpoint_net_cash_band' ||
        cashBand.flowTreatment !== 'all_aggregate_flow_already_included'))
  )
    return null

  return value as ExitPressureHistoricalBacktest
}

export function selectedHistoricalGrossFlow(
  value: ExitPressureHistoricalGrossFlow | null,
  routeKey: string,
  destination: string,
  requestedRaw: string | null,
  requestedAssetAddress: string | null,
  requestedAssetDecimals: number | null,
  asOfMs: number,
): ExitPressureHistoricalGrossFlow | null {
  if (
    !requestedRaw ||
    !requestedAssetAddress ||
    !validDecimals(requestedAssetDecimals) ||
    !sameScope(value, routeKey, destination) ||
    value?.requestedRaw !== requestedRaw ||
    !value ||
    value.requestedAmountRaw !== requestedRaw ||
    !ADDRESS.test(value.assetAddress) ||
    value.assetAddress.toLowerCase() !== requestedAssetAddress.toLowerCase() ||
    value.assetDecimals !== requestedAssetDecimals ||
    !validRaw(value.startingCashRaw) ||
    !Number.isSafeInteger(value.startingBlock) ||
    value.startingBlock < 0 ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.startingBlockHash) ||
    !validUtc(value.startingAt) ||
    !Number.isSafeInteger(asOfMs) ||
    asOfMs - Date.parse(value.startingAt) < -120_000 ||
    asOfMs - Date.parse(value.startingAt) > 30 * 60_000 ||
    !validDecimals(value.assetDecimals) ||
    !Number.isSafeInteger(value.horizonBlocks) ||
    value.horizonBlocks < 1 ||
    !Number.isSafeInteger(value.windowCount) ||
    value.windowCount < 1 ||
    !value.source ||
    !Number.isSafeInteger(value.source.fromBlock) ||
    !Number.isSafeInteger(value.source.toBlock) ||
    value.source.fromBlock > value.source.toBlock ||
    !value.pairedScenarios ||
    !value.pairedScenarios.p10Trough ||
    !value.pairedScenarios.worstTrough ||
    !value.pairedScenarios.highestGrossOutflow ||
    value.pairedScenarios.sampleCount !== value.windowCount ||
    value.pairedScenarios.p10Trough.rank !== Math.floor((value.windowCount - 1) * 0.1) + 1 ||
    value.pairedScenarios.worstTrough.rank !== 1 ||
    value.pairedScenarios.highestGrossOutflow.rank !== 1 ||
    !/^-?(0|[1-9][0-9]*)$/.test(value.currentMarginAfterQRaw) ||
    BigInt(value.startingCashRaw) - BigInt(requestedRaw) !== BigInt(value.currentMarginAfterQRaw)
  )
    return null
  const scenarios = [
    value.pairedScenarios.p10Trough,
    value.pairedScenarios.worstTrough,
    value.pairedScenarios.highestGrossOutflow,
  ]
  return scenarios.every((window) =>
    validSelectedPairedFlowWindow(
      window,
      value.pairedScenarios.sampleCount,
      value.horizonBlocks,
      value.source,
      value.startingCashRaw,
      requestedRaw,
    ),
  )
    ? value
    : null
}

function validSelectedPairedFlowWindow(
  window: TranslatedPairedFlowWindow,
  sampleCount: number,
  horizonBlocks: number,
  source: { fromBlock: number; toBlock: number; joinContentSha256?: string },
  startingCashRaw: string,
  requestedRaw: string,
) {
  const raw = (value: string) => /^(0|[1-9][0-9]*)$/.test(value)
  const signed = (value: string) => /^-?(0|[1-9][0-9]*)$/.test(value)
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1 ||
    !Number.isSafeInteger(horizonBlocks) ||
    horizonBlocks < 1 ||
    !Number.isSafeInteger(source.fromBlock) ||
    !Number.isSafeInteger(source.toBlock) ||
    !Number.isSafeInteger(window.rank) ||
    window.rank < 1 ||
    window.rank > sampleCount ||
    window.sampleCount !== sampleCount ||
    !Number.isSafeInteger(window.originBlock) ||
    !Number.isSafeInteger(window.targetBlock) ||
    !Number.isSafeInteger(window.troughBlock) ||
    window.targetBlock - window.originBlock !== horizonBlocks ||
    window.originBlock < source.fromBlock ||
    window.targetBlock > source.toBlock ||
    window.troughBlock < window.originBlock ||
    window.troughBlock > window.targetBlock ||
    ![
      startingCashRaw,
      requestedRaw,
      window.sourceCashRaw,
      window.targetCashRaw,
      window.grossReserveInRaw,
      window.grossReserveOutRaw,
      window.troughCashRaw,
      window.endpointCashRaw,
      window.troughCashRawReplayed,
      window.endpointDeficitAfterQRaw,
      window.troughDeficitAfterQRaw,
    ].every(raw) ||
    ![
      window.endpointCashDeltaRaw,
      window.troughCashDeltaRaw,
      window.endpointMarginAfterQRaw,
      window.troughMarginAfterQRaw,
    ].every(signed)
  )
    return false
  const sourceCash = BigInt(window.sourceCashRaw)
  const targetCash = BigInt(window.targetCashRaw)
  const grossIn = BigInt(window.grossReserveInRaw)
  const grossOut = BigInt(window.grossReserveOutRaw)
  const endpointDelta = BigInt(window.endpointCashDeltaRaw)
  const troughCash = BigInt(window.troughCashRaw)
  const troughDelta = BigInt(window.troughCashDeltaRaw)
  const startingCash = BigInt(startingCashRaw)
  const requested = BigInt(requestedRaw)
  const replayedEndpoint = startingCash + endpointDelta > 0n ? startingCash + endpointDelta : 0n
  const replayedTrough = startingCash + troughDelta > 0n ? startingCash + troughDelta : 0n
  return (
    matchesPairedWindowDuration(window, startingCashRaw, requestedRaw, source.joinContentSha256) &&
    sourceCash + grossIn - grossOut === targetCash &&
    targetCash - sourceCash === endpointDelta &&
    troughCash <= sourceCash &&
    troughCash <= targetCash &&
    troughCash - sourceCash === troughDelta &&
    replayedEndpoint.toString() === window.endpointCashRaw &&
    replayedTrough.toString() === window.troughCashRawReplayed &&
    (replayedEndpoint - requested).toString() === window.endpointMarginAfterQRaw &&
    (replayedTrough - requested).toString() === window.troughMarginAfterQRaw &&
    (replayedEndpoint < requested ? requested - replayedEndpoint : 0n).toString() ===
      window.endpointDeficitAfterQRaw &&
    (replayedTrough < requested ? requested - replayedTrough : 0n).toString() ===
      window.troughDeficitAfterQRaw
  )
}

export function formatExitPressureRaw(raw: string, decimals: number): string | null {
  if (!validRaw(raw) || !validDecimals(decimals)) return null
  if (decimals === 0) return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function formatDurationSeconds(seconds: number, rounding: 'floor' | 'ceil'): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return 'UNAVAILABLE'
  if (seconds % 86_400 === 0) return `${seconds / 86_400}D`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}H`
  const hours = rounding === 'floor' ? Math.floor(seconds / 3_600) : Math.ceil(seconds / 3_600)
  return `${hours}H`
}

function durationInterval(low: number, high: number): string {
  return `${formatDurationSeconds(low, 'floor')}–${formatDurationSeconds(high, 'ceil')}`
}

function censoredSampledSpan(count: number, lowerBoundSeconds: number | null): string {
  return count > 0 && lowerBoundSeconds !== null
    ? `${count} (≥${formatDurationSeconds(lowerBoundSeconds, 'floor')})`
    : '0'
}

export function formatExitPressureSignedRaw(raw: string, decimals: number): string | null {
  const negative = raw.startsWith('-')
  const formatted = formatExitPressureRaw(negative ? raw.slice(1) : raw, decimals)
  return formatted ? `${negative ? '−' : '+'}${formatted}` : null
}

export function formatRequestedCashShare(requestedRaw: string, cashRaw: string): string | null {
  if (!validRaw(requestedRaw) || !validRaw(cashRaw) || BigInt(cashRaw) === 0n) return null
  const hundredths = (BigInt(requestedRaw) * 10_000n + BigInt(cashRaw) / 2n) / BigInt(cashRaw)
  const whole = hundredths / 100n
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''}%`
}

function shortDestination(destination: string): string {
  return ADDRESS.test(destination.toLowerCase())
    ? `${destination.slice(0, 6)}…${destination.slice(-4)}`
    : destination
}

/** Bind the optional scenario to the independently selected current cash and view clock. */
export function selectedConditionalHeadroomForCard(
  value: unknown,
  question: Pick<
    ExitPressureCardProps,
    | 'routeKey'
    | 'destination'
    | 'requestedRaw'
    | 'requestedAssetAddress'
    | 'requestedAssetDecimals'
    | 'horizonHours'
    | 'asOfMs'
  >,
  current: ExitPressureCurrentCash | null,
  sampledValue?: unknown,
): ConditionalGrossFlowProjection | null {
  try {
    const payload = record(value)
    const request = record(payload?.request)
    const local = current?.sourceKind === 'manifest_bound_ledger'
    const localWitness = local
      ? selectedConditionalSampledHeadroomForCard(sampledValue, question, current)
      : null
    const readAt = local ? current?.firstLocalReceiptAt : current?.readAtUtc
    if (
      !current ||
      !request ||
      !question.requestedRaw ||
      question.horizonHours !== 24 ||
      (!localWitness && current.sourceKind !== 'live_read_only_two_origin_finalized') ||
      current.freshness !== 'fresh' ||
      current.routeKey !== question.routeKey ||
      current.destination.toLowerCase() !== question.destination.toLowerCase() ||
      current.assetAddress?.toLowerCase() !== question.requestedAssetAddress?.toLowerCase() ||
      current.assetDecimals !== question.requestedAssetDecimals ||
      typeof current.block !== 'string' ||
      !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
      BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !validUtc(current.observedAt) ||
      typeof readAt !== 'string' ||
      !validUtc(readAt) ||
      typeof request.asOf !== 'string' ||
      !validUtc(request.asOf) ||
      !Number.isSafeInteger(question.asOfMs) ||
      Date.parse(request.asOf) > question.asOfMs ||
      Date.parse(current.observedAt) > question.asOfMs ||
      question.asOfMs - Date.parse(current.observedAt) >
        CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000 ||
      Date.parse(readAt) > question.asOfMs
    )
      return null
    const selected = selectedConditionalGrossFlowHeadroom(
      value,
      {
        currentSource: {
          chainId: 1,
          routeKey: current.routeKey,
          destination: current.destination,
          asset: current.assetAddress!,
          assetDecimals: current.assetDecimals,
          cashRaw: current.cashRaw,
          blockNumber: Number(current.block),
          blockHash: current.blockHash!,
          blockTime: current.observedAt,
          readAt,
          finalized: true,
        },
        request: { requestedRaw: question.requestedRaw, asOf: request.asOf },
      },
      (s) => sha256(stringToHex(s)).slice(2),
    )
    return selected && Date.parse(selected.target.earliestAt) > question.asOfMs ? selected : null
  } catch {
    return null
  }
}

export type HolderTimeProcessIssue = {
  susdeForecast?: SusdeHolderForecastEnvelope
  issuedAtMs: number
  horizonHours: number
  owner: string
  requestedRaw: string
  block: string
  blockHash: string
  source?: MorphoV2HolderForecastIssue['source']
  independentSource?: MorphoV2HolderForecastIssue['independentSource']
}
type CashTimeQuestion = Pick<
  ExitPressureCardProps,
  | 'routeKey'
  | 'destination'
  | 'requestedRaw'
  | 'requestedAssetAddress'
  | 'requestedAssetDecimals'
  | 'horizonHours'
  | 'asOfMs'
  | 'requestedHolderAddress'
>
/** Source witness and exact native owner entitlement are selected independently of model payloads. */
export function issuedCashHolderTimeInputForCard(
  value: unknown,
  agreement: unknown,
  cometFacts: unknown,
  executionAgreement: unknown,
  question: CashTimeQuestion,
  current: ExitPressureCurrentCash | null,
): CashHolderTimeProcessInput | null {
  try {
    if (!question.requestedHolderAddress || !Number.isSafeInteger(question.asOfMs)) return null
    const cash = selectedConditionalSampledHeadroomForCard(
      value,
      { ...question, horizonHours: 24 },
      current,
    )
    if (!cash) return null
    const c = cash.currentSource
    const binding = {
      routeKey: question.routeKey,
      destination: question.destination.toLowerCase(),
      owner: question.requestedHolderAddress.toLowerCase(),
      requestedRaw: question.requestedRaw!,
      asset: c.asset,
      assetDecimals: c.assetDecimals,
      currentSource: {
        chainId: 1 as const,
        blockNumber: Number(c.block),
        blockHash: c.blockHash,
        blockTime: c.blockTime,
        finalized: true as const,
      },
      asOfMs: question.asOfMs,
      executionAgreement: executionAgreement as any,
    }
    const capacity = selectedHolderExitCapacity(agreement, binding)
    if (
      !capacity ||
      capacity.quote.entitlementMethod !== 'supplied_balance' ||
      capacity.quote.entitlementRaw === null
    )
      return null
    return structuredClone({
      cashProjection: cash,
      capacityAgreement: agreement,
      cometFactsAgreement: cometFacts,
      currentSource: c,
      binding,
      horizonHours: question.horizonHours,
      asOfMs: question.asOfMs,
    })
  } catch {
    return null
  }
}
/** Receipt-time USD3 issuance binds idle USDC diagnostics and independent full holder entitlement. */
export function issuedUsd3HolderTimeInputForCard(
  value: unknown,
  agreement: unknown,
  executionAgreement: unknown,
  question: CashTimeQuestion,
  current: ExitPressureCurrentCash | null,
): Usd3HolderCapacityInput | null {
  try {
    if (!question.requestedHolderAddress || !Number.isSafeInteger(question.asOfMs)) return null
    const cash = selectedUsd3CashForCard(value, question, current)
    if (!cash) return null
    const c = cash.currentSource
    const binding = {
      routeKey: question.routeKey,
      destination: question.destination.toLowerCase(),
      owner: question.requestedHolderAddress.toLowerCase(),
      requestedRaw: question.requestedRaw!,
      asset: c.asset,
      assetDecimals: c.assetDecimals,
      currentSource: {
        chainId: 1 as const,
        blockNumber: Number(c.block),
        blockHash: c.blockHash,
        blockTime: c.blockTime,
        finalized: true as const,
      },
      asOfMs: question.asOfMs,
      executionAgreement: executionAgreement as any,
    }
    const capacity = selectedHolderExitCapacity(agreement, binding)
    if (
      !capacity ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      capacity.quote.entitlementRaw === null ||
      capacity.quote.quotedMaxWithdrawStatus !== 'quoted' ||
      capacity.quote.quotedMaxWithdrawRaw === null
    )
      return null
    return structuredClone({
      cashProjection: cash,
      capacityAgreement: agreement,
      binding,
      currentSource: c,
      horizonHours: question.horizonHours,
      asOfMs: question.asOfMs,
    })
  } catch {
    return null
  }
}
export function issuedStusdsTimeInputForCard(
  value: unknown,
  agreement: unknown,
  executionAgreement: unknown,
  protocolEvidence: unknown,
  question: CashTimeQuestion,
  current: ExitPressureCurrentCash | null,
) {
  try {
    if (!question.requestedHolderAddress) return null
    const cash = selectedStusdsCashForCard(value, { ...question, horizonHours: 24 }, current)
    if (!cash) return null
    const s = cash.currentSource,
      source = {
        chainId: 1 as const,
        blockNumber: Number(s.block),
        blockHash: s.blockHash,
        blockTime: s.blockTime,
        finalized: true as const,
      },
      hash = (text: string) => sha256(stringToHex(text)).slice(2)
    const record = decodeStusdsProtocolEvidence(protocolEvidence),
      expected = {
        source,
        asOfMs: question.asOfMs,
        originHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
      }
    const approved = record
      ? replayStusdsCurrentProtocolCapacityEvidence(record, expected, hash)
      : null
    if (!approved) return null
    const binding = {
      routeKey: question.routeKey,
      destination: question.destination.toLowerCase(),
      owner: question.requestedHolderAddress.toLowerCase(),
      requestedRaw: question.requestedRaw!,
      asset: s.asset,
      assetDecimals: s.assetDecimals,
      currentSource: source,
      asOfMs: question.asOfMs,
      executionAgreement: executionAgreement as any,
    }
    const capacity = selectedHolderExitCapacity(agreement, binding)
    if (
      !capacity ||
      capacity.quote.entitlementMethod !== 'preview_redeem_full_position' ||
      capacity.quote.entitlementRaw === null
    )
      return null
    return structuredClone({
      history: stusdsPinnedProtocolHistory(),
      current: approved,
      capacityAgreement: agreement,
      binding,
      horizonHours: question.horizonHours,
      asOfMs: question.asOfMs,
    })
  } catch {
    return null
  }
}
function timeWitnessKey(current: ExitPressureCurrentCash | null): string | null {
  if (!current) return null
  const fields = [
    'routeKey',
    'destination',
    'cashRaw',
    'observedAt',
    'block',
    'blockHash',
    'readAtUtc',
    'firstLocalReceiptAt',
    'sourceKind',
    'manifestSha256',
    'receiptSha256',
    'assetAddress',
    'assetDecimals',
    'freshness',
    'label',
  ] as const
  const witness: Record<string, unknown> = {}
  for (const field of fields) {
    const v = current[field]
    if (
      v !== undefined &&
      v !== null &&
      typeof v !== (field === 'assetDecimals' ? 'number' : 'string')
    )
      return null
    witness[field] = v
  }
  return JSON.stringify(witness)
}
function freezeIssued<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freezeIssued)
    Object.freeze(v)
  }
  return v
}
/** Cheap clock-only check for a privately cached, already strict-selector-approved issuance. */
export function cashHolderTimeRenderWindow(
  value: Pick<NonNullable<ReturnType<typeof buildConditionalCashHolderTimeProcess>>, 'process'>,
  asOfMs: number,
) {
  return (
    Number.isSafeInteger(asOfMs) &&
    asOfMs >= Date.parse(value.process.issueAtUtc) &&
    asOfMs <= Date.parse(value.process.sourceProofValidUntil) &&
    asOfMs < Date.parse(value.process.targetAtUtc)
  )
}
export function cashHolderDurationDetail(
  value: Pick<NonNullable<ReturnType<typeof buildConditionalCashHolderTimeProcess>>, 'process'>,
) {
  const issue = Date.parse(value.process.issueAtUtc),
    target = Date.parse(value.process.targetAtUtc)
  const runs = value.process.scenarios
    .flatMap((s) => s.sampledShortfalls)
    .filter((r) => !r.recovery || Date.parse(r.recovery.by) > issue)
  if (!runs.length) return ''
  const bounds = runs.map((r) => {
    // Future exposure starts at issue, even when a source-age episode started earlier.
    const startLower = Math.max(issue, r.onset.after === null ? issue : Date.parse(r.onset.after)),
      startUpper = Math.max(issue, Date.parse(r.onset.by))
    const lower = Math.max(
      0,
      (r.recovery ? Math.max(issue, Date.parse(r.recovery.after)) : target) - startUpper,
    )
    const upper = r.recovery ? Math.max(0, Date.parse(r.recovery.by) - startLower) : null
    return { lower, upper }
  })
  const lower = Math.min(...bounds.map((b) => b.lower)),
    censored = bounds.some((b) => b.upper === null)
  const upper = censored ? null : Math.max(...bounds.map((b) => b.upper!))
  const unit = (upper ?? lower) < 60000 ? 's' : (upper ?? lower) < 3600000 ? 'min' : 'h',
    scale = unit === 's' ? 1000 : unit === 'min' ? 60000 : 3600000
  const roundedLower = Math.floor((lower / scale) * 10) / 10
  if (censored)
    return roundedLower === 0 ? ' · SHORTFALL AT TARGET' : ` · SHORTFALL ≥${roundedLower}${unit}`
  const roundedUpper = Math.ceil((upper! / scale) * 10) / 10
  return ` · SHORTFALL ${roundedLower}–${roundedUpper}${unit}`
}

function susdeFundingDetail(process: SusdeHolderTimeProcessModel['active']['funding']) {
  const sourceHeadroom = process.scenarios[0]?.points[0]?.headroomRaw
  const thins =
    sourceHeadroom !== undefined &&
    process.targetSummary &&
    BigInt(process.targetSummary.minimumHeadroomRaw) < BigInt(sourceHeadroom)
  return `${thins ? ' · FUNDING THINS' : ''}${cashHolderDurationDetail({ process })}`
}

/** Only the separately retained original idle receipt can select either forecast kind. */
export function selectedMorphoV2IdleJointForCard(
  retained: unknown,
  active: Pick<ExitPressureCardProps, 'routeKey' | 'destination' | 'requestedRaw' |
    'requestedAssetAddress' | 'requestedAssetDecimals' | 'requestedHolderAddress' |
    'horizonHours' | 'asOfMs'>,
  current: ExitPressureCurrentCash | null,
): MorphoV2IdleJointHolderForecast | MorphoV2IdleJointHolderForecastV2 | null {
  try {
    if (retained === null || typeof retained !== 'object' || Array.isArray(retained) ||
      Object.getPrototypeOf(retained) !== Object.prototype ||
      Object.getOwnPropertySymbols(retained).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(retained)
    if (Object.keys(descriptors).length !== 2 || !['question', 'issue'].every((key) =>
      descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))) return null
    const model = selectedMorphoV2IdleJointHolderForecastV2FromIssue(
      descriptors.issue.value, descriptors.question.value, active.asOfMs,
    ) ?? selectedMorphoV2IdleJointHolderForecastFromIssue(
      descriptors.issue.value, descriptors.question.value, active.asOfMs,
    )
    if (!model) return null
    const q = model.question
    if (q.routeKey !== active.routeKey || q.destination !== active.destination.toLowerCase() ||
      q.requestedRaw !== active.requestedRaw ||
      q.requestedAssetAddress !== active.requestedAssetAddress?.toLowerCase() ||
      q.requestedAssetDecimals !== active.requestedAssetDecimals ||
      q.requestedHolderAddress !== active.requestedHolderAddress?.toLowerCase() ||
      q.horizonHours !== active.horizonHours) return null
    if (current) {
      if (current.routeKey !== q.routeKey || current.destination.toLowerCase() !== q.destination ||
        current.assetAddress?.toLowerCase() !== q.requestedAssetAddress ||
        current.assetDecimals !== q.requestedAssetDecimals) return null
      const hasBlock = current.block !== undefined && current.block !== null
      const hasHash = current.blockHash !== undefined && current.blockHash !== null
      if ((hasBlock && current.block !== model.source.blockNumber) ||
        (hasHash && current.blockHash !== model.source.blockHash) ||
        (hasBlock && hasHash && current.observedAt !== model.source.blockTime)) return null
    }
    return model
  } catch { return null }
}

/** Round native amounts for display without converting the underlying integer to float. */
export function formatExitPressureApproxRaw(raw: string, decimals: number): string | null {
  const negative = raw.startsWith('-'), unsigned = negative ? raw.slice(1) : raw
  if (!validRaw(unsigned) || !validDecimals(decimals)) return null
  const value = BigInt(unsigned), digits = value.toString().length
  const scale = digits > 2 ? 10n ** BigInt(digits - 2) : 1n
  const rounded = ((value + scale / 2n) / scale) * scale
  const text = formatExitPressureRaw(rounded.toString(), decimals)
  return text === null ? null : `${negative && rounded !== 0n ? '−' : ''}${text}`
}

/** Keep displayed interval bounds outward, including signed headroom. */
export function formatExitPressureRawRange(lowerRaw: string, upperRaw: string, decimals: number): string | null {
  const signed = (raw: string) => validRaw(raw.startsWith('-') ? raw.slice(1) : raw)
  if (!signed(lowerRaw) || !signed(upperRaw) || !validDecimals(decimals)) return null
  const lower = BigInt(lowerRaw), upper = BigInt(upperRaw)
  if (lower > upper) return null
  if (lower === upper) {
    const absolute = lower < 0n ? -lower : lower
    const exact = formatExitPressureRaw(absolute.toString(), decimals)
    return exact === null ? null : `${lower < 0n ? '−' : ''}${exact}`
  }
  const bound = (value: bigint, direction: 'lower' | 'upper') => {
    const absolute = value < 0n ? -value : value
    const digits = absolute.toString().length
    const scale = digits > 2 ? 10n ** BigInt(digits - 2) : 1n
    const away = value < 0n ? direction === 'lower' : direction === 'upper'
    const rounded = (absolute / scale + (away && absolute % scale !== 0n ? 1n : 0n)) * scale
    const text = formatExitPressureRaw(rounded.toString(), decimals)
    return text === null ? null : `${value < 0n && rounded !== 0n ? '−' : ''}${text}`
  }
  const low = bound(lower, 'lower'), high = bound(upper, 'upper')
  return low === null || high === null ? null : `${low}–${high}`
}

/** Presentation of exact donor-model windows; horizon bounds never imply full episode bounds. */
export function morphoIdleAnalyticalConditionMetrics(model: MorphoV2IdleJointHolderForecast): {
  conditionWindow: string
  episodes: { onset: string; recovery: string; duration: string; withinHorizon: string }[]
} | null {
  const scenario = model.process.scenarios.find(s => s.status === 'usable')
  if (!scenario || scenario.status !== 'usable' || !scenario.modeledShortageWindows) return null
  const analytical = scenario.modeledShortageWindows
  const fractionBounds = (x: { numerator: string; denominator: string }) => {
    const n = BigInt(x.numerator), d = BigInt(x.denominator)
    return { lowerMs: Number(n / d), upperMs: Number((n + d - 1n) / d) }
  }
  const utcBound = (elapsed: number, upper: boolean) => {
    const raw = model.issuedAtMs + elapsed
    return utcMinute(new Date((upper ? Math.ceil(raw / 60000) : Math.floor(raw / 60000)) * 60000).toISOString())
  }
  const time = (b: { lowerMs: number; upperMs: number }) => {
    const lower = utcBound(b.lowerMs, false), upper = utcBound(b.upperMs, true)
    return lower === upper ? lower : `${lower}–${upper}`
  }
  const duration = (b: { lowerMs: number; upperMs: number }, open = false) => {
    const scale = b.upperMs < 60000 ? 1000 : b.upperMs < 3600000 ? 60000 : 3600000
    const unit = scale === 1000 ? 's' : scale === 60000 ? 'min' : 'h'
    const lower = Math.floor(b.lowerMs / scale), upper = Math.ceil(b.upperMs / scale)
    if (open) return lower === 0 ? 'Open episode' : `≥${lower}${unit} · open`
    return lower === upper ? `${lower}${unit}` : `${lower}–${upper}${unit}`
  }
  const adequate = analytical.exactAdequacyWindow
  const absolute = (ms: number, scale = 1) => new Date(ms).toISOString().slice(0, scale === 60000 ? 16 : scale === 1000 ? 19 : 23).replace('T', ' ') + ' UTC'
  let conditionWindow = 'No adequate interval'
  if (adequate) {
    const start = fractionBounds(adequate.start), end = fractionBounds(adequate.end)
    const sn = BigInt(adequate.start.numerator), sd = BigInt(adequate.start.denominator)
    const en = BigInt(adequate.end.numerator), ed = BigInt(adequate.end.denominator)
    const width = en * sd - sn * ed, denominator = ed * sd
    const location = `${absolute(model.issuedAtMs + start.lowerMs)}–${absolute(model.issuedAtMs + end.upperMs)}`
    const integer = analytical.adequacyWindow
    if (width === 0n) {
      conditionWindow = start.lowerMs === start.upperMs
        ? `Adequate instant · ${absolute(model.issuedAtMs + start.lowerMs)}`
        : `Adequate instant · location bound ${location}`
    } else if (!integer || integer.firstIntegerAdequateMs === integer.lastIntegerAdequateMs) {
      conditionWindow = `${width < denominator ? '<1 ms window' : 'Narrow window'} · location bound ${location}`
    } else {
      // An adequate interval rounds inward; event-location bounds below round outward.
      for (const scale of [60000, 1000, 1]) {
        const first = Math.ceil((model.issuedAtMs + integer.firstIntegerAdequateMs) / scale) * scale
        const last = Math.floor((model.issuedAtMs + integer.lastIntegerAdequateMs) / scale) * scale
        if (first < last) { conditionWindow = `${absolute(first, scale)} → ${absolute(last, scale)}`; break }
      }
    }
  }
  return { conditionWindow, episodes: analytical.windows.map(window => ({
    onset: window.leftCensored ? 'Open start · at issue' : time(window.startElapsedMs),
    recovery: window.rightCensored ? 'Open recovery · at horizon' : time(window.endElapsedMs),
    duration: duration(window.modeledDurationMs, window.leftCensored || window.rightCensored),
    withinHorizon: `${duration(window.modeledDurationMs)} within horizon`,
  })) }
}

export function saturnConditionalQuoteWindowLabel(model: SaturnAppForecast): string {
  const window = model.conditionalQuoteWindow
  if (!window) return 'No adequate quote within horizon'
  const firstMs = model.issuedAtMs + window.firstElapsedMs
  const lastMs = model.issuedAtMs + window.lastElapsedMs
  const utc = (ms: number, scale: number) => new Date(ms).toISOString()
    .slice(0, scale === 60000 ? 16 : scale === 1000 ? 19 : 23)
    .replace('T', ' ') + ' UTC'
  if (firstMs === lastMs) return `Adequate instant · ${utc(firstMs, 1)}`
  // Adequate intervals round inward; short intervals retain second or millisecond precision.
  for (const scale of [60000, 1000, 1]) {
    const first = Math.ceil(firstMs / scale) * scale
    const last = Math.floor(lastMs / scale) * scale
    if (first < last) return `${utc(first, scale)} → ${utc(last, scale)}`
  }
  return `Adequate instant · ${utc(firstMs, 1)}`
}

function morphoIdleSampledShortfall(model: MorphoV2IdleJointHolderForecast): string | null {
  const scenario = model.process.scenarios.find((s) => s.status === 'usable')
  if (!scenario || scenario.status !== 'usable') return null
  const timing = scenario.sampledTimeline
  if (timing.firstSampledInsufficiencyMs === null) return null
  const absoluteUtc = (elapsedMs: number) => utcMinute(new Date(model.issuedAtMs + elapsedMs).toISOString())
  if (timing.insufficientAtIssue) return absoluteUtc(0)
  return timing.firstSampledCrossing
    ? `${absoluteUtc(timing.firstSampledCrossing.earliestElapsedMs)}–${absoluteUtc(timing.firstSampledCrossing.latestElapsedMs)}`
    : absoluteUtc(timing.firstSampledInsufficiencyMs)
}

export function morphoIdlePanelTimingValue(model: MorphoV2IdleJointHolderForecastV2): string {
  const summary = model.sampledIntervalSummary
  const first = summary.firstSampledPossibleInsufficiencyMs
  if (first === null) return summary.censoredScenarioCount > 0 ? 'Unresolved' : 'No sampled shortage'
  const at = (elapsed: number) => utcMinute(new Date(model.issuedAtMs + elapsed).toISOString())
  const latest = summary.latestAffectedSampledInsufficiencyMs
  return latest === null ? `${at(first)}–unresolved` : `${at(first)}–${at(latest)}`
}

export function morphoIdlePanelCapacityChange(model: MorphoV2IdleJointHolderForecastV2): {
  lowerRaw: string; upperRaw: string; shrinkingDonorCount: number; donorCount: number
} | null {
  const changes = model.process.scenarios.flatMap((s) => {
    if (s.status !== 'usable') return []
    const lower = 'measurementInterval' in s ? s.measurementInterval.availableLowerRaw : s.measurement.availableRaw
    const upper = 'measurementInterval' in s ? s.measurementInterval.availableUpperRaw : s.measurement.availableRaw
    const issueLower = BigInt('issueInterval' in s ? s.issueInterval.availableLowerRaw : s.issueMeasurement.availableRaw)
    const issueUpper = BigInt('issueInterval' in s ? s.issueInterval.availableUpperRaw : s.issueMeasurement.availableRaw)
    return [{ lower: BigInt(lower) - issueUpper, upper: BigInt(upper) - issueLower }]
  })
  if (!changes.length) return null
  return {
    lowerRaw: changes.reduce((a, s) => s.lower < a ? s.lower : a, changes[0].lower).toString(),
    upperRaw: changes.reduce((a, s) => s.upper > a ? s.upper : a, changes[0].upper).toString(),
    shrinkingDonorCount: changes.filter((s) => s.lower < 0n).length,
    donorCount: changes.length,
  }
}

export function morphoIdlePanelDurationValue(
  model: MorphoV2IdleJointHolderForecastV2,
  lane: 'possible' | 'definite' = 'possible',
): string {
  const summary = model.modeledShortageSummary[lane]
  const range = summary.fullEpisodeDurationRangeMs
  if (!range) return model.modeledShortageSummary.censoredScenarioCount > 0 ? 'Unresolved' : 'No projected shortage'
  const lowerMs = summary.neverShortageScenarioCount > 0 ? 0 : range.lowerMs
  const scale = (range.upperMs ?? lowerMs) < 60000 ? 1000 : (range.upperMs ?? lowerMs) < 3600000 ? 60000 : 3600000
  const unit = scale === 1000 ? 's' : scale === 60000 ? 'min' : 'h'
  const time = (ms: number, upper: boolean) => {
    return `${upper ? Math.ceil(ms / scale) : Math.floor(ms / scale)}${unit}`
  }
  if (range.upperMs === null) return lowerMs < scale ? 'Unresolved' : `${time(lowerMs, false)}–unresolved`
  return lowerMs < scale ? `≤${time(range.upperMs, true)}` : `${time(lowerMs, false)}–${time(range.upperMs, true)}`
}

function morphoJointDetail(model: MorphoV2JointHolderForecast, symbol: string): React.ReactNode {
  const p = model.process,
    summary = p.descriptiveExpectedFlow.headline?.headroom
  const samples = p.scenarios.flatMap((s) =>
    s.status === 'usable' && s.sampledDuration ? [s.sampledDuration] : [],
  )
  const losses = samples.flatMap((s) =>
    s.firstSampledInsufficiencyMs === null ? [] : [s.firstSampledInsufficiencyMs],
  )
  const minutes = (ms: number) => String(Math.round(ms / 6000) / 10)
  const firstSample = losses.length
    ? `${minutes(Math.min(...losses))}–${minutes(Math.max(...losses))}min`
    : '—'
  const gapSeconds = samples.length
    ? Math.max(...samples.map((s) => s.maxCheckpointGapMs)) / 1000
    : null
  return (
    <>
      {`${model.targetAtUtc.slice(5, 19).replace('T', ' ')} UTC · MIN–MAX ${summary ? `${formatExitPressureSignedRaw(summary.band.minRaw, model.assetDecimals)}–${formatExitPressureSignedRaw(summary.band.maxRaw, model.assetDecimals)} ${symbol}` : '—'}`}
      <br />
      {`USABLE ${p.usableScenarioCount}/${model.attemptedDonorCount} · CENSORED ${p.descriptiveExpectedFlow.censoredScenarioCount} · EXCLUDED ${p.excludedDonors.length}`}
      <br />
      {`S ${formatExitPressureRaw(model.sharesRaw, model.shareDecimals)} · Ea ${formatExitPressureRaw(model.fullEaRaw, model.assetDecimals)} ${symbol} · M ? · MARKET MAX ${p.marketMaximumRaw === null ? '?' : formatExitPressureRaw(p.marketMaximumRaw, model.assetDecimals)} ${symbol}`}
      <br />
      {`LOSS SAMPLES ${losses.length}/${samples.length} · FIRST SAMPLE ${firstSample} · GAP ${gapSeconds === null ? '?' : `≤${gapSeconds}s`} · BETWEEN SAMPLES ?`}
    </>
  )
}

export function selectedAnalogCashForCard(
  value: AnalogCashScenario | null | undefined,
  issued: AnalogCashScenarioIssue | null,
  question: Pick<
    ExitPressureCardProps,
    | 'routeKey'
    | 'destination'
    | 'requestedRaw'
    | 'requestedAssetAddress'
    | 'requestedAssetDecimals'
    | 'horizonHours'
    | 'asOfMs'
  >,
  current: ExitPressureCurrentCash | null,
  ownNativeAvailable = false,
  currentSourceConflict = false,
) {
  if (
    !current ||
    current.freshness !== 'fresh' ||
    !current.assetAddress ||
    !current.block ||
    !current.blockHash ||
    current.routeKey !== question.routeKey ||
    current.destination.toLowerCase() !== question.destination.toLowerCase()
  )
    return null
  const local = current.sourceKind === 'manifest_bound_ledger'
  const readAt = local ? current.firstLocalReceiptAt : current.readAtUtc
  if (!readAt || !current.sourceKind) return null
  return selectedAnalogCashScenarioForPresentation(
    value,
    issued,
    {
      routeKey: question.routeKey,
      destination: question.destination,
      asset: question.requestedAssetAddress,
      decimals: question.requestedAssetDecimals,
      requestedRaw: question.requestedRaw,
      horizonHours: question.horizonHours,
      asOfMs: question.asOfMs,
      ownNativeAvailable,
      currentSourceConflict,
      currentSource: {
        chainId: 1,
        routeKey: current.routeKey,
        destination: current.destination.toLowerCase(),
        asset: current.assetAddress.toLowerCase(),
        assetDecimals: current.assetDecimals,
        cashRaw: current.cashRaw,
        block: current.block,
        blockHash: current.blockHash,
        blockTime: current.observedAt,
        readAt,
        sourceKind: current.sourceKind,
        ...(local
          ? { manifestSha256: current.manifestSha256, receiptSha256: current.receiptSha256 }
          : {}),
      },
    },
    (s) => sha256(stringToHex(s)).slice(2),
  )
}

/** Bind daily endpoint cash scenarios to independent native C2 metadata, never their own source. */
export function selectedConditionalSampledHeadroomForCard(
  value: unknown,
  question: Pick<
    ExitPressureCardProps,
    | 'routeKey'
    | 'destination'
    | 'requestedRaw'
    | 'requestedAssetAddress'
    | 'requestedAssetDecimals'
    | 'horizonHours'
    | 'asOfMs'
  >,
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  try {
    if (
      !current ||
      current.freshness !== 'fresh' ||
      question.horizonHours !== 24 ||
      !question.requestedRaw ||
      !question.requestedAssetAddress ||
      question.requestedAssetDecimals === null ||
      current.routeKey !== question.routeKey ||
      current.destination.toLowerCase() !== question.destination.toLowerCase() ||
      current.assetAddress?.toLowerCase() !== question.requestedAssetAddress.toLowerCase() ||
      current.assetDecimals !== question.requestedAssetDecimals ||
      typeof current.block !== 'string' ||
      !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
      !current.blockHash ||
      !validUtc(current.observedAt)
    )
      return null
    const local = current.sourceKind === 'manifest_bound_ledger'
    const readAt = local ? current.firstLocalReceiptAt : current.readAtUtc
    if (
      !readAt ||
      !validUtc(readAt) ||
      !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(
        current.sourceKind ?? '',
      )
    )
      return null
    return selectedConditionalSampledCashPathProjection(
      value,
      {
        identity: {
          routeKey: question.routeKey,
          destination: question.destination.toLowerCase(),
          asset: question.requestedAssetAddress.toLowerCase(),
          assetDecimals: question.requestedAssetDecimals,
        },
        requestedRaw: question.requestedRaw,
        asOfMs: question.asOfMs,
        currentSource: {
          chainId: 1,
          routeKey: current.routeKey,
          destination: current.destination.toLowerCase(),
          asset: current.assetAddress!.toLowerCase(),
          assetDecimals: current.assetDecimals,
          cashRaw: current.cashRaw,
          block: current.block,
          blockHash: current.blockHash,
          blockTime: current.observedAt,
          readAt,
          sourceKind: current.sourceKind!,
          ...(local
            ? { manifestSha256: current.manifestSha256, receiptSha256: current.receiptSha256 }
            : {}),
        },
      },
      (s) => sha256(stringToHex(s)).slice(2),
    )
  } catch {
    return null
  }
}

/** The H24 cash artifact is a source witness; query H never rescales its observed horizons. */
export function selectedSghoCashForCard(
  value: unknown,
  question: Parameters<typeof selectedConditionalSampledHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  if (
    question.routeKey !== 'GHO → sGho [GHO]' ||
    !Number.isInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 720 ||
    typeof current?.block !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return selectedConditionalSampledHeadroomForCard(
    value,
    { ...question, horizonHours: 24 },
    current,
  )
}

/** USD3 idle USDC remains a sampled cash diagnostic, not total withdrawal funding. */
export function selectedUsd3CashForCard(
  value: unknown,
  question: Parameters<typeof selectedConditionalSampledHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  if (
    question.routeKey !== 'USDC → USD3 [USDC]' ||
    question.destination.toLowerCase() !== '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' ||
    question.requestedAssetAddress?.toLowerCase() !==
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ||
    question.requestedAssetDecimals !== 6 ||
    !Number.isInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 720 ||
    typeof current?.block !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return selectedConditionalSampledHeadroomForCard(
    value,
    { ...question, horizonHours: 24 },
    current,
  )
}

/** Own cash history is only a independently sealed source witness for the index model. */
export function selectedSusdsCashForCard(
  value: unknown,
  question: Parameters<typeof selectedConditionalSampledHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  if (
    question.routeKey !== 'USDS → SUsds [USDS]' ||
    question.destination.toLowerCase() !== '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' ||
    !Number.isInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 720 ||
    typeof current?.block !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return selectedConditionalSampledHeadroomForCard(
    value,
    { ...question, horizonHours: 24 },
    current,
  )
}

/** Independently sealed native cash supplies only the source locator, not StUSDS unused funds. */
export function selectedStusdsCashForCard(
  value: unknown,
  question: Parameters<typeof selectedConditionalSampledHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  if (
    question.routeKey !== 'USDS → StUsds [USDS]' ||
    question.destination.toLowerCase() !== '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9' ||
    !Number.isInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 720 ||
    typeof current?.block !== 'string' ||
    !/^[1-9][0-9]*$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return selectedConditionalSampledHeadroomForCard(
    value,
    { ...question, horizonHours: 24 },
    current,
  )
}

/** Comet keeps the sealed daily path durations at every requested query horizon. */
export function selectedCometCashForCard(
  value: unknown,
  question: Parameters<typeof selectedConditionalSampledHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
): ConditionalSampledCashProjection | null {
  const m = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
  if (
    question.routeKey !== m.routeKey ||
    question.destination.toLowerCase() !== m.destination.toLowerCase() ||
    !Number.isInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 720 ||
    typeof current?.block !== 'string' ||
    !/^[1-9][0-9]*$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  return selectedConditionalSampledHeadroomForCard(
    value,
    { ...question, horizonHours: 24 },
    current,
  )
}

function utcMinute(value: string): string {
  return validUtc(value) ? value.slice(0, 16).replace('T', ' ') + ' UTC' : ''
}

type AvailableProspectiveCashModel = Exclude<
  ExitPressureProspectiveCashModel,
  { status: 'unavailable' }
>

/** Recheck the exact displayed subject even after the forecast client sanitizer. */
export function selectedProspectiveCashModel(
  value: ExitPressureProspectiveCashModel | null | undefined,
  routeKey: string,
  destination: string,
  requestedAssetAddress: string | null,
  horizonHours: number,
): AvailableProspectiveCashModel | null {
  if (
    !value ||
    value.status === 'unavailable' ||
    !requestedAssetAddress ||
    value.routeKey !== routeKey ||
    value.destination.toLowerCase() !== destination.toLowerCase() ||
    value.asset.toLowerCase() !== requestedAssetAddress.toLowerCase() ||
    value.horizonHours !== horizonHours ||
    value.claim !== 'aggregate_cash_proxy_only' ||
    value.holderExecutableExit !== false ||
    value.prospectiveValidated !== (value.status === 'validated')
  )
    return null
  return value
}

function activeProspectiveCashIssue(
  value: AvailableProspectiveCashModel,
  asOfMs: number,
): ExitPressureProspectiveCashIssue | null {
  const issue = value.latestActiveIssue
  if (
    !issue ||
    !Number.isSafeInteger(asOfMs) ||
    !validUtc(issue.issuedAtUtc) ||
    !validUtc(issue.targetHighUtc) ||
    !validUtc(issue.outcomeDueByUtc) ||
    asOfMs < Date.parse(issue.issuedAtUtc) ||
    asOfMs > Date.parse(issue.targetHighUtc) ||
    Date.parse(issue.targetHighUtc) > Date.parse(issue.outcomeDueByUtc)
  )
    return null
  return issue
}

function contextCapacityAmount(raw: string, decimals: number, symbol: string): string {
  const formatted = formatExitPressureRaw(raw, decimals)
  return formatted ? `${formatted} ${symbol}` : 'UNAVAILABLE'
}

const Metric: React.FC<{
  label: React.ReactNode
  value: React.ReactNode
  detail?: React.ReactNode
  warning?: boolean
}> = ({ label, value, detail, warning = false }) => (
  <Box minW={0}>
    <Text {...labelStyle}>{label}</Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.h4}
      color={warning ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}
      overflowWrap="anywhere"
      mt={SPACING.xs}
    >
      {value}
    </Text>
    {detail && (
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
        mt={SPACING.xs}
      >
        {detail}
      </Text>
    )}
  </Box>
)

/**
 * One exact-subject summary. Every numeric block is observational or
 * retrospective; unsupported forward headroom and duration are omitted.
 */
export function selectedProtocolCapacityForCard(
  input: {
    aaveSparkCapacityProjection?: unknown
    aaveSparkCapacitySource?: unknown
    fluidProtocolCapacityProjection?: unknown
    fluidProtocolCapacityProngs?: unknown
    conditionalGrossFlowHeadroom?: unknown
    conditionalSampledCashPathProjection?: unknown
  },
  question: Parameters<typeof selectedConditionalHeadroomForCard>[1],
  currentCash: ExitPressureCurrentCash | null,
) {
  const {
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    asOfMs,
  } = question
  const {
    aaveSparkCapacityProjection: aaveSparkInput,
    aaveSparkCapacitySource: aaveSparkSourceInput,
    fluidProtocolCapacityProjection: fluidProtocolInput,
    fluidProtocolCapacityProngs: fluidProngsInput,
    conditionalGrossFlowHeadroom: conditionalHeadroomInput,
    conditionalSampledCashPathProjection: conditionalSampledInput,
  } = input
  const fluidReadAt =
    currentCash?.sourceKind === 'manifest_bound_ledger'
      ? currentCash.firstLocalReceiptAt
      : currentCash?.readAtUtc
  // The daily projection is only a witness for the sealed current source here;
  // the protocol projection retains its own observed target interval at every query horizon.
  const fluidLocalWitness =
    currentCash?.sourceKind === 'manifest_bound_ledger'
      ? selectedConditionalSampledHeadroomForCard(
          conditionalSampledInput,
          {
            routeKey,
            destination,
            requestedRaw,
            requestedAssetAddress,
            requestedAssetDecimals,
            horizonHours: 24,
            asOfMs,
          },
          currentCash,
        )
      : null
  const fluidCurrentAccepted =
    currentCash &&
    currentCash.freshness === 'fresh' &&
    validUtc(currentCash.observedAt) &&
    typeof fluidReadAt === 'string' &&
    validUtc(fluidReadAt) &&
    Number.isSafeInteger(asOfMs) &&
    Date.parse(currentCash.observedAt) <= asOfMs &&
    asOfMs - Date.parse(currentCash.observedAt) <= CONDITIONAL_FLOW_SOURCE_MAX_AGE_SECONDS * 1000 &&
    Date.parse(fluidReadAt) >= Date.parse(currentCash.observedAt) &&
    Date.parse(fluidReadAt) <= asOfMs &&
    (currentCash.sourceKind === 'live_read_only_two_origin_finalized' || Boolean(fluidLocalWitness))
  const fluidProtocol =
    fluidCurrentAccepted &&
    currentCash &&
    currentCash.routeKey === routeKey &&
    typeof currentCash.destination === 'string' &&
    typeof currentCash.assetAddress === 'string' &&
    currentCash.destination.toLowerCase() === destination.toLowerCase() &&
    currentCash.assetAddress.toLowerCase() === requestedAssetAddress?.toLowerCase() &&
    currentCash.assetDecimals === requestedAssetDecimals &&
    (currentCash.sourceKind === 'manifest_bound_ledger' ||
      currentCash.sourceKind === 'live_read_only_two_origin_finalized') &&
    fluidProngsInput &&
    typeof fluidProngsInput === 'object' &&
    !Array.isArray(fluidProngsInput) &&
    requestedRaw &&
    requestedAssetAddress &&
    requestedAssetDecimals !== null &&
    typeof currentCash.block === 'string' &&
    /^[1-9][0-9]*$/.test(currentCash.block) &&
    Number.isSafeInteger(Number(currentCash.block)) &&
    currentCash.blockHash
      ? selectedFluidProtocolCapacityProjection(
          fluidProtocolInput,
          {
            routeKey,
            destination,
            asset: requestedAssetAddress,
            assetDecimals: requestedAssetDecimals,
            currentSource: {
              chainId: 1,
              blockNumber: Number(currentCash.block),
              blockHash: currentCash.blockHash,
              blockTime: currentCash.observedAt,
              finalized: true,
            },
            currentProngs: (fluidProngsInput as Record<string, unknown>).currentProngs,
            currentReadAtUtc: (fluidProngsInput as Record<string, unknown>).readAtUtc as string,
            requestedRaw,
            horizonHours,
            asOfMs,
          },
          (s) => sha256(stringToHex(s)).slice(2),
        )
      : null
  const aaveSparkCurrentSource: AaveSparkCapacitySource | null =
    fluidCurrentAccepted &&
    currentCash &&
    requestedAssetAddress &&
    requestedAssetDecimals !== null &&
    currentCash.routeKey === routeKey &&
    currentCash.destination?.toLowerCase() === destination.toLowerCase() &&
    currentCash.assetAddress?.toLowerCase() === requestedAssetAddress.toLowerCase() &&
    currentCash.assetDecimals === requestedAssetDecimals &&
    currentCash.block &&
    /^[1-9][0-9]*$/.test(currentCash.block) &&
    Number.isSafeInteger(Number(currentCash.block)) &&
    currentCash.blockHash &&
    fluidReadAt &&
    (currentCash.sourceKind === 'manifest_bound_ledger' ||
      currentCash.sourceKind === 'live_read_only_two_origin_finalized')
      ? {
          chainId: 1,
          routeKey,
          destination: destination.toLowerCase(),
          asset: requestedAssetAddress.toLowerCase(),
          assetDecimals: requestedAssetDecimals,
          cashRaw: currentCash.cashRaw,
          blockNumber: Number(currentCash.block),
          blockHash: currentCash.blockHash,
          blockTime: currentCash.observedAt,
          readAt: fluidReadAt,
          finalized: true,
          sourceKind: currentCash.sourceKind,
          ...(currentCash.sourceKind === 'manifest_bound_ledger'
            ? {
                manifestSha256: currentCash.manifestSha256,
                receiptSha256: currentCash.receiptSha256,
              }
            : {}),
        }
      : null
  const aaveSparkSourceMatches =
    aaveSparkCurrentSource &&
    aaveSparkSourceInput &&
    typeof aaveSparkSourceInput === 'object' &&
    !Array.isArray(aaveSparkSourceInput) &&
    Object.keys(aaveSparkSourceInput).length === Object.keys(aaveSparkCurrentSource).length &&
    Object.entries(aaveSparkCurrentSource).every(([key, value]) =>
      Object.is((aaveSparkSourceInput as Record<string, unknown>)[key], value),
    )
  // Evidence keeps its measured target; query H does not relabel the donor interval.
  const aaveSparkEvidenceQuestion = {
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours: 24,
    asOfMs,
  }
  const aaveSparkJoint = aaveSparkSourceMatches
    ? selectedConditionalHeadroomForCard(
        conditionalHeadroomInput,
        aaveSparkEvidenceQuestion,
        currentCash,
        conditionalSampledInput,
      )
    : null
  const aaveSparkDaily = aaveSparkSourceMatches
    ? selectedConditionalSampledHeadroomForCard(
        conditionalSampledInput,
        aaveSparkEvidenceQuestion,
        currentCash,
      )
    : null
  const aaveSparkCapacity =
    aaveSparkSourceMatches &&
    aaveSparkCurrentSource &&
    requestedRaw &&
    (aaveSparkJoint || aaveSparkDaily)
      ? selectedAaveSparkCapacityProjection(
          aaveSparkInput,
          {
            currentSource: aaveSparkCurrentSource,
            requestedRaw,
            horizonHours,
            asOfMs,
            reserveAgreement: null,
            pathEvidence:
              aaveSparkJoint &&
              aaveSparkCurrentSource.sourceKind === 'live_read_only_two_origin_finalized'
                ? { kind: 'aave_joint_windows', value: aaveSparkJoint }
                : { kind: 'sampled_daily_paths', value: aaveSparkDaily },
          },
          (value) => sha256(stringToHex(value)).slice(2),
        )
      : null

  return { aaveSparkCapacity, fluidProtocol, currentSource: aaveSparkCurrentSource }
}

export const ExitPressureCard: React.FC<ExitPressureCardProps> = ({
  scenarioMode = 'exit',
  depositAmount = '',
  initialDepositIssue = null,
  routeKey,
  destination,
  requestedAmount,
  requestedRaw,
  requestedAssetSymbol,
  requestedAssetAddress,
  requestedAssetDecimals,
  horizonHours,
  asOfMs,
  currentCash: currentCashInput,
  prospectiveCashModel: prospectiveCashModelInput,
  localCarryExitV2Evidence: localExactQInput = null,
  historicalBacktest: historicalBacktestInput = null,
  sampledCashPaths: sampledCashPathsInput = null,
  conditionalGrossFlowHeadroom: conditionalHeadroomInput = null,
  conditionalSampledCashPathProjection: conditionalSampledInput = null,
  conditionalEventImpact: conditionalEventImpactInput = null,
  analogCashScenario: analogCashInput = null,
  analogCashIssue = null,
  analogCashSourceConflict = false,
  aaveSparkCapacityProjection: aaveSparkInput = null,
  aaveSparkCapacitySource: aaveSparkSourceInput = null,
  fluidProtocolCapacityProjection: fluidProtocolInput = null,
  fluidProtocolCapacityProngs: fluidProngsInput = null,
  historicalScenario: historicalScenarioInput,
  grossWithdrawals: grossWithdrawalsInput,
  grossInflows: grossInflowsInput,
  historicalGrossFlow: historicalGrossFlowInput,
  historicalMarketGrossFlow: historicalMarketGrossFlowInput = null,
  morphoPayout: morphoPayoutInput,
  holderTimeProcessIssue: holderTimeProcessIssueInput = null,
  holderMorphoV2IdleJointIssue: holderMorphoV2IdleJointIssueRaw = null,
  holderSaturnForecastIssue = null,
  saturnRequestTokenId = null,
  holderCapacityAgreement: holderCapacityAgreementRaw = null,
  holderStusdsProtocolCapacityEvidence: holderStusdsProtocolEvidenceRaw = null,
  holderMorphoV2ProtocolCapacityEvidence: holderMorphoV2ProtocolEvidenceRaw = null,
  holderMorphoV2CurrentHolderPositionEvidence: holderMorphoV2HolderPositionEvidenceRaw = null,
  holderMorphoV2HistoricalHolderEaEvidence: holderMorphoV2HistoricalEaEvidenceRaw = null,
  holderUsd3JointIssue: holderUsd3JointIssueRaw = null,
  holderFluidUsdcBridgeJointIssue: holderFluidUsdcBridgeJointIssueRaw = null,
  holderFluidUsdtBridgeJointIssue: holderFluidUsdtBridgeJointIssueRaw = null,
  holderUmbrellaGhoJointIssue: holderUmbrellaGhoJointIssueRaw = null,
  holderApyUsdJointIssue: holderApyUsdJointIssueRaw = null,
  holderCometFactsAgreement: holderCometFactsAgreementRaw = null,
  holderAssessment: holderAssessmentRaw,
  requestedHolderAddress: requestedHolderAddressRaw = null,
  expectedEventEnrollment,
  eventContext: eventContextInput,
  historicalOutlook,
}) => {
  const holderTimeProcessIssue = scenarioMode === 'exit' ? holderTimeProcessIssueInput : null
  const holderMorphoV2IdleJointIssueInput =
    scenarioMode === 'exit' ? holderMorphoV2IdleJointIssueRaw : null
  const holderCapacityAgreementInput = scenarioMode === 'exit' ? holderCapacityAgreementRaw : null
  const holderStusdsProtocolEvidenceInput =
    scenarioMode === 'exit' ? holderStusdsProtocolEvidenceRaw : null
  const holderMorphoV2ProtocolEvidenceInput =
    scenarioMode === 'exit' ? holderMorphoV2ProtocolEvidenceRaw : null
  const holderMorphoV2HolderPositionEvidenceInput =
    scenarioMode === 'exit' ? holderMorphoV2HolderPositionEvidenceRaw : null
  const holderMorphoV2HistoricalEaEvidenceInput =
    scenarioMode === 'exit' ? holderMorphoV2HistoricalEaEvidenceRaw : null
  const holderUsd3JointIssueInput = scenarioMode === 'exit' ? holderUsd3JointIssueRaw : null
  const holderFluidUsdcBridgeJointIssueInput =
    scenarioMode === 'exit' ? holderFluidUsdcBridgeJointIssueRaw : null
  const holderFluidUsdtBridgeJointIssueInput =
    scenarioMode === 'exit' ? holderFluidUsdtBridgeJointIssueRaw : null
  const holderUmbrellaGhoJointIssueInput =
    scenarioMode === 'exit' ? holderUmbrellaGhoJointIssueRaw : null
  const holderApyUsdJointIssueInput = scenarioMode === 'exit' ? holderApyUsdJointIssueRaw : null
  const holderCometFactsAgreementInput =
    scenarioMode === 'exit' ? holderCometFactsAgreementRaw : null
  const holderAssessmentInput = scenarioMode === 'exit' ? holderAssessmentRaw : null
  const requestedHolderAddress = scenarioMode === 'exit' ? requestedHolderAddressRaw : null
  const currentCash = sameScope(currentCashInput, routeKey, destination) ? currentCashInput : null
  // The independent witness is small; stable primitive bytes keep timer renders from rebuilding paths.
  const timeWitnessJson = timeWitnessKey(currentCash)
  const timeWitness = useMemo<ExitPressureCurrentCash | null>(
    () => (timeWitnessJson ? freezeIssued(JSON.parse(timeWitnessJson)) : null),
    [timeWitnessJson],
  )
  const initialQuestionJson = JSON.stringify(
    initialDepositQuestion(
      scenarioMode,
      routeKey,
      destination,
      depositAmount,
      requestedAmount,
      horizonHours,
    ),
  )
  const issuedInitialDeposit = useMemo(() => {
    const question = JSON.parse(initialQuestionJson)
    if (
      !question ||
      requestedRaw !== question.plannedExitAssetsRaw ||
      requestedAssetAddress?.toLowerCase() !== question.asset ||
      requestedAssetDecimals !== 6
    )
      return null
    const selected = issuedInitialDepositScenario(initialDepositIssue, question, timeWitness)
    return selected ? freezeIssued(selected) : null
  }, [
    initialDepositIssue,
    initialQuestionJson,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    timeWitness,
  ])
  const initialDeposit = initialDepositRenderWindow(issuedInitialDeposit, asOfMs)
    ? issuedInitialDeposit
    : null
  const initialProcess = initialDeposit?.process ?? initialDeposit?.cashOnlyProcess ?? null
  const initialSummary = initialProcess?.targetSummary ?? null
  const prospectiveCashModel = selectedProspectiveCashModel(
    prospectiveCashModelInput,
    routeKey,
    destination,
    requestedAssetAddress,
    horizonHours,
  )
  const localExactQ =
    localExactQInput &&
    localExactQInput.routeKey === routeKey &&
    localExactQInput.destination === destination.toLowerCase() &&
    localExactQInput.asset === requestedAssetAddress?.toLowerCase() &&
    localExactQInput.horizonH === horizonHours &&
    ((localExactQInput.status === 'unavailable' &&
      (localExactQInput.assetsRaw === null || localExactQInput.assetsRaw === requestedRaw) &&
      (localExactQInput.decimals === null ||
        localExactQInput.decimals === requestedAssetDecimals)) ||
      (localExactQInput.status === 'collecting' &&
        localExactQInput.assetsRaw === requestedRaw &&
        localExactQInput.decimals === requestedAssetDecimals)) &&
    localExactQInput.forecastValidated === false &&
    localExactQInput.holderExecutableExit === false
      ? localExactQInput
      : null
  const localExactQRefreshDue = Boolean(
    localExactQ?.evidence?.latest.status === 'pending' &&
    Date.parse(localExactQ.evidence.latest.deadlineAtUtc) < asOfMs,
  )
  const historicalBacktest = selectedHistoricalBacktest(
    historicalBacktestInput,
    routeKey,
    destination,
    requestedRaw,
    horizonHours,
    requestedAssetAddress,
    requestedAssetDecimals,
    asOfMs,
  )
  const competingFlow = selectedHistoricalCompetingFlowEstimate(
    historicalBacktest?.expectedCompetingFlow,
    {
      routeKey,
      destination,
      asset: requestedAssetAddress ?? '',
      assetDecimals: requestedAssetDecimals ?? -1,
    },
    (s) => sha256(stringToHex(s)).slice(2),
  )
  // Timer ticks only expire this private approved issuance; they never rebuild/reissue its paths.
  const issuedCashTime = useMemo(() => {
    const issue = holderTimeProcessIssue
    if (
      !issue ||
      !Number.isSafeInteger(issue.issuedAtMs) ||
      typeof issue.owner !== 'string' ||
      issue.horizonHours !== horizonHours ||
      issue.owner.toLowerCase() !== requestedHolderAddress?.toLowerCase() ||
      issue.requestedRaw !== requestedRaw ||
      issue.block !== timeWitness?.block ||
      issue.blockHash !== timeWitness?.blockHash
    )
      return null
    const input = issuedCashHolderTimeInputForCard(
      conditionalSampledInput,
      holderCapacityAgreementInput ?? holderAssessmentInput?.capacityAgreement,
      holderCometFactsAgreementInput,
      holderAssessmentInput?.executionAgreement,
      {
        routeKey,
        destination,
        requestedRaw,
        requestedAssetAddress,
        requestedAssetDecimals,
        horizonHours,
        requestedHolderAddress,
        asOfMs: issue.issuedAtMs,
      },
      timeWitness,
    )
    if (!input) return null
    const privateInput = freezeIssued(structuredClone(input)),
      hash = (text: string) => sha256(stringToHex(text)).slice(2)
    const built = buildConditionalCashHolderTimeProcess(privateInput, hash)
    const selected = built
      ? selectedConditionalCashHolderTimeProcess(
          built,
          { input: privateInput, asOfMs: issue.issuedAtMs },
          hash,
        )
      : null
    return selected ? freezeIssued(structuredClone(selected)) : null
  }, [
    holderTimeProcessIssue,
    conditionalSampledInput,
    holderCapacityAgreementInput,
    holderCometFactsAgreementInput,
    holderAssessmentInput,
    routeKey,
    destination,
    requestedRaw,
    requestedHolderAddress,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    timeWitness,
  ])
  const cashTime =
    issuedCashTime && cashHolderTimeRenderWindow(issuedCashTime, asOfMs) ? issuedCashTime : null
  const cashTimeSummary = cashTime?.process.targetSummary ?? null
  const issuedStusdsTime = useMemo(() => {
    const issue = holderTimeProcessIssue
    if (
      !issue ||
      !Number.isSafeInteger(issue.issuedAtMs) ||
      typeof issue.owner !== 'string' ||
      issue.horizonHours !== horizonHours ||
      issue.owner.toLowerCase() !== requestedHolderAddress?.toLowerCase() ||
      issue.requestedRaw !== requestedRaw ||
      issue.block !== timeWitness?.block ||
      issue.blockHash !== timeWitness?.blockHash
    )
      return null
    const question = {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      requestedHolderAddress,
      asOfMs: issue.issuedAtMs,
    }
    const input = issuedStusdsTimeInputForCard(
      conditionalSampledInput,
      holderCapacityAgreementInput ?? holderAssessmentInput?.capacityAgreement,
      holderAssessmentInput?.executionAgreement,
      holderStusdsProtocolEvidenceInput,
      question,
      timeWitness,
    )
    if (!input) return null
    const privateInput = freezeIssued(structuredClone(input)),
      hash = (text: string) => sha256(stringToHex(text)).slice(2),
      record = decodeStusdsProtocolEvidence(holderStusdsProtocolEvidenceInput),
      expected = {
        source: privateInput.binding.currentSource,
        asOfMs: issue.issuedAtMs,
        originHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
      }
    const accept = (c: typeof input.current) =>
      acceptStusdsCurrentProtocolCapacityEvidence(c, record, expected, hash)
    const built = buildStusdsHolderTimeProcess(privateInput, accept),
      selected = built
        ? selectedStusdsHolderTimeProcess(built, privateInput, issue.issuedAtMs, accept)
        : null
    return selected ? freezeIssued(structuredClone(selected)) : null
  }, [
    holderTimeProcessIssue,
    conditionalSampledInput,
    holderCapacityAgreementInput,
    holderAssessmentInput,
    holderStusdsProtocolEvidenceInput,
    routeKey,
    destination,
    requestedRaw,
    requestedHolderAddress,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    timeWitness,
  ])
  const stusdsTime =
    issuedStusdsTime && cashHolderTimeRenderWindow({ process: issuedStusdsTime.lower }, asOfMs)
      ? issuedStusdsTime
      : null
  const stusdsTimeSummary = stusdsTime?.targetInterval ?? null

  const issuedSusdeTime = useMemo(() => {
    const issue = holderTimeProcessIssue
    const envelope = issue?.susdeForecast
    if (
      !issue ||
      !envelope ||
      issue.issuedAtMs !== Date.parse(envelope.issueAtUtc) ||
      issue.owner !== envelope.owner ||
      issue.requestedRaw !== envelope.originalRequestedRaw ||
      issue.block !== envelope.source.blockNumber ||
      issue.blockHash !== envelope.source.blockHash ||
      (timeWitness &&
        (timeWitness.block !== issue.block ||
          timeWitness.blockHash !== issue.blockHash ||
          timeWitness.observedAt !== envelope.source.blockTime))
    )
      return null
    return selectedSusdeHolderForecast(envelope, {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      requestedHolderAddress,
      horizonHours,
      source: envelope.source,
      asOfMs: issue.issuedAtMs,
    })
  }, [
    holderTimeProcessIssue,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    requestedHolderAddress,
    horizonHours,
    timeWitness,
  ])
  const susdeTime =
    issuedSusdeTime &&
    cashHolderTimeRenderWindow({ process: issuedSusdeTime.active.funding }, asOfMs)
      ? issuedSusdeTime
      : null
  const susdeTimeSummary = susdeTime?.active.funding.targetSummary ?? null

  const isUsd3JointSubject =
    routeKey === 'USDC → USD3 [USDC]' &&
    destination.toLowerCase() === '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'
  const issuedUsd3Joint = useMemo(() => {
    const retained = holderUsd3JointIssueInput,
      q = retained?.question
    if (
      !retained ||
      !q ||
      q.routeKey !== routeKey ||
      q.destination !== destination.toLowerCase() ||
      q.requestedRaw !== requestedRaw ||
      q.requestedAssetAddress !== requestedAssetAddress?.toLowerCase() ||
      q.requestedAssetDecimals !== requestedAssetDecimals ||
      q.horizonHours !== horizonHours ||
      q.requestedHolderAddress !== requestedHolderAddress?.toLowerCase() ||
      (timeWitness &&
        (retained.issue.block !== timeWitness.block ||
          retained.issue.blockHash !== timeWitness.blockHash ||
          retained.issue.source.blockTime !== timeWitness.observedAt))
    )
      return null
    return { issue: retained.issue, question: q }
  }, [
    holderUsd3JointIssueInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
  ])
  // The receipt selects its original private model. Retained external quote or
  // history references can never replace the funding inputs authorized by it.
  const usd3Joint = issuedUsd3Joint
    ? selectedUsd3JointHolderForecastFromIssue(
        issuedUsd3Joint.issue,
        issuedUsd3Joint.question,
        asOfMs,
      )
    : null
  const usd3JointSummary = usd3Joint?.process.targetSummary ?? null

  const isFluidUsdcBridgeJointSubject =
    routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]' &&
    destination.toLowerCase() === '0x273da948aca9261043fbdb2a857bc255ecc29012'
  const issuedFluidUsdcBridgeJoint = useMemo(() => {
    const retained = holderFluidUsdcBridgeJointIssueInput,
      q = retained?.question
    if (
      !retained ||
      !q ||
      q.routeKey !== routeKey ||
      q.destination !== destination.toLowerCase() ||
      q.requestedRaw !== requestedRaw ||
      q.requestedAssetAddress !== requestedAssetAddress?.toLowerCase() ||
      q.requestedAssetDecimals !== requestedAssetDecimals ||
      q.horizonHours !== horizonHours ||
      q.requestedHolderAddress !== requestedHolderAddress?.toLowerCase() ||
      (timeWitness &&
        (String(retained.issue.source.blockNumber) !== timeWitness.block ||
          retained.issue.source.blockHash !== timeWitness.blockHash ||
          retained.issue.source.blockTime !== timeWitness.observedAt))
    )
      return null
    return { issue: retained.issue, question: q }
  }, [
    holderFluidUsdcBridgeJointIssueInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
  ])
  // The receipt selects its original private model. Retained external quote or
  // history references can never replace the funding inputs authorized by it.
  const fluidUsdcBridgeJoint = issuedFluidUsdcBridgeJoint
    ? selectedFluidUsdcBridgeJointHolderForecastFromIssue(
        issuedFluidUsdcBridgeJoint.issue,
        issuedFluidUsdcBridgeJoint.question,
        asOfMs,
      )
    : null
  const fluidUsdcBridgeJointSummary = fluidUsdcBridgeJoint?.process.targetSummary ?? null

  const isFluidUsdtBridgeJointSubject =
    routeKey === FLUID_USDT_BRIDGE_JOINT_ROUTE &&
    destination.toLowerCase() === FLUID_USDT_BRIDGE_JOINT_VAULT
  const fluidUsdtBridgeJoint = useMemo(() => {
    try {
      if (!holderFluidUsdtBridgeJointIssueInput || !isFluidUsdtBridgeJointSubject) return null
      const data = (
        value: unknown,
        allowed: readonly string[] | null,
        max: number,
      ): Record<string, unknown> => {
        if (
          !value ||
          typeof value !== 'object' ||
          Object.getPrototypeOf(value) !== Object.prototype ||
          Object.getOwnPropertySymbols(value).length
        )
          throw Error('fluid_usdt_render_prop')
        const names = Object.getOwnPropertyNames(value)
        if (names.length > max) throw Error('fluid_usdt_render_prop')
        const descriptors = Object.getOwnPropertyDescriptors(value),
          out: Record<string, unknown> = {}
        for (const name of names) {
          const d = descriptors[name]
          if (
            (allowed && !allowed.includes(name)) ||
            ['__proto__', 'constructor', 'prototype'].includes(name) ||
            !d?.enumerable ||
            !Object.hasOwn(d, 'value')
          )
            throw Error('fluid_usdt_render_prop')
          out[name] = d.value
        }
        return out
      }
      const envelope = data(holderFluidUsdtBridgeJointIssueInput, ['question', 'issue'], 2)
      const copied = data(
        envelope.question,
        [
          'routeKey',
          'destination',
          'requestedRaw',
          'requestedAssetAddress',
          'requestedAssetDecimals',
          'requestedHolderAddress',
          'horizonHours',
          'asOfMs',
          'independentSource',
        ],
        9,
      )
      const sourceKeys = ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized']
      if (Object.hasOwn(copied, 'independentSource')) {
        const source = data(copied.independentSource, sourceKeys, 5)
        if (
          source.chainId !== 1 ||
          source.finalized !== true ||
          !Number.isSafeInteger(source.blockNumber) ||
          (source.blockNumber as number) < 1 ||
          typeof source.blockHash !== 'string' ||
          typeof source.blockTime !== 'string'
        )
          return null
        copied.independentSource = source
      }
      const issueData = data(envelope.issue, null, 32)
      if (Object.hasOwn(issueData, 'source')) data(issueData.source, sourceKeys, 5)
      if (Object.hasOwn(issueData, 'independentSource'))
        data(issueData.independentSource, sourceKeys, 5)
      const q = copied as unknown as FluidUsdtBridgeJointHolderForecastQuestion
      if (
        q.routeKey !== routeKey ||
        q.destination !== destination.toLowerCase() ||
        q.requestedRaw !== requestedRaw ||
        q.requestedAssetAddress !== requestedAssetAddress?.toLowerCase() ||
        q.requestedAssetDecimals !== requestedAssetDecimals ||
        q.horizonHours !== horizonHours ||
        q.requestedHolderAddress !== requestedHolderAddress?.toLowerCase() ||
        (q.independentSource &&
          timeWitness &&
          (String(q.independentSource.blockNumber) !== timeWitness.block ||
            q.independentSource.blockHash !== timeWitness.blockHash ||
            q.independentSource.blockTime !== timeWitness.observedAt))
      )
        return null
      // Keep the exact original issue pointer; descriptor copies never mint another receipt.
      return selectedFluidUsdtBridgeJointHolderForecastFromIssue(envelope.issue, q, asOfMs)
    } catch {
      return null
    }
  }, [
    holderFluidUsdtBridgeJointIssueInput,
    isFluidUsdtBridgeJointSubject,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
    asOfMs,
  ])
  const fluidUsdtBridgeJointSummary = fluidUsdtBridgeJoint?.process.targetSummary ?? null
  const fluidUsdtCashBoundary = useMemo(() => {
    if (!fluidUsdtBridgeJoint) return null
    return buildConditionalStockBoundaryOutlook({
      sourceAtUtc: fluidUsdtBridgeJoint.sourceAtUtc,
      issueAtUtc: fluidUsdtBridgeJoint.issueAtUtc,
      targetAtUtc: fluidUsdtBridgeJoint.targetAtUtc,
      currentValuesByChannel: fluidUsdtBridgeJoint.process.input.current.nativeProngs,
      cashChannelKeys: ['bankCash'],
      scenarios: fluidUsdtBridgeJoint.process.scenarios,
    })
  }, [fluidUsdtBridgeJoint])
  const fluidUsdtCashBoundaryValue = fluidUsdtCashBoundary?.boundaryDonors
    ? conditionalStockBoundaryHours(fluidUsdtCashBoundary)
    : null

  const isUmbrellaGhoJointSubject =
    routeKey === UMBRELLA_GHO_ROUTE && destination.toLowerCase() === UMBRELLA_STKGHO
  const issuedUmbrellaGhoJoint = useMemo(() => {
    const retained = holderUmbrellaGhoJointIssueInput
    const model = retained
      ? selectedUmbrellaGhoJointHolderForecastFromIssue(retained.issue, retained.question, asOfMs)
      : null
    if (!model) return null
    const q = retained?.question
    if (
      !retained ||
      !q ||
      q.routeKey !== routeKey ||
      q.destination !== destination.toLowerCase() ||
      q.requestedRaw !== requestedRaw ||
      q.requestedAssetAddress !== requestedAssetAddress?.toLowerCase() ||
      q.requestedAssetDecimals !== requestedAssetDecimals ||
      q.horizonHours !== horizonHours ||
      q.requestedHolderAddress !== requestedHolderAddress?.toLowerCase() ||
      // Independent cash context is not the staged holder's source binding.
      // Enforce it only when that witness is part of the original private question.
      (q.independentSource &&
        timeWitness &&
        (String(model.source.blockNumber) !== timeWitness.block ||
          model.source.blockHash !== timeWitness.blockHash ||
          model.source.blockTime !== timeWitness.observedAt))
    )
      return null
    return { issue: retained.issue, question: q }
  }, [
    holderUmbrellaGhoJointIssueInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
    asOfMs,
  ])
  // The receipt selects its original private model. Retained external quote or
  // history references can never replace the funding inputs authorized by it.
  const umbrellaGhoJoint = issuedUmbrellaGhoJoint
    ? selectedUmbrellaGhoJointHolderForecastFromIssue(
        issuedUmbrellaGhoJoint.issue,
        issuedUmbrellaGhoJoint.question,
        asOfMs,
      )
    : null
  const umbrellaGhoJointSummary = umbrellaGhoJoint?.process.targetSummary ?? null

  const isApyUsdJointSubject =
    routeKey === APY_USD_JOINT_NATIVE_SUBJECT.routeKey &&
    destination.toLowerCase() === APY_USD_JOINT_NATIVE_SUBJECT.destination
  const apyUsdJoint = useMemo(() => {
    const retained = holderApyUsdJointIssueInput
    if (!retained || !isApyUsdJointSubject) return null
    const q = retained.question
    if (
      !q ||
      q.routeKey !== routeKey ||
      q.destination !== destination.toLowerCase() ||
      q.requestedRaw !== requestedRaw ||
      q.requestedAssetAddress !== requestedAssetAddress?.toLowerCase() ||
      q.requestedAssetDecimals !== requestedAssetDecimals ||
      q.horizonHours !== horizonHours ||
      q.requestedHolderAddress !== requestedHolderAddress?.toLowerCase() ||
      q.plannedInitiationOffsetSeconds !== 0 ||
      q.fundingBasis !== 'native_liquid_cash' ||
      (q.independentSource &&
        timeWitness &&
        (String(q.independentSource.blockNumber) !== timeWitness.block ||
          q.independentSource.blockHash !== timeWitness.blockHash ||
          q.independentSource.blockTime !== timeWitness.observedAt))
    )
      return null
    // The original issue selects native full S and the complete owned NFT inventory.
    return selectedApyUsdJointHolderForecastFromIssue(retained.issue, q, asOfMs)
  }, [
    holderApyUsdJointIssueInput,
    isApyUsdJointSubject,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
    asOfMs,
  ])
  const apyUsdJointSummary = apyUsdJoint?.process.targetSummary ?? null

  const saturnForecast = useMemo(() => scenarioMode === 'exit' && requestedRaw && requestedHolderAddress &&
    requestedAssetAddress?.toLowerCase() === '0x00000000efe302beaa2b3e6e1b18d08d69a9012a' && requestedAssetDecimals === 6
    ? selectedSaturnAppForecastFromIssue(holderSaturnForecastIssue, {
      routeKey, destination: destination.toLowerCase(), owner: requestedHolderAddress.toLowerCase(),
      requestedRaw, horizonHours, ticketId: saturnRequestTokenId,
    }, asOfMs) : null, [scenarioMode, holderSaturnForecastIssue, routeKey, destination,
      requestedRaw, requestedHolderAddress, requestedAssetAddress, requestedAssetDecimals, horizonHours, saturnRequestTokenId, asOfMs])
  const morphoIdleJoint = useMemo(() => selectedMorphoV2IdleJointForCard(
    holderMorphoV2IdleJointIssueInput,
    { routeKey, destination, requestedRaw, requestedAssetAddress, requestedAssetDecimals,
      requestedHolderAddress, horizonHours, asOfMs },
    timeWitness ?? currentCashInput,
  ), [holderMorphoV2IdleJointIssueInput, routeKey, destination, requestedRaw,
    requestedAssetAddress, requestedAssetDecimals, requestedHolderAddress, horizonHours,
    asOfMs, timeWitness, currentCashInput])
  const morphoIdleNative = morphoIdleJoint?.status === 'conditional_morpho_v2_idle_joint_holder_forecast'
    ? morphoIdleJoint : null
  const morphoIdlePanel = morphoIdleJoint?.status === 'conditional_morpho_v2_idle_panel_holder_forecast'
    ? morphoIdleJoint : null
  const morphoIdleSummary = morphoIdleNative?.process.descriptive.headline ?? null
  const morphoIdlePanelChange = morphoIdlePanel ? morphoIdlePanelCapacityChange(morphoIdlePanel) : null
  const morphoIdleShrinking = morphoIdleNative?.process.scenarios.some((s) =>
    s.status === 'usable' && s.sampledTimeline.shrinkingAtHorizon) ?? false
  const morphoIdleShortfall = morphoIdleNative ? morphoIdleSampledShortfall(morphoIdleNative) : null
  const morphoIdleAnalytical = morphoIdleNative ? morphoIdleAnalyticalConditionMetrics(morphoIdleNative) : null

  const jointMorphoEvidencePresent =
    holderMorphoV2HolderPositionEvidenceInput !== null ||
    holderMorphoV2HistoricalEaEvidenceInput !== null ||
    Boolean(holderTimeProcessIssue && Object.hasOwn(holderTimeProcessIssue, 'profileId'))
  const issuedMorphoJoint = useMemo(() => {
    const issue = holderTimeProcessIssue
    if (
      !issue?.source ||
      !jointMorphoEvidencePresent ||
      !Number.isSafeInteger(issue.issuedAtMs) ||
      typeof issue.owner !== 'string' ||
      issue.horizonHours !== horizonHours ||
      issue.owner.toLowerCase() !== requestedHolderAddress?.toLowerCase() ||
      issue.requestedRaw !== requestedRaw ||
      issue.block !== String(issue.source.blockNumber) ||
      issue.blockHash !== issue.source.blockHash ||
      (timeWitness &&
        (timeWitness.block !== issue.block ||
          timeWitness.blockHash !== issue.blockHash ||
          timeWitness.observedAt !== issue.source.blockTime))
    )
      return null
    const question = {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      requestedHolderAddress,
      horizonHours,
      asOfMs: issue.issuedAtMs,
      ...(issue.independentSource ? { independentSource: issue.independentSource } : {}),
    }
    const model = selectedMorphoV2JointHolderForecastFromIssue(issue, question, asOfMs)
    if (!model) return null
    return { model, question: freezeIssued(question) }
  }, [
    holderTimeProcessIssue,
    asOfMs,
    jointMorphoEvidencePresent,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    requestedHolderAddress,
    horizonHours,
    timeWitness,
  ])
  const morphoJoint = issuedMorphoJoint
    ? selectedMorphoV2JointHolderForecast(
        issuedMorphoJoint.model,
        issuedMorphoJoint.question,
        asOfMs,
      )
    : null
  const morphoJointSummary = morphoJoint?.process.descriptiveExpectedFlow.headline?.headroom ?? null
  const morphoJointAssetSymbol = morphoJoint?.assetSymbol ?? null
  const issuedMorphoTime = useMemo(() => {
    if (jointMorphoEvidencePresent) return null
    const issue = holderTimeProcessIssue
    if (
      !issue?.source ||
      !Number.isSafeInteger(issue.issuedAtMs) ||
      typeof issue.owner !== 'string' ||
      issue.horizonHours !== horizonHours ||
      issue.owner.toLowerCase() !== requestedHolderAddress?.toLowerCase() ||
      issue.requestedRaw !== requestedRaw ||
      issue.block !== String(issue.source.blockNumber) ||
      issue.blockHash !== issue.source.blockHash
    )
      return null
    const source = issue.source
    const selected = issuedMorphoV2HolderForecast(
      holderCapacityAgreementInput ?? holderAssessmentInput?.capacityAgreement,
      holderAssessmentInput?.executionAgreement,
      holderMorphoV2ProtocolEvidenceInput,
      {
        routeKey,
        destination,
        requestedRaw,
        requestedAssetAddress,
        requestedAssetDecimals,
        requestedHolderAddress,
        horizonHours,
        asOfMs: issue.issuedAtMs,
        independentSource: issue.independentSource,
      },
    )
    if (
      !selected ||
      ['chainId', 'blockNumber', 'blockHash', 'blockTime', 'finalized'].some(
        (key) =>
          selected.input.binding.currentSource[key as keyof typeof source] !==
          source[key as keyof typeof source],
      )
    )
      return null
    return selected
  }, [
    jointMorphoEvidencePresent,
    holderTimeProcessIssue,
    holderCapacityAgreementInput,
    holderAssessmentInput?.capacityAgreement,
    holderAssessmentInput?.executionAgreement,
    holderMorphoV2ProtocolEvidenceInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    requestedHolderAddress,
    horizonHours,
  ])
  const morphoTime =
    issuedMorphoTime && morphoV2HolderForecastRenderWindow(issuedMorphoTime, asOfMs)
      ? issuedMorphoTime
      : null
  const morphoTimeSummary = morphoTime?.process.targetSummary ?? null

  const conditionalHeadroom = selectedConditionalHeadroomForCard(
    conditionalHeadroomInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
    conditionalSampledInput,
  )
  const sghoCash = selectedSghoCashForCard(
    conditionalSampledInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const usd3Cash = selectedUsd3CashForCard(
    conditionalSampledInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const susdsCash = selectedSusdsCashForCard(
    conditionalSampledInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const stusdsCash = selectedStusdsCashForCard(
    conditionalSampledInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const cometCash = selectedCometCashForCard(
    conditionalSampledInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const conditionalSampledHeadroom =
    selectedConditionalSampledHeadroomForCard(
      conditionalSampledInput,
      {
        routeKey,
        destination,
        requestedRaw,
        requestedAssetAddress,
        requestedAssetDecimals,
        horizonHours,
        asOfMs,
      },
      currentCash,
    ) ??
    sghoCash ??
    usd3Cash ??
    susdsCash ??
    cometCash
  const protocolCapacity = selectedProtocolCapacityForCard(
    {
      aaveSparkCapacityProjection: aaveSparkInput,
      aaveSparkCapacitySource: aaveSparkSourceInput,
      fluidProtocolCapacityProjection: fluidProtocolInput,
      fluidProtocolCapacityProngs: fluidProngsInput,
      conditionalGrossFlowHeadroom: conditionalHeadroomInput,
      conditionalSampledCashPathProjection: conditionalSampledInput,
    },
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const { aaveSparkCapacity, fluidProtocol } = protocolCapacity
  const nativeCashProjection = record(conditionalSampledInput)
  const analogCash =
    scenarioMode === 'exit'
      ? selectedAnalogCashForCard(
          analogCashInput,
          analogCashIssue,
          {
            routeKey,
            destination,
            requestedRaw,
            requestedAssetAddress,
            requestedAssetDecimals,
            horizonHours,
            asOfMs,
          },
          currentCash,
          nativeCashProjection?.status === 'estimated',
          analogCashSourceConflict || nativeCashProjection?.reason === 'current_source_conflict',
        )
      : null
  const flowMean = (value: { numeratorRaw: string; denominator: number }) =>
    formatExitPressureRaw((BigInt(value.numeratorRaw) / BigInt(value.denominator)).toString(), 6)
  const sampledCashPaths = selectedSampledCashPaths(
    sampledCashPathsInput,
    {
      routeKey,
      destination,
      requestedRaw,
      requestedAssetAddress,
      requestedAssetDecimals,
      horizonHours,
      asOfMs,
    },
    currentCash,
  )
  const currentCashFreshness =
    currentCash &&
    currentCash.freshness === 'fresh' &&
    Number.isSafeInteger(asOfMs) &&
    asOfMs - Date.parse(currentCash.observedAt) >= -120_000 &&
    asOfMs - Date.parse(currentCash.observedAt) <= 30 * 60_000
      ? 'fresh'
      : 'stale'
  const historicalScenario =
    sameScope(historicalScenarioInput, routeKey, destination) &&
    ADDRESS.test(historicalScenarioInput!.assetAddress.toLowerCase()) &&
    ADDRESS.test(historicalScenarioInput!.requestedAssetAddress.toLowerCase()) &&
    historicalScenarioInput!.assetAddress.toLowerCase() ===
      historicalScenarioInput!.requestedAssetAddress.toLowerCase() &&
    historicalScenarioInput!.assetSymbol === historicalScenarioInput!.requestedAssetSymbol &&
    historicalScenarioInput!.horizonHours === horizonHours &&
    currentCash !== null &&
    currentCashFreshness === 'fresh' &&
    currentCash.cashRaw === historicalScenarioInput!.currentCashRaw &&
    currentCash.assetDecimals === historicalScenarioInput!.assetDecimals &&
    currentCash.assetSymbol === historicalScenarioInput!.assetSymbol &&
    currentCash.assetAddress?.toLowerCase() ===
      historicalScenarioInput!.assetAddress.toLowerCase() &&
    currentCash.observedAt === historicalScenarioInput!.currentBlockAt &&
    currentCash.block === historicalScenarioInput!.currentBlock &&
    currentCash.blockHash?.toLowerCase() ===
      historicalScenarioInput!.currentBlockHash.toLowerCase() &&
    RAW.test(historicalScenarioInput!.currentBlock) &&
    HASH.test(historicalScenarioInput!.currentBlockHash.toLowerCase()) &&
    (historicalScenarioInput!.requestScope === 'first_leg' ||
      (historicalScenarioInput!.requestedRaw === requestedRaw &&
        historicalScenarioInput!.requestedAssetSymbol === requestedAssetSymbol))
      ? historicalScenarioInput
      : null
  const grossWithdrawals =
    sameScope(grossWithdrawalsInput, routeKey, destination) &&
    grossWithdrawalsInput?.direction === 'withdrawal'
      ? grossWithdrawalsInput
      : null
  const grossInflows =
    sameScope(grossInflowsInput, routeKey, destination) && grossInflowsInput?.direction === 'inflow'
      ? grossInflowsInput
      : null
  const historicalGrossFlow = selectedHistoricalGrossFlow(
    historicalGrossFlowInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    asOfMs,
  )
  const historicalMarketGrossFlow = selectHistoricalMarketGrossFlow(
    historicalMarketGrossFlowInput,
    routeKey,
    destination,
    horizonHours,
    requestedAssetAddress,
    requestedAssetDecimals,
  )
  const morphoPayout = sameScope(morphoPayoutInput, routeKey, destination)
    ? morphoPayoutInput
    : null
  const holderQuestion = {
    routeKey,
    destination,
    owner: requestedHolderAddress,
    requestedRaw,
    payoutAsset: requestedAssetAddress,
    horizonHours,
    asOfMs,
  }
  const boundHolderAssessment = matchingHolderExitViewAssessment(
    holderAssessmentInput,
    holderQuestion,
  )
  const holderMechanicalOutlook = selectedHolderExitMechanicalOutlook(
    boundHolderAssessment?.mechanicalOutlook,
    boundHolderAssessment,
    holderQuestion,
  )
  const mechanicalRow = holderMechanicalRow(
    holderMechanicalOutlook,
    requestedAssetAddress,
    requestedAssetDecimals,
    requestedAssetSymbol,
    asOfMs,
  )
  const holderWindowExpired =
    boundHolderAssessment?.condition?.gate === 'window_open' &&
    Number.isSafeInteger(boundHolderAssessment.condition.windowEndInclusive) &&
    boundHolderAssessment.condition.windowEndInclusive !== null &&
    asOfMs >= (boundHolderAssessment.condition.windowEndInclusive + 1) * 1000
  const holderAssessment = holderWindowExpired ? null : boundHolderAssessment
  const capacitySource =
    protocolCapacity.currentSource ??
    ((sghoCash ?? usd3Cash ?? susdsCash ?? stusdsCash ?? cometCash)
      ? {
          ...(sghoCash ?? usd3Cash ?? susdsCash ?? stusdsCash ?? cometCash)!.currentSource,
          blockNumber: Number(
            (sghoCash ?? usd3Cash ?? susdsCash ?? stusdsCash ?? cometCash)!.currentSource.block,
          ),
        }
      : null)
  const capacityBinding =
    capacitySource &&
    requestedHolderAddress &&
    requestedRaw &&
    !holderAssessmentInput?.request?.sharesRaw &&
    !holderAssessmentInput?.request?.receiptTokenId &&
    !holderAssessmentInput?.request?.requestTokenId &&
    !holderAssessmentInput?.request?.collateralVault &&
    !holderAssessmentInput?.request?.ptRaw &&
    !holderAssessmentInput?.request?.primeSharesRaw
      ? {
          routeKey,
          destination,
          owner: requestedHolderAddress,
          requestedRaw,
          asset: capacitySource.asset,
          assetDecimals: capacitySource.assetDecimals,
          currentSource: {
            chainId: 1 as const,
            blockNumber: capacitySource.blockNumber,
            blockHash: capacitySource.blockHash,
            blockTime: capacitySource.blockTime,
            finalized: true as const,
          },
          asOfMs,
          executionAgreement: holderAssessment?.executionAgreement,
        }
      : null
  const holderCapacity = capacityBinding
    ? selectedHolderExitCapacity(
        holderCapacityAgreementInput ?? holderAssessment?.capacityAgreement,
        capacityBinding,
      )
    : null
  const holderProof =
    holderCapacity && capacityBinding
      ? {
          capacityAgreement: holderCapacityAgreementInput ?? holderAssessment?.capacityAgreement,
          binding: capacityBinding,
        }
      : undefined
  // The cash selector independently supplies current C2. The native API separately issues
  // raw global evidence from its approved configured origins; no response self-source defaults.
  const stusdsEvidenceExpected =
    stusdsCash && holderProof
      ? {
          source: holderProof.binding.currentSource,
          asOfMs,
          originHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
        }
      : null
  const stusdsRawEvidence = decodeStusdsProtocolEvidence(holderStusdsProtocolEvidenceInput)
  const stusdsCurrent = stusdsEvidenceExpected
    ? replayStusdsCurrentProtocolCapacityEvidence(stusdsRawEvidence, stusdsEvidenceExpected, (s) =>
        sha256(stringToHex(s)).slice(2),
      )
    : null
  const stusdsHolderInput =
    stusdsCurrent && holderProof
      ? {
          history: stusdsPinnedProtocolHistory(),
          current: stusdsCurrent,
          capacityAgreement: holderProof.capacityAgreement,
          binding: holderProof.binding,
          horizonHours,
          asOfMs,
        }
      : null
  const acceptStusdsCurrent = (current: NonNullable<typeof stusdsCurrent>) =>
    Boolean(
      stusdsEvidenceExpected &&
      acceptStusdsCurrentProtocolCapacityEvidence(
        current,
        stusdsRawEvidence,
        stusdsEvidenceExpected,
        (s) => sha256(stringToHex(s)).slice(2),
      ),
    )
  const stusdsBuilt = stusdsHolderInput
    ? buildStusdsHistoricalHolderCapacityProjection(stusdsHolderInput, acceptStusdsCurrent)
    : null
  const stusdsSelected =
    stusdsBuilt && stusdsHolderInput
      ? selectedStusdsHistoricalHolderCapacityProjection(
          stusdsBuilt,
          stusdsHolderInput,
          acceptStusdsCurrent,
        )
      : null
  const stusdsFuture = stusdsSelected?.view.futureScenario ?? null
  const cometHolderInput =
    cometCash && holderProof
      ? {
          cashProjection: cometCash,
          capacityAgreement: holderProof.capacityAgreement,
          cometFactsAgreement:
            holderCometFactsAgreementInput ?? holderAssessment?.cometFactsAgreement,
          binding: holderProof.binding,
          currentSource: cometCash.currentSource,
          horizonHours,
          asOfMs,
        }
      : null
  const cometHolderBuilt = cometHolderInput
    ? buildCometHolderCapacityProjection(cometHolderInput, (s) => sha256(stringToHex(s)).slice(2))
    : null
  const cometHolder =
    cometHolderBuilt && cometHolderInput
      ? selectedCometHolderCapacityProjection(cometHolderBuilt, cometHolderInput, (s) =>
          sha256(stringToHex(s)).slice(2),
        )
      : null
  const cometHorizon = cometHolder?.horizons[0] ?? null
  const susdsHolderInput =
    susdsCash && holderProof
      ? {
          history: susdsPinnedIndexHistory(),
          capacityAgreement: holderProof.capacityAgreement,
          binding: holderProof.binding,
          currentSource: holderProof.binding.currentSource,
          currentReadAtUtc: susdsCash.currentSource.readAt,
          horizonHours,
          asOfMs,
        }
      : null
  const susdsHolderBuilt = susdsHolderInput
    ? buildSusdsHistoricalHolderCapacityProjection(susdsHolderInput, (s) =>
        sha256(stringToHex(s)).slice(2),
      )
    : null
  const susdsHolder =
    susdsHolderBuilt && susdsHolderInput
      ? selectedSusdsHistoricalHolderCapacityProjection(susdsHolderBuilt, susdsHolderInput, (s) =>
          sha256(stringToHex(s)).slice(2),
        )
      : null
  const susdsHorizon = susdsHolder?.view.groups[0] ?? null
  const aaveSparkHolder =
    aaveSparkCapacity && holderProof
      ? buildAaveSparkCapacityProjection(
          { ...aaveSparkCapacity.input, asOfMs, holder: holderProof },
          (value) => sha256(stringToHex(value)).slice(2),
        )
      : null
  const sghoHolderInput =
    sghoCash && holderProof
      ? {
          cashProjection: sghoCash,
          capacityAgreement: holderProof.capacityAgreement,
          binding: holderProof.binding,
          currentSource: sghoCash.currentSource,
          horizonHours,
          asOfMs,
        }
      : null
  const sghoHolderBuilt = sghoHolderInput
    ? buildSghoHolderCapacityProjection(sghoHolderInput, (s) => sha256(stringToHex(s)).slice(2))
    : null
  const sghoHolder =
    sghoHolderInput && sghoHolderBuilt
      ? selectedSghoHolderCapacityProjection(sghoHolderBuilt, sghoHolderInput, (s) =>
          sha256(stringToHex(s)).slice(2),
        )
      : null
  const issuedUsd3Holder = useMemo(() => {
    const issue = holderTimeProcessIssue
    if (
      !issue ||
      !Number.isSafeInteger(issue.issuedAtMs) ||
      typeof issue.owner !== 'string' ||
      issue.horizonHours !== horizonHours ||
      issue.owner.toLowerCase() !== requestedHolderAddress?.toLowerCase() ||
      issue.requestedRaw !== requestedRaw ||
      issue.block !== timeWitness?.block ||
      issue.blockHash !== timeWitness?.blockHash
    )
      return null
    const input = issuedUsd3HolderTimeInputForCard(
      conditionalSampledInput,
      holderCapacityAgreementInput ?? holderAssessmentInput?.capacityAgreement,
      holderAssessmentInput?.executionAgreement,
      {
        routeKey,
        destination,
        requestedRaw,
        requestedAssetAddress,
        requestedAssetDecimals,
        horizonHours,
        requestedHolderAddress,
        asOfMs: issue.issuedAtMs,
      },
      timeWitness,
    )
    if (!input) return null
    const privateInput = freezeIssued(structuredClone(input)),
      hash = (s: string) => sha256(stringToHex(s)).slice(2)
    const built = buildUsd3HolderCapacityProjection(privateInput, hash)
    const selected = built ? selectedUsd3HolderCapacityProjection(built, privateInput, hash) : null
    return selected ? freezeIssued(structuredClone(selected)) : null
  }, [
    holderTimeProcessIssue,
    conditionalSampledInput,
    holderCapacityAgreementInput,
    holderAssessmentInput,
    routeKey,
    destination,
    requestedRaw,
    requestedAssetAddress,
    requestedAssetDecimals,
    horizonHours,
    requestedHolderAddress,
    timeWitness,
  ])
  const usd3Holder =
    issuedUsd3Holder && cashHolderTimeRenderWindow(issuedUsd3Holder, asOfMs)
      ? issuedUsd3Holder
      : null
  const fluidHolder =
    fluidProtocol && holderProof
      ? buildFluidProtocolCapacityProjection(
          {
            currentProngs: fluidProtocol.currentProngs,
            currentReadAtUtc: fluidProtocol.currentReadAtUtc,
            requestedRaw: requestedRaw!,
            horizonHours,
            asOfMs,
            holder: holderProof,
          },
          (value) => sha256(stringToHex(value)).slice(2),
        )
      : null
  const selectedAaveSparkCapacity = aaveSparkHolder ?? aaveSparkCapacity
  const selectedFluidProtocol = fluidHolder ?? fluidProtocol
  const aaveSparkHorizon = selectedAaveSparkCapacity?.horizons[0] ?? null
  const fluidProtocolHorizon = selectedFluidProtocol?.projection.horizons[0] ?? null
  const conditionalHolderHeadroom =
    conditionalHeadroom && holderAssessment && currentCash && requestedHolderAddress && requestedRaw
      ? selectedConditionalHolderFlowProjection(
          {
            cashProjection: conditionalHeadroom,
            assessment: holderAssessment,
            executionAgreement: holderAssessment.executionAgreement,
          },
          {
            currentSource: {
              chainId: 1,
              routeKey: currentCash.routeKey,
              destination: currentCash.destination.toLowerCase(),
              asset: currentCash.assetAddress!.toLowerCase(),
              assetDecimals: currentCash.assetDecimals,
              cashRaw: currentCash.cashRaw,
              blockNumber: Number(currentCash.block),
              blockHash: currentCash.blockHash!,
              blockTime: currentCash.observedAt,
              readAt:
                currentCash.sourceKind === 'manifest_bound_ledger'
                  ? currentCash.firstLocalReceiptAt!
                  : currentCash.readAtUtc!,
              finalized: true,
            },
            owner: requestedHolderAddress,
            requestedRaw,
            horizonHours,
            asOfMs,
          },
          (s) => sha256(stringToHex(s)).slice(2),
        )
      : null
  const projectedHeadroom = conditionalHolderHeadroom ?? conditionalHeadroom
  const conditionalHolderSampledCash =
    conditionalSampledHeadroom &&
    holderAssessment &&
    currentCash &&
    requestedHolderAddress &&
    requestedRaw
      ? selectedConditionalHolderSampledCashProjection(
          {
            cashProjection: conditionalSampledHeadroom,
            assessment: holderAssessment,
            executionAgreement: holderAssessment.executionAgreement,
          },
          {
            currentSource: {
              chainId: 1,
              routeKey: currentCash.routeKey,
              destination: currentCash.destination.toLowerCase(),
              asset: currentCash.assetAddress!.toLowerCase(),
              assetDecimals: currentCash.assetDecimals,
              cashRaw: currentCash.cashRaw,
              block: currentCash.block,
              blockHash: currentCash.blockHash!,
              blockTime: currentCash.observedAt,
              readAt:
                currentCash.sourceKind === 'manifest_bound_ledger'
                  ? currentCash.firstLocalReceiptAt!
                  : currentCash.readAtUtc!,
              sourceKind: currentCash.sourceKind!,
              ...(currentCash.sourceKind === 'manifest_bound_ledger'
                ? {
                    manifestSha256: currentCash.manifestSha256,
                    receiptSha256: currentCash.receiptSha256,
                  }
                : {}),
            },
            owner: requestedHolderAddress,
            requestedRaw,
            horizonHours,
            asOfMs,
          },
          (s) => sha256(stringToHex(s)).slice(2),
        )
      : null
  const holderSampledEligibility = conditionalHolderSampledCash?.horizons[0].mechanicalEligibility
  const holderSampledEligible =
    holderSampledEligibility?.earliest === 'conditional_by_target' &&
    holderSampledEligibility.latest === 'conditional_by_target'
  const projectedCashHorizon = usd3Cash
    ? (usd3Holder?.horizons[0] ?? null)
    : (sghoHolder?.horizons[0] ?? conditionalSampledHeadroom?.horizons[0] ?? null)
  const eventQuestion: RouteEventQuestion | null =
    requestedRaw &&
    requestedAssetAddress &&
    ADDRESS.test(requestedAssetAddress.toLowerCase()) &&
    requestedAssetDecimals !== null &&
    validDecimals(requestedAssetDecimals)
      ? {
          routeKey,
          destination: destination.toLowerCase(),
          requestedRaw,
          payoutAsset: requestedAssetAddress.toLowerCase(),
          assetDecimals: requestedAssetDecimals,
          horizonHours,
        }
      : null
  const eventContext =
    eventQuestion && expectedEventEnrollment
      ? matchingRouteEventContext(eventContextInput, eventQuestion, expectedEventEnrollment, asOfMs)
      : null

  const eventImpactIssuedAt = conditionalEventImpactIssuedAt(conditionalEventImpactInput)
  const conditionalEventImpact =
    scenarioMode === 'exit' &&
    eventQuestion &&
    eventImpactIssuedAt &&
    currentCash &&
    currentCash.assetAddress &&
    currentCash.block &&
    currentCash.blockHash &&
    currentCash.sourceKind &&
    (currentCash.readAtUtc || currentCash.firstLocalReceiptAt)
      ? selectedConditionalEventImpact(
          conditionalEventImpactInput,
          {
            routeKey,
            destination: destination.toLowerCase(),
            asset: eventQuestion.payoutAsset,
            assetDecimals: eventQuestion.assetDecimals,
            requestedRaw: eventQuestion.requestedRaw,
            horizonHours,
            issuedAtUtc: eventImpactIssuedAt,
          },
          {
            routeKey,
            destination: destination.toLowerCase(),
            chainId: 1,
            asset: currentCash.assetAddress.toLowerCase(),
            assetDecimals: currentCash.assetDecimals,
            cashRaw: currentCash.cashRaw,
            block: currentCash.block,
            blockHash: currentCash.blockHash,
            blockTime: currentCash.observedAt,
            readAt: currentCash.readAtUtc ?? currentCash.firstLocalReceiptAt!,
            sourceKind: currentCash.sourceKind,
            ...(currentCash.manifestSha256 ? { manifestSha256: currentCash.manifestSha256 } : {}),
            ...(currentCash.receiptSha256 ? { receiptSha256: currentCash.receiptSha256 } : {}),
          },
          asOfMs,
        )
      : null

  const currentCashAmount = currentCash
    ? formatExitPressureRaw(currentCash.cashRaw, currentCash.assetDecimals)
    : null
  const cashShare =
    currentCash &&
    requestedRaw &&
    currentCash.assetSymbol === requestedAssetSymbol &&
    validRaw(currentCash.cashRaw)
      ? formatRequestedCashShare(requestedRaw, currentCash.cashRaw)
      : null
  const prospectiveIssue = prospectiveCashModel
    ? activeProspectiveCashIssue(prospectiveCashModel, asOfMs)
    : null
  const prospectivePoint =
    prospectiveIssue && requestedAssetDecimals !== null
      ? formatExitPressureRaw(prospectiveIssue.projection.pointRaw, requestedAssetDecimals)
      : null
  const prospectiveLow =
    prospectiveIssue && requestedAssetDecimals !== null
      ? formatExitPressureRaw(prospectiveIssue.projection.lowRaw, requestedAssetDecimals)
      : null
  const prospectiveHigh =
    prospectiveIssue && requestedAssetDecimals !== null
      ? formatExitPressureRaw(prospectiveIssue.projection.highRaw, requestedAssetDecimals)
      : null
  const prospectiveEvidence = prospectiveCashModel
    ? `SCHEDULE ${prospectiveCashModel.schedule.onTime}/${prospectiveCashModel.schedule.scheduled} · OUTCOMES ${prospectiveCashModel.outcome.observed}/${prospectiveCashModel.outcome.issued} · INTERVAL ${prospectiveCashModel.interval.covered}/${prospectiveCashModel.interval.observed} · SOURCE ${prospectiveCashModel.source.available}/${prospectiveCashModel.source.opportunities}`
    : null
  const projectionAsOfAt =
    Number.isSafeInteger(asOfMs) && asOfMs >= 0 ? new Date(asOfMs).toISOString() : ''
  const routeProjection = historicalScenario
    ? deriveRouteProxyExitProjection({
        routeKey,
        destination: destination.toLowerCase(),
        requestedRaw: historicalScenario.requestedRaw,
        currentCashRaw: historicalScenario.currentCashRaw,
        pointRaw: historicalScenario.pointRaw,
        bandLowRaw: historicalScenario.bandLowRaw,
        bandHighRaw: historicalScenario.bandHighRaw,
        horizonHours: historicalScenario.horizonHours,
        currentAt: historicalScenario.currentBlockAt,
        targetAt: historicalScenario.targetAt,
        asOfAt: projectionAsOfAt,
        method: historicalScenario.method,
        samples: historicalScenario.sampleCount,
        validation: historicalScenario.validation,
      })
    : null
  const projectedValues =
    routeProjection?.status === 'research_projection'
      ? {
          capacity: {
            low: formatExitPressureRaw(
              routeProjection.capacityRaw.low,
              historicalScenario!.assetDecimals,
            ),
            point: formatExitPressureRaw(
              routeProjection.capacityRaw.point,
              historicalScenario!.assetDecimals,
            ),
            high: formatExitPressureRaw(
              routeProjection.capacityRaw.high,
              historicalScenario!.assetDecimals,
            ),
          },
          margin: {
            low: formatExitPressureSignedRaw(
              routeProjection.marginAfterQRaw.low,
              historicalScenario!.assetDecimals,
            ),
            point: formatExitPressureSignedRaw(
              routeProjection.marginAfterQRaw.point,
              historicalScenario!.assetDecimals,
            ),
            high: formatExitPressureSignedRaw(
              routeProjection.marginAfterQRaw.high,
              historicalScenario!.assetDecimals,
            ),
          },
          change:
            routeProjection.projectedChangeRaw === null
              ? null
              : formatExitPressureSignedRaw(
                  routeProjection.projectedChangeRaw,
                  historicalScenario!.assetDecimals,
                ),
          netFlow: {
            low: formatExitPressureSignedRaw(
              routeProjection.expectedNetFlowRaw.low,
              historicalScenario!.assetDecimals,
            ),
            point: formatExitPressureSignedRaw(
              routeProjection.expectedNetFlowRaw.point,
              historicalScenario!.assetDecimals,
            ),
            high: formatExitPressureSignedRaw(
              routeProjection.expectedNetFlowRaw.high,
              historicalScenario!.assetDecimals,
            ),
          },
        }
      : null
  const projectedRequestAmount = historicalScenario
    ? formatExitPressureRaw(historicalScenario.requestedRaw, historicalScenario.assetDecimals)
    : null
  const horizonAssessment =
    routeProjection?.status === 'research_projection'
      ? {
          band_above_q_at_horizon: `Band at or above Q at +${routeProjection.horizonHours}h`,
          q_inside_band_at_horizon: `Q inside band at +${routeProjection.horizonHours}h`,
          band_below_q_at_horizon: `Band below Q at +${routeProjection.horizonHours}h`,
        }[routeProjection.horizonAssessment]
      : null
  const requestStages = holderAssessment?.stages.filter((stage) => stage.relatedToRequest) ?? []
  const simulatedStages = requestStages.filter((stage) => stage.status === 'simulated').length
  const holderWarning = Boolean(
    holderAssessment &&
    (holderAssessment.status !== 'assessed' ||
      requestStages.some((stage) => stage.status !== 'simulated') ||
      holderAssessment.finalPayout.status === 'unassessed'),
  )
  const historicalBacktestSignal = historicalBacktest?.absoluteQBacktest.retrospectiveSignal

  const directionMetric = (flow: ExitPressureGrossDirection, label: string) => {
    const amount = formatExitPressureRaw(flow.amountRaw, flow.assetDecimals)
    if (!amount) return null
    return (
      <Metric
        label={label}
        value={`${amount} ${flow.assetSymbol}`}
        detail={`${flow.window === 'maximum_24h' ? 'MAX OBSERVED 24H' : 'OBSERVED SPAN'} · ${utcMinute(flow.windowStartAt)}–${utcMinute(flow.windowEndAt)} · ${flow.eventCount} ${flow.eventCountScope === 'window' ? 'WINDOW' : 'SOURCE'} EVENTS${flow.includesBorrowing ? ' · INCLUDES BORROWING' : ''}${flow.interpretation === 'gross_underlying_inflow_not_net_replenishment' ? ' · NOT NET REPLENISHMENT' : ''}${flow.mayIncludeDebtRepayment ? ' · MAY INCLUDE DEBT REPAYMENT' : ''}`}
      />
    )
  }
  const historicalGrossFlowValues = historicalGrossFlow
    ? {
        currentMargin: formatExitPressureSignedRaw(
          historicalGrossFlow.currentMarginAfterQRaw,
          historicalGrossFlow.assetDecimals,
        ),
        scenarios: [
          ['Heavy flow', historicalGrossFlow.pairedScenarios.p10Trough],
          ['Worst recorded flow', historicalGrossFlow.pairedScenarios.worstTrough],
          ['Largest outflow', historicalGrossFlow.pairedScenarios.highestGrossOutflow],
        ].map(([label, window]) => ({
          label: label as string,
          window: window as TranslatedPairedFlowWindow,
          inflow: formatExitPressureRaw(
            (window as TranslatedPairedFlowWindow).grossReserveInRaw,
            historicalGrossFlow.assetDecimals,
          ),
          outflow: formatExitPressureRaw(
            (window as TranslatedPairedFlowWindow).grossReserveOutRaw,
            historicalGrossFlow.assetDecimals,
          ),
          troughMargin: formatExitPressureSignedRaw(
            (window as TranslatedPairedFlowWindow).troughMarginAfterQRaw,
            historicalGrossFlow.assetDecimals,
          ),
        })),
      }
    : null
  const hasCurrentProvenance = Boolean(
    currentCash ||
    holderAssessment ||
    mechanicalRow ||
    eventContext?.status === 'route_event_context',
  )
  const hasHistoricalProvenance = Boolean(
    historicalBacktest ||
    sampledCashPaths ||
    historicalScenario ||
    grossWithdrawals ||
    grossInflows ||
    historicalGrossFlow ||
    historicalMarketGrossFlow ||
    morphoPayout,
  )

  return (
    <Card variant="subtle" p={SPACING.base} data-testid="exit-pressure-card">
      <VStack align="stretch" spacing={SPACING.base}>
        <HStack justify="space-between" align="start" spacing={SPACING.base} flexWrap="wrap">
          <Box minW={0}>
            <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
              EXIT PRESSURE · +{horizonHours}H
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h3}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
              maxW="100%"
              overflowWrap="anywhere"
            >
              Q {requestedAmount} {requestedAssetSymbol}
            </Text>
          </Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            textAlign={{ base: 'left', md: 'right' }}
          >
            {routeKey} · {shortDestination(destination)}
          </Text>
        </HStack>

        {(currentCashAmount || holderAssessment || mechanicalRow) && (
          <SimpleGrid columns={{ base: 1, sm: 2, lg: 3 }} spacing={SPACING.base}>
            {currentCash && currentCashAmount && (
              <Metric
                label={currentCash.label}
                value={`${currentCashAmount} ${currentCash.assetSymbol}`}
                detail={`${currentCashFreshness.toUpperCase()} · ${utcMinute(currentCash.observedAt)}`}
                warning={currentCashFreshness === 'stale'}
              />
            )}
            {cashShare && <Metric label="Q / current cash" value={cashShare} />}
            {(holderAssessment || mechanicalRow) && (
              <Box
                title={
                  mechanicalRow
                    ? `Conditional on unchanged parameters and holder state; checked block ${boundHolderAssessment?.source.blockNumber}. Known stage bounds do not attest final conversion or future execution.`
                    : undefined
                }
              >
                <Metric
                  label={mechanicalRow?.label ?? 'Current holder check'}
                  value={
                    mechanicalRow?.value ??
                    `${simulatedStages}/${requestStages.length} request stages simulated`
                  }
                  detail={
                    mechanicalRow
                      ? mechanicalRow.detail
                      : `FINAL PAYOUT · ${holderAssessment!.finalPayout.status.replaceAll('_', ' ').toUpperCase()} · BLOCK ${holderAssessment!.source.blockNumber}`
                  }
                  warning={mechanicalRow?.warning ?? holderWarning}
                />
              </Box>
            )}
          </SimpleGrid>
        )}

        {prospectiveCashModel && (
          <Box
            data-testid="exit-pressure-prospective-cash"
            data-state={prospectiveCashModel.status}
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.base}
          >
            <HStack justify="space-between" align="start" spacing={SPACING.base} flexWrap="wrap">
              <Text
                {...labelStyle}
                color={
                  prospectiveCashModel.status === 'validated'
                    ? SEMANTIC_COLORS.success
                    : SEMANTIC_COLORS.info
                }
              >
                PROSPECTIVE CASH MODEL · {prospectiveCashModel.status.toUpperCase()}
              </Text>
              {prospectiveIssue && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  TARGET {utcMinute(prospectiveIssue.targetAtUtc)}
                </Text>
              )}
            </HStack>
            <SimpleGrid
              columns={{
                base: 1,
                lg: prospectivePoint && prospectiveLow && prospectiveHigh ? 3 : 1,
              }}
              spacing={SPACING.base}
              mt={SPACING.sm}
            >
              <Metric label="Prospective evidence" value={prospectiveEvidence} />
              {prospectivePoint && prospectiveLow && prospectiveHigh && (
                <>
                  <Metric
                    label="Active cash point"
                    value={`${prospectivePoint} ${requestedAssetSymbol}`}
                  />
                  <Metric
                    label="Active cash range"
                    value={`${prospectiveLow}–${prospectiveHigh} ${requestedAssetSymbol}`}
                  />
                </>
              )}
            </SimpleGrid>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
              mt={SPACING.sm}
            >
              AGGREGATE CASH · NOT HOLDER EXECUTION
            </Text>
          </Box>
        )}

        {localExactQ && (
          <Box
            data-testid="exit-pressure-local-exact-q"
            data-state={localExactQRefreshDue ? 'refresh_due' : localExactQ.status}
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.base}
          >
            <HStack justify="space-between" align="start" spacing={SPACING.base} flexWrap="wrap">
              <Text
                {...labelStyle}
                color={
                  localExactQ.status === 'collecting' && !localExactQRefreshDue
                    ? SEMANTIC_COLORS.info
                    : SEMANTIC_COLORS.warning
                }
              >
                LOCAL Q OBSERVATIONS ·{' '}
                {localExactQRefreshDue ? 'REFRESH DUE' : localExactQ.status.toUpperCase()}
              </Text>
              {localExactQ.evidence && (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  TARGET {utcMinute(localExactQ.evidence.latest.targetAtUtc)} ·{' '}
                  {localExactQRefreshDue
                    ? 'REFRESH DUE'
                    : localExactQ.evidence.latest.status.replaceAll('_', ' ').toUpperCase()}
                </Text>
              )}
            </HStack>
            {localExactQ.evidence && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
                mt={SPACING.sm}
              >
                ISSUED {localExactQ.evidence.issued} ·{' '}
                {!localExactQRefreshDue && <>PENDING {localExactQ.evidence.pending} · </>}
                MEASURED {localExactQ.evidence.measured} · UNVERIFIED{' '}
                {localExactQ.evidence.recordedUnverified} · UNAVAILABLE{' '}
                {localExactQ.evidence.unavailable} · MISSING {localExactQ.evidence.missing} ·
                CENSORED {localExactQ.evidence.censored}
              </Text>
            )}
          </Box>
        )}

        {sampledCashPaths && (
          <VStack
            align="stretch"
            spacing={SPACING.sm}
            data-testid="exit-pressure-sampled-cash-paths"
          >
            <Text
              {...labelStyle}
              title={`Fixed seven-day historical net cash changes replayed from block ${sampledCashPaths.current.block}; Q subtracted once. ${sampledCashPaths.counts.eligibleEpisodes} eligible episodes; ${sampledCashPaths.counts.gapRejectedEpisodes} gap-rejected. Sampled brackets do not establish continuous time below Q or holder execution. Left censoring means already below at the first sample; right censoring means no later above-Q sample; gap censoring means timing is unobserved across a gap.`}
            >
              Historical scenarios · 7d
            </Text>
            <Text {...labelStyle}>Margin after Q · lowest / ending · {requestedAssetSymbol}</Text>
            {(
              [
                ['Worst cash drop', sampledCashPaths.examples.worstTrough],
                ['Heavy cash drop', sampledCashPaths.examples.p10Trough],
                ['Lowest ending cash', sampledCashPaths.examples.worstEndpoint],
              ] as const
            ).map(([label, example]) => (
              <Box
                key={label}
                title={`${utcMinute(example.originAt)} → ${utcMinute(example.endpointAt)}; sampled interval brackets relative to this historical start. ${example.sampledBelowQ.leftCensored ? 'Already below Q at the first sample; onset unobserved. ' : ''}${example.sampledBelowQ.rightCensored ? 'No subsequent above-Q sample; recovery unobserved. ' : ''}${example.sampledBelowQ.gapCensored ? 'Missing samples censor timing.' : ''}`}
              >
                <Metric
                  label={label}
                  value={`${sampledMargin(example.troughMarginAfterQRaw, sampledCashPaths.identity.assetDecimals)} / ${sampledMargin(example.endpointMarginAfterQRaw, sampledCashPaths.identity.assetDecimals)}`}
                  warning={example.troughMarginAfterQRaw.startsWith('-')}
                  detail={sampledPathTiming(example)}
                />
              </Box>
            ))}
          </VStack>
        )}

        {historicalBacktest && (
          <Box
            data-testid="exit-pressure-historical-backtest"
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.base}
          >
            <Text {...labelStyle}>
              HISTORICAL Q BACKTEST · +{historicalBacktest.question.horizonHours}H
            </Text>
            <SimpleGrid columns={{ base: 1, sm: 2, lg: 4 }} spacing={SPACING.base} mt={SPACING.sm}>
              <Metric
                label="Split · fit / calibration / holdout"
                value={`${historicalBacktest.absoluteQBacktest.counts.fit} / ${historicalBacktest.absoluteQBacktest.counts.calibration} / ${historicalBacktest.absoluteQBacktest.counts.holdout}`}
                detail={`${historicalBacktest.absoluteQBacktest.counts.total} NONOVERLAPPING ENDPOINT PAIRS`}
              />
              <Metric
                label="Endpoints below Q · fit / calibration / holdout"
                value={`${historicalBacktest.absoluteQBacktest.outcomes.fitBelowQ.numerator}/${historicalBacktest.absoluteQBacktest.outcomes.fitBelowQ.denominator} / ${historicalBacktest.absoluteQBacktest.outcomes.calibrationBelowQ.numerator}/${historicalBacktest.absoluteQBacktest.outcomes.calibrationBelowQ.denominator} / ${historicalBacktest.absoluteQBacktest.outcomes.holdoutBelowQ.numerator}/${historicalBacktest.absoluteQBacktest.outcomes.holdoutBelowQ.denominator}`}
                warning={historicalBacktest.absoluteQBacktest.outcomes.holdoutBelowQ.numerator > 0}
              />
              <Metric
                label="Signal eligibility"
                value={historicalBacktestSignal?.status === 'supported' ? 'ELIGIBLE' : 'WITHHELD'}
                detail={
                  historicalBacktestSignal?.status === 'supported'
                    ? 'RETROSPECTIVE ONLY'
                    : historicalBacktestSignal?.reason.replaceAll('_', ' ').toUpperCase()
                }
                warning={historicalBacktestSignal?.status !== 'supported'}
              />
              <Metric
                label="Completed sampled spans · median / P90 / longest"
                value={
                  historicalBacktest.duration.status === 'historical_interval_outlook'
                    ? historicalBacktest.duration.completedSampledRunDurationSeconds
                      ? `${durationInterval(historicalBacktest.duration.completedSampledRunDurationSeconds.median.low, historicalBacktest.duration.completedSampledRunDurationSeconds.median.high)} / ${durationInterval(historicalBacktest.duration.completedSampledRunDurationSeconds.p90.low, historicalBacktest.duration.completedSampledRunDurationSeconds.p90.high)} / ${durationInterval(historicalBacktest.duration.completedSampledRunDurationSeconds.longest.low, historicalBacktest.duration.completedSampledRunDurationSeconds.longest.high)}`
                      : 'NONE'
                    : 'UNOBSERVED'
                }
                detail={
                  historicalBacktest.duration.status === 'historical_interval_outlook'
                    ? `${historicalBacktest.duration.completedSampledRuns} COMPLETED · AGGREGATE CASH · BETWEEN-SAMPLE RECOVERY UNKNOWN`
                    : 'NO SAMPLED BELOW-Q RUN'
                }
                warning={historicalBacktest.duration.status !== 'historical_interval_outlook'}
              />
              {historicalBacktest.duration.status === 'historical_interval_outlook' && (
                <Metric
                  label="Censored sampled spans · left / right"
                  value={`${censoredSampledSpan(historicalBacktest.duration.leftCensoredRuns, historicalBacktest.duration.censoredRunObservedSpanLowerBoundSeconds.leftLongest)} / ${censoredSampledSpan(historicalBacktest.duration.rightCensoredRuns, historicalBacktest.duration.censoredRunObservedSpanLowerBoundSeconds.rightLongest)}`}
                  detail="AGGREGATE CASH SAMPLE SPAN ONLY"
                  warning={
                    historicalBacktest.duration.leftCensoredRuns > 0 ||
                    historicalBacktest.duration.rightCensoredRuns > 0
                  }
                />
              )}
            </SimpleGrid>
          </Box>
        )}

        {historicalScenario &&
          routeProjection?.status === 'research_projection' &&
          projectedValues?.capacity.low &&
          projectedValues.capacity.point &&
          projectedValues.capacity.high &&
          projectedValues.margin.low &&
          projectedValues.margin.point &&
          projectedValues.margin.high &&
          projectedValues.netFlow.low &&
          projectedValues.netFlow.point &&
          projectedValues.netFlow.high &&
          projectedRequestAmount &&
          horizonAssessment && (
            <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.base}>
              <Text
                {...labelStyle}
                color={
                  routeProjection.alert ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textSecondary
                }
              >
                {historicalScenario.requestScope === 'first_leg'
                  ? 'FIRST LEG PROJECTION'
                  : 'ROUTE EXIT PROJECTION'}{' '}
                · Q {projectedRequestAmount} {historicalScenario.requestedAssetSymbol} · +
                {routeProjection.horizonHours}H · TARGET {utcMinute(routeProjection.targetAt)}
              </Text>
              <Text {...labelStyle} mt={SPACING.xs}>
                {routeProjection.method.replaceAll('_', ' ').toUpperCase()} ·{' '}
                {routeProjection.samples} ENDPOINT PAIRS
                {routeProjection.validation
                  ? ` · UNTOUCHED TEST ${routeProjection.validation.covered}/${routeProjection.validation.holdout} · COVERAGE ${routeProjection.validation.coveragePassed ? 'PASS' : 'FAIL'}${routeProjection.validation.pointBeatsPersistence === null ? '' : ` · POINT SKILL ${routeProjection.validation.pointBeatsPersistence ? 'PASS' : 'FAIL'}`}`
                  : ''}{' '}
                · PROSPECTIVE UNVALIDATED ·{' '}
                {historicalScenario.requestScope === 'first_leg' ? 'STAGE' : 'ROUTE'} CASH PROXY ·
                HOLDER CALL UNASSESSED
              </Text>
              <SimpleGrid
                columns={{ base: 1, sm: 2, lg: 3 }}
                spacing={SPACING.base}
                mt={SPACING.sm}
              >
                <Metric
                  label={
                    routeProjection.method === 'historical_net_change'
                      ? 'Projected cash · worst / P10 / P90'
                      : 'Projected cash band · low–high'
                  }
                  value={
                    routeProjection.method === 'historical_net_change'
                      ? `${projectedValues.capacity.low} / ${projectedValues.capacity.point} / ${projectedValues.capacity.high} ${historicalScenario.assetSymbol}`
                      : `${projectedValues.capacity.low}–${projectedValues.capacity.high} ${historicalScenario.assetSymbol}`
                  }
                  detail={
                    routeProjection.method === 'historical_net_change'
                      ? undefined
                      : `POINT ${projectedValues.capacity.point} ${historicalScenario.assetSymbol}`
                  }
                />
                <Metric
                  label={`${historicalScenario.requestScope === 'first_leg' ? 'Margin after first-leg Q' : 'Margin after Q'} · ${routeProjection.method === 'historical_net_change' ? 'worst / P10 / P90' : 'band low–high'}`}
                  value={
                    routeProjection.method === 'historical_net_change'
                      ? `${projectedValues.margin.low} / ${projectedValues.margin.point} / ${projectedValues.margin.high} ${historicalScenario.assetSymbol}`
                      : `${projectedValues.margin.low}–${projectedValues.margin.high} ${historicalScenario.assetSymbol}`
                  }
                  detail={
                    routeProjection.method === 'historical_net_change'
                      ? undefined
                      : `POINT ${projectedValues.margin.point} ${historicalScenario.assetSymbol}`
                  }
                  warning={routeProjection.projectedState !== 'band_covers_q'}
                />
                <Metric
                  label={
                    routeProjection.method === 'historical_net_change'
                      ? 'Historical route net flow · worst / P10 / P90'
                      : 'Expected route net flow · low / point / high'
                  }
                  value={`${projectedValues.netFlow.low} / ${projectedValues.netFlow.point} / ${projectedValues.netFlow.high} ${historicalScenario.assetSymbol}`}
                  detail={`${horizonAssessment} · ${routeProjection.direction.toUpperCase()}${projectedValues.change ? ` ${projectedValues.change} ${historicalScenario.assetSymbol}` : ''}${routeProjection.alert ? ' · PROJECTED SHRINK' : ''}`}
                  warning={routeProjection.projectedState !== 'band_covers_q'}
                />
              </SimpleGrid>
            </Box>
          )}

        {(grossWithdrawals || grossInflows) && (
          <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.base}>
            <Text {...labelStyle}>OBSERVED COMPETING FLOW · DIRECTION WINDOWS MAY DIFFER</Text>
            <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.base} mt={SPACING.sm}>
              {grossWithdrawals && directionMetric(grossWithdrawals, 'Gross withdrawals')}
              {grossInflows && directionMetric(grossInflows, 'Gross underlying inflow')}
            </SimpleGrid>
          </Box>
        )}

        {scenarioMode === 'initial_deposit' && (
          <Box
            data-testid="initial-deposit-scenario"
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.hairline}
            pt={SPACING.base}
          >
            <HStack justify="space-between" spacing={SPACING.sm} flexWrap="wrap">
              <Text {...labelStyle}>
                {initialDeposit?.admission.status === 'blocked_under_reference_rules'
                  ? 'After deposit · counterfactual admission'
                  : 'After deposit · if admitted'}
              </Text>
              <Text {...labelStyle} color={SEMANTIC_COLORS.warning}>
                {initialDeposit
                  ? initialDeposit.admission.status === 'unknown'
                    ? 'Admission unknown'
                    : 'Admission blocked under reference rules'
                  : 'Deposit outlook unassessed'}
              </Text>
            </HStack>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
            >
              D {depositAmount} · Q {requestedAmount} {requestedAssetSymbol}
            </Text>
            {initialDeposit && (
              <Text {...labelStyle} mt={SPACING.xs}>
                {initialDeposit.hypotheticalReceipt.status === 'conditional_source_indexed_receipt'
                  ? `Hypothetical receipt ${formatExitPressureRaw(initialDeposit.hypotheticalReceipt.entitlementRaw, 6)} ${requestedAssetSymbol}`
                  : 'Receipt unassessed · cash only'}
                {' · '}SOURCE {utcMinute(initialDeposit.hypotheticalDepositAtUtc)}
              </Text>
            )}
          </Box>
        )}
        {(initialSummary ||
          saturnForecast ||
          (historicalGrossFlow && historicalGrossFlowValues?.currentMargin) ||
          conditionalHeadroom ||
          conditionalSampledHeadroom ||
          analogCash ||
          fluidProtocolHorizon ||
          aaveSparkHorizon ||
          susdsHorizon ||
          stusdsFuture ||
          cometHorizon ||
          cashTimeSummary ||
          stusdsTimeSummary ||
          susdeTimeSummary ||
          (isUsd3JointSubject && scenarioMode === 'exit') ||
          (isFluidUsdcBridgeJointSubject && scenarioMode === 'exit') ||
          (isFluidUsdtBridgeJointSubject && scenarioMode === 'exit') ||
          (isUmbrellaGhoJointSubject && scenarioMode === 'exit') ||
          (isApyUsdJointSubject && scenarioMode === 'exit') ||
          morphoIdleJoint ||
          morphoJoint ||
          morphoTimeSummary) && (
          <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.base}>
            <Text {...labelStyle}>
              {saturnForecast ? (
                'CONDITIONAL CONVERSION'
              ) : initialSummary ? (
                'AFTER DEPOSIT · CONDITIONAL'
              ) : historicalGrossFlow && historicalGrossFlowValues?.currentMargin ? (
                <>
                  CONDITIONAL HISTORICAL FLOW · {historicalGrossFlow.horizonBlocks} BLOCKS ·{' '}
                  {historicalGrossFlow.windowCount} WINDOWS
                </>
              ) : isFluidUsdtBridgeJointSubject && scenarioMode === 'exit' ? (
                'CONDITIONAL QUOTE FUNDING'
              ) : susdsHorizon ||
                stusdsFuture ||
                cometHorizon ||
                cashTimeSummary ||
                stusdsTimeSummary ||
                susdeTimeSummary ||
                (isUsd3JointSubject && scenarioMode === 'exit') ||
                (isFluidUsdcBridgeJointSubject && scenarioMode === 'exit') ||
                (isFluidUsdtBridgeJointSubject && scenarioMode === 'exit') ||
                (isUmbrellaGhoJointSubject && scenarioMode === 'exit') ||
                (isApyUsdJointSubject && scenarioMode === 'exit') ||
                morphoIdleJoint ||
                morphoJoint ||
                morphoTimeSummary ? (
                'CONDITIONAL HOLDER OUTLOOK'
              ) : analogCash ? (
                'ANALOG CASH · CASH ONLY'
              ) : (
                'CONDITIONAL FLOW'
              )}
            </Text>
            {saturnForecast && (
              <Tooltip label="Exact-size historical quote changes continue at a constant rate. Future inventory, price, ticket release and additional competition remain unknown; this is not an executable payout forecast.">
                <Text {...labelStyle} mt={SPACING.xs}>
                  {saturnForecast.holderEntitlementEstablished ? 'Whole ticket' : 'Public amount'}
                  {' · '}{formatExitPressureRaw(saturnForecast.conversionInputUsdatRaw, 6)} USDat
                  {' · B '}{saturnForecast.funding.source.blockNumber}
                </Text>
              </Tooltip>
            )}
            <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.base} mt={SPACING.sm}>
              {susdeTime?.pending.funding?.targetSummary && (
                <Metric
                  label="Existing queue · whole claim"
                  value={`${formatExitPressureSignedRaw(susdeTime.pending.funding.targetSummary.empiricalP10HeadroomRaw, 18)}–${formatExitPressureSignedRaw(susdeTime.pending.funding.targetSummary.empiricalP90HeadroomRaw, 18)} USDe`}
                  warning={susdeTime.pending.funding.targetSummary.minimumHeadroomRaw.startsWith(
                    '-',
                  )}
                  detail={`${susdeTime.pending.eligibleAtTarget ? 'ELIGIBLE BY TARGET' : 'COOLDOWN BEYOND TARGET'}${susdeFundingDetail(susdeTime.pending.funding)}`}
                />
              )}
              {susdeTime?.newCooldown?.funding.targetSummary && (
                <Metric
                  label="New cooldown · whole claim"
                  value={`${formatExitPressureSignedRaw(susdeTime.newCooldown.funding.targetSummary.empiricalP10HeadroomRaw, 18)}–${formatExitPressureSignedRaw(susdeTime.newCooldown.funding.targetSummary.empiricalP90HeadroomRaw, 18)} USDe`}
                  warning={susdeTime.newCooldown.funding.targetSummary.minimumHeadroomRaw.startsWith(
                    '-',
                  )}
                  detail={`IF STARTED ${utcMinute(susdeTime.input.current.source.blockTime)} → END ${utcMinute(susdeTime.newCooldown.eligibleAtUtc)} · ${susdeTime.newCooldown.eligibleAtTarget ? 'ELIGIBLE BY TARGET' : 'COOLDOWN BEYOND TARGET'}${susdeFundingDetail(susdeTime.newCooldown.funding)}`}
                />
              )}
              {historicalGrossFlow && historicalGrossFlowValues?.currentMargin && (
                <Metric
                  label="Starting headroom"
                  value={`${historicalGrossFlowValues.currentMargin} ${historicalGrossFlow.assetSymbol}`}
                  warning={historicalGrossFlow.currentMarginAfterQRaw.startsWith('-')}
                  detail={`SOURCE · ${utcMinute(historicalGrossFlow.startingAt)}`}
                />
              )}
              {isFluidUsdtBridgeJointSubject && scenarioMode === 'exit' ? (
                <>
                  <Metric
                    label={
                      <Text
                        as="span"
                        aria-label="Selected-horizon same-pool USDT quote-funding USDC margin"
                      >
                        Conditional quote-funding margin
                      </Text>
                    }
                    value={
                      fluidUsdtBridgeJointSummary
                        ? `${formatExitPressureSignedRaw(fluidUsdtBridgeJointSummary.marginBand.p10Raw, 6)}–${formatExitPressureSignedRaw(fluidUsdtBridgeJointSummary.marginBand.p90Raw, 6)} USDC`
                        : '—'
                    }
                    warning={
                      fluidUsdtBridgeJointSummary?.marginBand.minimumRaw.startsWith('-') ?? false
                    }
                    detail={
                      fluidUsdtBridgeJoint ? utcMinute(fluidUsdtBridgeJoint.targetAtUtc) : undefined
                    }
                  />
                  {fluidUsdtCashBoundaryValue && (
                    <Tooltip label="Conditional historical-flow paths reach a cash boundary between sampled checkpoints; this is not an observed depletion time or delivery qualification.">
                      <Box>
                        <Metric
                          label="Projected cash depletion"
                          value={fluidUsdtCashBoundaryValue}
                          warning
                        />
                      </Box>
                    </Tooltip>
                  )}
                </>
              ) : isApyUsdJointSubject && scenarioMode === 'exit' ? (
                <Metric
                  label={
                    <Text as="span" aria-label="Selected-horizon joint APY USD holder headroom">
                      Expected headroom
                    </Text>
                  }
                  value={
                    apyUsdJointSummary
                      ? `${formatExitPressureSignedRaw(apyUsdJointSummary.headroom.band.p10Raw, 18)}–${formatExitPressureSignedRaw(apyUsdJointSummary.headroom.band.p90Raw, 18)} apxUSD`
                      : '—'
                  }
                  warning={apyUsdJointSummary?.headroom.band.minRaw.startsWith('-') ?? false}
                  detail={
                    apyUsdJoint
                      ? `${utcMinute(apyUsdJoint.targetAtUtc)}${apyUsdJointSummary ? ` · MIN ${formatExitPressureSignedRaw(apyUsdJointSummary.headroom.band.minRaw, 18)} apxUSD` : ''}`
                      : undefined
                  }
                />
              ) : isUmbrellaGhoJointSubject && scenarioMode === 'exit' ? (
                <Metric
                  label={
                    <Text
                      as="span"
                      aria-label="Selected-horizon joint Umbrella GHO holder headroom"
                    >
                      Expected headroom
                    </Text>
                  }
                  value={
                    umbrellaGhoJointSummary
                      ? `${formatExitPressureSignedRaw(umbrellaGhoJointSummary.headroom.band.p10Raw, 18)}–${formatExitPressureSignedRaw(umbrellaGhoJointSummary.headroom.band.p90Raw, 18)} GHO`
                      : '—'
                  }
                  warning={umbrellaGhoJointSummary?.headroom.band.minRaw.startsWith('-') ?? false}
                  detail={umbrellaGhoJoint ? utcMinute(umbrellaGhoJoint.targetAtUtc) : undefined}
                />
              ) : isFluidUsdcBridgeJointSubject && scenarioMode === 'exit' ? (
                <Metric
                  label={
                    <Text
                      as="span"
                      aria-label="Selected-horizon joint Fluid USDC bridge holder headroom"
                    >
                      Expected headroom
                    </Text>
                  }
                  value={
                    fluidUsdcBridgeJointSummary
                      ? `${formatExitPressureSignedRaw(fluidUsdcBridgeJointSummary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(fluidUsdcBridgeJointSummary.empiricalP90HeadroomRaw, 6)} USDC`
                      : '—'
                  }
                  warning={fluidUsdcBridgeJointSummary?.minimumHeadroomRaw.startsWith('-') ?? false}
                  detail={
                    fluidUsdcBridgeJoint ? utcMinute(fluidUsdcBridgeJoint.targetAtUtc) : undefined
                  }
                />
              ) : initialSummary && initialProcess ? (
                <Metric
                  label={
                    <Tooltip
                      label={
                        initialDeposit?.process
                          ? initialDeposit.admission.status === 'blocked_under_reference_rules'
                            ? 'Counterfactual successful admission: source reserve flags block supply under the reference rules. Hypothetical source-indexed receipt; future execution is unverified.'
                            : 'If admitted at the original checked source. Joint historical net cash includes competition; the hypothetical receipt index and income stay fixed. Admission and future execution are unverified.'
                          : 'Aggregate cash after a hypothetical admitted deposit at the original checked source. Receipt entitlement is unassessed; this cash band does not establish holder exit capacity.'
                      }
                    >
                      <Text as="span" tabIndex={0} _focusVisible={FOCUS_STYLES.ring}>
                        {initialDeposit?.process
                          ? 'Projected exit headroom'
                          : 'Projected cash headroom'}
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(initialSummary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(initialSummary.empiricalP90HeadroomRaw, 6)} ${requestedAssetSymbol}`}
                  warning={initialSummary.minimumHeadroomRaw.startsWith('-')}
                  detail={`${initialProcess.targetAtUtc.slice(5, 19).replace('T', ' ')} UTC${cashHolderDurationDetail({ process: initialProcess })}`}
                />
              ) : isUsd3JointSubject && scenarioMode === 'exit' ? (
                <Metric
                  label={
                    <Text as="span" aria-label="Selected-horizon joint USD3 holder headroom">
                      Expected headroom
                    </Text>
                  }
                  value={
                    usd3JointSummary
                      ? `${formatExitPressureSignedRaw(usd3JointSummary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(usd3JointSummary.empiricalP90HeadroomRaw, 6)} USDC`
                      : '—'
                  }
                  warning={usd3JointSummary?.minimumHeadroomRaw.startsWith('-') ?? false}
                  detail={usd3Joint ? utcMinute(usd3Joint.targetAtUtc) : undefined}
                />
              ) : susdeTimeSummary && susdeTime ? (
                <Metric
                  label={
                    <Tooltip label="Conditional funding only. Full active entitlement excludes the existing queue; future execution and restrictions are unassessed.">
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Selected-horizon conditional sUSDe active funding headroom"
                      >
                        Active funding headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(susdeTimeSummary.empiricalP10HeadroomRaw, 18)}–${formatExitPressureSignedRaw(susdeTimeSummary.empiricalP90HeadroomRaw, 18)} USDe`}
                  warning={susdeTimeSummary.minimumHeadroomRaw.startsWith('-')}
                  detail={`${utcMinute(susdeTime.targetAtUtc)}${susdeFundingDetail(susdeTime.active.funding)}`}
                />
              ) : saturnForecast ? (
                <>
                  <Metric
                    label={saturnForecast.shrinking ? 'Projected AUSD · shrinking' : 'Projected AUSD'}
                    value={`${formatExitPressureRaw(saturnForecast.scenarios[0].quotedFinalAusdRaw, 6)} AUSD`}
                  />
                  <Metric
                    label="Headroom"
                    value={`${formatExitPressureSignedRaw(saturnForecast.scenarios[0].requestedHeadroomAusdRaw, 6)} AUSD`}
                    warning={saturnForecast.scenarios[0].requestedHeadroomAusdRaw.startsWith('-')}
                  />
                  <Metric
                    label="Adequate conversion window"
                    value={saturnConditionalQuoteWindowLabel(saturnForecast)}
                  />
                  <Metric
                    label={<Tooltip label="A successful current claim simulation is separate from physical pullable cash. Future ticket funding and delivery remain unknown."><Text as="span">Ticket funding</Text></Tooltip>}
                    value={saturnForecast.funding.particularTicket === 'simulated_current_claim' ? 'Claim simulated · future unknown' : 'Unknown'}
                  />
                </>
              ) : morphoIdlePanel ? (
                <>
                  <Metric
                    label="Projected exit capacity"
                    value={`${formatExitPressureRawRange(morphoIdlePanel.capacityInterval.lowerAvailableRaw, morphoIdlePanel.capacityInterval.upperAvailableRaw, morphoIdlePanel.question.requestedAssetDecimals)} PYUSD`}
                    warning={BigInt(morphoIdlePanel.capacityInterval.upperShortfallRaw) > 0n}
                    detail={utcMinute(morphoIdlePanel.targetAtUtc)}
                  />
                  <Metric
                    label="Headroom"
                    value={`${formatExitPressureRawRange(morphoIdlePanel.capacityInterval.lowerHeadroomRaw, morphoIdlePanel.capacityInterval.upperHeadroomRaw, morphoIdlePanel.question.requestedAssetDecimals)} PYUSD`}
                    warning={BigInt(morphoIdlePanel.capacityInterval.upperShortfallRaw) > 0n}
                  />
                  {BigInt(morphoIdlePanel.capacityInterval.upperShortfallRaw) > 0n && (
                    <Metric
                      label="Projected shortage"
                      value={`${formatExitPressureRawRange(morphoIdlePanel.capacityInterval.lowerShortfallRaw, morphoIdlePanel.capacityInterval.upperShortfallRaw, morphoIdlePanel.question.requestedAssetDecimals)} PYUSD`}
                      warning
                    />
                  )}
                  <Metric
                    label={<Tooltip label={`${morphoIdlePanel.sampledIntervalSummary.neverInsufficientScenarioCount}/${morphoIdlePanel.sampledIntervalSummary.relevantScenarioCount} no sampled shortage · ${morphoIdlePanel.sampledIntervalSummary.censoredScenarioCount + morphoIdlePanel.panelInspection.configurationCensoredPairs} censored · maximum sample gap ${Math.ceil(morphoIdlePanel.sampledIntervalSummary.maxCheckpointGapMs / 60000)}min · ${morphoIdlePanel.entitlementBasis}`}><Text as="span">Projected shortage onset</Text></Tooltip>}
                    value={morphoIdlePanelTimingValue(morphoIdlePanel)}
                    warning={morphoIdlePanel.sampledIntervalSummary.firstSampledPossibleInsufficiencyMs !== null}
                  />
                  <Metric
                    label={<Tooltip label={`Analytical modeled windows · upper-capacity shortage duration ${morphoIdlePanelDurationValue(morphoIdlePanel, 'definite')} · ${morphoIdlePanel.modeledShortageSummary.possible.neverShortageScenarioCount} no-shortage scenarios · ${morphoIdlePanel.modeledShortageSummary.possible.leftCensoredScenarioCount} open starts · ${morphoIdlePanel.modeledShortageSummary.possible.rightCensoredScenarioCount} open recoveries`}><Text as="span">Projected shortage duration</Text></Tooltip>}
                    value={morphoIdlePanelDurationValue(morphoIdlePanel)}
                    warning={morphoIdlePanel.sampledIntervalSummary.firstSampledPossibleInsufficiencyMs !== null}
                  />
                  {morphoIdlePanelChange && (
                    <Metric
                      label={<Tooltip label={`${morphoIdlePanelChange.shrinkingDonorCount}/${morphoIdlePanelChange.donorCount} donors may shrink`}><Text as="span">Capacity change</Text></Tooltip>}
                      value={`${formatExitPressureRawRange(morphoIdlePanelChange.lowerRaw, morphoIdlePanelChange.upperRaw, morphoIdlePanel.question.requestedAssetDecimals)} PYUSD`}
                      warning={morphoIdlePanelChange.shrinkingDonorCount > 0}
                      detail={morphoIdlePanelChange.shrinkingDonorCount > 0 ? 'May shrink' : undefined}
                    />
                  )}
                </>
              ) : morphoIdleNative && morphoIdleSummary ? (
                <>
                  <Metric
                    label="Projected exit capacity"
                    value={`${formatExitPressureRawRange(morphoIdleSummary.available.minimumRaw, morphoIdleSummary.available.maximumRaw, morphoIdleNative.process.identity.assetDecimals)} ${morphoIdleNative.process.identity.routeKey.split(' → ')[0]}`}
                    warning={BigInt(morphoIdleSummary.shortfall.maximumRaw) > 0n || morphoIdleShrinking}
                    detail={`${utcMinute(morphoIdleNative.targetAtUtc)}${morphoIdleShrinking ? ' · SHRINKING' : ''}`}
                  />
                  {morphoIdleAnalytical ? (
                    <>
                      <Metric
                        label="Modeled exit window"
                        value={morphoIdleAnalytical.conditionWindow}
                        detail="Capacity ≥ request · within horizon"
                        warning={morphoIdleAnalytical.episodes.length > 0}
                      />
                      {morphoIdleAnalytical.episodes.length === 0 ? (
                        <Metric label="Modeled shortage duration" value="No shortage within horizon" />
                      ) : morphoIdleAnalytical.episodes.map((episode, i) => (
                        <React.Fragment key={i}>
                          <Metric label={`Shortage ${i + 1} · onset bound`} value={episode.onset} warning />
                          <Metric label={`Shortage ${i + 1} · recovery bound`} value={episode.recovery} warning />
                          <Metric
                            label={`Shortage ${i + 1} · duration`}
                            value={episode.duration}
                            detail={episode.withinHorizon}
                            warning
                          />
                        </React.Fragment>
                      ))}
                    </>
                  ) : null}
                  {morphoIdleShortfall && (
                    <Metric label="Sampled capacity shortfall" value={morphoIdleShortfall} warning />
                  )}
                </>
              ) : morphoJoint ? (
                <Metric
                  label={
                    <Text as="span" aria-label="Selected-horizon joint Morpho holder headroom">
                      Expected headroom
                    </Text>
                  }
                  value={
                    morphoJointSummary
                      ? `${formatExitPressureSignedRaw(morphoJointSummary.empiricalMean.floorRaw, morphoJoint.assetDecimals)} ${morphoJointAssetSymbol}`
                      : '—'
                  }
                  warning={morphoJoint.process.scenarios.some(
                    (s) =>
                      s.status === 'usable' &&
                      BigInt(s.measurement.availableRaw) < BigInt(morphoJoint.requestedRaw),
                  )}
                  detail={morphoJointDetail(morphoJoint, morphoJoint.assetSymbol)}
                />
              ) : morphoTimeSummary && morphoTime ? (
                <Metric
                  label={
                    <Tooltip label="If observed idle and Blue cash changes continue, current adapter limits, borrowing rate and your full entitlement stay unchanged. Future transfers and implementation equivalence remain unverified. Sampled timing may miss changes.">
                      <Text
                        as="span"
                        cursor="help"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Selected-horizon conditional Morpho holder headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(morphoTimeSummary.empiricalP10HeadroomRaw, 6)}–${formatExitPressureSignedRaw(morphoTimeSummary.empiricalP90HeadroomRaw, 6)} USDC`}
                  warning={morphoTimeSummary.minimumHeadroomRaw.startsWith('-')}
                  detail={`${morphoTime.targetAtUtc.slice(5, 19).replace('T', ' ')} UTC${cashHolderDurationDetail(morphoTime)}`}
                />
              ) : cashTimeSummary && cashTime ? (
                <Metric
                  label={
                    <Tooltip label="If observed net cash changes continue at a constant rate and your entitlement and withdrawal rules stay unchanged. Sampled timing bounds may miss changes between observations.">
                      <Text
                        as="span"
                        cursor="help"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Selected-horizon conditional holder headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(cashTimeSummary.empiricalP10HeadroomRaw, requestedAssetDecimals!)}–${formatExitPressureSignedRaw(cashTimeSummary.empiricalP90HeadroomRaw, requestedAssetDecimals!)} ${requestedAssetSymbol}`}
                  warning={cashTimeSummary.minimumHeadroomRaw.startsWith('-')}
                  detail={`${cashTime.process.targetAtUtc.slice(5, 19).replace('T', ' ')} UTC${cashHolderDurationDetail(cashTime)}`}
                />
              ) : stusdsTimeSummary && stusdsTime ? (
                <Metric
                  label={
                    <Tooltip label="If observed net supply, debt and auction changes continue and current interest and withdrawal rules stay unchanged. Sampled timing bounds may miss changes between observations.">
                      <Text
                        as="span"
                        cursor="help"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Selected-horizon conditional StUSDS holder headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(stusdsTimeSummary.headroomLowerRaw, 18)}–${formatExitPressureSignedRaw(stusdsTimeSummary.headroomUpperRaw, 18)} USDS`}
                  warning={stusdsTimeSummary.headroomLowerRaw.startsWith('-')}
                  detail={`${stusdsTime.targetAtUtc.slice(5, 19).replace('T', ' ')} UTC${cashHolderDurationDetail({ process: stusdsTime.lower })}`}
                />
              ) : cometHorizon ? (
                <Metric
                  label={
                    <Tooltip
                      label={`If historical net liquidity changes repeat and your supplied balance, authority and withdrawal rules stay unchanged. Interest growth is not modeled. Pause ${cometHolder!.withdrawalsPaused === null ? 'unknown' : cometHolder!.withdrawalsPaused ? 'observed; held unchanged' : 'not observed; held unchanged'}. Implementation and future transfers unverified.`}
                    >
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Projected exit headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(cometHorizon.userHeadroom.p10Raw, 6)}–${formatExitPressureSignedRaw(cometHorizon.userHeadroom.p90Raw, 6)} USDC`}
                  warning={cometHorizon.userHeadroom.p10Raw.startsWith('-')}
                  detail={`${cometHorizon.target.earliestAt.slice(5, 19).replace('T', ' ')}–${cometHorizon.target.latestAt.slice(5, 19).replace('T', ' ')} UTC`}
                />
              ) : stusdsFuture ? (
                <Metric
                  label={
                    <Tooltip label="If observed supply, debt and auction changes repeat and interest and withdrawal rules stay unchanged. One saved interval; implementation and future eligibility unverified.">
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Projected exit headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(stusdsFuture.headroomLowerRaw[1], 18)}–${formatExitPressureSignedRaw(stusdsFuture.headroomUpperRaw[1], 18)} USDS`}
                  warning={stusdsFuture.headroomLowerRaw[1].startsWith('-')}
                  detail={`${stusdsFuture.targetAt.slice(5, 19).replace('T', ' ')} UTC`}
                />
              ) : susdsHorizon ? (
                <Metric
                  label={
                    <Tooltip label="If your own share-value changes repeat and holdings and redemption rules stay unchanged. 29 saved checkpoints; implementation and future withdrawal eligibility unverified.">
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label="Projected exit headroom"
                      >
                        Projected exit headroom
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(susdsHorizon.headroomLower.p10Raw, 18)}–${formatExitPressureSignedRaw(susdsHorizon.headroomUpper.p90Raw, 18)} USDS`}
                  warning={susdsHorizon.headroomLower.p10Raw.startsWith('-')}
                  detail={`${susdsHorizon.targetAt.slice(5, 19).replace('T', ' ')} UTC`}
                />
              ) : aaveSparkHorizon && selectedAaveSparkCapacity ? (
                <Metric
                  label={
                    <Tooltip
                      label={
                        aaveSparkHolder
                          ? 'If observed reserve changes repeat and your entitlement, permissions and withdrawal rules stay unchanged. Conditional holder estimate; future execution is unverified.'
                          : 'Conditional on the observed reserve changes repeating and withdrawal restrictions staying unchanged. Protocol liquidity after your amount; holder entitlement and execution are unverified.'
                      }
                    >
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label={
                          aaveSparkHolder
                            ? 'Projected exit headroom'
                            : 'Projected protocol headroom'
                        }
                      >
                        {aaveSparkHolder
                          ? 'Projected exit headroom'
                          : 'Projected protocol headroom'}
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(aaveSparkHorizon.requestedHeadroom.p10Raw, selectedAaveSparkCapacity.input.currentSource.assetDecimals)}${aaveSparkHorizon.scenarioCount > 1 ? `–${formatExitPressureSignedRaw(aaveSparkHorizon.requestedHeadroom.p90Raw, selectedAaveSparkCapacity.input.currentSource.assetDecimals)}` : ''} ${requestedAssetSymbol}`}
                  warning={aaveSparkHorizon.requestedHeadroom.p10Raw.startsWith('-')}
                  detail={`CONDITIONAL · ${aaveSparkHorizon.scenarioCount} scenario${aaveSparkHorizon.scenarioCount === 1 ? '' : 's'} · ${aaveSparkHorizon.target.earliestAt.slice(5, 19).replace('T', ' ')}${aaveSparkHorizon.target.latestAt !== aaveSparkHorizon.target.earliestAt ? `–${aaveSparkHorizon.target.latestAt.slice(5, 19).replace('T', ' ')}` : ''} UTC`}
                />
              ) : fluidProtocolHorizon && selectedFluidProtocol ? (
                <Metric
                  label={
                    <Tooltip
                      label={
                        fluidHolder
                          ? 'If observed liquidity and withdrawal-limit changes repeat and your entitlement, permissions and withdrawal rules stay unchanged. Conditional holder estimate; future execution is unverified.'
                          : 'If the observed liquidity and withdrawal-limit changes repeat. Rules and withdrawal restrictions may change.'
                      }
                    >
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label={
                          fluidHolder ? 'Projected exit headroom' : 'Projected protocol headroom'
                        }
                      >
                        {fluidHolder ? 'Projected exit headroom' : 'Projected protocol headroom'}
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(fluidProtocolHorizon.requestedHeadroom.p10Raw, selectedFluidProtocol.currentProngs.assetDecimals)}${fluidProtocolHorizon.episodeCount > 1 ? `–${formatExitPressureSignedRaw(fluidProtocolHorizon.requestedHeadroom.p90Raw, selectedFluidProtocol.currentProngs.assetDecimals)}` : ''} ${requestedAssetSymbol}`}
                  warning={fluidProtocolHorizon.requestedHeadroom.p10Raw.startsWith('-')}
                  detail={`CONDITIONAL · ${fluidProtocolHorizon.episodeCount} episode${fluidProtocolHorizon.episodeCount === 1 ? '' : 's'} · ${fluidProtocolHorizon.target.earliestAt.slice(5, 19).replace('T', ' ')}${fluidProtocolHorizon.target.latestAt !== fluidProtocolHorizon.target.earliestAt ? `–${fluidProtocolHorizon.target.latestAt.slice(5, 19).replace('T', ' ')}` : ''} UTC`}
                />
              ) : analogCash ? (
                <>
                  <Metric
                    label="Cash at target"
                    value={`${formatExitPressureRaw((BigInt(analogCash.targetCashHeadroomRange.minimumRaw) + BigInt(analogCash.input.requestedRaw)).toString(), requestedAssetDecimals!)}–${formatExitPressureRaw((BigInt(analogCash.targetCashHeadroomRange.maximumRaw) + BigInt(analogCash.input.requestedRaw)).toString(), requestedAssetDecimals!)} ${requestedAssetSymbol}`}
                    detail={`SCENARIO RANGE · ${analogCash.input.donors.length} donor${analogCash.input.donors.length === 1 ? '' : 's'}`}
                  />
                  <Metric
                    label="Cash headroom"
                    value={`${formatExitPressureSignedRaw(analogCash.targetCashHeadroomRange.minimumRaw, requestedAssetDecimals!)}–${formatExitPressureSignedRaw(analogCash.targetCashHeadroomRange.maximumRaw, requestedAssetDecimals!)} ${requestedAssetSymbol}`}
                    warning={analogCash.targetCashHeadroomRange.minimumRaw.startsWith('-')}
                    detail={`${utcMinute(analogCash.targetAtUtc)} · SAMPLED${cashHolderDurationDetail(
                      {
                        process: {
                          ...analogCash.scenarios[0].process,
                          scenarios: analogCash.scenarios.flatMap((s) => s.process.scenarios),
                        },
                      },
                    )}`}
                  />
                </>
              ) : projectedHeadroom ? (
                <Metric
                  label={
                    <Tooltip
                      label={
                        conditionalHolderHeadroom
                          ? 'Matching-source withdrawal simulated by two providers. Conditional on historical flows and unchanged holder balance, authority and mechanics; no future payout is guaranteed.'
                          : 'Conditional on historical flows repeating and mechanical conditions staying unchanged. Cash headroom only; holder execution is unverified.'
                      }
                    >
                      <Text as="span" tabIndex={0} _focusVisible={FOCUS_STYLES.ring}>
                        {conditionalHolderHeadroom
                          ? 'Projected exit headroom'
                          : 'Projected headroom'}
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(projectedHeadroom.userHeadroom.p10Raw, 6)}–${formatExitPressureSignedRaw(projectedHeadroom.userHeadroom.p90Raw, 6)} USDC`}
                  warning={projectedHeadroom.userHeadroom.p10Raw.startsWith('-')}
                  detail={`CONDITIONAL · P10–P90 · ${projectedHeadroom.target.earliestAt.slice(5, 19).replace('T', ' ')}–${projectedHeadroom.target.latestAt.slice(5, 19).replace('T', ' ')} UTC`}
                />
              ) : projectedCashHorizon && conditionalSampledHeadroom ? (
                <Metric
                  label={
                    <Tooltip
                      label={
                        usd3Holder
                          ? 'Conditional funding coverage from a constant historical net cash flow rate to the requested target, including source age, capped by independently agreed full-position entitlement. Owner maximum is only a source-time quote; future funding and withdrawal restrictions are censored. This does not establish complete holder ability or executable exit.'
                          : sghoHolder
                            ? 'Conditional on historical cash changes repeating and unchanged pause, eligibility and full-position share value. Each scenario is capped by independently agreed holder entitlement before your amount. This is not a future executable maximum.'
                            : holderSampledEligible
                              ? 'Matching-source full withdrawal simulated by two providers. Known mechanical eligibility covers both ends of this sampled time range, conditional on unchanged holder balance, authority and mechanics. Underlying balance proxy after your amount, not maximum withdrawal; a deficit does not establish future holder failure.'
                              : 'Sampled underlying balance after your amount, not maximum withdrawal. Conditional on historical cash changes repeating; this does not establish holder exit or failure.'
                      }
                    >
                      <Text
                        as="span"
                        tabIndex={0}
                        _focusVisible={FOCUS_STYLES.ring}
                        aria-label={
                          usd3Holder
                            ? 'Projected funding headroom'
                            : sghoHolder
                              ? 'Projected exit headroom'
                              : holderSampledEligible
                                ? 'Projected cash headroom, holder checked at source'
                                : undefined
                        }
                      >
                        {usd3Holder
                          ? 'Projected funding headroom'
                          : sghoHolder
                            ? 'Projected exit headroom'
                            : 'Projected cash headroom'}
                      </Text>
                    </Tooltip>
                  }
                  value={`${formatExitPressureSignedRaw(projectedCashHorizon.userHeadroom.p10Raw, conditionalSampledHeadroom.identity.assetDecimals)}–${formatExitPressureSignedRaw(projectedCashHorizon.userHeadroom.p90Raw, conditionalSampledHeadroom.identity.assetDecimals)} ${usd3Holder ? usd3Holder.assetSymbol : requestedAssetSymbol}`}
                  warning={projectedCashHorizon.userHeadroom.p10Raw.startsWith('-')}
                  detail={`CONDITIONAL · ${sghoHolder ? '' : 'P10–P90 · '}${projectedCashHorizon.target.earliestAt.slice(5, 19).replace('T', ' ')}–${projectedCashHorizon.target.latestAt.slice(5, 19).replace('T', ' ')} UTC`}
                />
              ) : null}
              {historicalGrossFlow && historicalGrossFlowValues?.currentMargin && competingFlow && (
                <Metric
                  label="Historical mean inflow / outflow"
                  value={`${flowMean(competingFlow.grossReplenishment.mean)} / ${flowMean(competingFlow.grossDepletion.mean)} USDC`}
                  detail={`OUT RANGE ${formatExitPressureRaw(competingFlow.grossDepletion.p10Raw, 6)}–${formatExitPressureRaw(competingFlow.grossDepletion.p90Raw, 6)} USDC · ${competingFlow.timeCoverage.durationSeconds ? `${Math.floor(competingFlow.timeCoverage.durationSeconds.lowerSeconds / 60)}–${Math.ceil(competingFlow.timeCoverage.durationSeconds.upperSeconds / 60)}min` : 'TIME UNKNOWN'} · ${competingFlow.windowCount} windows`}
                />
              )}
            </SimpleGrid>
            {historicalGrossFlow && historicalGrossFlowValues?.currentMargin && (
              <VStack align="stretch" spacing={SPACING.xs} mt={SPACING.sm}>
                {historicalGrossFlowValues.scenarios.map(
                  ({ label, window, inflow, outflow, troughMargin }) => (
                    <Box
                      key={`${label}-${window.originBlock}`}
                      borderTop="1px solid"
                      borderColor={SEMANTIC_COLORS.borderSubtle}
                      pt={SPACING.xs}
                    >
                      <Text {...labelStyle}>{label}</Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textPrimary}
                      >
                        IN {inflow} / OUT {outflow} · MARGIN AFTER Q {troughMargin}{' '}
                        {historicalGrossFlow.assetSymbol}
                      </Text>
                      {window.duration && (
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.xs}
                          color={SEMANTIC_COLORS.textSecondary}
                        >
                          {historicalDurationLabel(window.duration)} · END-OF-BLOCK
                        </Text>
                      )}
                    </Box>
                  ),
                )}
              </VStack>
            )}
          </Box>
        )}

        {historicalMarketGrossFlow && (
          <Box
            data-testid="exit-pressure-historical-market-gross-flow"
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.base}
          >
            <Text {...labelStyle}>
              RECORDED MARKET GROSS FLOW · +{horizonHours}H · RETROSPECTIVE
            </Text>
            <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.base} mt={SPACING.sm}>
              {historicalMarketDirectionMetric(
                historicalMarketGrossFlow.subject.inflow,
                'GROSS INFLOW COVERAGE',
                historicalMarketGrossFlow.coverage.corroboratedGrossInflowSubjects,
                historicalMarketGrossFlow.subject.assetDecimals,
                requestedAssetSymbol,
              )}
              {historicalMarketDirectionMetric(
                historicalMarketGrossFlow.subject.outflow,
                'GROSS OUTFLOW COVERAGE',
                historicalMarketGrossFlow.coverage.corroboratedGrossOutflowSubjects,
                historicalMarketGrossFlow.subject.assetDecimals,
                requestedAssetSymbol,
              )}
            </SimpleGrid>
            {historicalMarketGrossFlow.subject.morphoRecordedRange?.state ===
              'single_provider_recorded_range' && (
              <Box
                data-testid="exit-pressure-morpho-recorded-range"
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.base}
                mt={SPACING.base}
              >
                <Text {...labelStyle}>MORPHO VAULT · SINGLE-PROVIDER RECORDED RANGE</Text>
                <Text {...labelStyle} mt={SPACING.xs}>
                  RANGE TOTALS ONLY · EVENT TIMES UNRECORDED · HOLDER PAYOUT UNRECONCILED
                </Text>
                <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.base} mt={SPACING.sm}>
                  <Metric
                    label="Recorded deposits"
                    value={`${formatExitPressureRaw(historicalMarketGrossFlow.subject.morphoRecordedRange.grossDeposit.recordedTotalWithinCoverage.amountRaw, historicalMarketGrossFlow.subject.assetDecimals!)} ${requestedAssetSymbol}`}
                  />
                  <Metric
                    label="External-receiver withdrawals"
                    value={`${formatExitPressureRaw(historicalMarketGrossFlow.subject.morphoRecordedRange.grossExternalReceiverWithdraw.recordedTotalWithinCoverage.amountRaw, historicalMarketGrossFlow.subject.assetDecimals!)} ${requestedAssetSymbol}`}
                  />
                </SimpleGrid>
              </Box>
            )}
            {historicalMarketGrossFlow.subject.morphoRecordedRange?.state === 'unavailable' && (
              <Text {...labelStyle} mt={SPACING.sm}>
                MORPHO RECORDED RANGE UNAVAILABLE
              </Text>
            )}
            {historicalMarketGrossFlow.subject.secondaryRouteFlow?.state ===
              'single_provider_recorded_range' && (
              <Box
                data-testid="exit-pressure-secondary-route-flow"
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.base}
                mt={SPACING.base}
              >
                <Text {...labelStyle}>
                  {historicalMarketGrossFlow.subject.secondaryRouteFlow.venue} ROUTE FLOW ·
                  SINGLE-PROVIDER RECORDED RANGE
                </Text>
                <Text {...labelStyle} mt={SPACING.xs}>
                  OUTPUT-TOKEN UNITS · NOT HOLDER-ATTRIBUTED · SUBJECT UNDERLYING GROSS FLOW
                  UNMEASURED
                </Text>
                {historicalMarketGrossFlow.subject.secondaryRouteFlow.legs.map((leg) => (
                  <SimpleGrid
                    key={`${leg.outputAsset}:${leg.scope}`}
                    columns={{ base: 1, sm: 2 }}
                    spacing={SPACING.base}
                    mt={SPACING.sm}
                  >
                    <Metric
                      label={`${leg.scope.replaceAll('_', ' ')} · recorded exit direction`}
                      value={`${formatExitPressureRaw(leg.grossExit.recordedTotalWithinCoverage.amountRaw, leg.outputDecimals)} ${leg.outputSymbol}`}
                    />
                    <Metric
                      label={`${leg.scope.replaceAll('_', ' ')} · recorded entry direction`}
                      value={`${formatExitPressureRaw(leg.grossEntry.recordedTotalWithinCoverage.amountRaw, leg.outputDecimals)} ${leg.outputSymbol}`}
                    />
                  </SimpleGrid>
                ))}
              </Box>
            )}
            {historicalMarketGrossFlow.subject.secondaryRouteFlow?.state === 'unavailable' && (
              <Text {...labelStyle} mt={SPACING.sm}>
                SECONDARY ROUTE FLOW UNAVAILABLE
              </Text>
            )}
          </Box>
        )}

        {morphoPayout &&
          morphoPayout.receiptMatchedTransactions +
            morphoPayout.externalPayoutRows +
            morphoPayout.pendingTransactions +
            morphoPayout.ambiguousTransactions >
            0 && (
            <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.base}>
              <Text {...labelStyle}>OBSERVED VAULT PAYOUTS</Text>
              <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.base} mt={SPACING.sm}>
                <Metric label="Receipt matched" value={morphoPayout.receiptMatchedTransactions} />
                <Metric label="Payout rows" value={morphoPayout.externalPayoutRows} />
                <Metric label="Pending" value={morphoPayout.pendingTransactions} />
                <Metric label="Ambiguous" value={morphoPayout.ambiguousTransactions} />
              </SimpleGrid>
              <Text {...labelStyle} mt={SPACING.sm}>
                SOURCE COMPLETENESS UNPROVEN · SAME-HOLDER EXIT UNESTABLISHED · UNCALIBRATED
              </Text>
            </Box>
          )}

        {eventContext?.status === 'route_event_context' && (
          <Box
            data-testid="exit-pressure-context"
            borderTop="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pt={SPACING.base}
          >
            <Text {...labelStyle}>CONTEXT</Text>
            <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base} mt={SPACING.sm}>
              <Metric
                label="Event"
                value={
                  eventContext.event.status === 'observed'
                    ? eventContext.event.kind.replaceAll('_', ' ').toUpperCase()
                    : eventContext.event.status === 'none'
                      ? 'NONE'
                      : eventContext.event.status === 'not_recorded'
                        ? 'NOT RECORDED'
                        : 'SOURCE UNAVAILABLE'
                }
                detail={
                  eventContext.event.status === 'observed'
                    ? utcMinute(eventContext.event.at)
                    : undefined
                }
                warning={eventContext.event.status === 'source_unavailable'}
              />
              <Metric
                label="Protocol headlines"
                value={
                  eventContext.news.status === 'observed' ? (
                    <Link
                      href={eventContext.news.url}
                      isExternal
                      rel="noopener noreferrer"
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      {eventContext.news.title}
                    </Link>
                  ) : (
                    'SOURCE UNAVAILABLE'
                  )
                }
                detail={
                  eventContext.news.status === 'observed'
                    ? `${eventContext.news.coverage === 'latest_items_only' ? `LATEST ${eventContext.news.observedItemCount} · ` : ''}RAW GOOGLE NEWS · ${eventContext.news.source.toUpperCase()} · ${utcMinute(eventContext.news.observedAt)}`
                    : undefined
                }
                warning={eventContext.news.status === 'source_unavailable'}
              />
              <Metric
                label="Aggregate cash proxy"
                value={
                  eventContext.capacity.status === 'observed'
                    ? `${contextCapacityAmount(eventContext.capacity.beforeRaw, eventContext.capacity.assetDecimals, requestedAssetSymbol)} → ${contextCapacityAmount(eventContext.capacity.afterRaw, eventContext.capacity.assetDecimals, requestedAssetSymbol)}`
                    : eventContext.capacity.status === 'none'
                      ? 'NONE'
                      : 'SOURCE UNAVAILABLE'
                }
                detail={
                  eventContext.capacity.status === 'observed'
                    ? `Q / CASH PROXY ${eventContext.capacity.requestedShareBefore} → ${eventContext.capacity.requestedShareAfter} · CASH PROXY ${eventContext.capacity.direction.toUpperCase()} · NOT HOLDER EXIT · ${utcMinute(eventContext.capacity.afterAt)}`
                    : undefined
                }
                warning={
                  eventContext.capacity.status === 'source_unavailable' ||
                  (eventContext.capacity.status === 'observed' &&
                    eventContext.capacity.direction === 'shrinking')
                }
              />
            </SimpleGrid>
          </Box>
        )}

        {conditionalEventImpact && (
          <Box
            data-testid="exit-pressure-conditional-event-impact"
            pt={SPACING.sm}
            title="If historical adverse net flow continues."
          >
            <Metric
              label="Conditional cash impact"
              value={
                conditionalEventImpact.target.netImpactRange
                  ? `${formatExitPressureSignedRaw(conditionalEventImpact.target.netImpactRange.minimumRaw, currentCash!.assetDecimals)}–${formatExitPressureSignedRaw(conditionalEventImpact.target.netImpactRange.maximumRaw, currentCash!.assetDecimals)} ${currentCash!.assetSymbol}`
                  : 'CENSORED'
              }
              detail={`TARGET ${utcMinute(conditionalEventImpact.targetAtUtc)} · MIN CASH ${conditionalEventImpact.target.cashRange ? formatExitPressureRaw(conditionalEventImpact.target.cashRange.minimumRaw, currentCash!.assetDecimals) : 'CENSORED'} · CASH PROXY`}
              warning={!conditionalEventImpact.target.complete}
            />
          </Box>
        )}

        {historicalOutlook}

        {(hasCurrentProvenance || hasHistoricalProvenance) && (
          <Text
            data-testid="exit-pressure-provenance"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            letterSpacing="0.12em"
            color={SEMANTIC_COLORS.textTertiary}
          >
            PROVENANCE / {hasCurrentProvenance ? 'CURRENT FINALIZED' : ''}
            {hasCurrentProvenance && hasHistoricalProvenance ? ' + ' : ''}
            {hasHistoricalProvenance ? 'LOCAL HISTORY' : ''} · CLAIM /{' '}
            {hasCurrentProvenance && hasHistoricalProvenance
              ? 'CURRENT + RETROSPECTIVE'
              : hasHistoricalProvenance
                ? 'RETROSPECTIVE'
                : 'CURRENT'}
          </Text>
        )}
      </VStack>
    </Card>
  )
}

export default ExitPressureCard
