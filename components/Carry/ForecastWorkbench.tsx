import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Select,
  SimpleGrid,
  Text,
  VStack,
} from '@chakra-ui/react'
import NextLink from 'next/link'

import {
  ExitEvidenceAlert,
  type CurrentExitSample,
  type ExitEvidenceScope,
} from '@/components/Carry/ExitEvidenceAlert'
import {
  ExitPressureCard,
  selectHistoricalMarketGrossFlow,
  selectedSampledCashPaths,
  selectedConditionalHeadroomForCard,
  selectedProtocolCapacityForCard,
  selectedConditionalSampledHeadroomForCard,
  selectedSghoCashForCard,
  selectedSusdsCashForCard,
  selectedStusdsCashForCard,
  selectedCometCashForCard,
  issuedCashHolderTimeInputForCard,
  issuedUsd3HolderTimeInputForCard,
  selectedUsd3CashForCard,
  issuedStusdsTimeInputForCard,
  type HolderTimeProcessIssue,
  type ExitPressureUsd3JointIssue,
  type ExitPressureMorphoV2IdleJointIssue,
  type ExitPressureFluidUsdcBridgeJointIssue,
  type ExitPressureFluidUsdtBridgeJointIssue,
  type ExitPressureUmbrellaGhoJointIssue,
  type ExitPressureApyUsdJointIssue,
  type ExitPressureCurrentCash,
  type ExitPressureGrossDirection,
  type ExitPressureHistoricalGrossFlow,
  type ExitPressureHistoricalScenario,
  type ExitPressureMorphoPayout,
  type ExitPressureProspectiveCashModel,
  type ExitPressureLocalExactQEvidence,
  type HistoricalMarketGrossFlowResponse,
} from '@/components/Carry/ExitPressureCard'
import {
  HolderExitForceabilityGate,
  type ApyUsdOpenReceiptCurrent,
  type HolderExitForceabilityView,
} from '@/components/Carry/HolderExitForceabilityGate'
import {
  HolderExitHistoricalOutlook,
  historicalExitAssetSymbol,
} from '@/components/Carry/HolderExitHistoricalOutlook'
import { StakedUsdatQueuePressureCard } from '@/components/Carry/StakedUsdatQueuePressureCard'
import { Card } from '@/components/ui/Card'
import {
  fetchSusdeHolderForecastResponse,
  holderExitRequestCanPublish,
  susdeCoreAssessmentSource,
  susdeHolderForecastIssueFromResponse,
} from '@/lib/carry/susdeHolderForecastBinding'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { APXUSD_ASSET, APXUSD_RECEIPT, APYUSD_ROUTE, APYUSD_VAULT } from '@/lib/carry/apyUsdExit'
import { isApyUsdOpenReceiptBlockFreshAt } from '@/lib/carry/apyUsdOpenReceiptFreshness'
import {
  projectApyUsdNet,
  validApyUsdFeeCurve,
  type ApyUsdFeeCurve,
} from '@/lib/carry/apyUsdFeeOutlook'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import { initialDepositMarket } from '@/lib/carry/initialDepositCapacityProjection'
import {
  changeInitialDepositAmounts,
  initialDepositIssueFromResponse,
  initialDepositNativeRaw,
  initialDepositQuestion,
  type CarryScenarioMode,
  type InitialDepositQuestion,
  type InitialDepositScenarioIssue,
} from '@/components/Carry/initialDepositScenario'
import type { HistoricalSampledCashPathsResult } from '@/lib/carry/historicalSampledCashPaths'
import type { CarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import {
  isFreshHistoricalCashBlock,
  matchesPairedWindowDuration,
  type TranslatedPairedFlowWindow,
} from '@/lib/carry/historicalGrossFlowStress'
import {
  projectAggregateCashStress24h,
  type CarryCurrentReadStatus,
  type CarryHistoricalCashContext,
} from '@/lib/carry/historicalCashContext'
import {
  AUSD_ASSET,
  FLUID_USDT_ROUTE,
  USDT as FLUID_BRIDGE_PAYOUT_ASSET,
  USDE_ASSET,
  MAX_CURRENT_EXIT_BLOCK_AGE_MS,
  isCurrentHolderExitAssessment,
  resolveHolderExitSubject,
  type HolderExitAssessment,
} from '@/lib/carry/holderExitAssessment'
import {
  selectedHolderExitMechanicalOutlook,
  type HolderExitAssessmentView,
} from '@/lib/carry/holderExitMechanicalOutlookView'
import type { LocalHistoricalCashScenario } from '@/lib/carry/localHistoricalCashScenario'
import type { ExitImpactForecast } from '@/lib/forecast/exitImpactForecast'
import { resolveMorphoExitTarget } from '@/lib/carry/morphoExitQuote'
import {
  morphoV2HolderForecastIssueFromResponse,
  morphoV2ProtocolEvidenceFromResponse,
} from '@/lib/carry/morphoV2HolderForecastBinding'
import { morphoV2JointHolderForecastIssueFromResponse } from '@/lib/carry/morphoV2JointHolderForecastBinding'
import {
  morphoV2IdleJointHolderForecastFromResponse,
  morphoV2IdleJointHolderForecastIssue,
  selectedMorphoV2IdleJointHolderForecastFromIssue,
} from '@/lib/carry/morphoV2IdleJointHolderForecastBinding'
import {
  morphoV2IdleJointHolderForecastV2FromResponse,
  morphoV2IdleJointHolderForecastV2Issue,
  selectedMorphoV2IdleJointHolderForecastV2FromIssue,
} from '@/lib/carry/morphoV2IdlePanelHolderForecastBinding'
import { resolveMorphoV2IdleTrustedProfile } from '@/lib/carry/morphoV2IdleTrustedProfiles'
import { fluidUsdcBridgeJointHolderForecastIssueFromResponse } from '@/lib/carry/fluidUsdcBridgeJointHolderForecastBinding'
import { fluidUsdtBridgeJointHolderForecastIssueFromResponse } from '@/lib/carry/fluidUsdtBridgeJointHolderForecastBinding'
import { umbrellaGhoJointHolderForecastIssueFromResponse } from '@/lib/carry/umbrellaGhoJointHolderForecastBinding'
import { apyUsdJointHolderForecastIssueFromResponse } from '@/lib/carry/apyUsdJointHolderForecastBinding'
import { usd3JointHolderForecastIssueFromResponse } from '@/lib/carry/usd3JointHolderForecastBinding'
import {
  expectedRouteEventEnrollment,
  matchingRouteEventContext,
  type ExpectedRouteEventEnrollment,
  type RouteEventContextResponse,
  type RouteEventQuestion,
} from '@/lib/carry/routeEventContext'
import { resolveSusdeCooldownExitTarget } from '@/lib/carry/susdeCooldownExitQuote'
import {
  HASTRA_STAKING_VAULT,
  PYUSD_STAKING_ROUTE,
  PYUSD_TOKEN,
  USDC_TOKEN,
} from '@/lib/carry/pyusdStakingRouteIdentity'
import { resolveConditionalHolderSampledCashSubject } from '@/lib/carry/conditionalHolderSampledCashProjection'
import {
  conditionalEventImpactIssuedAt,
  conditionalEventImpactCurrentWitness,
  selectedConditionalEventImpact,
  type ConditionalEventImpact,
} from '@/lib/carry/conditionalEventImpact'
import { registeredConditionalSampledCashIdentity } from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  snapshotAnalogCashScenarioIssue,
  type AnalogCashScenarioIssue,
} from '@/lib/carry/analogCashScenarioPresentation'
import type { AnalogCashScenario } from '@/lib/carry/venueForecastAnalogPrior'
import type { forecastRouteCash } from '@/lib/carry/routeCashForecast'
import { SUSDS_VAULT, USDS_ASSET } from '@/lib/carry/susdsExitQuote'
import { USD3_VAULT } from '@/lib/carry/usd3ExitQuote'
import {
  STAKED_USDAT_IMPLEMENTATION,
  STAKED_USDAT_QUEUE,
  STAKED_USDAT_QUEUE_IMPLEMENTATION,
  STAKED_USDAT_ROUTE,
  STAKED_USDAT_VAULT,
  USDAT_ASSET,
} from '@/lib/carry/stakedUsdatExit'
import { TWYNE_PT_ASSET, TWYNE_PT_ROUTE, TWYNE_PT_WRAPPER } from '@/lib/carry/twynePtExit'
import {
  ORIGINAL_GHO,
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  VERIFIED_STKGHO_IMPLEMENTATION,
} from '@/lib/carry/umbrellaGhoExit'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import { saturnAppForecastFromResponse, saturnAppForecastIssue, type SaturnAppForecastIssue, type SaturnForecastQuestion } from '@/lib/carry/saturnAppForecastEvidence'

type VaultObservation = {
  vault: string
  asset: string
  vaultDecimals: number
  assetDecimals: number
  totalAssetsRaw?: string | null
  totalSupplyRaw: string
  cashRaw: string | null
  cashInterpretation?: 'wrapped_atoken_exit_cash_unassessed' | 'direct_buffer_only'
  firstLocalReceiptAt?: string
  routeAssetIdentity?:
    | 'confirmed'
    | 'factory_verified'
    | 'source_verified'
    | 'market_verified'
    | 'unverified'
  marketKind?: 'aave_v3_atoken' | 'compound_v3_comet' | 'spark_lend_atoken'
  exitMechanics?: 'async_queue' | 'cooldown_required' | 'unassessed'
  identityEvidenceUrl?: string
  source: 'finalized_erc4626' | 'finalized_direct_supply'
}

type RouteObservations = {
  routeKey: string
  status: 'observed' | 'unavailable'
  observedAt?: string
  firstLocalReceiptAt?: string
  block?: string | number
  blockHash?: string
  freshness?: 'fresh' | 'stale'
  caveat?: string
  destinations: VaultObservation[]
  forecastValidation: 'not_validated'
  exitProjectionStatus: 'unavailable'
  durationProjectionStatus: 'unavailable'
}

type HistoricalGrossFlowStress = {
  status: 'historical_flow_stress'
  chainId: number
  marketKey: string
  routeKey: string
  destination: string
  requestedRaw: string
  asset: string
  assetDecimals: number
  archiveVerification: 'full_sealed_replay'
  archiveArtifactSha256: string
  currentCash: {
    cashRaw: string
    blockNumber: number
    blockHash: string
    blockTimestamp: string
    rpcHostAgreement: 'multi_rpc_host_match'
  }
  stress: {
    source: { fromBlock: number; toBlock: number; joinContentSha256?: string }
    horizonBlocks: number
    nonoverlappingWindowCount: number
    currentCashMarginToRequestedRaw: string
    grossReserveInRaw: { upper: string }
    grossReserveOutRaw: { upper: string }
    troughMarginToRequestedRaw: { lower: string }
    pairedWindowSha256: string
    historicalScenarios: {
      selection: 'retrospective_observed_rank_not_forecast_probability'
      horizonBlocks: number
      sampleCount: number
      p10Trough: TranslatedPairedFlowWindow
      worstTrough: TranslatedPairedFlowWindow
      highestGrossOutflow: TranslatedPairedFlowWindow
    }
    exactWindowExtrema: {
      maxGrossReserveOutRaw: string
      maxGrossReserveInRaw: string
      minTroughMarginToRequestedRaw: string
      maxTroughReplayDeficitRaw: string
    }
    validation: 'not_validated'
    holderExecutableExit: false
  }
}

function validHistoricalFlowWindow(
  window: TranslatedPairedFlowWindow,
  sampleCount: number,
  horizonBlocks: number,
  source: { fromBlock: number; toBlock: number; joinContentSha256?: string },
  currentCashRaw: string,
  requestedRaw: string,
) {
  const raw = /^(0|[1-9][0-9]*)$/
  const signed = /^-?(0|[1-9][0-9]*)$/
  if (
    !Number.isSafeInteger(window.rank) ||
    window.rank < 1 ||
    window.rank > sampleCount ||
    window.sampleCount !== sampleCount ||
    !Number.isSafeInteger(window.originBlock) ||
    !Number.isSafeInteger(window.targetBlock) ||
    !Number.isSafeInteger(window.troughBlock) ||
    window.targetBlock - window.originBlock !== horizonBlocks ||
    window.troughBlock < window.originBlock ||
    window.troughBlock > window.targetBlock ||
    window.originBlock < source.fromBlock ||
    window.targetBlock > source.toBlock ||
    ![
      window.sourceCashRaw,
      window.targetCashRaw,
      window.grossReserveInRaw,
      window.grossReserveOutRaw,
      window.troughCashRaw,
      window.endpointCashRaw,
      window.troughCashRawReplayed,
      window.endpointDeficitAfterQRaw,
      window.troughDeficitAfterQRaw,
    ].every((value) => raw.test(value)) ||
    ![
      window.endpointCashDeltaRaw,
      window.troughCashDeltaRaw,
      window.endpointMarginAfterQRaw,
      window.troughMarginAfterQRaw,
    ].every((value) => signed.test(value))
  )
    return false
  const sourceCash = BigInt(window.sourceCashRaw)
  const targetCash = BigInt(window.targetCashRaw)
  const grossIn = BigInt(window.grossReserveInRaw)
  const grossOut = BigInt(window.grossReserveOutRaw)
  const endpointDelta = BigInt(window.endpointCashDeltaRaw)
  const troughCash = BigInt(window.troughCashRaw)
  const troughDelta = BigInt(window.troughCashDeltaRaw)
  const current = BigInt(currentCashRaw)
  const requested = BigInt(requestedRaw)
  const replayedEndpoint = current + endpointDelta > 0n ? current + endpointDelta : 0n
  const replayedTrough = current + troughDelta > 0n ? current + troughDelta : 0n
  return (
    matchesPairedWindowDuration(window, currentCashRaw, requestedRaw, source.joinContentSha256) &&
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

type DirectSupplierFlowContext = {
  status: 'observed'
  marketKey: string
  routeKey: string
  destination: string
  underlying: string
  underlyingDecimals: number
  coverage: { startMs: number; endMs: number; finalized: true; receiptsComplete: boolean }
  payoutCount: number
  unclassifiedWithdrawalCount: number
  grossCometWithdrawEvents?: { eventCount: number; amountRaw: string }
  max24hGrossCometWithdrawEvents?:
    | { status: 'observed'; amountRaw: string; eventCount: number; startMs: number; endMs: number }
    | { status: 'unavailable'; reason: string }
  sameAddressSettledCount: number
  largestSameAddressSinglePayoutRaw: string
  max24hGrossWithdrawal:
    | { status: 'observed'; amountRaw: string; startMs: number; endMs: number }
    | { status: 'unavailable'; reason: string }
  evidenceKind: 'sealed_public_receipt_replay'
  calibratedForecast: false
}

type DirectSupplierSupplyContext = {
  status: 'observed'
  marketKey: string
  routeKey: string
  destination: string
  underlying: string
  underlyingDecimals: number
  coverage: { startMs: number; endMs: number; finalized: true; receiptsComplete: true }
  supplyEventCount: number
  grossUnderlyingInflowRaw: string
  max24hGrossUnderlyingInflow:
    | { status: 'observed'; amountRaw: string; eventCount: number; startMs: number; endMs: number }
    | { status: 'unavailable'; reason: 'coverage_under_24h' }
  evidenceKind: 'sealed_public_receipt_replay'
  calibratedForecast: false
  interpretation: 'gross_underlying_inflow_not_net_replenishment_or_holder_exit'
}

type MorphoV2PayoutContext = {
  status: 'observed'
  routeKey: string
  destination: string
  sourceRangeCount: number
  latestCoveredBlock: string | null
  latestCoveredAt: string | null
  sourceCompleteness: 'not_independently_proven'
  candidateTransactions: number
  sealedTransactions: number
  receiptReconciledTransactions: number
  externalPayoutProofRows: number
  ambiguousTransactions: number
  pendingTransactions: number
  payoutMeaning: 'historical_external_receiver_transfer'
  sameHolderExit: 'not_established'
  calibratedForecast: false
}

export type RouteCashForecastView = {
  routeKey: string
  destination: string
  source: 'prospective_finalized_observations'
  forecast: ReturnType<typeof forecastRouteCash>
  sampledCashPaths?: HistoricalSampledCashPathsResult | null
  liveCurrentRead?: CarryCurrentReadStatus | null
  conditionalGrossFlowHeadroom?: unknown
  conditionalSampledCashPathProjection?: unknown
  conditionalEventImpact?: ConditionalEventImpact | null
  conditionalEventImpactCurrentSource?: ReturnType<typeof conditionalEventImpactCurrentWitness>
  analogCashScenario?: AnalogCashScenario | null
  initialDepositProjection?: unknown
  aaveSparkCapacityProjection?: unknown
  aaveSparkCapacitySource?: unknown
  fluidProtocolCapacityProjection?: unknown
  fluidProtocolCapacityProngs?: unknown
  localHistoricalScenario?:
    | LocalHistoricalCashScenario
    | {
        status: 'unavailable'
        reason:
          | 'untouched_interval_coverage_failed'
          | 'untouched_point_skill_failed'
          | 'ledger_unavailable'
          | 'not_24h_or_untracked'
      }
  exitImpact?: {
    historicalBacktest: ExitImpactForecast | null
    historicalBacktestUnavailableReason: string | null
    conditionalProjection: ExitImpactForecast | null
  }
  baselineEvidence:
    | {
        status: 'available'
        kind: 'prospective_aggregate_cash_persistence_baseline'
        attempts: {
          total: number
          issued: number
          sourceUnavailable: number
          sourceInvalid: number
          unassessed: number
        }
        outcomes: { observed: number; censoredMissing: number; pending: number }
      }
    | { status: 'not_enrolled'; enrolledHorizonsHours: [1, 24] }
    | { status: 'unavailable'; reason: 'ledger_unavailable' }
  prospectiveCashModel: ExitPressureProspectiveCashModel
  localCarryExitV2Evidence?: ExitPressureLocalExactQEvidence | null
  historicalModel?:
    | { status: 'unavailable'; reason: ModelEvidenceUnavailableReason }
    | {
        status: 'historical_projection'
        claim: 'aggregate_cash_proxy_only'
        modelKind: 'learned_delta' | 'persistence_band'
        prospectiveValidated: boolean
        holderExecutableExit: false
        projection: {
          issuedAt: string
          targetAt: string
          pointRaw: string
          bandLowRaw: string
          bandHighRaw: string
          assetDecimals: number
        }
        backtest: {
          fit: number
          calibration: number
          selection: number | null
          selectionCovered: number | null
          selectionCoveragePassed: boolean | null
          holdout: number
          holdoutCovered: number
          holdoutCoveragePassed: boolean
          holdoutPointBeatsPersistence: boolean | null
          holdoutModelMae: { numeratorRaw: string; denominator: number } | null
          holdoutPersistenceMae: { numeratorRaw: string; denominator: number } | null
        }
        prospective: { issued: number; observed: number; censoredMissing: number; pending: number }
      }
  twynePtReserveModel?:
    | {
        status: 'unavailable'
        reason: 'no_current_issue' | 'ledger_unavailable' | 'untouched_interval_coverage_failed'
      }
    | {
        status: 'historical_projection'
        metric: 'aave_pt_reserve_cash_raw'
        claim: 'shared_aave_pt_reserve_cash_only'
        prospectiveValidated: false
        holderExecutableExit: false
        projection: {
          issuedAt: string
          targetAt: string
          pointRaw: string
          bandLowRaw: string
          bandHighRaw: string
          assetDecimals: number
        }
        backtest: { fit: number; calibration: number; holdout: number; covered: number }
        prospective: { issued: number; observed: number; censoredMissing: number; pending: number }
      }
    | null
  validation: {
    holderExit: 'unavailable'
    conditionDuration: 'unavailable'
    predictiveAlert: 'unavailable'
  }
}

type ProjectionQualificationReason =
  | 'untouched_interval_coverage_failed'
  | 'untouched_point_skill_failed'

type ModelEvidenceUnavailableReason =
  | 'not_enrolled'
  | 'no_current_issue'
  | 'ledger_unavailable'
  | ProjectionQualificationReason

export type RouteForecastQuestion = {
  routeKey: string
  destination: string
  amountUnits: string
  horizonHours: 1 | 24 | 48 | 168 | 336 | 720
  payoutAsset: string | null
  payoutAssetDecimals?: number | null
}

type RouteForecastUnavailable = {
  status: 'unavailable'
  reason: string
  prospectiveCashModel: ExitPressureProspectiveCashModel
  localCarryExitV2Evidence?: ExitPressureLocalExactQEvidence | null
}
type RouteForecastArchiveResult = RouteCashForecastView | RouteForecastUnavailable
type RouteForecastFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>
type RouteEventContextFetch = RouteForecastFetch

type HolderExitEvidenceView = {
  status: 'available' | 'unavailable'
  routeKey: string
  destination: string
  calibratedForecast: false
  primeFirstStageEvidence?: {
    scope: 'prime_to_wylds_callable_only'
    finalPayoutAssessment: 'usdc_and_pyusd_unassessed'
    cells: Array<{
      horizonHours: number
      issued: number
      baselineCallable: number
      baselineImpaired: number
      measured: number
      callable: number
      nonCallable: number
      missedWindow: number
      pending: number
      outcomeMissing: number
    }>
  }
  fluidHolderEvidence?: {
    scope: 'local_public_same_holder_eth_calls'
    minedDelivery: 'not_measured_by_prospective_lane'
    cells: Array<{
      horizonHours: number
      distinctIssueEpisodes: number
      issuedCases: number
      baselineCallable: number
      measuredCases: number
      simulatedSuccess: number
      simulatedRevert: number
      holderIneligible: number
      entitlementUnassessed: number
      identityChanged: number
      pending: number
      censored: number
      outcomeMissing: number
    }>
  } | null
  receiptInitiationEvidence?: {
    scope: 'same_holder_withdraw_for_receipt_eth_call_only'
    finalPayoutAssessment: 'unmeasured_no_mined_receipt_in_study'
    cells: Array<{
      horizonHours: number
      issued: number
      baselineCallable: number
      initiationMeasured: number
      initiationSuccess: number
      initiationReverted: number
      outcomePending: number
      outcomeMissing: number
      outcomeCensored: number
    }>
  } | null
  queueRequestEvidence?: {
    scope: 'same_holder_queue_request_eth_call_only'
    sampling: 'stress_enriched_reverting_eoa_else_callable'
    cells: Array<{
      horizonHours: number
      issued: number
      baselineCallable: number
      baselineReverted: number
      onTimeStateScored: number
      requestCallMeasured: number
      stillCallable: number
      becameReverting: number
      simulatedCallRecovery: number
      stillReverting: number
      holderAttrition: number
      requestUnavailable: number
      regimeChangeCensored: number
      missed: number
      pending: number
    }>
  } | null
  cells: Array<{
    horizonHours: number
    issued: number
    baselineEligible: number
    baselineImpaired: number
    onTimeMeasured: number
    onTimeMeasuredSuccess: number
    onTimeMeasuredNonSuccess: number
    onTimeUnknownRevert: number
    onTimeHolderAttrition: number
    outcomeUnavailable: number
    outcomeMissing: number
    outcomePending: number
    impairedSimulatedRecovery: number
    impairedStillReverting: number
    impairedHolderAttrition: number
    impairedInconclusiveRevert: number
    impairedOutcomePending: number
    impairedOutcomeMissing: number
    impairedOutcomeUnavailable: number
  }>
}

type LiveExitState =
  | { status: 'idle' | 'loading' }
  | { status: 'error' }
  | {
      status: 'assessment_result'
      assessment: HolderExitAssessmentView
      sample: CurrentExitSample | null
    }
  | {
      status: 'twyne_pt_unsupported'
      reason: 'deployment_unattested' | 'identity_changed'
      blockNumber: number
    }
  | {
      status: 'twyne_pt_result'
      blockTime: string
      blockNumber: number
      simulation: 'success' | 'evm_revert' | 'position_insufficient'
      sharesBurnedRaw: string | null
      redeemedPtRaw: string | null
      redeemBelowRequested: boolean
      ptExpiry: number
    }
  | {
      status: 'staked_usdat_result'
      blockTime: string
      blockNumber: number
      request: 'success' | 'evm_revert' | 'not_attempted'
      vaultPaused: boolean
      queuePaused: boolean
      previewUsdatRaw: string | null
      claim: 'success' | 'evm_revert' | 'not_holder' | 'not_found' | null
      claimUsdatRaw: string | null
      requestTokenId: string | null
      requestedLimit: null | {
        minSharePriceRaw: string
        currentNetSharePriceRaw: string | null
        comparison: 'above_current_quote' | 'at_or_below_current_quote' | 'quote_unavailable'
        limitUpdateSimulation: 'success' | 'evm_revert'
      }
    }
  | {
      status: 'apyusd_result'
      blockTime: string
      blockNumber: number
      initiation: 'success' | 'evm_revert'
      ifInitiatedAtCheckedBlockClaimableAt: number | null
      ifInitiatedAtCheckedBlockEarliestNetRaw: string | null
      ifInitiatedAtCheckedBlockMinimumFeeAt: number | null
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: string | null
    }
  | {
      status: 'umbrella_result'
      blockTime: string
      blockNumber: number
      gate:
        | 'no_shares'
        | 'cooldown_not_started'
        | 'waiting'
        | 'window_expired'
        | 'paused'
        | 'amount_exceeds_window'
        | 'window_open'
      cooldownEnd: number | null
      windowEndInclusive: number | null
      simulation: 'success' | 'evm_revert' | 'not_attempted'
      slashExposure: 'slashable_assets_present' | 'no_slashable_assets'
    }
  | {
      status: 'cooldown_result'
      blockTime: string
      blockNumber: number
      pendingAssetsRaw: string
      cooldownEnd: string | null
      exitMode: 'cooldown' | 'direct_withdrawal'
      initiationStatus: 'success' | 'evm_revert' | 'not_applicable'
      directWithdrawalStatus: 'success' | 'evm_revert' | null
      claimStatus: 'success' | 'evm_revert' | 'not_yet_eligible' | 'no_pending_claim'
      cooldownDurationSeconds: number
      resetsPending: boolean
    }
  | {
      status: 'fluid_bridge_usdc_leg_result'
      blockTime: string
      blockNumber: number
      usdcAmount: string
      simulation: 'success' | 'evm_revert' | 'position_insufficient'
    }
  | {
      status: 'result'
      executable: boolean
      method: 'limit' | 'simulation' | 'pool_simulation' | 'holder_balance' | 'holder_shares'
      blockTime: string
      blockNumber: number
      sample: CurrentExitSample | null
    }

type HolderWatchStatus = {
  id: string
  state: 'absent' | 'queued' | 'issued' | 'retrying' | 'quarantined' | 'exhausted'
  horizons: Array<{
    horizonHours: 1 | 24
    state:
      | 'absent'
      | 'queued'
      | 'issued'
      | 'pending'
      | 'measured_success'
      | 'measured_failure'
      | 'censored'
      | 'retrying'
      | 'quarantined'
      | 'exhausted'
  }>
  forecastValidated: false
}

type HolderWatchView =
  | { status: 'idle' }
  | { status: 'loading'; scope: string }
  | {
      status: 'error'
      scope: string
      reason: 'unavailable' | 'rate_limited' | 'limit_reached'
    }
  | { status: 'result'; scope: string; value: HolderWatchStatus }

type LiveExitResponse = {
  status?: unknown
  source?: { chainId?: unknown; blockNumber?: unknown; blockHash?: unknown; blockTime?: unknown }
  vault?: {
    address?: unknown
    assetAddress?: unknown
    assetDecimals?: unknown
    implementationSourceAttested?: unknown
    cooldownDurationSeconds?: unknown
  }
  market?: {
    address?: unknown
    assetAddress?: unknown
    assetDecimals?: unknown
    identity?: unknown
  }
  position?: { effectiveExitGhoRaw?: unknown }
  routeKey?: unknown
  request?: { assetsRaw?: unknown; assetUnit?: unknown }
  simulation?: { status?: unknown }
  routeLeg?: {
    checked?: unknown
    usdcToUsdtConversion?: unknown
    usdtReceipt?: unknown
  }
  pending?: { assetsRaw?: unknown; cooldownEnd?: unknown }
  exitMode?: unknown
  initiation?: { status?: unknown }
  directWithdrawal?: { status?: unknown } | null
  claim?: { status?: unknown }
  newRequestWouldResetPending?: unknown
}

const SGHO_ROUTE = 'GHO → sGho [GHO]'
const AAVE_USDE_MARKET = DIRECT_SUPPLY_MARKETS.aaveV3Usde
const CANONICAL_SGHO_DECIMALS = 18
const SUSDS_ROUTE = 'USDS → SUsds [USDS]'
const SUSDE_ROUTE = 'USDe → Staked USDe [USDe]'
const USD3_ROUTE = 'USDC → USD3 [USDC]'
const AAVE_USDC_ROUTE = 'USDC → supply on Aave V3'
const DIRECT_MARKET_ROUTES = new Set([
  AAVE_USDC_ROUTE,
  AAVE_USDE_MARKET.routeKey,
  'USDC → supply on Compound v3',
  'USDT → supply on Spark',
])
const DIRECT_FLOW_MARKET_BY_ROUTE: Record<string, keyof typeof DIRECT_SUPPLY_MARKETS> = {
  [DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey]: 'aaveV3Usdc',
  [DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey]: 'aaveV3Usde',
  [DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey]: 'compoundV3Usdc',
  [DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey]: 'sparkLendUsdt',
}
const FLUID_LITE_USD_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012'
const FLUID_LITE_USD_ROUTES = new Set([
  'USDC → FluidBridgeAggregatorProxy [USDC]',
  'USDT → FluidBridgeAggregatorProxy [USDC]',
])
const AUSD_VAULT_V2_ROUTE = 'AUSD → VaultV2 [AUSD]'
const AUSD_VAULT_V2_DESTINATIONS = new Set([
  '0x32401b9fb79065bc15949de0bd43927492f02f0c',
  '0xbeeff0d672ab7f5018dfb614c93981045d4aa98a',
  '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589',
])
const TRACKED_DIRECT_VAULT_ROUTES: Record<
  string,
  { vault: string; asset: string; assetDecimals: number }
> = {
  'USDS → StUsds [USDS]': {
    vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    assetDecimals: 18,
  },
  'USDC → Fluid USD Coin [USDC]': {
    vault: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  },
  'USDT → fToken [USDT]': {
    vault: '0x5c20b550819128074fd538edf79791733ccedd18',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    assetDecimals: 6,
  },
  'GHO → fToken [GHO]': {
    vault: '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    assetDecimals: 18,
  },
  'USDC → FluidBridgeAggregatorProxy [USDC]': {
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  },
  'USDT → FluidBridgeAggregatorProxy [USDC]': {
    vault: FLUID_LITE_USD_VAULT,
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  },
}
const DEFAULT_EXIT_SIZE = '10000'

export function isTrackedDirectVaultExitRoute(
  routeKey: string,
  destination: string,
  observation:
    | Pick<VaultObservation, 'vault' | 'asset' | 'assetDecimals' | 'routeAssetIdentity'>
    | undefined,
): boolean {
  const tracked = TRACKED_DIRECT_VAULT_ROUTES[routeKey]
  return Boolean(
    tracked &&
    observation &&
    destination.toLowerCase() === tracked.vault &&
    observation.vault.toLowerCase() === tracked.vault &&
    observation.asset.toLowerCase() === tracked.asset &&
    observation.assetDecimals === tracked.assetDecimals &&
    ['confirmed', 'source_verified'].includes(observation.routeAssetIdentity ?? ''),
  )
}

export function isApyUsdCurrentExitRoute(
  routeKey: string,
  destination: string,
  selected: Pick<VaultObservation, 'vault' | 'asset' | 'assetDecimals' | 'source'> | undefined,
): boolean {
  return (
    routeKey === APYUSD_ROUTE &&
    destination.toLowerCase() === APYUSD_VAULT &&
    (!selected ||
      (selected.vault.toLowerCase() === APYUSD_VAULT &&
        selected.asset.toLowerCase() === APXUSD_ASSET &&
        selected.assetDecimals === 18 &&
        selected.source === 'finalized_erc4626'))
  )
}

function isApyUsdOpenReceiptCurrent(value: unknown): value is ApyUsdOpenReceiptCurrent {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<ApyUsdOpenReceiptCurrent>
  const block = result.block
  return (
    result.status === 'fresh' &&
    result.scope === 'historical_open_receipts' &&
    result.prospectiveQForecast === false &&
    !!block &&
    Number.isSafeInteger(block.number) &&
    block.number > 0 &&
    typeof block.hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(block.hash) &&
    Number.isSafeInteger(block.timestamp) &&
    block.timestamp > 0 &&
    isApyUsdOpenReceiptBlockFreshAt(block.timestamp, Date.now()) &&
    typeof result.observedAtUtc === 'string' &&
    Number.isFinite(Date.parse(result.observedAtUtc)) &&
    typeof result.openReceiptCount === 'number' &&
    Number.isSafeInteger(result.openReceiptCount) &&
    result.openReceiptCount >= 0 &&
    typeof result.noCurrentOwnerCount === 'number' &&
    Number.isSafeInteger(result.noCurrentOwnerCount) &&
    result.noCurrentOwnerCount >= 0 &&
    typeof result.holderChangedCount === 'number' &&
    Number.isSafeInteger(result.holderChangedCount) &&
    result.holderChangedCount >= 0 &&
    result.openReceiptCount + result.noCurrentOwnerCount + result.holderChangedCount === 7 &&
    typeof result.claimSimulationPassCount === 'number' &&
    Number.isSafeInteger(result.claimSimulationPassCount) &&
    result.claimSimulationPassCount >= 0 &&
    result.claimSimulationPassCount <= result.openReceiptCount &&
    typeof result.fullEscrowSimulationCount === 'number' &&
    Number.isSafeInteger(result.fullEscrowSimulationCount) &&
    result.fullEscrowSimulationCount >= 0 &&
    result.fullEscrowSimulationCount <= result.claimSimulationPassCount &&
    typeof result.noCodeHolderCount === 'number' &&
    Number.isSafeInteger(result.noCodeHolderCount) &&
    result.noCodeHolderCount >= 0 &&
    typeof result.delegatedEoaHolderCount === 'number' &&
    Number.isSafeInteger(result.delegatedEoaHolderCount) &&
    result.delegatedEoaHolderCount >= 0 &&
    typeof result.contractHolderCount === 'number' &&
    Number.isSafeInteger(result.contractHolderCount) &&
    result.contractHolderCount >= 0 &&
    result.noCodeHolderCount + result.delegatedEoaHolderCount + result.contractHolderCount ===
      result.openReceiptCount &&
    Array.isArray(result.sourceHosts) &&
    result.sourceHosts.length > 0 &&
    result.sourceHosts.every((host) => typeof host === 'string' && host.length > 0)
  )
}

export function isStakedUsdatCurrentExitRoute(
  routeKey: string,
  destination: string,
  selected: Pick<VaultObservation, 'vault' | 'asset' | 'assetDecimals'> | undefined,
): boolean {
  return (
    routeKey === STAKED_USDAT_ROUTE &&
    destination.toLowerCase() === STAKED_USDAT_VAULT &&
    (!selected ||
      (selected.vault.toLowerCase() === STAKED_USDAT_VAULT &&
        selected.asset.toLowerCase() === USDAT_ASSET &&
        selected.assetDecimals === 6))
  )
}

export function isTwynePtCurrentExitRoute(
  routeKey: string,
  destination: string,
  selected: Pick<VaultObservation, 'vault' | 'asset' | 'assetDecimals'> | undefined,
): boolean {
  return (
    routeKey === TWYNE_PT_ROUTE &&
    destination.toLowerCase() === TWYNE_PT_WRAPPER &&
    (!selected ||
      (selected.vault.toLowerCase() === TWYNE_PT_WRAPPER &&
        selected.asset.toLowerCase() === TWYNE_PT_ASSET &&
        selected.assetDecimals === 18))
  )
}

export function liveExitEndpoint(routeKey: string, isTrackedDirectVault: boolean): string {
  if (routeKey === SGHO_ROUTE) return '/api/carry/sgho-exit'
  if (routeKey === SUSDS_ROUTE) return '/api/carry/susds-exit'
  if (routeKey === SUSDE_ROUTE) return '/api/carry/susde-cooldown-exit'
  if (routeKey === UMBRELLA_GHO_ROUTE) return '/api/carry/umbrella-gho-exit'
  if (routeKey === APYUSD_ROUTE) return '/api/carry/apyusd-exit'
  if (routeKey === STAKED_USDAT_ROUTE) return '/api/carry/staked-usdat-exit'
  if (routeKey === TWYNE_PT_ROUTE) return '/api/carry/twyne-pt-exit'
  if (routeKey === USD3_ROUTE) return '/api/carry/usd3-exit'
  if (DIRECT_MARKET_ROUTES.has(routeKey)) return '/api/carry/direct-supply-exit'
  if (isTrackedDirectVault) return '/api/carry/tracked-direct-vault-exit'
  return '/api/carry/morpho-exit'
}

export function hasUnrepresentativeIdleCash(routeKey: string, destination: string): boolean {
  return (
    (FLUID_LITE_USD_ROUTES.has(routeKey) && destination.toLowerCase() === FLUID_LITE_USD_VAULT) ||
    (routeKey === AUSD_VAULT_V2_ROUTE &&
      AUSD_VAULT_V2_DESTINATIONS.has(destination.toLowerCase())) ||
    isPyusdStakingSubject(routeKey, destination)
  )
}

export function shouldShowHistoricalCashContext(routeKey: string, destination: string): boolean {
  return (
    !hasUnrepresentativeIdleCash(routeKey, destination) &&
    !isPyusdStakingSubject(routeKey, destination)
  )
}

export function isPyusdStakingSubject(routeKey: string, destination: string): boolean {
  return routeKey === PYUSD_STAKING_ROUTE && destination.toLowerCase() === HASTRA_STAKING_VAULT
}

type CurrentExitIdentity = Pick<
  VaultObservation,
  'vault' | 'asset' | 'assetDecimals' | 'routeAssetIdentity' | 'source' | 'marketKind'
>

export function isCanonicalFixedVaultExitObservation(
  routeKey: string,
  destination: string,
  selected: CurrentExitIdentity | undefined,
): boolean {
  let target =
    routeKey === SUSDS_ROUTE
      ? { vault: SUSDS_VAULT, asset: USDS_ASSET, decimals: 18 }
      : routeKey === USD3_ROUTE
        ? { vault: USD3_VAULT, asset: USDC_TOKEN, decimals: 6 }
        : null
  if (routeKey === SUSDE_ROUTE) {
    try {
      const resolved = resolveSusdeCooldownExitTarget(routeKey, destination as `0x${string}`)
      target = { vault: resolved.vault, asset: resolved.asset, decimals: resolved.decimals }
    } catch {
      return false
    }
  }
  return Boolean(
    target &&
    selected &&
    destination.toLowerCase() === target.vault.toLowerCase() &&
    selected.vault.toLowerCase() === target.vault.toLowerCase() &&
    selected.asset.toLowerCase() === target.asset.toLowerCase() &&
    selected.assetDecimals === target.decimals &&
    selected.source === 'finalized_erc4626' &&
    ['confirmed', 'source_verified'].includes(selected.routeAssetIdentity ?? ''),
  )
}

/** Canonical current checks may proceed during a missing snapshot, never past a conflicting one. */
export function canonicalCurrentExitDecimals(
  routeKey: string,
  destination: string,
  selected: CurrentExitIdentity | undefined,
  observationPresent: boolean,
  sghoLiveRoute: boolean,
): number | null {
  const isSgho =
    routeKey === SGHO_ROUTE &&
    sghoLiveRoute &&
    destination.toLowerCase() === GHO_SGHO.destination.toLowerCase()
  const isAaveUsde =
    routeKey === AAVE_USDE_MARKET.routeKey &&
    destination.toLowerCase() === AAVE_USDE_MARKET.destination.toLowerCase()
  if (!isSgho && !isAaveUsde) return null
  if (!selected)
    return observationPresent ? null : isSgho ? CANONICAL_SGHO_DECIMALS : AAVE_USDE_MARKET.decimals
  if (selected.vault.toLowerCase() !== destination.toLowerCase()) return null
  if (isSgho) {
    return selected.source === 'finalized_erc4626' &&
      ['confirmed', 'source_verified'].includes(selected.routeAssetIdentity ?? '') &&
      selected.asset.toLowerCase() === GHO_SGHO.borrowAsset.toLowerCase() &&
      selected.assetDecimals === CANONICAL_SGHO_DECIMALS
      ? CANONICAL_SGHO_DECIMALS
      : null
  }
  return selected.source === 'finalized_direct_supply' &&
    selected.marketKind === 'aave_v3_atoken' &&
    selected.routeAssetIdentity === 'market_verified' &&
    selected.asset.toLowerCase() === AAVE_USDE_MARKET.underlying.toLowerCase() &&
    selected.assetDecimals === AAVE_USDE_MARKET.decimals
    ? AAVE_USDE_MARKET.decimals
    : null
}

function formatRawUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return 'Unavailable'
  }
  const unit = 10n ** BigInt(decimals)
  const hundredths = (BigInt(raw) * 100n + unit / 2n) / unit
  const whole = (hundredths / 100n).toString()
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

function formatExactRawUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    return 'Unavailable'
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals || undefined).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, '') : ''
  return fraction ? `${whole}.${fraction}` : whole
}

function formatSignedRawUnits(raw: string, decimals: number): string {
  const negative = raw.startsWith('-')
  const amount = formatRawUnits(negative ? raw.slice(1) : raw, decimals)
  return amount === 'Unavailable' ? amount : `${negative ? '−' : '+'}${amount}`
}

function nonnegativeRawSum(left: string, right: string): string | null {
  if (!/^\d+$/.test(left) || !/^-?\d+$/.test(right)) return null
  const sum = BigInt(left) + BigInt(right)
  return (sum > 0n ? sum : 0n).toString()
}

function timestamp(value: string | undefined): string {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? 'Unavailable'
    : date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

export function isRecentExitCheck(blockTime: string, nowMs: number): boolean {
  const blockMs = Date.parse(blockTime)
  const ageMs = nowMs - blockMs
  return Number.isFinite(blockMs) && ageMs >= 0 && ageMs <= MAX_CURRENT_EXIT_BLOCK_AGE_MS
}

export function isMatchingDirectSupplierFlowContext(
  value: unknown,
  marketKey: keyof typeof DIRECT_SUPPLY_MARKETS,
  routeKey: string,
  destination: string,
): value is DirectSupplierFlowContext {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<DirectSupplierFlowContext>
  const market = DIRECT_SUPPLY_MARKETS[marketKey]
  const coverage = result.coverage
  const maximum = result.max24hGrossWithdrawal
  const cometMaximum = result.max24hGrossCometWithdrawEvents
  return (
    result.status === 'observed' &&
    result.marketKey === marketKey &&
    result.routeKey === routeKey &&
    routeKey === market.routeKey &&
    result.destination === destination.toLowerCase() &&
    result.destination === market.destination.toLowerCase() &&
    result.underlying === market.underlying.toLowerCase() &&
    result.underlyingDecimals === market.decimals &&
    result.evidenceKind === 'sealed_public_receipt_replay' &&
    result.calibratedForecast === false &&
    coverage?.finalized === true &&
    typeof coverage.receiptsComplete === 'boolean' &&
    Number.isSafeInteger(coverage.startMs) &&
    Number.isSafeInteger(coverage.endMs) &&
    (coverage.endMs ?? 0) > (coverage.startMs ?? 0) &&
    Number.isFinite(new Date(coverage.startMs ?? NaN).valueOf()) &&
    Number.isFinite(new Date(coverage.endMs ?? NaN).valueOf()) &&
    Number.isSafeInteger(result.payoutCount) &&
    (result.payoutCount ?? -1) >= 0 &&
    Number.isSafeInteger(result.unclassifiedWithdrawalCount) &&
    (result.unclassifiedWithdrawalCount ?? -1) >= 0 &&
    coverage.receiptsComplete === (result.unclassifiedWithdrawalCount === 0) &&
    (marketKey !== 'compoundV3Usdc' ||
      (Number.isSafeInteger(result.grossCometWithdrawEvents?.eventCount) &&
        result.grossCometWithdrawEvents?.eventCount ===
          (result.payoutCount ?? 0) + (result.unclassifiedWithdrawalCount ?? 0) &&
        /^\d+$/.test(result.grossCometWithdrawEvents?.amountRaw ?? '') &&
        ((cometMaximum?.status === 'unavailable' && typeof cometMaximum.reason === 'string') ||
          (cometMaximum?.status === 'observed' &&
            /^\d+$/.test(cometMaximum.amountRaw ?? '') &&
            Number.isSafeInteger(cometMaximum.startMs) &&
            Number.isSafeInteger(cometMaximum.endMs) &&
            (cometMaximum.startMs ?? -1) >= (coverage.startMs ?? 0) &&
            (cometMaximum.endMs ?? 0) <= (coverage.endMs ?? 0) &&
            (cometMaximum.endMs ?? 0) - (cometMaximum.startMs ?? 0) === 86_400_000)))) &&
    Number.isSafeInteger(result.sameAddressSettledCount) &&
    (result.sameAddressSettledCount ?? -1) >= 0 &&
    (result.sameAddressSettledCount ?? 0) <= (result.payoutCount ?? -1) &&
    /^\d+$/.test(result.largestSameAddressSinglePayoutRaw ?? '') &&
    ((maximum?.status === 'unavailable' && typeof maximum.reason === 'string') ||
      (maximum?.status === 'observed' &&
        /^\d+$/.test(maximum.amountRaw ?? '') &&
        Number.isSafeInteger(maximum.startMs) &&
        Number.isSafeInteger(maximum.endMs) &&
        (maximum.startMs ?? -1) >= (coverage.startMs ?? 0) &&
        (maximum.endMs ?? 0) <= (coverage.endMs ?? 0) &&
        (maximum.endMs ?? 0) - (maximum.startMs ?? 0) === 86_400_000))
  )
}

export function isMatchingDirectSupplierSupplyContext(
  value: unknown,
  marketKey: keyof typeof DIRECT_SUPPLY_MARKETS,
  routeKey: string,
  destination: string,
): value is DirectSupplierSupplyContext {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<DirectSupplierSupplyContext>
  const market = DIRECT_SUPPLY_MARKETS[marketKey]
  const coverage = result.coverage
  const maximum = result.max24hGrossUnderlyingInflow
  const validMaximum =
    maximum?.status === 'observed'
      ? /^\d+$/.test(maximum.amountRaw) &&
        Number.isSafeInteger(maximum.eventCount) &&
        maximum.eventCount >= 0 &&
        Number.isSafeInteger(maximum.startMs) &&
        Number.isSafeInteger(maximum.endMs) &&
        maximum.startMs >= (coverage?.startMs ?? Infinity) &&
        maximum.endMs <= (coverage?.endMs ?? -Infinity) &&
        maximum.endMs - maximum.startMs === 86_400_000
      : maximum?.status === 'unavailable' &&
        maximum.reason === 'coverage_under_24h' &&
        (coverage?.endMs ?? Infinity) - (coverage?.startMs ?? -Infinity) < 86_400_000
  return (
    result.status === 'observed' &&
    result.marketKey === marketKey &&
    result.routeKey === routeKey &&
    routeKey === market.routeKey &&
    result.destination === destination.toLowerCase() &&
    result.destination === market.destination.toLowerCase() &&
    result.underlying === market.underlying.toLowerCase() &&
    result.underlyingDecimals === market.decimals &&
    coverage?.finalized === true &&
    coverage.receiptsComplete === true &&
    Number.isSafeInteger(coverage.startMs) &&
    Number.isSafeInteger(coverage.endMs) &&
    coverage.endMs > coverage.startMs &&
    Number.isSafeInteger(result.supplyEventCount) &&
    (result.supplyEventCount ?? -1) >= 0 &&
    /^\d+$/.test(result.grossUnderlyingInflowRaw ?? '') &&
    validMaximum &&
    result.evidenceKind === 'sealed_public_receipt_replay' &&
    result.interpretation === 'gross_underlying_inflow_not_net_replenishment_or_holder_exit' &&
    result.calibratedForecast === false
  )
}

export function isMatchingMorphoV2PayoutContext(
  value: unknown,
  routeKey: string,
  destination: string,
): value is MorphoV2PayoutContext {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<MorphoV2PayoutContext>
  const counts = [
    result.sourceRangeCount,
    result.candidateTransactions,
    result.sealedTransactions,
    result.receiptReconciledTransactions,
    result.externalPayoutProofRows,
    result.ambiguousTransactions,
    result.pendingTransactions,
  ]
  return (
    result.status === 'observed' &&
    result.routeKey === routeKey &&
    result.destination === destination.toLowerCase() &&
    result.sourceCompleteness === 'not_independently_proven' &&
    result.payoutMeaning === 'historical_external_receiver_transfer' &&
    result.sameHolderExit === 'not_established' &&
    result.calibratedForecast === false &&
    counts.every((count) => Number.isSafeInteger(count) && (count ?? -1) >= 0) &&
    (result.sourceRangeCount === 0 ||
      (/^[1-9][0-9]*$/.test(result.latestCoveredBlock ?? '') &&
        Number.isFinite(Date.parse(result.latestCoveredAt ?? '')))) &&
    result.sealedTransactions ===
      (result.receiptReconciledTransactions ?? -1) + (result.ambiguousTransactions ?? -1) &&
    result.candidateTransactions ===
      (result.sealedTransactions ?? -1) + (result.pendingTransactions ?? -1) &&
    (result.externalPayoutProofRows ?? -1) >= (result.receiptReconciledTransactions ?? 0)
  )
}

function formatUnits(value: number): string {
  if (value > 0 && value < 0.01) return '<0.01'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

function readableReason(reason: string | null): string {
  return reason ? reason.replace(/_/g, ' ') : 'unavailable'
}

const labelStyle = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

export function rawExitAmount(units: string, decimals: number): string | null {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(units) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  )
    return null
  const [whole, fraction = ''] = units.split('.')
  if (fraction.length > decimals) return null
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  return raw > 0n && raw < 1n << 256n ? raw.toString() : null
}

/** AUSD payout units and independent sUSDat vault shares have different decimals. */
export function stakedUsdatExitAmounts(payoutUnits: string, shareUnits: string) {
  return {
    assetsRaw: rawExitAmount(payoutUnits, 6),
    sharesRaw: rawExitAmount(shareUnits, 18),
  }
}

type HistoricalAssayQuestion =
  | {
      status: 'ready'
      amountUnits: string
      requestedRaw: string
      asset: string
      assetDecimals: number
      assetSymbol: string
    }
  | {
      status: 'abstain'
      reason:
        | 'stage_units_differ'
        | 'assay_not_user_amount'
        | 'asset_identity_unverified'
        | 'amount_invalid'
    }

export function historicalAssayQuestion(input: {
  routeKey: string
  exitSize: string
  exitAssetSymbol: string
  exitAssetDecimals: number | null
  selectedAsset: string | null
  selectedAssetDecimals: number | null
  payoutAsset: string | null
  fluidBridgeUsdcLegSize: string
  verifiedFluidBridgeUsdcLeg: boolean
}): HistoricalAssayQuestion {
  // The recorded first-leg question is explicitly USDC, independent of the USDT payout Q.
  if (input.routeKey === FLUID_USDT_ROUTE) {
    if (
      !input.verifiedFluidBridgeUsdcLeg ||
      input.selectedAsset?.toLowerCase() !== USDC_TOKEN.toLowerCase() ||
      input.payoutAsset?.toLowerCase() !== FLUID_BRIDGE_PAYOUT_ASSET.toLowerCase() ||
      input.selectedAssetDecimals !== 6
    )
      return { status: 'abstain', reason: 'asset_identity_unverified' }
    const requestedRaw = rawExitAmount(input.fluidBridgeUsdcLegSize, 6)
    return requestedRaw
      ? {
          status: 'ready',
          amountUnits: input.fluidBridgeUsdcLegSize,
          requestedRaw,
          asset: USDC_TOKEN.toLowerCase(),
          assetDecimals: 6,
          assetSymbol: 'USDC',
        }
      : { status: 'abstain', reason: 'amount_invalid' }
  }

  // These assays record share/PT stage units rather than the payout asset in Exit size.
  if (
    input.routeKey === STAKED_USDAT_ROUTE ||
    input.routeKey === PYUSD_STAKING_ROUTE ||
    input.routeKey === TWYNE_PT_ROUTE ||
    input.routeKey === UMBRELLA_GHO_ROUTE
  )
    return { status: 'abstain', reason: 'stage_units_differ' }
  if (input.routeKey === SUSDE_ROUTE) return { status: 'abstain', reason: 'assay_not_user_amount' }

  const assayedSymbol = historicalExitAssetSymbol(input.routeKey)
  if (
    !assayedSymbol ||
    input.exitAssetSymbol !== assayedSymbol ||
    !input.selectedAsset ||
    !input.payoutAsset ||
    input.selectedAsset?.toLowerCase() !== input.payoutAsset?.toLowerCase() ||
    input.selectedAssetDecimals !== input.exitAssetDecimals ||
    input.exitAssetDecimals === null
  )
    return { status: 'abstain', reason: 'asset_identity_unverified' }
  const requestedRaw = rawExitAmount(input.exitSize, input.exitAssetDecimals)
  return requestedRaw
    ? {
        status: 'ready',
        amountUnits: input.exitSize,
        requestedRaw,
        asset: input.selectedAsset!.toLowerCase(),
        assetDecimals: input.exitAssetDecimals,
        assetSymbol: assayedSymbol,
      }
    : { status: 'abstain', reason: 'amount_invalid' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactExitImpactQuestion(
  value: unknown,
  question: RouteForecastQuestion,
): value is ExitImpactForecast {
  if (question.horizonHours !== 1 && question.horizonHours !== 24) return false
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.question)) return false
  const assetDecimals = value.identity.assetDecimals
  const requestedRaw =
    typeof assetDecimals === 'number' ? rawExitAmount(question.amountUnits, assetDecimals) : null
  return Boolean(
    question.payoutAsset &&
    value.identity.routeKey === question.routeKey &&
    typeof value.identity.destination === 'string' &&
    value.identity.destination.toLowerCase() === question.destination.toLowerCase() &&
    typeof value.identity.asset === 'string' &&
    value.identity.asset.toLowerCase() === question.payoutAsset.toLowerCase() &&
    Number.isInteger(assetDecimals) &&
    requestedRaw &&
    value.question.requestedRaw === requestedRaw &&
    value.question.horizonHours === question.horizonHours &&
    value.claimClass === 'route_proxy' &&
    value.holderExecutableExit === false &&
    value.prospectiveValidated === false &&
    value.forecastValidated === false,
  )
}

type ProjectionQualificationFailure = ProjectionQualificationReason | 'ledger_unavailable'

function conditionalExitImpactQualificationFailure(
  value: unknown,
): ProjectionQualificationFailure | null {
  if (
    !isRecord(value) ||
    value.status !== 'research_projection' ||
    value.analysisKind !== 'conditional_live_projection' ||
    !isRecord(value.cashBand) ||
    value.cashBand.status !== 'available'
  )
    return 'ledger_unavailable'
  const band = value.cashBand
  const holdout = band.holdout
  if (!isRecord(holdout)) return 'ledger_unavailable'
  const recomputedCoveragePassed = Number(holdout.covered) * 100 >= Number(holdout.holdout) * 80
  if (
    !Number.isSafeInteger(holdout.holdout) ||
    Number(holdout.holdout) <= 0 ||
    !Number.isSafeInteger(holdout.covered) ||
    Number(holdout.covered) < 0 ||
    Number(holdout.covered) > Number(holdout.holdout) ||
    holdout.coveragePassed !== recomputedCoveragePassed ||
    !['learned_delta', 'persistence_band'].includes(String(band.method))
  )
    return 'ledger_unavailable'
  if (band.method === 'persistence_band') {
    if (
      holdout.pointBeatsPersistence !== null ||
      holdout.modelMae !== null ||
      holdout.persistenceMae !== null
    )
      return 'ledger_unavailable'
    return recomputedCoveragePassed ? null : 'untouched_interval_coverage_failed'
  }
  if (
    !isRecord(holdout.modelMae) ||
    !isRecord(holdout.persistenceMae) ||
    !/^(0|[1-9][0-9]*)$/.test(String(holdout.modelMae.numeratorRaw)) ||
    !/^(0|[1-9][0-9]*)$/.test(String(holdout.persistenceMae.numeratorRaw)) ||
    holdout.modelMae.denominator !== holdout.holdout ||
    holdout.persistenceMae.denominator !== holdout.holdout
  )
    return 'ledger_unavailable'
  const recomputedPointBeatsPersistence =
    BigInt(String(holdout.modelMae.numeratorRaw)) <
    BigInt(String(holdout.persistenceMae.numeratorRaw))
  if (holdout.pointBeatsPersistence !== recomputedPointBeatsPersistence) return 'ledger_unavailable'
  if (!recomputedCoveragePassed) return 'untouched_interval_coverage_failed'
  return recomputedPointBeatsPersistence ? null : 'untouched_point_skill_failed'
}

function qualifiedConditionalExitImpact(value: unknown): boolean {
  return conditionalExitImpactQualificationFailure(value) === null
}

function historicalModelQualificationFailure(
  value: unknown,
): ProjectionQualificationFailure | null {
  if (!isRecord(value) || value.status !== 'historical_projection' || !isRecord(value.backtest))
    return 'ledger_unavailable'
  const holdout = value.backtest
  const countsValid = Boolean(
    Number.isSafeInteger(holdout.holdout) &&
    Number(holdout.holdout) > 0 &&
    Number.isSafeInteger(holdout.holdoutCovered) &&
    Number(holdout.holdoutCovered) >= 0 &&
    Number(holdout.holdoutCovered) <= Number(holdout.holdout) &&
    holdout.holdoutCoveragePassed ===
      Number(holdout.holdoutCovered) * 100 >= Number(holdout.holdout) * 80,
  )
  if (!countsValid) return 'ledger_unavailable'
  if (value.modelKind === 'persistence_band') {
    if (
      holdout.holdoutPointBeatsPersistence !== null ||
      holdout.holdoutModelMae !== null ||
      holdout.holdoutPersistenceMae !== null
    )
      return 'ledger_unavailable'
    return holdout.holdoutCoveragePassed === true ? null : 'untouched_interval_coverage_failed'
  }
  if (
    value.modelKind !== 'learned_delta' ||
    typeof holdout.holdoutPointBeatsPersistence !== 'boolean' ||
    !isRecord(holdout.holdoutModelMae) ||
    !isRecord(holdout.holdoutPersistenceMae) ||
    !/^(0|[1-9][0-9]*)$/.test(String(holdout.holdoutModelMae.numeratorRaw)) ||
    !/^(0|[1-9][0-9]*)$/.test(String(holdout.holdoutPersistenceMae.numeratorRaw)) ||
    holdout.holdoutModelMae.denominator !== holdout.holdout ||
    holdout.holdoutPersistenceMae.denominator !== holdout.holdout
  )
    return 'ledger_unavailable'
  const recomputedPointBeatsPersistence =
    BigInt(String(holdout.holdoutModelMae.numeratorRaw)) <
    BigInt(String(holdout.holdoutPersistenceMae.numeratorRaw))
  if (holdout.holdoutPointBeatsPersistence !== recomputedPointBeatsPersistence)
    return 'ledger_unavailable'
  if (holdout.holdoutCoveragePassed !== true) return 'untouched_interval_coverage_failed'
  return recomputedPointBeatsPersistence ? null : 'untouched_point_skill_failed'
}

function twyneModelQualificationFailure(
  value: unknown,
): 'untouched_interval_coverage_failed' | 'ledger_unavailable' | null {
  if (!isRecord(value) || value.status !== 'historical_projection' || !isRecord(value.backtest))
    return 'ledger_unavailable'
  const holdout = value.backtest.holdout
  const covered = value.backtest.covered
  const countsValid = Boolean(
    Number.isSafeInteger(holdout) &&
    Number(holdout) > 0 &&
    Number.isSafeInteger(covered) &&
    Number(covered) >= 0 &&
    Number(covered) <= Number(holdout),
  )
  if (!countsValid) return 'ledger_unavailable'
  return Number(covered) * 100 >= Number(holdout) * 80 ? null : 'untouched_interval_coverage_failed'
}

function unavailableConditionalProjection(
  value: Record<string, unknown>,
  sourceReason: ProjectionQualificationFailure,
): ExitImpactForecast {
  const sanitized = { ...value }
  delete sanitized.reference
  delete sanitized.absoluteQBacktest
  delete sanitized.cashBand
  delete sanitized.alert
  return {
    ...sanitized,
    status: 'unavailable',
    analysisKind: 'conditional_live_projection',
    reason: 'source_unavailable',
    sourceReason,
  } as ExitImpactForecast
}

const PROSPECTIVE_RAW = /^(0|[1-9]\d*)$/
const PROSPECTIVE_ADDRESS = /^0x[0-9a-f]{40}$/
const MAX_UINT256 = (1n << 256n) - 1n
const PROSPECTIVE_HORIZON_MS = 24 * 60 * 60 * 1000

function invalidProspectiveCashModel(
  question: RouteForecastQuestion,
): ExitPressureProspectiveCashModel {
  return {
    status: 'unavailable',
    routeKey: question.routeKey,
    destination: question.destination.toLowerCase(),
    asset: question.payoutAsset?.toLowerCase() ?? null,
    horizonHours: question.horizonHours === 24 ? 24 : null,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: false,
    schedule: null,
    outcome: null,
    interval: null,
    source: null,
    latestActiveIssue: null,
    reason: 'invalid_response',
  }
}

function validProspectiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validProspectivePercent(value: unknown): value is number {
  return validProspectiveCount(value) && value <= 100
}

function exactPercent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.floor((numerator / denominator) * 100)
}

function validProspectiveRaw(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 78 &&
    PROSPECTIVE_RAW.test(value) &&
    BigInt(value) <= MAX_UINT256
  )
}

function validProspectiveUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return (
    Number.isSafeInteger(milliseconds) &&
    milliseconds >= 0 &&
    new Date(milliseconds).toISOString() === value
  )
}

function validProspectiveIssue(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.projection)) return false
  const clocks = [
    value.issuedAtUtc,
    value.sourceAtUtc,
    value.targetAtUtc,
    value.targetLowUtc,
    value.targetHighUtc,
    value.outcomeDueByUtc,
  ]
  if (!clocks.every(validProspectiveUtc)) return false
  const [issuedAt, sourceAt, targetAt, targetLow, targetHigh, outcomeDueBy] = clocks.map((clock) =>
    Date.parse(clock as string),
  )
  if (
    targetAt - sourceAt !== PROSPECTIVE_HORIZON_MS ||
    sourceAt > issuedAt ||
    issuedAt > targetLow ||
    targetLow > targetAt ||
    targetAt > targetHigh ||
    targetHigh > outcomeDueBy
  )
    return false

  const projection = value.projection
  if (
    ![projection.sourceCashRaw, projection.pointRaw, projection.lowRaw, projection.highRaw].every(
      validProspectiveRaw,
    ) ||
    BigInt(projection.lowRaw as string) > BigInt(projection.pointRaw as string) ||
    BigInt(projection.pointRaw as string) > BigInt(projection.highRaw as string)
  )
    return false

  const hasPersistence = Object.prototype.hasOwnProperty.call(projection, 'persistenceRaw')
  const baselineKeys = ['baselinePointRaw', 'baselineLowRaw', 'baselineHighRaw'] as const
  const hasBaseline = baselineKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(projection, key),
  )
  if (hasPersistence === hasBaseline) return false
  if (hasPersistence) {
    return (
      !baselineKeys.some((key) => Object.prototype.hasOwnProperty.call(projection, key)) &&
      validProspectiveRaw(projection.persistenceRaw) &&
      projection.persistenceRaw === projection.sourceCashRaw
    )
  }
  if (
    Object.prototype.hasOwnProperty.call(projection, 'persistenceRaw') ||
    !baselineKeys.every((key) => validProspectiveRaw(projection[key]))
  )
    return false
  return (
    projection.baselinePointRaw === projection.sourceCashRaw &&
    BigInt(projection.baselineLowRaw as string) <= BigInt(projection.baselinePointRaw as string) &&
    BigInt(projection.baselinePointRaw as string) <= BigInt(projection.baselineHighRaw as string)
  )
}

/**
 * Treat the API payload as untrusted. A malformed prospective field abstains
 * locally without discarding the independently useful route response.
 */
export function sanitizeProspectiveCashModel(
  value: unknown,
  question: RouteForecastQuestion,
): ExitPressureProspectiveCashModel {
  const unavailable = invalidProspectiveCashModel(question)
  const expectedDestination = question.destination.toLowerCase()
  const expectedAsset = question.payoutAsset?.toLowerCase() ?? null
  if (
    !isRecord(value) ||
    value.routeKey !== question.routeKey ||
    typeof value.destination !== 'string' ||
    value.destination.toLowerCase() !== expectedDestination ||
    (typeof value.asset === 'string' ? value.asset.toLowerCase() : value.asset) !== expectedAsset ||
    value.claim !== 'aggregate_cash_proxy_only' ||
    value.holderExecutableExit !== false
  )
    return unavailable

  if (value.status === 'unavailable') {
    const reasons = [
      'no_exact_model_match',
      'prospective_ledger_unavailable',
      'local_evidence_unavailable',
      'invalid_response',
    ]
    return value.horizonHours === (question.horizonHours === 24 ? 24 : null) &&
      value.prospectiveValidated === false &&
      value.schedule === null &&
      value.outcome === null &&
      value.interval === null &&
      value.source === null &&
      value.latestActiveIssue === null &&
      typeof value.reason === 'string' &&
      reasons.includes(value.reason)
      ? (value as ExitPressureProspectiveCashModel)
      : unavailable
  }

  if (
    (value.status !== 'collecting' && value.status !== 'validated') ||
    value.prospectiveValidated !== (value.status === 'validated') ||
    question.horizonHours !== 24 ||
    value.horizonHours !== 24 ||
    !expectedAsset ||
    !PROSPECTIVE_ADDRESS.test(expectedDestination) ||
    !PROSPECTIVE_ADDRESS.test(expectedAsset) ||
    !isRecord(value.schedule) ||
    !isRecord(value.outcome) ||
    !isRecord(value.interval) ||
    !isRecord(value.source)
  )
    return unavailable

  const schedule = value.schedule
  const outcome = value.outcome
  const interval = value.interval
  const source = value.source
  if (
    !validProspectiveCount(schedule.scheduled) ||
    !validProspectiveCount(schedule.onTime) ||
    !validProspectiveCount(schedule.missed) ||
    !validProspectivePercent(schedule.coveragePercent) ||
    !Number.isSafeInteger(schedule.onTime + schedule.missed) ||
    schedule.onTime + schedule.missed !== schedule.scheduled ||
    schedule.coveragePercent !== exactPercent(schedule.onTime, schedule.scheduled) ||
    (Object.prototype.hasOwnProperty.call(schedule, 'current') &&
      typeof schedule.current !== 'boolean') ||
    (value.status === 'validated' && schedule.current === false) ||
    !validProspectiveCount(outcome.issued) ||
    !validProspectiveCount(outcome.observed) ||
    !validProspectiveCount(outcome.censored) ||
    !validProspectiveCount(outcome.pending) ||
    !validProspectivePercent(outcome.availabilityPercent) ||
    !Number.isSafeInteger(outcome.observed + outcome.censored + outcome.pending) ||
    outcome.observed + outcome.censored + outcome.pending !== outcome.issued ||
    !validProspectiveCount(interval.observed) ||
    !validProspectiveCount(interval.covered) ||
    !validProspectiveCount(interval.missed) ||
    !validProspectivePercent(interval.coveragePercent) ||
    !Number.isSafeInteger(interval.covered + interval.missed) ||
    interval.covered + interval.missed !== interval.observed ||
    interval.coveragePercent !== exactPercent(interval.covered, interval.observed) ||
    !validProspectiveCount(source.opportunities) ||
    !validProspectiveCount(source.available) ||
    !validProspectiveCount(source.unavailable) ||
    !validProspectiveCount(source.ineligible) ||
    !validProspectiveCount(source.unassessed) ||
    !Number.isSafeInteger(
      source.available + source.unavailable + source.ineligible + source.unassessed,
    ) ||
    source.available + source.unavailable + source.ineligible + source.unassessed !==
      source.opportunities
  )
    return unavailable

  const assessedSources = source.available + source.unavailable
  if (
    (assessedSources === 0 && source.availabilityPercent !== null) ||
    (assessedSources > 0 &&
      (!validProspectivePercent(source.availabilityPercent) ||
        source.availabilityPercent !== exactPercent(source.available, assessedSources))) ||
    (value.latestActiveIssue !== null && !validProspectiveIssue(value.latestActiveIssue))
  )
    return unavailable
  return value as ExitPressureProspectiveCashModel
}

/** Keep only public local observations for this exact requested amount. */
export function sanitizeLocalCarryExitV2Evidence(
  value: unknown,
  question: RouteForecastQuestion,
): ExitPressureLocalExactQEvidence | null {
  if (
    !isRecord(value) ||
    value.routeKey !== question.routeKey ||
    value.destination !== question.destination.toLowerCase() ||
    value.asset !== question.payoutAsset?.toLowerCase() ||
    value.horizonH !== question.horizonHours ||
    value.claim !== 'local_exact_q_observation_only' ||
    value.provenance !== 'local_operator_clock' ||
    [
      'independentTimestamp',
      'independentWitness',
      'externalMonotonicCheckpoint',
      'rollbackProof',
      'minedPayoutProven',
      'prospectiveValidated',
      'forecastValidated',
      'holderExecutableExit',
      'calibratedForecast',
    ].some((key) => value[key] !== false)
  )
    return null
  const identity = {
    routeKey: question.routeKey,
    destination: question.destination.toLowerCase(),
    asset: question.payoutAsset?.toLowerCase() ?? null,
    decimals: value.decimals as number | null,
    assetsRaw: value.assetsRaw as string | null,
    horizonH: question.horizonHours,
    claim: 'local_exact_q_observation_only' as const,
    provenance: 'local_operator_clock' as const,
    independentTimestamp: false as const,
    independentWitness: false as const,
    externalMonotonicCheckpoint: false as const,
    rollbackProof: false as const,
    minedPayoutProven: false as const,
    prospectiveValidated: false as const,
    calibratedForecast: false as const,
    measurementValidatorId:
      value.status === 'collecting' ? 'carry-exit-v2-trusted-source-registry-v1' : null,
    forecastValidated: false as const,
    holderExecutableExit: false as const,
  }
  if (value.status === 'unavailable') {
    if (
      value.evidence !== null ||
      value.measurementValidatorId !== null ||
      !(
        value.decimals === null ||
        (Number.isInteger(value.decimals) &&
          Number(value.decimals) >= 0 &&
          Number(value.decimals) <= 36)
      ) ||
      !(
        value.assetsRaw === null ||
        (typeof value.assetsRaw === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(value.assetsRaw) &&
          value.assetsRaw.length <= 78)
      ) ||
      (question.payoutAssetDecimals != null &&
        value.decimals !== null &&
        value.decimals !== question.payoutAssetDecimals) ||
      (value.assetsRaw !== null &&
        value.assetsRaw !== rawExitAmount(question.amountUnits, Number(value.decimals))) ||
      (value.decimals === null && value.assetsRaw !== null)
    )
      return null
    return { ...identity, status: 'unavailable', evidence: null }
  }
  if (
    value.status !== 'collecting' ||
    !isRecord(value.evidence) ||
    typeof value.measurementValidatorId !== 'string' ||
    value.measurementValidatorId !== 'carry-exit-v2-trusted-source-registry-v1' ||
    !Number.isInteger(value.decimals) ||
    Number(value.decimals) < 0 ||
    Number(value.decimals) > 36 ||
    (question.payoutAssetDecimals != null && value.decimals !== question.payoutAssetDecimals) ||
    typeof value.assetsRaw !== 'string' ||
    value.assetsRaw.length > 78 ||
    value.assetsRaw !== rawExitAmount(question.amountUnits, Number(value.decimals))
  )
    return null
  const e = value.evidence
  const keys = [
    'issued',
    'pending',
    'recordedUnverified',
    'measured',
    'missing',
    'censored',
    'unavailable',
    'due',
    'localReadbacks',
  ] as const
  if (
    keys.some((key) => !validProspectiveCount(e[key])) ||
    Number(e.issued) < 1 ||
    Number(e.pending) +
      Number(e.recordedUnverified) +
      Number(e.measured) +
      Number(e.missing) +
      Number(e.censored) +
      Number(e.unavailable) !==
      e.issued ||
    Number(e.due) > Number(e.issued) ||
    Number(e.localReadbacks) > Number(e.issued) ||
    Number(e.measured) > Number(e.localReadbacks) ||
    !isRecord(e.latest)
  )
    return null
  const latest = e.latest
  const statuses = [
    'pending',
    'recorded_unverified',
    'measured',
    'missing',
    'censored',
    'unavailable',
  ]
  const statusCountKey =
    latest.status === 'recorded_unverified' ? 'recordedUnverified' : String(latest.status)
  if (
    !statuses.includes(String(latest.status)) ||
    Number(e[statusCountKey]) < 1 ||
    typeof latest.due !== 'boolean' ||
    typeof latest.localReadback !== 'boolean' ||
    (latest.due && Number(e.due) === 0) ||
    (latest.localReadback && Number(e.localReadbacks) === 0) ||
    ((latest.status === 'measured' || latest.status === 'recorded_unverified') &&
      latest.localReadback !== true) ||
    typeof latest.targetAtUtc !== 'string' ||
    typeof latest.deadlineAtUtc !== 'string' ||
    !Number.isFinite(Date.parse(latest.targetAtUtc)) ||
    !Number.isFinite(Date.parse(latest.deadlineAtUtc)) ||
    new Date(latest.targetAtUtc).toISOString() !== latest.targetAtUtc ||
    new Date(latest.deadlineAtUtc).toISOString() !== latest.deadlineAtUtc ||
    Date.parse(latest.deadlineAtUtc) < Date.parse(latest.targetAtUtc)
  )
    return null
  const counts = Object.fromEntries(keys.map((key) => [key, e[key]])) as Pick<
    NonNullable<ExitPressureLocalExactQEvidence['evidence']>,
    (typeof keys)[number]
  >
  return {
    ...identity,
    status: 'collecting',
    evidence: {
      ...counts,
      latest: {
        targetAtUtc: latest.targetAtUtc,
        deadlineAtUtc: latest.deadlineAtUtc,
        status: latest.status as NonNullable<
          ExitPressureLocalExactQEvidence['evidence']
        >['latest']['status'],
        due: latest.due,
        localReadback: latest.localReadback,
      },
    },
  }
}

/** Unsigned transport context, never a private holder forecast receipt. */
export function conditionalEventImpactFromForecastResponse(
  value: unknown,
  question: RouteForecastQuestion,
  receivedAtMs: number,
  currentWitness: unknown,
): ConditionalEventImpact | null {
  if (!isRecord(value)) return null
  const issuedAtUtc = conditionalEventImpactIssuedAt(value)
  const native = registeredConditionalSampledCashIdentity(question.routeKey, question.destination)
  const requestedRaw = native ? rawExitAmount(question.amountUnits, native.assetDecimals) : null
  if (
    !issuedAtUtc ||
    !native ||
    !requestedRaw ||
    question.payoutAsset?.toLowerCase() !== native.asset ||
    question.payoutAssetDecimals !== native.assetDecimals
  )
    return null
  const source = conditionalEventImpactCurrentWitness(currentWitness, receivedAtMs)
  if (!source) return null
  // Safe replay snapshots own data before reading any nested caller properties.
  const replay = selectedConditionalEventImpact(
    value,
    {
      ...native,
      requestedRaw,
      horizonHours: question.horizonHours,
      issuedAtUtc,
    },
    source,
    receivedAtMs,
  )
  return replay
}

/** Reject stale or cross-subject JSON before it reaches the selected route. */
export function matchingRouteForecastResponse(
  value: unknown,
  question: RouteForecastQuestion,
): RouteCashForecastView | null {
  if (!isRecord(value) || !isRecord(value.forecast)) return null
  if (
    value.routeKey !== question.routeKey ||
    typeof value.destination !== 'string' ||
    value.destination.toLowerCase() !== question.destination.toLowerCase() ||
    value.source !== 'prospective_finalized_observations' ||
    value.forecast.claim !== 'aggregate_cash_proxy_only' ||
    value.forecast.amountUnits !== Number(question.amountUnits) ||
    value.forecast.horizonHours !== question.horizonHours
  )
    return null

  const impact = isRecord(value.exitImpact) ? value.exitImpact : null
  const historical = impact?.historicalBacktest
  const conditional = impact?.conditionalProjection
  if (
    (historical !== null &&
      historical !== undefined &&
      !exactExitImpactQuestion(historical, question)) ||
    (conditional !== null &&
      conditional !== undefined &&
      !exactExitImpactQuestion(conditional, question))
  )
    return null
  const conditionalFailure =
    !isRecord(conditional) || conditional.status !== 'research_projection'
      ? null
      : conditionalExitImpactQualificationFailure(conditional)
  const historicalModelFailure =
    !isRecord(value.historicalModel) || value.historicalModel.status !== 'historical_projection'
      ? null
      : historicalModelQualificationFailure(value.historicalModel)
  const twyneModelFailure =
    !isRecord(value.twynePtReserveModel) ||
    value.twynePtReserveModel.status !== 'historical_projection'
      ? null
      : twyneModelQualificationFailure(value.twynePtReserveModel)
  const sampledInput = value.sampledCashPaths as HistoricalSampledCashPathsResult | null | undefined
  const sampled =
    sampledInput?.status === 'conditional_historical_sampled_cash_paths' ? sampledInput : null
  const sampledCashPaths = sampled
    ? selectedSampledCashPaths(
        sampled,
        {
          routeKey: question.routeKey,
          destination: question.destination,
          requestedRaw: Number.isInteger(sampled.identity?.assetDecimals)
            ? rawExitAmount(question.amountUnits, sampled.identity.assetDecimals)
            : null,
          requestedAssetAddress: question.payoutAsset,
          requestedAssetDecimals: question.payoutAssetDecimals ?? sampled.identity?.assetDecimals,
          horizonHours: question.horizonHours,
          asOfMs: Date.now(),
        },
        sampled.current
          ? {
              routeKey: sampled.identity?.routeKey,
              destination: sampled.identity?.destination,
              assetAddress: sampled.identity?.asset,
              assetDecimals: sampled.identity?.assetDecimals,
              assetSymbol: '',
              cashRaw: sampled.current.cashRaw,
              observedAt: sampled.current.blockAt,
              block: sampled.current.block,
              blockHash: sampled.current.blockHash,
              freshness: 'fresh',
              label: 'Market cash',
            }
          : null,
      )
    : sampledInput
  const sampledChanged = sampledCashPaths !== sampledInput
  const prospectiveCashModel = sanitizeProspectiveCashModel(value.prospectiveCashModel, question)
  const localCarryExitV2Evidence =
    value.localCarryExitV2Evidence === undefined
      ? undefined
      : sanitizeLocalCarryExitV2Evidence(value.localCarryExitV2Evidence, question)
  const localEvidenceChanged =
    JSON.stringify(localCarryExitV2Evidence) !== JSON.stringify(value.localCarryExitV2Evidence)
  const prospectiveModelChanged = prospectiveCashModel !== value.prospectiveCashModel
  const conditionalEventImpact =
    value.conditionalEventImpact === undefined
      ? undefined
      : conditionalEventImpactFromForecastResponse(
          value.conditionalEventImpact,
          question,
          Date.now(),
          value.conditionalEventImpactCurrentSource,
        )
  const conditionalEventImpactCurrentSource = conditionalEventImpact
    ? conditionalEventImpactCurrentWitness(value.conditionalEventImpactCurrentSource, Date.now())
    : null
  const eventImpactChanged =
    conditionalEventImpact !== value.conditionalEventImpact ||
    (value.conditionalEventImpactCurrentSource !== undefined &&
      conditionalEventImpactCurrentSource !== value.conditionalEventImpactCurrentSource)
  if (
    conditionalFailure === null &&
    historicalModelFailure === null &&
    twyneModelFailure === null &&
    !prospectiveModelChanged &&
    !sampledChanged &&
    !localEvidenceChanged &&
    !eventImpactChanged
  )
    return value as RouteCashForecastView
  return {
    ...(value as RouteCashForecastView),
    sampledCashPaths,
    prospectiveCashModel,
    ...(conditionalEventImpact === undefined ? {} : { conditionalEventImpact }),
    ...(value.conditionalEventImpactCurrentSource === undefined
      ? {}
      : { conditionalEventImpactCurrentSource }),
    ...(localCarryExitV2Evidence === undefined ? {} : { localCarryExitV2Evidence }),
    ...(conditionalFailure === null
      ? {}
      : {
          exitImpact: {
            ...(impact as Record<string, unknown>),
            conditionalProjection: unavailableConditionalProjection(
              conditional as Record<string, unknown>,
              conditionalFailure,
            ),
          } as RouteCashForecastView['exitImpact'],
        }),
    ...(historicalModelFailure === null
      ? {}
      : {
          historicalModel: {
            status: 'unavailable',
            reason: historicalModelFailure,
          } as const,
        }),
    ...(twyneModelFailure === null
      ? {}
      : {
          twynePtReserveModel: {
            status: 'unavailable',
            reason: twyneModelFailure,
          } as const,
        }),
  }
}

export function isLiveConditionalProjectionEligible(
  value: RouteCashForecastView,
  question: RouteForecastQuestion,
): boolean {
  if (
    !Number.isSafeInteger(question.horizonHours) ||
    question.horizonHours < 1 ||
    question.horizonHours > 8760
  )
    return false
  const native = registeredConditionalSampledCashIdentity(question.routeKey, question.destination)
  if (native)
    return Boolean(
      typeof question.payoutAsset === 'string' &&
      question.payoutAsset.toLowerCase() === native.asset &&
      question.payoutAssetDecimals === native.assetDecimals &&
      typeof question.amountUnits === 'string' &&
      rawExitAmount(question.amountUnits, native.assetDecimals) !== null,
    )
  if (question.horizonHours !== 24) return false
  const historical = value.exitImpact?.historicalBacktest
  return (
    historical?.status === 'historical_backtest' &&
    historical.analysisKind === 'retrospective_backtest' &&
    exactExitImpactQuestion(historical, question)
  )
}

/**
 * Delivers sealed history first, then asks for the bounded live-current
 * enrichment for supported native questions or exact H24 historical support.
 */
export async function loadRouteForecastWithLiveCurrent(
  question: RouteForecastQuestion,
  signal: AbortSignal,
  onArchive: (result: RouteForecastArchiveResult) => void,
  fetcher: RouteForecastFetch = fetch,
): Promise<RouteCashForecastView | null> {
  const query = new URLSearchParams({
    routeKey: question.routeKey,
    destination: question.destination,
    amountUnits: question.amountUnits,
    horizonHours: String(question.horizonHours),
  })
  const archiveResponse = await fetcher(`/api/carry/forecast?${query.toString()}`, { signal })
  if (!archiveResponse.ok) throw new Error('route_forecast_unavailable')
  const archiveValue = await archiveResponse.json()
  if (
    isRecord(archiveValue) &&
    archiveValue.status === 'unavailable' &&
    typeof archiveValue.reason === 'string'
  ) {
    onArchive({
      status: 'unavailable',
      reason: archiveValue.reason,
      localCarryExitV2Evidence: sanitizeLocalCarryExitV2Evidence(
        archiveValue.localCarryExitV2Evidence,
        question,
      ),
      prospectiveCashModel: sanitizeProspectiveCashModel(
        archiveValue.prospectiveCashModel,
        question,
      ),
    })
    return null
  }
  const archive = matchingRouteForecastResponse(archiveValue, question)
  if (!archive) throw new Error('route_forecast_identity_mismatch')
  onArchive(archive)
  if (!isLiveConditionalProjectionEligible(archive, question)) return null

  const liveQuery = new URLSearchParams(query)
  liveQuery.set('includeLiveCurrent', '1')
  try {
    const liveResponse = await fetcher(`/api/carry/forecast?${liveQuery.toString()}`, { signal })
    if (!liveResponse.ok) return null
    const live = matchingRouteForecastResponse(await liveResponse.json(), question)
    return live && isLiveConditionalProjectionEligible(live, question) ? live : null
  } catch {
    return null
  }
}

export async function loadInitialDepositForecast(
  baselineQuestion: RouteForecastQuestion,
  depositQuestion: InitialDepositQuestion,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const sentAtMs = Date.now()
  const { asset: _asset, assetDecimals: _decimals, ...payload } = depositQuestion
  const response = await fetcher('/api/carry/forecast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) throw new Error('initial_deposit_forecast_unavailable')
  const body: unknown = await response.json()
  if (signal.aborted) return null
  const baseline = matchingRouteForecastResponse(body, baselineQuestion)
  if (!baseline) throw new Error('initial_deposit_baseline_mismatch')
  return {
    baseline,
    issue: initialDepositIssueFromResponse(body, depositQuestion, sentAtMs, Date.now()),
  }
}

/** Exact-question context stays independent from every forecast/model response. */
export async function loadRouteEventContext(
  question: RouteEventQuestion,
  expectedEnrollment: ExpectedRouteEventEnrollment,
  signal: AbortSignal,
  fetcher: RouteEventContextFetch = fetch,
): Promise<RouteEventContextResponse | null> {
  const query = new URLSearchParams({
    routeKey: question.routeKey,
    destination: question.destination,
    requestedRaw: question.requestedRaw,
    payoutAsset: question.payoutAsset,
    assetDecimals: String(question.assetDecimals),
    horizonHours: String(question.horizonHours),
  })
  const response = await fetcher(`/api/carry/route-context?${query.toString()}`, { signal })
  if (!response.ok) throw new Error('route_event_context_unavailable')
  return matchingRouteEventContext(await response.json(), question, expectedEnrollment)
}

type ConditionalExitPressureEvidence = {
  currentCash: ExitPressureCurrentCash
  historicalScenario: ExitPressureHistoricalScenario
}

/**
 * The shared exit-impact object owns the band and validation results. The
 * local scenario only supplies block identity for that same current endpoint.
 */
export function conditionalExitPressureEvidence(
  value: RouteCashForecastView | null,
  question: RouteForecastQuestion,
  assetSymbol: string,
  label: ExitPressureCurrentCash['label'],
): ConditionalExitPressureEvidence | null {
  if (!value || matchingRouteForecastResponse(value, question) !== value) return null
  const projection = value.exitImpact?.conditionalProjection
  const metadata = value.localHistoricalScenario
  if (
    !projection ||
    projection.status !== 'research_projection' ||
    projection.analysisKind !== 'conditional_live_projection' ||
    !exactExitImpactQuestion(projection, question) ||
    projection.reference.basis !== 'scenario_current_endpoint' ||
    projection.cashBand.status !== 'available' ||
    !qualifiedConditionalExitImpact(projection) ||
    projection.cashBand.evidence !== 'historical_conditional_projection' ||
    projection.cashBand.modelKind !== 'endpoint_net_cash_band' ||
    projection.cashBand.flowTreatment !== 'all_aggregate_flow_already_included' ||
    metadata?.status !== 'historical_conditional_cash_scenario' ||
    metadata.currentCashRaw !== projection.reference.cashRaw ||
    metadata.currentBlockAt !== projection.reference.at ||
    metadata.targetAt !== projection.cashBand.targetAt ||
    metadata.assetDecimals !== projection.identity.assetDecimals ||
    metadata.method !== projection.cashBand.method ||
    metadata.fit !== projection.cashBand.holdout.fit ||
    metadata.calibration !== projection.cashBand.holdout.calibration ||
    metadata.selection !== projection.cashBand.holdout.selection ||
    metadata.selectionCovered !== projection.cashBand.holdout.selectionCovered ||
    metadata.holdout !== projection.cashBand.holdout.holdout ||
    metadata.holdoutCovered !== projection.cashBand.holdout.covered ||
    metadata.holdoutPointBeatsPersistence !== projection.cashBand.holdout.pointBeatsPersistence ||
    !/^(0|[1-9][0-9]*)$/.test(metadata.currentBlock) ||
    !/^0x[0-9a-fA-F]{64}$/.test(metadata.currentBlockHash) ||
    !Number.isSafeInteger(metadata.pairs) ||
    metadata.pairs <= 0
  )
    return null

  const { cashBand } = projection
  return {
    currentCash: {
      routeKey: question.routeKey,
      destination: question.destination.toLowerCase(),
      cashRaw: projection.reference.cashRaw,
      assetDecimals: projection.identity.assetDecimals,
      assetSymbol,
      assetAddress: projection.identity.asset.toLowerCase(),
      observedAt: projection.reference.at,
      block: metadata.currentBlock,
      blockHash: metadata.currentBlockHash,
      freshness: 'fresh',
      label,
    },
    historicalScenario: {
      routeKey: question.routeKey,
      destination: question.destination.toLowerCase(),
      horizonHours: 24,
      claim: metadata.claim,
      prospectiveValidated: false,
      holderExecutableExit: false,
      pointRaw: cashBand.capacityRaw.point,
      bandLowRaw: cashBand.capacityRaw.low,
      bandHighRaw: cashBand.capacityRaw.high,
      assetDecimals: projection.identity.assetDecimals,
      assetSymbol,
      assetAddress: projection.identity.asset.toLowerCase(),
      currentBlockAt: projection.reference.at,
      currentBlock: metadata.currentBlock,
      currentBlockHash: metadata.currentBlockHash,
      targetAt: cashBand.targetAt,
      sampleCount: metadata.pairs,
      method: cashBand.method,
      requestedRaw: projection.question.requestedRaw,
      requestedAssetAddress: projection.identity.asset.toLowerCase(),
      requestedAssetSymbol: assetSymbol,
      requestScope: 'route_exit',
      currentCashRaw: projection.reference.cashRaw,
      validation: {
        fit: cashBand.holdout.fit,
        calibration: cashBand.holdout.calibration,
        holdout: cashBand.holdout.holdout,
        covered: cashBand.holdout.covered,
        coveragePassed: cashBand.holdout.coveragePassed,
        pointBeatsPersistence: cashBand.holdout.pointBeatsPersistence,
      },
    },
  }
}

const EARLIER_CLAIM_STAGES = new Set(['receipt_claim', 'pending_claim', 'existing_ticket_claim'])

/** Elapsed whole minutes at the checked block, never wall-clock time or a release estimate. */
export function elapsedAtSourceBlock(sinceUnix: string, blockTime: string): string | null {
  const blockMs = Date.parse(blockTime)
  if (
    !Number.isSafeInteger(blockMs) ||
    typeof sinceUnix !== 'string' ||
    !/^[1-9]\d*$/.test(sinceUnix) ||
    BigInt(sinceUnix) > BigInt(Math.floor(blockMs / 1000))
  )
    return null
  const elapsedMinutes = Math.floor((blockMs - Number(sinceUnix) * 1000) / 60_000)
  if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes < 0) return null
  const days = Math.floor(elapsedMinutes / 1440)
  const hours = Math.floor((elapsedMinutes % 1440) / 60)
  const minutes = elapsedMinutes % 60
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function splitHolderExitStages(stages: HolderExitAssessment['stages']) {
  const routeStages: HolderExitAssessment['stages'] = []
  const existingClaimStages: HolderExitAssessment['stages'] = []
  for (const stage of stages) {
    if (EARLIER_CLAIM_STAGES.has(stage.name) && !stage.relatedToRequest)
      existingClaimStages.push(stage)
    else routeStages.push(stage)
  }
  return { routeStages, existingClaimStages }
}

/** Copy genuine current provenance only onto an independently matching chosen baseline. */
export function withBoundSampledCashCurrentMetadata(
  current: ExitPressureCurrentCash | null,
  value: unknown,
): ExitPressureCurrentCash | null {
  if (
    !current ||
    !isRecord(value) ||
    value.cashRaw !== current.cashRaw ||
    value.block !== current.block ||
    value.blockHash !== current.blockHash ||
    value.blockAt !== current.observedAt ||
    typeof value.asset !== 'string' ||
    value.asset.toLowerCase() !== current.assetAddress?.toLowerCase() ||
    value.assetDecimals !== current.assetDecimals
  )
    return current
  if (
    value.sourceKind === 'live_read_only_two_origin_finalized' &&
    typeof value.readAtUtc === 'string'
  )
    return {
      ...current,
      sourceKind: 'live_read_only_two_origin_finalized',
      readAtUtc: value.readAtUtc,
    }
  if (
    value.sourceKind === undefined &&
    typeof value.firstLocalReceiptAt === 'string' &&
    typeof value.manifestSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.manifestSha256) &&
    typeof value.receiptSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.receiptSha256)
  )
    return {
      ...current,
      sourceKind: 'manifest_bound_ledger',
      firstLocalReceiptAt: value.firstLocalReceiptAt,
      manifestSha256: value.manifestSha256,
      receiptSha256: value.receiptSha256,
    }
  return current
}

/** Bind the independent source witness to the already chosen cash observation.
 * It never obtains current provenance from the sidecar's own input. */
export function withBoundEventImpactCurrentMetadata(
  current: ExitPressureCurrentCash | null,
  value: unknown,
  asOfMs: number,
): ExitPressureCurrentCash | null {
  const s = conditionalEventImpactCurrentWitness(value, asOfMs)
  if (
    !current ||
    !s ||
    current.routeKey !== s.routeKey ||
    current.destination.toLowerCase() !== s.destination ||
    current.cashRaw !== s.cashRaw ||
    current.block !== s.block ||
    current.blockHash !== s.blockHash ||
    current.observedAt !== s.blockTime ||
    current.assetAddress?.toLowerCase() !== s.asset ||
    current.assetDecimals !== s.assetDecimals ||
    (current.readAtUtc !== undefined && current.readAtUtc !== s.readAt) ||
    (current.firstLocalReceiptAt !== undefined && current.firstLocalReceiptAt !== s.readAt) ||
    (current.sourceKind !== undefined && current.sourceKind !== s.sourceKind) ||
    (current.manifestSha256 !== undefined && current.manifestSha256 !== s.manifestSha256) ||
    (current.receiptSha256 !== undefined && current.receiptSha256 !== s.receiptSha256)
  )
    return current
  return {
    ...current,
    readAtUtc: s.readAt,
    sourceKind: s.sourceKind,
    ...(s.manifestSha256 ? { manifestSha256: s.manifestSha256 } : {}),
    ...(s.receiptSha256 ? { receiptSha256: s.receiptSha256 } : {}),
  }
}

/** Select a fresh independent response witness over a missing/stale archived
 * cash observation. An explicitly conflicting fresh source remains selected,
 * so the Card rejects its sidecar; private holder receipts are unaffected. */
export function eventImpactCurrentForWorkbench(
  current: ExitPressureCurrentCash | null,
  value: unknown,
  question: RouteForecastQuestion,
  symbol: string,
  label: ExitPressureCurrentCash['label'],
  asOfMs: number,
): ExitPressureCurrentCash | null {
  const s = conditionalEventImpactCurrentWitness(value, asOfMs)
  if (
    !s ||
    s.routeKey !== question.routeKey ||
    s.destination !== question.destination.toLowerCase() ||
    s.asset !== question.payoutAsset?.toLowerCase() ||
    s.assetDecimals !== question.payoutAssetDecimals ||
    !rawExitAmount(question.amountUnits, s.assetDecimals)
  )
    return current
  const sourceAge = current ? asOfMs - Date.parse(current.observedAt) : null
  const stale =
    current &&
    (current.freshness === 'stale' ||
      (sourceAge !== null && Number.isFinite(sourceAge) && sourceAge > 1800000))
  if (current && !stale) return withBoundEventImpactCurrentMetadata(current, s, asOfMs)
  return {
    routeKey: s.routeKey,
    destination: s.destination,
    cashRaw: s.cashRaw,
    assetDecimals: s.assetDecimals,
    assetSymbol: symbol,
    assetAddress: s.asset,
    observedAt: s.blockTime,
    block: s.block,
    blockHash: s.blockHash,
    freshness: 'fresh',
    label,
    readAtUtc: s.readAt,
    sourceKind: s.sourceKind,
    ...(s.manifestSha256 ? { manifestSha256: s.manifestSha256 } : {}),
    ...(s.receiptSha256 ? { receiptSha256: s.receiptSha256 } : {}),
  }
}

/** Separate server-issued current locator; this mapping grants no client provenance. */
export function analogCashCurrentForWorkbench(
  issued: AnalogCashScenarioIssue | null,
  question: RouteForecastQuestion,
  symbol: string,
  asOfMs: number,
): ExitPressureCurrentCash | null {
  try {
    if (!issued) return null
    const s = issued.currentSource,
      input = issued.input
    if (
      ![s.blockTime, s.readAt, input.issueAtUtc].every(
        (at) =>
          typeof at === 'string' &&
          Number.isSafeInteger(Date.parse(at)) &&
          new Date(Date.parse(at)).toISOString() === at,
      ) ||
      Date.parse(s.blockTime) > Date.parse(s.readAt) ||
      Date.parse(s.readAt) > Date.parse(input.issueAtUtc) ||
      !['manifest_bound_ledger', 'live_read_only_two_origin_finalized'].includes(s.sourceKind) ||
      (s.sourceKind === 'manifest_bound_ledger' &&
        ![s.manifestSha256, s.receiptSha256].every(
          (sha) => typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha),
        ))
    )
      return null
    if (
      s.routeKey !== question.routeKey ||
      s.destination !== question.destination.toLowerCase() ||
      s.asset !== question.payoutAsset?.toLowerCase() ||
      s.assetDecimals !== question.payoutAssetDecimals ||
      input.requestedRaw !== rawExitAmount(question.amountUnits, s.assetDecimals) ||
      input.horizonHours !== question.horizonHours ||
      !Number.isSafeInteger(asOfMs) ||
      asOfMs < Date.parse(input.issueAtUtc) ||
      asOfMs > Date.parse(s.blockTime) + 1800000 ||
      asOfMs >= Date.parse(input.issueAtUtc) + input.horizonHours * 3600000 ||
      !/^[1-9][0-9]{0,77}$/.test(s.block) ||
      !/^0x[0-9a-f]{64}$/.test(s.blockHash) ||
      !/^[1-9][0-9]{0,77}$/.test(s.cashRaw) ||
      BigInt(s.cashRaw) >= 1n << 256n ||
      BigInt(s.block) >= 1n << 256n
    )
      return null
    return {
      routeKey: s.routeKey,
      destination: s.destination,
      assetAddress: s.asset,
      assetDecimals: s.assetDecimals,
      assetSymbol: symbol,
      cashRaw: s.cashRaw,
      observedAt: s.blockTime,
      block: s.block,
      blockHash: s.blockHash,
      freshness: 'fresh',
      label:
        input.currentProfile.cashMeaning === 'underlying_reserve' ||
        input.currentProfile.cashMeaning === 'shared_bank_cash'
          ? 'Market cash'
          : 'Vault cash',
      sourceKind: s.sourceKind,
      ...(s.sourceKind === 'manifest_bound_ledger'
        ? {
            firstLocalReceiptAt: s.readAt,
            manifestSha256: s.manifestSha256,
            receiptSha256: s.receiptSha256,
          }
        : { readAtUtc: s.readAt }),
    }
  } catch {
    return null
  }
}

/** Request the holder check at independently selected C2 only after exact native Q binding. */
export function matchingHolderForecastSourceReference(
  value: unknown,
  question: Parameters<typeof selectedConditionalHeadroomForCard>[1],
  current: ExitPressureCurrentCash | null,
  sampledValue?: unknown,
  protocolInput?: Parameters<typeof selectedProtocolCapacityForCard>[0],
): { blockNumber: number; blockHash: string; blockTime: string } | null {
  if (
    !resolveConditionalHolderSampledCashSubject(question.routeKey, question.destination) ||
    !current ||
    typeof current.block !== 'string' ||
    !/^(0|[1-9][0-9]{0,77})$/.test(current.block) ||
    BigInt(current.block) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null
  const protocol = protocolInput
    ? selectedProtocolCapacityForCard(protocolInput, question, current)
    : null
  const selected =
    selectedSghoCashForCard(sampledValue, question, current) ||
    selectedSusdsCashForCard(sampledValue, question, current) ||
    selectedStusdsCashForCard(sampledValue, question, current) ||
    selectedCometCashForCard(sampledValue, question, current) ||
    selectedUsd3CashForCard(sampledValue, question, current) ||
    protocol?.aaveSparkCapacity ||
    protocol?.fluidProtocol ||
    selectedConditionalHeadroomForCard(value, question, current, sampledValue) ||
    selectedConditionalSampledHeadroomForCard(sampledValue, question, current)
  return selected
    ? {
        blockNumber: Number(current.block),
        blockHash: current.blockHash!,
        blockTime: current.observedAt,
      }
    : null
}

/** A failed execution check may still carry independently agreed current position facts. */
export function holderCapacityAgreementFromResponse(
  value: unknown,
  status: number,
): unknown | null {
  return (status === 200 || status === 503) &&
    isRecord(value) &&
    (status !== 503 || value.error === 'holder_exit_assessment_unavailable') &&
    value.capacityAgreement !== undefined
    ? value.capacityAgreement
    : null
}

/** Keep the original current agreement, bytes and private issue together. The
 * server's real issue clock is part of the complete request binding. */
export function holderUsd3JointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<ExitPressureUsd3JointIssue['question'], 'asOfMs'>,
  receivedAtMs: number,
): ExitPressureUsd3JointIssue | null {
  if (
    !isRecord(value) ||
    typeof value.usd3JointIssuedAtUtc !== 'string' ||
    !Number.isSafeInteger(receivedAtMs)
  )
    return null
  const issuedAtMs = Date.parse(value.usd3JointIssuedAtUtc)
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    new Date(issuedAtMs).toISOString() !== value.usd3JointIssuedAtUtc ||
    issuedAtMs > receivedAtMs
  )
    return null
  const completeQuestion = { ...question, asOfMs: issuedAtMs }
  const issue = usd3JointHolderForecastIssueFromResponse(value, status, completeQuestion)
  const capacityAgreement = holderCapacityAgreementFromResponse(value, status)
  return issue && capacityAgreement && value.usd3JointHistoricalEvidence
    ? {
        question: completeQuestion,
        issue,
        capacityAgreement,
        historicalEvidence: value.usd3JointHistoricalEvidence,
      }
    : null
}

export function holderFluidUsdcBridgeJointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<ExitPressureFluidUsdcBridgeJointIssue['question'], 'asOfMs'>,
  receivedAtMs: number,
): ExitPressureFluidUsdcBridgeJointIssue | null {
  if (
    !isRecord(value) ||
    typeof value.fluidUsdcBridgeJointIssuedAtUtc !== 'string' ||
    !Number.isSafeInteger(receivedAtMs)
  )
    return null
  const issuedAtMs = Date.parse(value.fluidUsdcBridgeJointIssuedAtUtc)
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    new Date(issuedAtMs).toISOString() !== value.fluidUsdcBridgeJointIssuedAtUtc ||
    issuedAtMs > receivedAtMs
  )
    return null
  const completeQuestion = { ...question, asOfMs: issuedAtMs }
  const issue = fluidUsdcBridgeJointHolderForecastIssueFromResponse(value, status, completeQuestion)
  const capacityAgreement = holderCapacityAgreementFromResponse(value, status)
  return issue && capacityAgreement && value.fluidUsdcBridgeJointHistoricalEvidence
    ? {
        question: completeQuestion,
        issue,
        capacityAgreement,
        historicalEvidence: value.fluidUsdcBridgeJointHistoricalEvidence,
      }
    : null
}

/** The issue clock is copied from the server after native retention, never from the request clock. */
export function holderFluidUsdtBridgeJointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<ExitPressureFluidUsdtBridgeJointIssue['question'], 'asOfMs'>,
  receivedAtMs: number,
): ExitPressureFluidUsdtBridgeJointIssue | null {
  try {
    if (!isRecord(value) || !Number.isSafeInteger(receivedAtMs)) return null
    const stamp = Object.getOwnPropertyDescriptor(value, 'fluidUsdtBridgeJointIssuedAtUtc')
    if (!stamp?.enumerable || !Object.hasOwn(stamp, 'value') || typeof stamp.value !== 'string')
      return null
    const issuedAtMs = Date.parse(stamp.value)
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      new Date(issuedAtMs).toISOString() !== stamp.value ||
      issuedAtMs > receivedAtMs
    )
      return null
    if (
      !isRecord(question) ||
      Object.getPrototypeOf(question) !== Object.prototype ||
      Object.getOwnPropertySymbols(question).length
    )
      return null
    const descriptors = Object.getOwnPropertyDescriptors(question)
    const allowed = [
      'routeKey',
      'destination',
      'requestedRaw',
      'requestedAssetAddress',
      'requestedAssetDecimals',
      'requestedHolderAddress',
      'horizonHours',
      'independentSource',
    ]
    if (Object.keys(descriptors).length > allowed.length) return null
    const safeQuestion: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return null
      safeQuestion[key] = descriptor.value
    }
    const completeQuestion = {
      ...safeQuestion,
      asOfMs: issuedAtMs,
    } as ExitPressureFluidUsdtBridgeJointIssue['question']
    const issue = fluidUsdtBridgeJointHolderForecastIssueFromResponse(
      value,
      status,
      completeQuestion,
      receivedAtMs,
    )
    return issue ? { question: completeQuestion, issue } : null
  } catch {
    return null
  }
}

export function holderUmbrellaGhoJointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<ExitPressureUmbrellaGhoJointIssue['question'], 'asOfMs'>,
  receivedAtMs: number,
): ExitPressureUmbrellaGhoJointIssue | null {
  if (
    !isRecord(value) ||
    typeof value.umbrellaGhoJointIssuedAtUtc !== 'string' ||
    !Number.isSafeInteger(receivedAtMs)
  )
    return null
  const issuedAtMs = Date.parse(value.umbrellaGhoJointIssuedAtUtc)
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    new Date(issuedAtMs).toISOString() !== value.umbrellaGhoJointIssuedAtUtc ||
    issuedAtMs > receivedAtMs
  )
    return null
  const completeQuestion = { ...question, asOfMs: issuedAtMs }
  const issue = umbrellaGhoJointHolderForecastIssueFromResponse(
    value,
    status,
    completeQuestion,
    receivedAtMs,
  )
  return issue && value.umbrellaGhoNativeCapacity && value.umbrellaGhoJointHistoricalEvidence
    ? {
        question: completeQuestion,
        issue,
        nativeCapacity: value.umbrellaGhoNativeCapacity,
        historicalEvidence: value.umbrellaGhoJointHistoricalEvidence,
      }
    : null
}

export function holderApyUsdJointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<
    ExitPressureApyUsdJointIssue['question'],
    'asOfMs' | 'plannedInitiationOffsetSeconds' | 'fundingBasis'
  >,
  receivedAtMs: number,
): ExitPressureApyUsdJointIssue | null {
  if (
    !isRecord(value) ||
    typeof value.apyUsdJointIssuedAtUtc !== 'string' ||
    !Number.isSafeInteger(receivedAtMs)
  )
    return null
  const issuedAtMs = Date.parse(value.apyUsdJointIssuedAtUtc)
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    new Date(issuedAtMs).toISOString() !== value.apyUsdJointIssuedAtUtc ||
    issuedAtMs > receivedAtMs
  )
    return null
  const completeQuestion = {
    ...question,
    asOfMs: issuedAtMs,
    plannedInitiationOffsetSeconds: 0,
    fundingBasis: 'native_liquid_cash' as const,
  }
  const issue = apyUsdJointHolderForecastIssueFromResponse(
    value,
    status,
    completeQuestion,
    receivedAtMs,
  )
  return issue ? { question: completeQuestion, issue } : null
}

export function holderForecastHorizonOptions(
  routeKey: string,
  destination: string,
  scenarioMode: string,
): readonly number[] {
  return scenarioMode === 'exit' &&
    routeKey === UMBRELLA_GHO_ROUTE &&
    destination.toLowerCase() === UMBRELLA_STKGHO
    ? [1, 24, 48, 168, 336, 720]
    : [1, 24, 48, 168]
}

/** Retain exactly one browser-local receipt from the qualified API Saturn envelope. */
export function holderSaturnForecastIssueFromResponse(value: unknown, status: number,
  question: Omit<SaturnForecastQuestion, 'asOfMs'>, receivedAtMs: number): SaturnAppForecastIssue | null {
  const model = saturnAppForecastFromResponse(value, status, question, receivedAtMs)
  return model ? saturnAppForecastIssue(model) : null
}

/** Retain the server's native issue clock and the browser's original idle receipt. */
export function holderMorphoV2IdleJointIssueFromResponse(
  value: unknown,
  status: number,
  question: Omit<ExitPressureMorphoV2IdleJointIssue['question'], 'asOfMs'>,
  receivedAtMs: number,
): ExitPressureMorphoV2IdleJointIssue | null {
  try {
    if (!isRecord(value) || !Number.isSafeInteger(receivedAtMs)) return null
    const stamp = Object.getOwnPropertyDescriptor(value, 'morphoV2IdleJointIssuedAtUtc')
    if (!stamp?.enumerable || !Object.hasOwn(stamp, 'value') || typeof stamp.value !== 'string')
      return null
    const issuedAtMs = Date.parse(stamp.value)
    if (!Number.isSafeInteger(issuedAtMs) || new Date(issuedAtMs).toISOString() !== stamp.value ||
      issuedAtMs > receivedAtMs) return null
    if (!isRecord(question) || Object.getPrototypeOf(question) !== Object.prototype ||
      Object.getOwnPropertySymbols(question).length) return null
    const descriptors = Object.getOwnPropertyDescriptors(question)
    const allowed = ['routeKey', 'destination', 'requestedRaw', 'requestedAssetAddress',
      'requestedAssetDecimals', 'requestedHolderAddress', 'horizonHours', 'independentSource']
    if (Object.keys(descriptors).length > allowed.length) return null
    const safeQuestion: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return null
      safeQuestion[key] = descriptor.value
    }
    const completeQuestion = { ...safeQuestion, asOfMs: issuedAtMs }
    const panelModel = morphoV2IdleJointHolderForecastV2FromResponse(value, status, completeQuestion)
    if (panelModel) {
      const issue = morphoV2IdleJointHolderForecastV2Issue(panelModel)
      if (!issue || !selectedMorphoV2IdleJointHolderForecastV2FromIssue(issue, panelModel.question, receivedAtMs))
        return null
      return Object.freeze({ question: panelModel.question, issue })
    }
    const model = morphoV2IdleJointHolderForecastFromResponse(value, status, {
      ...safeQuestion, asOfMs: issuedAtMs,
    })
    const issue = model ? morphoV2IdleJointHolderForecastIssue(model) : null
    if (!model || !issue ||
      !selectedMorphoV2IdleJointHolderForecastFromIssue(issue, model.question, receivedAtMs))
      return null
    return Object.freeze({ question: model.question, issue })
  } catch { return null }
}

export function holderTimeProcessIssueFromResponse(
  value: unknown,
  status: number,
  question: Parameters<typeof issuedCashHolderTimeInputForCard>[4],
  current: ExitPressureCurrentCash | null,
  cashProjection: unknown,
  independentSource: { blockNumber: number; blockHash: string; blockTime: string } | null = null,
): HolderTimeProcessIssue | null {
  try {
    if (resolveMorphoV2IdleTrustedProfile(question.routeKey, question.destination.toLowerCase(),
      question.requestedAssetAddress?.toLowerCase())) return null
  } catch {
    return null
  }
  const susdeIssue = susdeHolderForecastIssueFromResponse(value, status, {
    ...question,
    ...(independentSource
      ? {
          source: {
            chainId: 1,
            blockNumber: String(independentSource.blockNumber),
            blockHash: independentSource.blockHash.toLowerCase(),
            blockTime: independentSource.blockTime,
            finalized: true,
          } as const,
        }
      : {}),
  })
  if (susdeIssue) return susdeIssue
  const agreement = holderCapacityAgreementFromResponse(value, status)
  if (!agreement || !isRecord(value)) return null
  const morphoQuestion = {
    ...question,
    ...(independentSource
      ? {
          independentSource: {
            chainId: 1 as const,
            ...independentSource,
            finalized: true as const,
          },
        }
      : {}),
  }
  const jointIssue = morphoV2JointHolderForecastIssueFromResponse(value, status, morphoQuestion)
  if (jointIssue) return jointIssue
  const jointEvidencePresent =
    Object.hasOwn(value, 'morphoV2CurrentHolderPositionEvidence') ||
    Object.hasOwn(value, 'morphoV2HistoricalHolderEaEvidence')
  const morphoIssue = !jointEvidencePresent
    ? morphoV2HolderForecastIssueFromResponse(value, status, morphoQuestion)
    : null
  if (morphoIssue) return morphoIssue
  const input =
    issuedCashHolderTimeInputForCard(
      cashProjection,
      agreement,
      holderCometFactsAgreementFromResponse(value, status),
      value.executionAgreement,
      question,
      current,
    ) ??
    issuedStusdsTimeInputForCard(
      cashProjection,
      agreement,
      value.executionAgreement,
      holderStusdsProtocolEvidenceFromResponse(value, status),
      question,
      current,
    ) ??
    issuedUsd3HolderTimeInputForCard(
      cashProjection,
      agreement,
      value.executionAgreement,
      question,
      current,
    )
  return input
    ? {
        issuedAtMs: question.asOfMs,
        horizonHours: question.horizonHours,
        owner: input.binding.owner,
        requestedRaw: input.binding.requestedRaw,
        block: String(input.binding.currentSource.blockNumber),
        blockHash: input.binding.currentSource.blockHash,
      }
    : null
}

export function holderStusdsProtocolEvidenceFromResponse(
  value: unknown,
  status: number,
): unknown | null {
  return (status === 200 || status === 503) &&
    isRecord(value) &&
    (status !== 503 || value.error === 'holder_exit_assessment_unavailable') &&
    value.stusdsCurrentProtocolCapacityEvidence !== undefined
    ? value.stusdsCurrentProtocolCapacityEvidence
    : null
}

/** Preserve the optional native bytes on the same request publication boundary. */
export function holderMorphoV2PositionEvidenceFromResponse(value: unknown, status: number) {
  const accepted =
    (status === 200 || status === 503) &&
    isRecord(value) &&
    (status !== 503 || value.error === 'holder_exit_assessment_unavailable')
  return {
    holder:
      accepted && Object.hasOwn(value, 'morphoV2CurrentHolderPositionEvidence')
        ? value.morphoV2CurrentHolderPositionEvidence
        : null,
    historical:
      accepted && Object.hasOwn(value, 'morphoV2HistoricalHolderEaEvidence')
        ? value.morphoV2HistoricalHolderEaEvidence
        : null,
  }
}

/** Optional global Comet restrictions retain their own source-bound two-origin evidence. */
export function holderCometFactsAgreementFromResponse(
  value: unknown,
  status: number,
): unknown | null {
  return (status === 200 || status === 503) &&
    isRecord(value) &&
    (status !== 503 || value.error === 'holder_exit_assessment_unavailable') &&
    value.cometFactsAgreement !== undefined
    ? value.cometFactsAgreement
    : null
}

/** Bad optional mechanics never discard an otherwise matched current assessment. */
export function withMatchingHolderMechanicalOutlook(
  assessment: HolderExitAssessmentView,
  owner: string,
  nowMs: number,
): HolderExitAssessmentView {
  const mechanicalOutlook = selectedHolderExitMechanicalOutlook(
    assessment.mechanicalOutlook,
    assessment,
    {
      routeKey: assessment.routeKey,
      destination: assessment.destinationAddress,
      owner,
      requestedRaw: assessment.request.assetsRaw,
      payoutAsset: assessment.request.assetAddress,
      horizonHours: assessment.request.horizonHours,
      asOfMs: nowMs,
    },
  )
  return { ...assessment, mechanicalOutlook }
}

export function isMatchingHolderExitAssessment(
  value: unknown,
  request: {
    routeKey: string
    destinationAddress: string
    owner: string
    assetsRaw: string
    horizonHours: number
    payoutAsset: string
    kind:
      | 'direct'
      | 'apy'
      | 'fluid'
      | 'morpho'
      | 'tracked'
      | 'sgho'
      | 'susds'
      | 'usd3'
      | 'umbrella_gho'
      | 'susde'
      | 'staked_usdat'
      | 'twyne_pt'
      | 'pyusd_staking'
    firstLegUsdcRaw?: string
    receiptTokenId?: string
    sharesRaw?: string
    requestTokenId?: string
    collateralVault?: string
    ptRaw?: string
    primeSharesRaw?: string
  },
): value is HolderExitAssessment {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<HolderExitAssessment>
  const source = result.source
  const payout = result.finalPayout
  const forecast = result.forecast
  const stages = result.stages
  if (
    result.routeKey !== request.routeKey ||
    result.destinationAddress?.toLowerCase() !== request.destinationAddress.toLowerCase() ||
    result.owner?.toLowerCase() !== request.owner.toLowerCase() ||
    result.request?.assetsRaw !== request.assetsRaw ||
    result.request?.horizonHours !== request.horizonHours ||
    (request.kind === 'apy' && result.request?.receiptTokenId !== request.receiptTokenId) ||
    (request.kind === 'staked_usdat' &&
      (result.request?.sharesRaw !== request.sharesRaw ||
        result.request?.requestTokenId !== request.requestTokenId)) ||
    (request.kind === 'twyne_pt' &&
      (result.request?.collateralVault?.toLowerCase() !== request.collateralVault?.toLowerCase() ||
        result.request?.ptRaw !== request.ptRaw)) ||
    (request.kind === 'pyusd_staking' &&
      result.request?.primeSharesRaw !== request.primeSharesRaw) ||
    result.request?.assetAddress?.toLowerCase() !== request.payoutAsset.toLowerCase() ||
    source?.chainId !== 1 ||
    typeof source?.blockNumber !== 'number' ||
    !Number.isSafeInteger(source.blockNumber) ||
    !/^0x[0-9a-fA-F]{64}$/.test(source.blockHash ?? '') ||
    typeof source.blockTime !== 'string' ||
    Number.isNaN(Date.parse(source.blockTime)) ||
    source.originValidation !== 'two_provider' ||
    payout?.assetAddress?.toLowerCase() !== request.payoutAsset.toLowerCase() ||
    forecast?.status !== 'unvalidated' ||
    forecast.futureExit !== null ||
    forecast.exitDurationHours !== null ||
    forecast.prospectiveValidated !== false ||
    !Array.isArray(stages) ||
    !stages.every(
      (stage) =>
        stage &&
        typeof stage.name === 'string' &&
        typeof stage.relatedToRequest === 'boolean' &&
        ['simulated', 'reverted', 'unassessed'].includes(stage.status),
    )
  )
    return false
  if (request.kind === 'umbrella_gho') {
    const redeem = stages[0]
    const condition = result.condition
    if (
      stages.length !== 1 ||
      redeem.name !== 'redeem' ||
      redeem.amountRaw !== request.assetsRaw ||
      redeem.assetAddress?.toLowerCase() !== request.payoutAsset.toLowerCase() ||
      redeem.relatedToRequest !== true ||
      (condition &&
        (![
          'window_open',
          'waiting',
          'window_expired',
          'paused',
          'no_shares',
          'cooldown_not_started',
          'amount_exceeds_window',
        ].includes(condition.gate) ||
          !['slashable_assets_present', 'no_slashable_assets'].includes(condition.slashExposure)))
    )
      return false
    if (redeem.status === 'simulated')
      return (
        result.status === 'assessed' &&
        condition?.gate === 'window_open' &&
        Number.isSafeInteger(condition.windowEndInclusive) &&
        condition.windowEndInclusive !== null &&
        condition.windowEndInclusive * 1000 >= Date.parse(source.blockTime) &&
        payout.status === 'simulated' &&
        typeof payout.amountRaw === 'string' &&
        /^\d+$/.test(payout.amountRaw) &&
        BigInt(payout.amountRaw) >= BigInt(request.assetsRaw)
      )
    return (
      (result.status === 'partial' || result.status === 'unsupported') &&
      payout.status === 'unassessed' &&
      payout.amountRaw === null
    )
  }
  if (request.kind === 'susde') {
    return !!susdeCoreAssessmentSource(value, {
      routeKey: request.routeKey,
      destination: request.destinationAddress,
      requestedHolderAddress: request.owner,
      requestedRaw: request.assetsRaw,
      requestedAssetAddress: request.payoutAsset,
      requestedAssetDecimals: 18,
      horizonHours: request.horizonHours,
      asOfMs: Date.parse(source.blockTime),
    })
  }
  if (request.kind === 'staked_usdat') {
    const condition = result.stakedUsdatCondition
    const queue = stages[0]
    const claim = stages[1]
    return (
      (result.status === 'partial' || result.status === 'unsupported') &&
      stages.length === 2 &&
      queue.name === 'queue_request' &&
      queue.relatedToRequest === false &&
      queue.assetAddress === null &&
      queue.amountRaw === null &&
      claim.name === 'existing_ticket_claim' &&
      claim.relatedToRequest === false &&
      claim.assetAddress?.toLowerCase() === USDAT_ASSET &&
      payout.status === 'unassessed' &&
      payout.amountRaw === null &&
      (result.status === 'unsupported'
        ? condition === undefined && queue.status === 'unassessed' && claim.status === 'unassessed'
        : condition !== undefined &&
          condition.requestedSharesRaw === request.sharesRaw &&
          condition.existingTicketId === (request.requestTokenId ?? null) &&
          (condition.existingTicketOwnership === null ||
            ['holder', 'other_owner', 'not_found'].includes(condition.existingTicketOwnership)) &&
          (condition.existingTicketClaimStatus === null ||
            ['success', 'evm_revert', 'not_holder', 'not_found'].includes(
              condition.existingTicketClaimStatus,
            )) &&
          (condition.existingTicketClaimStatus !== 'success' ||
            condition.existingTicketOwnership === 'holder') &&
          (condition.existingTicketRequestedAtUnix === null ||
            (condition.existingTicketOwnership === 'holder' &&
              elapsedAtSourceBlock(condition.existingTicketRequestedAtUnix, source.blockTime) !==
                null)) &&
          (condition.existingTicketRequestedLimit === null ||
            (condition.existingTicketOwnership === 'holder' &&
              /^\d+$/.test(condition.existingTicketRequestedLimit.minSharePriceRaw) &&
              ['above_current_quote', 'at_or_below_current_quote', 'quote_unavailable'].includes(
                condition.existingTicketRequestedLimit.comparison,
              ) &&
              ['success', 'evm_revert'].includes(
                condition.existingTicketRequestedLimit.limitUpdateSimulation,
              ) &&
              (condition.existingTicketRequestedLimit.comparison === 'quote_unavailable'
                ? condition.existingTicketRequestedLimit.currentNetSharePriceRaw === null
                : typeof condition.existingTicketRequestedLimit.currentNetSharePriceRaw ===
                    'string' &&
                  /^\d+$/.test(condition.existingTicketRequestedLimit.currentNetSharePriceRaw) &&
                  BigInt(condition.existingTicketRequestedLimit.currentNetSharePriceRaw) <
                    BigInt(condition.existingTicketRequestedLimit.minSharePriceRaw) ===
                    (condition.existingTicketRequestedLimit.comparison ===
                      'above_current_quote')))) &&
          ['success', 'evm_revert', 'not_attempted'].includes(condition.queueRequestStatus) &&
          (condition.queueRequestStatus === 'success'
            ? typeof condition.simulatedQueueTicketId === 'string' &&
              /^\d+$/.test(condition.simulatedQueueTicketId)
            : condition.simulatedQueueTicketId === null) &&
          queue.status ===
            (condition.queueRequestStatus === 'success'
              ? 'simulated'
              : condition.queueRequestStatus === 'evm_revert'
                ? 'reverted'
                : 'unassessed') &&
          claim.status ===
            (condition.existingTicketClaimStatus === 'success'
              ? 'simulated'
              : condition.existingTicketClaimStatus === 'evm_revert'
                ? 'reverted'
                : 'unassessed') &&
          (claim.status === 'simulated'
            ? typeof claim.amountRaw === 'string' && /^\d+$/.test(claim.amountRaw)
            : claim.amountRaw === null))
    )
  }
  if (request.kind === 'twyne_pt') {
    const stage = stages[0]
    const condition = result.twyneCondition
    if (result.status === 'unsupported')
      return (
        stages.length === 0 &&
        condition?.status === 'unsupported' &&
        condition.collateralVault.toLowerCase() === request.collateralVault?.toLowerCase() &&
        condition.requestedPtRaw === request.ptRaw &&
        payout.status === 'unassessed' &&
        payout.amountRaw === null
      )
    return (
      result.status === 'partial' &&
      stages.length === 1 &&
      stage.name === 'pt_redemption' &&
      stage.assetAddress?.toLowerCase() === TWYNE_PT_ASSET &&
      stage.amountRaw === request.ptRaw &&
      stage.relatedToRequest === false &&
      condition !== undefined &&
      condition.collateralVault.toLowerCase() === request.collateralVault?.toLowerCase() &&
      condition.requestedPtRaw === request.ptRaw &&
      ['observed', 'restricted', 'unsupported'].includes(condition.status) &&
      (condition.status === 'observed'
        ? typeof condition.simulatedReturnedPtRaw === 'string' &&
          /^\d+$/.test(condition.simulatedReturnedPtRaw) &&
          BigInt(condition.simulatedReturnedPtRaw) >= BigInt(request.ptRaw ?? '0')
        : condition.simulatedReturnedPtRaw === null ||
          (typeof condition.simulatedReturnedPtRaw === 'string' &&
            /^\d+$/.test(condition.simulatedReturnedPtRaw))) &&
      stage.status ===
        (condition.status === 'observed'
          ? 'simulated'
          : condition.reason === 'evm_revert'
            ? 'reverted'
            : 'unassessed') &&
      payout.status === 'unassessed' &&
      payout.amountRaw === null
    )
  }
  if (request.kind === 'pyusd_staking') {
    if (payout.status !== 'unassessed' || payout.amountRaw !== null) return false
    const queue = result.pyusdYieldQueueCondition
    const queueValid =
      queue === undefined ||
      (queue !== null &&
        typeof queue.holder === 'string' &&
        queue.holder.toLowerCase() === request.owner.toLowerCase() &&
        /^(0|[1-9]\d*)$/.test(queue.existingWyldsSharesRaw) &&
        /^(0|[1-9]\d*)$/.test(queue.pendingSharesRaw) &&
        /^(0|[1-9]\d*)$/.test(queue.pendingUsdcRaw) &&
        /^(0|[1-9]\d*)$/.test(queue.pendingSinceUnix) &&
        (queue.pendingSinceUnix === '0' ||
          elapsedAtSourceBlock(queue.pendingSinceUnix, source.blockTime) !== null) &&
        typeof queue.yieldPaused === 'boolean' &&
        typeof queue.yieldFrozen === 'boolean' &&
        /^0x[0-9a-fA-F]{40}$/.test(queue.redeemVault) &&
        queue.requestAssessed === false &&
        queue.completion === 'admin_gated_unassessed' &&
        queue.usdcPayout === 'not_attested')
    if (!queueValid) return false
    if (!request.primeSharesRaw)
      return (
        stages.length === 0 &&
        (result.status === 'partial'
          ? result.unsupportedReason === undefined &&
            queue !== undefined &&
            (BigInt(queue.existingWyldsSharesRaw) > 0n ||
              BigInt(queue.pendingSharesRaw) > 0n ||
              BigInt(queue.pendingUsdcRaw) > 0n)
          : result.status === 'unsupported' &&
            queue === undefined &&
            ['pyusd_leg_not_verified', 'deployment_unattested', 'identity_changed'].includes(
              result.unsupportedReason ?? '',
            ))
      )
    if (result.status === 'unsupported')
      return (
        ['deployment_unattested', 'identity_changed'].includes(result.unsupportedReason ?? '') &&
        stages.length === 0
      )
    const condition = result.pyusdStakingCondition
    const stage = stages[0]
    return (
      result.status === 'partial' &&
      result.unsupportedReason === undefined &&
      stages.length === 1 &&
      stage.name === 'prime_redemption' &&
      stage.assetAddress?.toLowerCase() === HASTRA_STAKING_VAULT &&
      stage.amountRaw === request.primeSharesRaw &&
      stage.relatedToRequest === false &&
      condition?.requestedPrimeSharesRaw === request.primeSharesRaw &&
      /^[1-9]\d*$/.test(request.primeSharesRaw) &&
      /^(0|[1-9]\d*)$/.test(condition.holderPrimeSharesRaw) &&
      /^(0|[1-9]\d*)$/.test(condition.maxRedeemRaw) &&
      typeof condition.stakingPaused === 'boolean' &&
      typeof condition.holderFrozen === 'boolean' &&
      (condition.simulatedWyldsRaw === null ||
        /^(0|[1-9]\d*)$/.test(condition.simulatedWyldsRaw)) &&
      (condition.previewWyldsRaw === null || /^(0|[1-9]\d*)$/.test(condition.previewWyldsRaw)) &&
      [
        'insufficient_prime_shares',
        'staking_paused',
        'holder_frozen',
        'below_max_redeem',
        'redeem_reverted',
        'zero_wylds_out',
        'prime_to_wylds_callable',
      ].includes(condition.reason) &&
      (condition.reason !== 'prime_to_wylds_callable' ||
        (BigInt(condition.holderPrimeSharesRaw) >= BigInt(request.primeSharesRaw) &&
          BigInt(condition.maxRedeemRaw) >= BigInt(request.primeSharesRaw) &&
          condition.stakingPaused === false &&
          condition.holderFrozen === false &&
          condition.simulatedWyldsRaw !== null &&
          BigInt(condition.simulatedWyldsRaw) > 0n)) &&
      stage.status ===
        (condition.reason === 'prime_to_wylds_callable'
          ? 'simulated'
          : condition.simulatedWyldsRaw === null
            ? 'reverted'
            : 'unassessed')
    )
  }
  if (
    request.kind === 'direct' ||
    request.kind === 'morpho' ||
    request.kind === 'tracked' ||
    request.kind === 'sgho' ||
    request.kind === 'susds' ||
    request.kind === 'usd3'
  )
    return (
      result.status === 'assessed' &&
      stages.length === 1 &&
      stages[0].name === 'withdrawal' &&
      stages[0].amountRaw === request.assetsRaw &&
      stages[0].relatedToRequest === true &&
      stages[0].assetAddress?.toLowerCase() === request.payoutAsset.toLowerCase() &&
      ['simulated', 'reverted', 'unassessed'].includes(stages[0].status) &&
      (stages[0].status === 'simulated'
        ? payout.status === 'simulated' && payout.amountRaw === request.assetsRaw
        : payout.status === 'unassessed' && payout.amountRaw === null)
    )
  if (request.kind === 'apy') {
    const condition = result.apyUsdCondition
    const existingClaim = result.existingReceiptClaim
    return (
      (result.status === 'partial' || result.status === 'unsupported') &&
      stages.length === 2 &&
      stages[0].name === 'receipt_initiation' &&
      stages[0].amountRaw === request.assetsRaw &&
      stages[0].relatedToRequest === true &&
      stages[1].name === 'receipt_claim' &&
      stages[1].relatedToRequest === false &&
      stages[1].assetAddress?.toLowerCase() === request.payoutAsset.toLowerCase() &&
      (existingClaim === undefined
        ? stages[1].amountRaw === null &&
          (request.receiptTokenId === undefined
            ? stages[1].status === 'unassessed'
            : stages[1].status !== 'simulated')
        : request.receiptTokenId !== undefined &&
          existingClaim.tokenId === request.receiptTokenId &&
          existingClaim.assetAddress.toLowerCase() === request.payoutAsset.toLowerCase() &&
          existingClaim.status === 'simulated' &&
          existingClaim.delivery === 'not_observed' &&
          /^[1-9]\d{0,77}$/.test(existingClaim.amountRaw) &&
          stages[1].status === 'simulated' &&
          stages[1].amountRaw === existingClaim.amountRaw) &&
      (result.status === 'unsupported'
        ? condition === undefined &&
          existingClaim === undefined &&
          stages[0].status === 'unassessed' &&
          stages[1].status === 'unassessed' &&
          stages[1].amountRaw === null
        : condition !== undefined &&
          Number.isSafeInteger(condition.currentMinimumClaimDelaySeconds) &&
          condition.currentMinimumClaimDelaySeconds >= 0 &&
          condition.currentMinimumClaimDelaySeconds <= 90 * 86_400 &&
          condition.ifInitiatedAtCheckedBlockClaimableAt ===
            (stages[0].status === 'simulated'
              ? Date.parse(source.blockTime) / 1000 + condition.currentMinimumClaimDelaySeconds
              : null) &&
          (stages[0].status === 'simulated'
            ? typeof condition.ifInitiatedAtCheckedBlockEarliestNetRaw === 'string' &&
              /^\d+$/.test(condition.ifInitiatedAtCheckedBlockEarliestNetRaw) &&
              BigInt(condition.ifInitiatedAtCheckedBlockEarliestNetRaw) <=
                BigInt(request.assetsRaw) &&
              Number.isSafeInteger(condition.ifInitiatedAtCheckedBlockMinimumFeeAt) &&
              condition.ifInitiatedAtCheckedBlockMinimumFeeAt! >=
                condition.ifInitiatedAtCheckedBlockClaimableAt! &&
              typeof condition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw === 'string' &&
              /^\d+$/.test(condition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw) &&
              BigInt(condition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw) <=
                BigInt(request.assetsRaw) &&
              (condition.ifInitiatedAtCheckedBlockHorizonNetRaw === null ||
                (typeof condition.ifInitiatedAtCheckedBlockHorizonNetRaw === 'string' &&
                  /^\d+$/.test(condition.ifInitiatedAtCheckedBlockHorizonNetRaw) &&
                  BigInt(condition.ifInitiatedAtCheckedBlockHorizonNetRaw) <=
                    BigInt(request.assetsRaw)))
            : condition.ifInitiatedAtCheckedBlockEarliestNetRaw === null &&
              condition.ifInitiatedAtCheckedBlockMinimumFeeAt === null &&
              condition.ifInitiatedAtCheckedBlockMinimumFeeNetRaw === null &&
              condition.ifInitiatedAtCheckedBlockHorizonNetRaw === null)) &&
      payout.status === 'unassessed' &&
      payout.amountRaw === null
    )
  }
  return (
    result.status === 'partial' &&
    stages.length === 3 &&
    stages[0].name === 'usdc_vault_withdrawal' &&
    stages[0].assetAddress?.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' &&
    stages[0].amountRaw === request.firstLegUsdcRaw &&
    stages[0].relatedToRequest === false &&
    stages[1].name === 'usdc_to_usdt_conversion' &&
    stages[1].status === 'unassessed' &&
    stages[2].name === 'usdt_delivery' &&
    stages[2].status === 'unassessed' &&
    stages[2].relatedToRequest === true &&
    payout.status === 'unassessed' &&
    payout.amountRaw === null
  )
}

export function resolvedMorphoAssessmentTarget(routeKey: string, destination: string) {
  if (!routeKey.includes('→ VaultV2 [') || !/^0x[0-9a-fA-F]{40}$/.test(destination)) return null
  try {
    return resolveMorphoExitTarget(routeKey, destination.toLowerCase() as `0x${string}`)
  } catch {
    return null
  }
}

export function isLocalHolderWatchHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

export function isHolderWatchStatus(value: unknown): value is HolderWatchStatus {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<HolderWatchStatus>
  const intakeStates = ['absent', 'queued', 'issued', 'retrying', 'quarantined', 'exhausted']
  const horizonStates = [
    ...intakeStates,
    'pending',
    'measured_success',
    'measured_failure',
    'censored',
  ]
  return (
    typeof result.id === 'string' &&
    /^[0-9a-f]{64}$/.test(result.id) &&
    typeof result.state === 'string' &&
    intakeStates.includes(result.state) &&
    result.forecastValidated === false &&
    Array.isArray(result.horizons) &&
    result.horizons.length === 2 &&
    [1, 24].every((hour) =>
      result.horizons?.some(
        (entry) =>
          entry &&
          entry.horizonHours === hour &&
          typeof entry.state === 'string' &&
          horizonStates.includes(entry.state),
      ),
    )
  )
}

async function fetchHolderWatchStatus(
  request: { routeKey: string; destinationAddress: string; owner: string; assetsRaw: string },
  signal: AbortSignal,
  expectedId?: string,
): Promise<HolderWatchStatus> {
  const response = await fetch('/api/carry/holder-exit-watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status', ...request }),
    signal,
  })
  if (response.status === 429) throw new Error('holder_watch_rate_limited')
  if (!response.ok) throw new Error('holder_watch_status_unavailable')
  const value: unknown = await response.json()
  if (!isHolderWatchStatus(value) || (expectedId && value.id !== expectedId))
    throw new Error('holder_watch_status_invalid')
  return value
}

export const ForecastWorkbench: React.FC<{ chainName: string }> = ({ chainName }) => {
  const [registry, setRegistry] = useState<CarryForecastRegistry | null>(null)
  const [registryError, setRegistryError] = useState(false)
  const [registryLoading, setRegistryLoading] = useState(true)
  const [routeKey, setRouteKey] = useState('')
  const [vault, setVault] = useState('')
  const [exitSize, setExitSize] = useState(DEFAULT_EXIT_SIZE)
  const [scenarioMode, setScenarioMode] = useState<CarryScenarioMode>('exit')
  const [depositSize, setDepositSize] = useState(DEFAULT_EXIT_SIZE)
  const depositInitialized = useRef(false)
  const plannedExitEdited = useRef(false)
  const [initialDepositIssue, setInitialDepositIssue] =
    useState<InitialDepositScenarioIssue | null>(null)
  const [fluidBridgeUsdcLegSize, setFluidBridgeUsdcLegSize] = useState('1')
  const [stakedUsdatShares, setStakedUsdatShares] = useState('10')
  const [stakedUsdatTokenId, setStakedUsdatTokenId] = useState('')
  const [apyUsdReceiptTokenId, setApyUsdReceiptTokenId] = useState('')
  const [twyneCollateralVault, setTwyneCollateralVault] = useState('')
  const [twynePtSize, setTwynePtSize] = useState('1')
  const [primeShares, setPrimeShares] = useState('1')
  const [horizonHours, setHorizonHours] = useState<1 | 24 | 48 | 168 | 336 | 720>(1)
  const [holderAddress, setHolderAddress] = useState('')
  const [holderTimeProcessIssue, setHolderTimeProcessIssue] =
    useState<HolderTimeProcessIssue | null>(null)
  const [holderCapacityAgreement, setHolderCapacityAgreement] = useState<unknown>(null)
  const [holderStusdsProtocolCapacityEvidence, setHolderStusdsProtocolCapacityEvidence] =
    useState<unknown>(null)
  const [holderMorphoV2ProtocolCapacityEvidence, setHolderMorphoV2ProtocolCapacityEvidence] =
    useState<unknown>(null)
  const [
    holderMorphoV2CurrentHolderPositionEvidence,
    setHolderMorphoV2CurrentHolderPositionEvidence,
  ] = useState<unknown>(null)
  const [holderMorphoV2HistoricalHolderEaEvidence, setHolderMorphoV2HistoricalHolderEaEvidence] =
    useState<unknown>(null)
  const [holderSaturnForecastIssue, setHolderSaturnForecastIssue] = useState<SaturnAppForecastIssue | null>(null)
  const [holderMorphoV2IdleJointIssue, setHolderMorphoV2IdleJointIssue] =
    useState<ExitPressureMorphoV2IdleJointIssue | null>(null)
  const [holderCometFactsAgreement, setHolderCometFactsAgreement] = useState<unknown>(null)
  const [holderUsd3JointIssue, setHolderUsd3JointIssue] =
    useState<ExitPressureUsd3JointIssue | null>(null)
  const [holderFluidUsdcBridgeJointIssue, setHolderFluidUsdcBridgeJointIssue] =
    useState<ExitPressureFluidUsdcBridgeJointIssue | null>(null)
  const [holderFluidUsdtBridgeJointIssue, setHolderFluidUsdtBridgeJointIssue] =
    useState<ExitPressureFluidUsdtBridgeJointIssue | null>(null)
  const [liveExit, setLiveExit] = useState<LiveExitState>({ status: 'idle' })
  const [holderUmbrellaGhoJointIssue, setHolderUmbrellaGhoJointIssue] =
    useState<ExitPressureUmbrellaGhoJointIssue | null>(null)
  const [holderApyUsdJointIssue, setHolderApyUsdJointIssue] =
    useState<ExitPressureApyUsdJointIssue | null>(null)
  const [checkClockMs, setCheckClockMs] = useState(() => Date.now())
  useEffect(() => {
    const refreshClock = () => setCheckClockMs(Date.now())
    const interval = window.setInterval(refreshClock, 30_000)
    window.addEventListener('focus', refreshClock)
    window.addEventListener('visibilitychange', refreshClock)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshClock)
      window.removeEventListener('visibilitychange', refreshClock)
    }
  }, [])
  useEffect(() => {
    if (liveExit.status !== 'assessment_result') return
    const condition = liveExit.assessment.condition
    const pending = liveExit.assessment.cooldownCondition
    const deadlineSeconds =
      condition?.gate === 'window_open'
        ? condition.windowEndInclusive
        : condition?.gate === 'waiting'
          ? condition.cooldownEnd
          : null
    const deadlineMs =
      deadlineSeconds !== null && Number.isSafeInteger(deadlineSeconds)
        ? condition?.gate === 'window_open'
          ? (deadlineSeconds + 1) * 1000
          : deadlineSeconds * 1000
        : pending?.pendingClaimStatus === 'not_yet_eligible'
          ? Date.parse(pending.pendingClaimEarliestAt ?? '')
          : NaN
    if (!Number.isFinite(deadlineMs)) return
    const timeout = window.setTimeout(
      () => setCheckClockMs(Date.now()),
      Math.max(0, deadlineMs - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [liveExit])
  const [localHolderWatch, setLocalHolderWatch] = useState(false)
  const [holderWatch, setHolderWatch] = useState<HolderWatchView>({ status: 'idle' })
  const holderWatchRequest = useRef<AbortController | null>(null)
  const [alertScope, setAlertScope] = useState<ExitEvidenceScope | null>(null)
  const alertRequestId = useRef(0)
  const liveExitRequest = useRef<AbortController | null>(null)
  const [observation, setObservation] = useState<RouteObservations | null>(null)
  const [observationError, setObservationError] = useState(false)
  const [observationLoading, setObservationLoading] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [routeForecastData, setRouteForecastData] = useState<RouteCashForecastView | null>(null)
  const [routeForecastLiveData, setRouteForecastLiveData] = useState<RouteCashForecastView | null>(
    null,
  )
  const [routeForecastLoading, setRouteForecastLoading] = useState(false)
  const [routeForecastError, setRouteForecastError] = useState(false)
  const [routeForecastUnavailable, setRouteForecastUnavailable] =
    useState<RouteForecastUnavailable | null>(null)
  const [routeEventContext, setRouteEventContext] = useState<RouteEventContextResponse | null>(null)
  const [holderEvidence, setHolderEvidence] = useState<HolderExitEvidenceView | null>(null)
  const [forceabilityEvidence, setForceabilityEvidence] =
    useState<HolderExitForceabilityView | null>(null)
  const [apyUsdOpenReceiptCurrent, setApyUsdOpenReceiptCurrent] =
    useState<ApyUsdOpenReceiptCurrent | null>(null)
  const queueRequestEvidenceCell = holderEvidence?.queueRequestEvidence?.cells.find(
    (cell) => cell.horizonHours === horizonHours,
  )
  const receiptInitiationEvidenceCell = holderEvidence?.receiptInitiationEvidence?.cells.find(
    (cell) => cell.horizonHours === horizonHours,
  )
  const fluidHolderEvidenceCell = holderEvidence?.fluidHolderEvidence?.cells.find(
    (cell) => cell.horizonHours === horizonHours,
  )
  const primeFirstStageCell = holderEvidence?.primeFirstStageEvidence?.cells.find(
    (cell) => cell.horizonHours === horizonHours,
  )
  const holderEvidenceSummary = useMemo(() => {
    if (holderEvidence?.status !== 'available') return null
    const cells = holderEvidence.cells.filter((cell) => cell.horizonHours === horizonHours)
    if (cells.length === 0) return null
    return cells.reduce(
      (sum, cell) => ({
        issued: sum.issued + cell.issued,
        eligible: sum.eligible + cell.baselineEligible,
        impaired: sum.impaired + cell.baselineImpaired,
        measured: sum.measured + cell.onTimeMeasured,
        success: sum.success + cell.onTimeMeasuredSuccess,
        nonSuccess: sum.nonSuccess + cell.onTimeMeasuredNonSuccess,
        unknown: sum.unknown + cell.onTimeUnknownRevert,
        attrition: sum.attrition + cell.onTimeHolderAttrition,
        unavailable: sum.unavailable + cell.outcomeUnavailable,
        missing: sum.missing + cell.outcomeMissing,
        pending: sum.pending + cell.outcomePending,
        recovered: sum.recovered + cell.impairedSimulatedRecovery,
        stillReverting: sum.stillReverting + cell.impairedStillReverting,
        impairedAttrition: sum.impairedAttrition + cell.impairedHolderAttrition,
        impairedInconclusive: sum.impairedInconclusive + cell.impairedInconclusiveRevert,
        impairedPending: sum.impairedPending + cell.impairedOutcomePending,
        impairedMissing: sum.impairedMissing + cell.impairedOutcomeMissing,
        impairedUnavailable: sum.impairedUnavailable + cell.impairedOutcomeUnavailable,
      }),
      {
        issued: 0,
        eligible: 0,
        impaired: 0,
        measured: 0,
        success: 0,
        nonSuccess: 0,
        unknown: 0,
        attrition: 0,
        unavailable: 0,
        missing: 0,
        pending: 0,
        recovered: 0,
        stillReverting: 0,
        impairedAttrition: 0,
        impairedInconclusive: 0,
        impairedPending: 0,
        impairedMissing: 0,
        impairedUnavailable: 0,
      },
    )
  }, [holderEvidence, horizonHours])
  const [historicalCash, setHistoricalCash] = useState<CarryHistoricalCashContext | null>(null)
  const [historicalGrossFlow, setHistoricalGrossFlow] = useState<HistoricalGrossFlowStress | null>(
    null,
  )
  const [historicalMarketGrossFlow, setHistoricalMarketGrossFlow] =
    useState<HistoricalMarketGrossFlowResponse | null>(null)
  const [directFlowContext, setDirectFlowContext] = useState<DirectSupplierFlowContext | null>(null)
  const [directSupplyContext, setDirectSupplyContext] =
    useState<DirectSupplierSupplyContext | null>(null)
  const [morphoPayoutContext, setMorphoPayoutContext] = useState<MorphoV2PayoutContext | null>(null)
  const assetUnit =
    routeKey === PYUSD_STAKING_ROUTE
      ? 'PYUSD'
      : routeKey === STAKED_USDAT_ROUTE
        ? 'AUSD'
        : routeKey === TWYNE_PT_ROUTE
          ? 'USDe'
          : routeKey === 'USDT → FluidBridgeAggregatorProxy [USDC]'
            ? 'USDT'
            : (routeKey.match(/\[([^\]]+)\]$/)?.[1] ?? routeKey.split(' → ')[0] ?? 'units')
  const historicalAssetSymbol = historicalExitAssetSymbol(routeKey)
  const validStakedUsdatShares =
    /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(stakedUsdatShares) &&
    Number.isFinite(Number(stakedUsdatShares)) &&
    Number(stakedUsdatShares) > 0
  const validStakedUsdatTokenId =
    stakedUsdatTokenId === '' ||
    (/^(0|[1-9]\d{0,77})$/.test(stakedUsdatTokenId) &&
      BigInt(stakedUsdatTokenId) <= (1n << 256n) - 1n)
  const validApyUsdReceiptTokenId =
    apyUsdReceiptTokenId === '' ||
    (/^[1-9]\d{0,77}$/.test(apyUsdReceiptTokenId) &&
      BigInt(apyUsdReceiptTokenId) <= (1n << 256n) - 1n)
  const validTwyneCollateralVault = /^0x[0-9a-fA-F]{40}$/.test(twyneCollateralVault.trim())
  const validTwynePtSize = rawExitAmount(twynePtSize, 18) !== null
  const primeSharesInputRaw = rawExitAmount(primeShares, 6)
  const validPrimeShares = primeSharesInputRaw !== null && BigInt(primeSharesInputRaw) <= 10n ** 18n
  const validExitSize =
    /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(exitSize) &&
    Number.isFinite(Number(exitSize)) &&
    Number(exitSize) > 0 &&
    Number(exitSize) <= 1_000_000_000_000_000
  const validFluidBridgeUsdcLegSize = rawExitAmount(fluidBridgeUsdcLegSize, 6) !== null

  useEffect(() => {
    const controller = new AbortController()
    async function loadUniverse() {
      try {
        const response = await fetch('/api/carry/forecast-universe', { signal: controller.signal })
        if (!response.ok) throw new Error('universe_unavailable')
        const result = (await response.json()) as CarryForecastRegistry
        if (!Array.isArray(result.routeGroups) || result.status !== 'source_inventory_only') {
          throw new Error('universe_invalid')
        }
        setRegistry(result)
        const initialGroup =
          result.routeGroups.find((group) => group.routeKey === SGHO_ROUTE) ?? result.routeGroups[0]
        setRouteKey(initialGroup?.routeKey ?? '')
        setVault(initialGroup?.contractSubjects[0]?.destinationAddress ?? '')
      } catch {
        if (!controller.signal.aborted) setRegistryError(true)
      } finally {
        if (!controller.signal.aborted) setRegistryLoading(false)
      }
    }
    void loadUniverse()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!routeKey) return
    const controller = new AbortController()
    setObservation(null)
    setObservationError(false)
    setObservationLoading(true)
    async function loadRoute() {
      try {
        const response = await fetch(
          `/api/carry/forecast-observations?routeKey=${encodeURIComponent(routeKey)}`,
          {
            signal: controller.signal,
          },
        )
        if (!response.ok) throw new Error('observation_unavailable')
        const result = (await response.json()) as RouteObservations
        if (result.routeKey !== routeKey || !Array.isArray(result.destinations)) {
          throw new Error('observation_invalid')
        }
        setObservation(result)
      } catch {
        if (!controller.signal.aborted) setObservationError(true)
      } finally {
        if (!controller.signal.aborted) setObservationLoading(false)
      }
    }
    void loadRoute()
    return () => controller.abort()
  }, [routeKey, refreshVersion])

  const group = useMemo(() => {
    const matches = registry?.routeGroups.filter((entry) => entry.routeKey === routeKey)
    return matches?.length === 1 ? matches[0] : undefined
  }, [registry, routeKey])
  const matchingSubjects = group?.contractSubjects.filter(
    (entry) => entry.destinationAddress.toLowerCase() === vault.toLowerCase(),
  )
  const subject = matchingSubjects?.length === 1 ? matchingSubjects[0] : undefined
  const destination = subject?.destinationAddress ?? ''
  const routeEventExpectedEnrollment = useMemo(
    () => expectedRouteEventEnrollment(subject?.sourceCoverage.recorderVenues),
    [subject],
  )
  const directFlowMarketKey = DIRECT_FLOW_MARKET_BY_ROUTE[routeKey]
  useEffect(() => {
    setDirectFlowContext(null)
    if (!directFlowMarketKey || !destination) return
    const controller = new AbortController()
    const query = new URLSearchParams({ marketKey: directFlowMarketKey })
    const load = async () => {
      try {
        const response = await fetch(`/api/carry/direct-supplier-flow-context?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result: unknown = await response.json()
        if (
          isMatchingDirectSupplierFlowContext(result, directFlowMarketKey, routeKey, destination) &&
          !controller.signal.aborted
        )
          setDirectFlowContext(result)
      } catch {
        // Local historical evidence may be absent for this market.
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 30 * 60_000)
    return () => {
      window.clearInterval(interval)
      controller.abort()
    }
  }, [destination, directFlowMarketKey, refreshVersion, routeKey])
  const selectedDirectFlow =
    directFlowContext &&
    directFlowMarketKey &&
    isMatchingDirectSupplierFlowContext(
      directFlowContext,
      directFlowMarketKey,
      routeKey,
      destination,
    )
      ? directFlowContext
      : null
  useEffect(() => {
    setDirectSupplyContext(null)
    if (!directFlowMarketKey || !destination) return
    const controller = new AbortController()
    const query = new URLSearchParams({ marketKey: directFlowMarketKey })
    const load = async () => {
      try {
        const response = await fetch(`/api/carry/direct-supplier-supply-context?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result: unknown = await response.json()
        if (
          isMatchingDirectSupplierSupplyContext(
            result,
            directFlowMarketKey,
            routeKey,
            destination,
          ) &&
          !controller.signal.aborted
        )
          setDirectSupplyContext(result)
      } catch {
        // Keep observed withdrawal evidence when the independent supply archive is absent.
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 30 * 60_000)
    return () => {
      window.clearInterval(interval)
      controller.abort()
    }
  }, [destination, directFlowMarketKey, refreshVersion, routeKey])
  const selectedDirectSupply =
    directSupplyContext &&
    directFlowMarketKey &&
    isMatchingDirectSupplierSupplyContext(
      directSupplyContext,
      directFlowMarketKey,
      routeKey,
      destination,
    )
      ? directSupplyContext
      : null
  useEffect(() => {
    setMorphoPayoutContext(null)
    if (!routeKey.includes('→ VaultV2 [') || !destination) return
    const controller = new AbortController()
    const query = new URLSearchParams({ routeKey, destination })
    const load = async () => {
      try {
        const response = await fetch(`/api/carry/morpho-v2-payout-context?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result: unknown = await response.json()
        if (
          isMatchingMorphoV2PayoutContext(result, routeKey, destination) &&
          !controller.signal.aborted
        )
          setMorphoPayoutContext(result)
      } catch {
        // Local historical evidence may be absent for this vault.
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 30 * 60_000)
    return () => {
      window.clearInterval(interval)
      controller.abort()
    }
  }, [destination, refreshVersion, routeKey])
  const selectedMorphoPayout =
    morphoPayoutContext &&
    isMatchingMorphoV2PayoutContext(morphoPayoutContext, routeKey, destination)
      ? morphoPayoutContext
      : null
  useEffect(() => {
    setHistoricalCash(null)
    if (!destination || !shouldShowHistoricalCashContext(routeKey, destination)) return
    const controller = new AbortController()
    const query = new URLSearchParams({ routeKey, destination })
    const isMatchingContext = (result: CarryHistoricalCashContext) =>
      result.routeKey === routeKey &&
      result.destination === destination.toLowerCase() &&
      ['historical_context', 'unavailable'].includes(result.status)
    void (async () => {
      try {
        const response = await fetch(`/api/carry/historical-cash-context?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('historical_cash_unavailable')
        const result = (await response.json()) as CarryHistoricalCashContext
        if (!isMatchingContext(result) || controller.signal.aborted) return
        setHistoricalCash(result)
      } catch {
        // Historical context is optional; the exact subject card omits absent evidence.
      }
    })()
    return () => controller.abort()
  }, [destination, refreshVersion, routeKey])
  const isTwynePtReserve = destination.toLowerCase() === TWYNE_PT_WRAPPER
  const selected = observation?.destinations.find(
    (entry) => entry.vault.toLowerCase() === vault.toLowerCase(),
  )
  useEffect(() => {
    setHistoricalGrossFlow(null)
    const market = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
    if (
      routeKey !== AAVE_USDC_ROUTE ||
      destination.toLowerCase() !== market.destination.toLowerCase() ||
      !selected ||
      selected.vault.toLowerCase() !== market.destination.toLowerCase() ||
      selected.asset.toLowerCase() !== market.underlying.toLowerCase() ||
      selected.assetDecimals !== market.decimals ||
      selected.marketKind !== 'aave_v3_atoken' ||
      selected.routeAssetIdentity !== 'market_verified'
    )
      return
    const requestedRaw = rawExitAmount(exitSize, market.decimals)
    if (!requestedRaw || BigInt(requestedRaw) === 0n) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ routeKey, destination, requestedRaw })
      void (async () => {
        try {
          const response = await fetch(`/api/carry/historical-flow-stress?${query}`, {
            signal: controller.signal,
          })
          if (!response.ok) return
          const result = (await response.json()) as HistoricalGrossFlowStress
          const ageMs = Date.now() - Date.parse(result.currentCash?.blockTimestamp ?? '')
          if (
            result.status !== 'historical_flow_stress' ||
            result.chainId !== 1 ||
            result.marketKey !== 'aaveV3Usdc' ||
            result.routeKey !== routeKey ||
            result.destination !== destination.toLowerCase() ||
            result.requestedRaw !== requestedRaw ||
            result.asset?.toLowerCase() !== market.underlying.toLowerCase() ||
            result.assetDecimals !== market.decimals ||
            result.archiveVerification !== 'full_sealed_replay' ||
            !/^[0-9a-f]{64}$/.test(result.archiveArtifactSha256 ?? '') ||
            result.currentCash?.rpcHostAgreement !== 'multi_rpc_host_match' ||
            !/^[0-9]+$/.test(result.currentCash?.cashRaw ?? '') ||
            !Number.isSafeInteger(result.currentCash?.blockNumber) ||
            !/^0x[0-9a-fA-F]{64}$/.test(result.currentCash?.blockHash ?? '') ||
            !Number.isSafeInteger(Date.parse(result.currentCash?.blockTimestamp ?? '')) ||
            new Date(Date.parse(result.currentCash.blockTimestamp)).toISOString() !==
              result.currentCash.blockTimestamp ||
            !Number.isFinite(ageMs) ||
            ageMs < -120_000 ||
            ageMs > 30 * 60_000 ||
            result.stress?.validation !== 'not_validated' ||
            result.stress.holderExecutableExit !== false ||
            result.stress.nonoverlappingWindowCount < 1 ||
            !/^[0-9a-f]{64}$/.test(result.stress.pairedWindowSha256 ?? '') ||
            result.stress.historicalScenarios?.selection !==
              'retrospective_observed_rank_not_forecast_probability' ||
            result.stress.historicalScenarios.horizonBlocks !== result.stress.horizonBlocks ||
            result.stress.historicalScenarios.sampleCount !==
              result.stress.nonoverlappingWindowCount ||
            result.stress.historicalScenarios.p10Trough.rank !==
              Math.floor((result.stress.nonoverlappingWindowCount - 1) * 0.1) + 1 ||
            result.stress.historicalScenarios.worstTrough.rank !== 1 ||
            result.stress.historicalScenarios.highestGrossOutflow.rank !== 1 ||
            ![
              result.stress.historicalScenarios.p10Trough,
              result.stress.historicalScenarios.worstTrough,
              result.stress.historicalScenarios.highestGrossOutflow,
            ].every((window) =>
              validHistoricalFlowWindow(
                window,
                result.stress.nonoverlappingWindowCount,
                result.stress.horizonBlocks,
                result.stress.source,
                result.currentCash.cashRaw,
                requestedRaw,
              ),
            ) ||
            !/^-?[0-9]+$/.test(result.stress.currentCashMarginToRequestedRaw ?? '') ||
            BigInt(result.stress.currentCashMarginToRequestedRaw) !==
              BigInt(result.currentCash.cashRaw) - BigInt(requestedRaw) ||
            !/^[0-9]+$/.test(result.stress.grossReserveInRaw?.upper ?? '') ||
            !/^[0-9]+$/.test(result.stress.grossReserveOutRaw?.upper ?? '') ||
            !/^[0-9]+$/.test(result.stress.exactWindowExtrema?.maxGrossReserveInRaw ?? '') ||
            !/^[0-9]+$/.test(result.stress.exactWindowExtrema?.maxGrossReserveOutRaw ?? '') ||
            !/^-?[0-9]+$/.test(result.stress.troughMarginToRequestedRaw?.lower ?? '') ||
            !/^-?[0-9]+$/.test(
              result.stress.exactWindowExtrema?.minTroughMarginToRequestedRaw ?? '',
            ) ||
            !/^[0-9]+$/.test(result.stress.exactWindowExtrema?.maxTroughReplayDeficitRaw ?? '')
          )
            return
          if (!controller.signal.aborted) setHistoricalGrossFlow(result)
        } catch {
          // A retrospective flow row is optional; current holder exit evidence stays separate.
        }
      })()
    }, 450)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [destination, exitSize, refreshVersion, routeKey, selected])
  const historicalGrossFlowVisible =
    historicalGrossFlow &&
    isFreshHistoricalCashBlock(historicalGrossFlow.currentCash.blockTimestamp, checkClockMs)
      ? historicalGrossFlow
      : null
  const historicalProjectionRequest = (() => {
    if (historicalCash?.status !== 'historical_context') return null
    try {
      const subject = resolveHolderExitSubject(routeKey, destination.toLowerCase() as `0x${string}`)
      if (subject.payoutAsset.toLowerCase() === historicalCash.asset.toLowerCase()) {
        const requestedRaw = rawExitAmount(exitSize, historicalCash.assetDecimals)
        return requestedRaw
          ? {
              requestedRaw,
              requestScope: 'route_exit' as const,
              requestedAssetAddress: subject.payoutAsset.toLowerCase(),
              requestedAssetSymbol: historicalExitAssetSymbol(routeKey) ?? assetUnit,
            }
          : null
      }
    } catch {
      // Unknown subjects and asset-mismatched staged routes cannot support Q arithmetic.
    }
    return null
  })()
  const historicalCashStress =
    historicalCash?.status === 'historical_context' && historicalProjectionRequest
      ? projectAggregateCashStress24h(
          historicalCash,
          {
            route_key: routeKey,
            destination: destination.toLowerCase(),
            asset: historicalCash.asset.toLowerCase(),
          },
          historicalProjectionRequest.requestedRaw,
          checkClockMs,
        )
      : null
  const canonicalExitDecimals = canonicalCurrentExitDecimals(
    routeKey,
    destination,
    selected,
    observation !== null,
    subject?.sourceCoverage.sghoLiveRoute === true,
  )
  const isUmbrellaGho =
    routeKey === UMBRELLA_GHO_ROUTE &&
    destination.toLowerCase() === UMBRELLA_STKGHO &&
    (!selected ||
      (selected.vault.toLowerCase() === UMBRELLA_STKGHO &&
        selected.asset.toLowerCase() === ORIGINAL_GHO &&
        selected.assetDecimals === 18))
  useEffect(() => {
    if (horizonHours > 168 && (!isUmbrellaGho || scenarioMode !== 'exit')) setHorizonHours(168)
  }, [horizonHours, isUmbrellaGho, scenarioMode])
  const isApyUsd = isApyUsdCurrentExitRoute(routeKey, destination, selected)
  const isStakedUsdat = isStakedUsdatCurrentExitRoute(routeKey, destination, selected)
  const isTwynePt = isTwynePtCurrentExitRoute(routeKey, destination, selected)
  const exitAssetDecimals =
    isStakedUsdat || isPyusdStakingSubject(routeKey, destination)
      ? 6
      : isUmbrellaGho || isApyUsd || isTwynePt
        ? 18
        : routeKey === SGHO_ROUTE || routeKey === AAVE_USDE_MARKET.routeKey
          ? canonicalExitDecimals
          : (selected?.assetDecimals ?? null)
  const isTrackedDirectVault = isTrackedDirectVaultExitRoute(routeKey, destination, selected)
  const morphoAssessmentTarget = useMemo(
    () => resolvedMorphoAssessmentTarget(routeKey, destination),
    [routeKey, destination],
  )
  const isFluidBridgeUsdtLeg = routeKey === FLUID_USDT_ROUTE && isTrackedDirectVault
  const boundAssessment =
    scenarioMode === 'exit' &&
    liveExit.status === 'assessment_result' &&
    liveExit.assessment.routeKey === routeKey &&
    liveExit.assessment.destinationAddress.toLowerCase() === destination.toLowerCase() &&
    liveExit.assessment.owner.toLowerCase() === holderAddress.trim().toLowerCase() &&
    liveExit.assessment.request.assetsRaw === rawExitAmount(exitSize, exitAssetDecimals ?? -1) &&
    liveExit.assessment.request.horizonHours === horizonHours &&
    (!isStakedUsdat ||
      (liveExit.assessment.request.sharesRaw === rawExitAmount(stakedUsdatShares, 18) &&
        liveExit.assessment.request.requestTokenId ===
          (stakedUsdatTokenId === '' ? undefined : stakedUsdatTokenId))) &&
    (!isApyUsd ||
      liveExit.assessment.request.receiptTokenId ===
        (apyUsdReceiptTokenId === '' ? undefined : apyUsdReceiptTokenId)) &&
    (!isTwynePt ||
      (liveExit.assessment.request.collateralVault?.toLowerCase() ===
        twyneCollateralVault.trim().toLowerCase() &&
        liveExit.assessment.request.ptRaw === rawExitAmount(twynePtSize, 18))) &&
    (!isPyusdStakingSubject(routeKey, destination) ||
      liveExit.assessment.request.primeSharesRaw === rawExitAmount(primeShares, 6)) &&
    (!isFluidBridgeUsdtLeg ||
      liveExit.assessment.stages[0]?.amountRaw === rawExitAmount(fluidBridgeUsdcLegSize, 6))
      ? liveExit.assessment
      : null
  const selectedAssessment =
    boundAssessment && isCurrentHolderExitAssessment(boundAssessment, checkClockMs)
      ? boundAssessment
      : null
  const currentExitRequestedRaw = rawExitAmount(exitSize, exitAssetDecimals ?? -1)
  const routeForecastPayoutAsset = (() => {
    if (!destination) return null
    try {
      return resolveHolderExitSubject(routeKey, destination.toLowerCase() as `0x${string}`)
        .payoutAsset
    } catch {
      return null
    }
  })()
  useEffect(() => {
    setHistoricalMarketGrossFlow(null)
    if (
      !group ||
      !subject ||
      !/^0x[0-9a-fA-F]{40}$/.test(destination) ||
      ![24, 168].includes(horizonHours)
    )
      return
    const controller = new AbortController()
    const query = new URLSearchParams({
      routeKey,
      destination: destination.toLowerCase(),
      horizonHours: String(horizonHours),
    })
    void (async () => {
      try {
        const response = await fetch(`/api/carry/historical-gross-flow?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result = selectHistoricalMarketGrossFlow(
          await response.json(),
          routeKey,
          destination,
          horizonHours,
          routeForecastPayoutAsset,
          exitAssetDecimals,
        )
        if (!controller.signal.aborted) setHistoricalMarketGrossFlow(result)
      } catch {
        // The retrospective gross-flow lane is independent of other exit evidence.
      }
    })()
    return () => controller.abort()
  }, [
    destination,
    exitAssetDecimals,
    group,
    horizonHours,
    refreshVersion,
    routeForecastPayoutAsset,
    routeKey,
    subject,
  ])
  const selectedHistoricalAssayQuestion = historicalAssayQuestion({
    routeKey,
    exitSize,
    exitAssetSymbol: assetUnit,
    exitAssetDecimals,
    selectedAsset: selected?.asset ?? null,
    selectedAssetDecimals: selected?.assetDecimals ?? null,
    payoutAsset: routeForecastPayoutAsset,
    fluidBridgeUsdcLegSize,
    verifiedFluidBridgeUsdcLeg: isFluidBridgeUsdtLeg,
  })
  const routeForecastQuestion: RouteForecastQuestion = {
    routeKey,
    destination: destination.toLowerCase(),
    amountUnits: exitSize,
    horizonHours,
    payoutAsset: routeForecastPayoutAsset,
    payoutAssetDecimals: exitAssetDecimals,
  }
  const routeEventQuestion = useMemo<RouteEventQuestion | null>(
    () =>
      currentExitRequestedRaw && routeForecastPayoutAsset && exitAssetDecimals !== null
        ? {
            routeKey,
            destination: destination.toLowerCase(),
            requestedRaw: currentExitRequestedRaw,
            payoutAsset: routeForecastPayoutAsset.toLowerCase(),
            assetDecimals: exitAssetDecimals,
            horizonHours,
          }
        : null,
    [
      currentExitRequestedRaw,
      destination,
      exitAssetDecimals,
      horizonHours,
      routeForecastPayoutAsset,
      routeKey,
    ],
  )
  const selectedRouteEventContext =
    routeEventQuestion && routeEventExpectedEnrollment
      ? matchingRouteEventContext(
          routeEventContext,
          routeEventQuestion,
          routeEventExpectedEnrollment,
        )
      : null
  const selectedRouteForecast =
    matchingRouteForecastResponse(routeForecastLiveData, routeForecastQuestion) ??
    matchingRouteForecastResponse(routeForecastData, routeForecastQuestion)
  const analogCashIssue = useMemo(
    () => snapshotAnalogCashScenarioIssue(selectedRouteForecast?.analogCashScenario),
    [selectedRouteForecast?.analogCashScenario],
  )
  const analogCurrent = routeForecastQuestion
    ? analogCashCurrentForWorkbench(analogCashIssue, routeForecastQuestion, assetUnit, checkClockMs)
    : null
  const selectedProspectiveCashModel =
    selectedRouteForecast?.prospectiveCashModel ??
    routeForecastUnavailable?.prospectiveCashModel ??
    null
  const selectedHistoricalCash =
    historicalCash?.status === 'historical_context' &&
    historicalCash.routeKey === routeKey &&
    historicalCash.destination === destination.toLowerCase()
      ? historicalCash
      : null
  const historicalBacktestCandidate =
    selectedRouteForecast?.exitImpact?.historicalBacktest?.status === 'historical_backtest'
      ? selectedRouteForecast.exitImpact.historicalBacktest
      : null
  const historicalBacktestRequestedRaw = historicalBacktestCandidate
    ? rawExitAmount(exitSize, historicalBacktestCandidate.identity.assetDecimals)
    : null
  const historicalBacktestPayoutAsset = routeForecastPayoutAsset
  const exitPressureHistoricalBacktest =
    historicalBacktestCandidate &&
    historicalBacktestRequestedRaw &&
    historicalBacktestPayoutAsset &&
    historicalBacktestCandidate.identity.asset.toLowerCase() ===
      historicalBacktestPayoutAsset.toLowerCase() &&
    historicalBacktestCandidate.question.requestedRaw === historicalBacktestRequestedRaw
      ? historicalBacktestCandidate
      : null
  const sampledCandidate = selectedRouteForecast?.sampledCashPaths
  const sampledCurrent =
    sampledCandidate?.status === 'conditional_historical_sampled_cash_paths' &&
    sampledCandidate.identity.routeKey === routeKey &&
    sampledCandidate.identity.destination.toLowerCase() === destination.toLowerCase() &&
    sampledCandidate.identity.asset.toLowerCase() === routeForecastPayoutAsset?.toLowerCase() &&
    sampledCandidate.requestedRaw ===
      rawExitAmount(exitSize, sampledCandidate.identity.assetDecimals)
      ? sampledCandidate
      : null
  const historicalCurrent = selectedHistoricalCash?.current ?? null
  const observedAt = observation?.observedAt
  const validObservedAt = observedAt && Number.isFinite(Date.parse(observedAt)) ? observedAt : null
  const cashLabel: ExitPressureCurrentCash['label'] =
    selectedRouteForecast?.forecast.cashKind === 'direct_buffer_only' ||
    selected?.cashInterpretation === 'direct_buffer_only'
      ? 'Direct buffer'
      : selectedRouteForecast?.forecast.cashKind === 'market_cash' || selected?.marketKind
        ? 'Market cash'
        : 'Vault cash'
  const conditionalExitPressure = conditionalExitPressureEvidence(
    selectedRouteForecast,
    routeForecastQuestion,
    assetUnit,
    cashLabel,
  )
  const exitPressureRequestedRaw =
    conditionalExitPressure?.historicalScenario.requestedRaw ??
    exitPressureHistoricalBacktest?.question.requestedRaw ??
    currentExitRequestedRaw
  const exitPressureCurrentCashBase: ExitPressureCurrentCash | null = conditionalExitPressure
    ? conditionalExitPressure.currentCash
    : sampledCurrent
      ? {
          routeKey,
          destination: destination.toLowerCase(),
          cashRaw: sampledCurrent.current.cashRaw,
          assetDecimals: sampledCurrent.identity.assetDecimals,
          assetSymbol: assetUnit,
          assetAddress: sampledCurrent.identity.asset,
          observedAt: sampledCurrent.current.blockAt,
          block: sampledCurrent.current.block,
          blockHash: sampledCurrent.current.blockHash,
          freshness: 'fresh',
          label: cashLabel,
        }
      : analogCurrent
        ? analogCurrent
        : historicalCurrent
          ? {
              routeKey,
              destination: destination.toLowerCase(),
              cashRaw: historicalCurrent.cashRaw,
              assetDecimals: selectedHistoricalCash!.assetDecimals,
              assetSymbol: historicalAssetSymbol ?? assetUnit,
              assetAddress: selectedHistoricalCash!.asset.toLowerCase(),
              observedAt: historicalCurrent.blockAt,
              block: historicalCurrent.block,
              blockHash: historicalCurrent.blockHash,
              freshness: historicalCurrent.freshness,
              label:
                selected?.cashInterpretation === 'direct_buffer_only'
                  ? 'Direct buffer'
                  : 'Market cash',
            }
          : selected?.cashRaw &&
              /^\d+$/.test(selected.cashRaw) &&
              validObservedAt &&
              selected.cashInterpretation !== 'wrapped_atoken_exit_cash_unassessed'
            ? {
                routeKey,
                destination: destination.toLowerCase(),
                cashRaw: selected.cashRaw,
                assetDecimals: selected.assetDecimals,
                assetSymbol: historicalAssetSymbol ?? assetUnit,
                assetAddress: selected.asset.toLowerCase(),
                observedAt: validObservedAt,
                freshness: observation?.freshness ?? 'stale',
                label:
                  selected.cashInterpretation === 'direct_buffer_only'
                    ? 'Direct buffer'
                    : selected.marketKind
                      ? 'Market cash'
                      : 'Vault cash',
              }
            : null
  const exitPressureCurrentCash = eventImpactCurrentForWorkbench(
    withBoundSampledCashCurrentMetadata(exitPressureCurrentCashBase, sampledCurrent?.current),
    selectedRouteForecast?.conditionalEventImpactCurrentSource,
    routeForecastQuestion,
    assetUnit,
    cashLabel,
    checkClockMs,
  )
  const fallbackScenarioHigh =
    selectedHistoricalCash && historicalCashStress?.status === 'available'
      ? nonnegativeRawSum(
          historicalCashStress.currentCashRaw,
          selectedHistoricalCash.p90NetChangeRaw,
        )
      : null
  const exitPressureHistoricalScenario: ExitPressureHistoricalScenario | null =
    conditionalExitPressure?.historicalScenario ??
    (historicalCashStress?.status === 'available' &&
    fallbackScenarioHigh &&
    historicalProjectionRequest
      ? {
          routeKey,
          destination: destination.toLowerCase(),
          horizonHours: 24,
          claim: 'aggregate_cash_proxy_only',
          prospectiveValidated: false,
          holderExecutableExit: false,
          pointRaw: historicalCashStress.p10ProjectedCashRaw,
          bandLowRaw: historicalCashStress.worstSampledProjectedCashRaw,
          bandHighRaw: fallbackScenarioHigh,
          assetDecimals: historicalCashStress.assetDecimals,
          assetSymbol: historicalProjectionRequest.requestedAssetSymbol,
          assetAddress: historicalCashStress.asset.toLowerCase(),
          currentBlockAt: historicalCashStress.currentBlockAt,
          currentBlock: historicalCashStress.currentBlock,
          currentBlockHash: historicalCashStress.currentBlockHash,
          targetAt: new Date(
            Date.parse(historicalCashStress.currentBlockAt) + 24 * 60 * 60 * 1000,
          ).toISOString(),
          sampleCount: historicalCashStress.sampleCount,
          method: 'historical_net_change',
          requestedRaw: historicalCashStress.requestedAssetsRaw,
          requestedAssetAddress: historicalProjectionRequest.requestedAssetAddress,
          requestedAssetSymbol: historicalProjectionRequest.requestedAssetSymbol,
          requestScope: historicalProjectionRequest.requestScope,
          currentCashRaw: historicalCashStress.currentCashRaw,
          validation: null,
        }
      : null)
  const directWithdrawalMaximum =
    selectedDirectFlow?.max24hGrossWithdrawal.status === 'observed'
      ? {
          amountRaw: selectedDirectFlow.max24hGrossWithdrawal.amountRaw,
          eventCount: selectedDirectFlow.payoutCount,
          eventCountScope: 'source' as const,
          includesBorrowing: false,
          startMs: selectedDirectFlow.max24hGrossWithdrawal.startMs,
          endMs: selectedDirectFlow.max24hGrossWithdrawal.endMs,
        }
      : selectedDirectFlow?.max24hGrossCometWithdrawEvents?.status === 'observed'
        ? {
            amountRaw: selectedDirectFlow.max24hGrossCometWithdrawEvents.amountRaw,
            eventCount: selectedDirectFlow.max24hGrossCometWithdrawEvents.eventCount,
            eventCountScope: 'window' as const,
            includesBorrowing: true,
            startMs: selectedDirectFlow.max24hGrossCometWithdrawEvents.startMs,
            endMs: selectedDirectFlow.max24hGrossCometWithdrawEvents.endMs,
          }
        : null
  const exitPressureGrossWithdrawals: ExitPressureGrossDirection | null =
    selectedDirectFlow && directWithdrawalMaximum
      ? {
          routeKey,
          destination: destination.toLowerCase(),
          direction: 'withdrawal',
          amountRaw: directWithdrawalMaximum.amountRaw,
          assetDecimals: selectedDirectFlow.underlyingDecimals,
          assetSymbol: assetUnit,
          window: 'maximum_24h',
          eventCount: directWithdrawalMaximum.eventCount,
          eventCountScope: directWithdrawalMaximum.eventCountScope,
          windowStartAt: new Date(directWithdrawalMaximum.startMs).toISOString(),
          windowEndAt: new Date(directWithdrawalMaximum.endMs).toISOString(),
          interpretation: 'gross_withdrawal',
          includesBorrowing: directWithdrawalMaximum.includesBorrowing,
        }
      : null
  const supplyMaximum =
    selectedDirectSupply?.max24hGrossUnderlyingInflow.status === 'observed'
      ? {
          amountRaw: selectedDirectSupply.max24hGrossUnderlyingInflow.amountRaw,
          eventCount: selectedDirectSupply.max24hGrossUnderlyingInflow.eventCount,
          eventCountScope: 'window' as const,
          window: 'maximum_24h' as const,
          startMs: selectedDirectSupply.max24hGrossUnderlyingInflow.startMs,
          endMs: selectedDirectSupply.max24hGrossUnderlyingInflow.endMs,
        }
      : selectedDirectSupply
        ? {
            amountRaw: selectedDirectSupply.grossUnderlyingInflowRaw,
            eventCount: selectedDirectSupply.supplyEventCount,
            eventCountScope: 'source' as const,
            window: 'observed_span' as const,
            startMs: selectedDirectSupply.coverage.startMs,
            endMs: selectedDirectSupply.coverage.endMs,
          }
        : null
  const exitPressureGrossInflows: ExitPressureGrossDirection | null =
    selectedDirectSupply && supplyMaximum
      ? {
          routeKey,
          destination: destination.toLowerCase(),
          direction: 'inflow',
          amountRaw: supplyMaximum.amountRaw,
          assetDecimals: selectedDirectSupply.underlyingDecimals,
          assetSymbol: assetUnit,
          window: supplyMaximum.window,
          eventCount: supplyMaximum.eventCount,
          eventCountScope: supplyMaximum.eventCountScope,
          windowStartAt: new Date(supplyMaximum.startMs).toISOString(),
          windowEndAt: new Date(supplyMaximum.endMs).toISOString(),
          interpretation: 'gross_underlying_inflow_not_net_replenishment',
          mayIncludeDebtRepayment: directFlowMarketKey === 'compoundV3Usdc',
        }
      : null
  const exitPressureHistoricalGrossFlow: ExitPressureHistoricalGrossFlow | null =
    historicalGrossFlowVisible &&
    exitPressureRequestedRaw &&
    historicalGrossFlowVisible.routeKey === routeKey &&
    historicalGrossFlowVisible.destination === destination.toLowerCase() &&
    historicalGrossFlowVisible.requestedRaw === exitPressureRequestedRaw
      ? {
          routeKey: historicalGrossFlowVisible.routeKey,
          destination: historicalGrossFlowVisible.destination,
          requestedRaw: historicalGrossFlowVisible.requestedRaw,
          archiveVerification: historicalGrossFlowVisible.archiveVerification,
          validation: historicalGrossFlowVisible.stress.validation,
          holderExecutableExit: historicalGrossFlowVisible.stress.holderExecutableExit,
          windowCount: historicalGrossFlowVisible.stress.nonoverlappingWindowCount,
          assetDecimals: historicalGrossFlowVisible.assetDecimals,
          assetSymbol: assetUnit,
          assetAddress: historicalGrossFlowVisible.asset.toLowerCase(),
          startingCashRaw: historicalGrossFlowVisible.currentCash.cashRaw,
          source: historicalGrossFlowVisible.stress.source,
          horizonBlocks: historicalGrossFlowVisible.stress.horizonBlocks,
          startingBlock: historicalGrossFlowVisible.currentCash.blockNumber,
          startingBlockHash: historicalGrossFlowVisible.currentCash.blockHash,
          startingAt: historicalGrossFlowVisible.currentCash.blockTimestamp,
          requestedAmountRaw: historicalGrossFlowVisible.requestedRaw,
          currentMarginAfterQRaw: historicalGrossFlowVisible.stress.currentCashMarginToRequestedRaw,
          pairedScenarios: historicalGrossFlowVisible.stress.historicalScenarios,
        }
      : null
  const exitPressureMorphoPayout: ExitPressureMorphoPayout | null = selectedMorphoPayout
    ? {
        routeKey,
        destination: destination.toLowerCase(),
        receiptMatchedTransactions: selectedMorphoPayout.receiptReconciledTransactions,
        externalPayoutRows: selectedMorphoPayout.externalPayoutProofRows,
        pendingTransactions: selectedMorphoPayout.pendingTransactions,
        ambiguousTransactions: selectedMorphoPayout.ambiguousTransactions,
        sourceCompleteness: selectedMorphoPayout.sourceCompleteness,
        sameHolderExit: selectedMorphoPayout.sameHolderExit,
        calibratedForecast: selectedMorphoPayout.calibratedForecast,
      }
    : null
  const selectedStageGroups = selectedAssessment
    ? splitHolderExitStages(selectedAssessment.stages)
    : null
  const watchScope =
    localHolderWatch && morphoAssessmentTarget && selectedAssessment
      ? JSON.stringify([
          selectedAssessment.routeKey,
          selectedAssessment.destinationAddress.toLowerCase(),
          selectedAssessment.owner.toLowerCase(),
          selectedAssessment.request.assetsRaw,
          selectedAssessment.request.horizonHours,
        ])
      : null
  const watchRequestBody = useMemo(
    () =>
      watchScope && selectedAssessment
        ? {
            routeKey: selectedAssessment.routeKey,
            destinationAddress: selectedAssessment.destinationAddress,
            owner: selectedAssessment.owner,
            assetsRaw: selectedAssessment.request.assetsRaw,
          }
        : null,
    [watchScope, selectedAssessment],
  )
  const selectedWatch =
    holderWatch.status === 'result' && holderWatch.scope === watchScope ? holderWatch.value : null
  const hideIdleCashModel = hasUnrepresentativeIdleCash(routeKey, destination)
  useEffect(() => {
    setLocalHolderWatch(isLocalHolderWatchHostname(window.location.hostname))
  }, [])
  useEffect(() => {
    holderWatchRequest.current?.abort()
    setHolderWatch({ status: 'idle' })
    if (!watchScope || !watchRequestBody) return
    const controller = new AbortController()
    holderWatchRequest.current = controller
    setHolderWatch({ status: 'loading', scope: watchScope })
    void (async () => {
      try {
        const value = await fetchHolderWatchStatus(watchRequestBody, controller.signal)
        if (!controller.signal.aborted && holderWatchRequest.current === controller)
          setHolderWatch({ status: 'result', scope: watchScope, value })
      } catch (error) {
        if (!controller.signal.aborted && holderWatchRequest.current === controller)
          setHolderWatch({
            status: 'error',
            scope: watchScope,
            reason:
              error instanceof Error && error.message === 'holder_watch_rate_limited'
                ? 'rate_limited'
                : 'unavailable',
          })
      }
    })()
    return () => controller.abort()
  }, [watchScope, watchRequestBody])
  useEffect(() => () => holderWatchRequest.current?.abort(), [])

  async function updateHolderWatch() {
    if (!watchScope || !watchRequestBody || !selectedAssessment) return
    holderWatchRequest.current?.abort()
    const controller = new AbortController()
    holderWatchRequest.current = controller
    setHolderWatch({ status: 'loading', scope: watchScope })
    try {
      let expectedId: string | undefined
      if (!selectedWatch || selectedWatch.state === 'absent') {
        const response = await fetch('/api/carry/holder-exit-watch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'enqueue',
            ...watchRequestBody,
            horizonHours: selectedAssessment.request.horizonHours,
          }),
          signal: controller.signal,
        })
        if (response.status === 429) {
          const problem = (await response.json()) as { error?: unknown }
          throw new Error(
            problem.error === 'watch_limit_reached'
              ? 'holder_watch_limit_reached'
              : 'holder_watch_rate_limited',
          )
        }
        if (!response.ok) throw new Error('holder_watch_enqueue_unavailable')
        const value = (await response.json()) as {
          id?: unknown
          state?: unknown
          forecastValidated?: unknown
        }
        if (
          typeof value.id !== 'string' ||
          !/^[0-9a-f]{64}$/.test(value.id) ||
          !['queued', 'already_queued'].includes(String(value.state)) ||
          value.forecastValidated !== false
        )
          throw new Error('holder_watch_enqueue_invalid')
        expectedId = value.id
      }
      const value = await fetchHolderWatchStatus(
        watchRequestBody,
        controller.signal,
        expectedId ?? selectedWatch?.id,
      )
      if (!controller.signal.aborted && holderWatchRequest.current === controller)
        setHolderWatch({ status: 'result', scope: watchScope, value })
    } catch (error) {
      if (!controller.signal.aborted && holderWatchRequest.current === controller)
        setHolderWatch({
          status: 'error',
          scope: watchScope,
          reason:
            error instanceof Error && error.message === 'holder_watch_limit_reached'
              ? 'limit_reached'
              : error instanceof Error && error.message === 'holder_watch_rate_limited'
                ? 'rate_limited'
                : 'unavailable',
        })
    }
  }
  const canCheckLiveExit =
    isPyusdStakingSubject(routeKey, destination) ||
    isTwynePt ||
    isUmbrellaGho ||
    isApyUsd ||
    isStakedUsdat ||
    (routeKey === SGHO_ROUTE && canonicalExitDecimals !== null) ||
    isCanonicalFixedVaultExitObservation(routeKey, destination, selected) ||
    (routeKey.includes('→ VaultV2 [') && selected?.routeAssetIdentity === 'factory_verified') ||
    (routeKey === AAVE_USDE_MARKET.routeKey && canonicalExitDecimals !== null) ||
    (DIRECT_MARKET_ROUTES.has(routeKey) &&
      routeKey !== AAVE_USDE_MARKET.routeKey &&
      selected?.routeAssetIdentity === 'market_verified') ||
    isTrackedDirectVault
  useEffect(() => {
    liveExitRequest.current?.abort()
    setLiveExit({ status: 'idle' })
    setHolderCapacityAgreement(null)
    setHolderTimeProcessIssue(null)
    setHolderCometFactsAgreement(null)
    setHolderStusdsProtocolCapacityEvidence(null)
    setHolderMorphoV2ProtocolCapacityEvidence(null)
    setHolderMorphoV2CurrentHolderPositionEvidence(null)
    setHolderMorphoV2HistoricalHolderEaEvidence(null)
    setHolderMorphoV2IdleJointIssue(null)
    setHolderSaturnForecastIssue(null)
    setHolderUsd3JointIssue(null)
    setHolderFluidUsdcBridgeJointIssue(null)
    setHolderFluidUsdtBridgeJointIssue(null)
    setHolderUmbrellaGhoJointIssue(null)
    setHolderApyUsdJointIssue(null)
  }, [
    scenarioMode,
    routeKey,
    destination,
    exitSize,
    fluidBridgeUsdcLegSize,
    stakedUsdatShares,
    stakedUsdatTokenId,
    apyUsdReceiptTokenId,
    twyneCollateralVault,
    twynePtSize,
    primeShares,
    holderAddress,
    refreshVersion,
    exitPressureCurrentCash?.block,
    exitPressureCurrentCash?.blockHash,
    exitPressureCurrentCash?.observedAt,
    exitPressureCurrentCash?.cashRaw,
    exitPressureCurrentCash?.assetAddress,
    exitPressureCurrentCash?.assetDecimals,
  ])
  useEffect(() => {
    if (routeKey === SUSDE_ROUTE) return
    liveExitRequest.current?.abort()
    setLiveExit({ status: 'idle' })
    setHolderTimeProcessIssue(null)
    setHolderCapacityAgreement(null)
    setHolderCometFactsAgreement(null)
    setHolderStusdsProtocolCapacityEvidence(null)
    setHolderMorphoV2ProtocolCapacityEvidence(null)
    setHolderMorphoV2CurrentHolderPositionEvidence(null)
    setHolderMorphoV2HistoricalHolderEaEvidence(null)
    setHolderMorphoV2IdleJointIssue(null)
    setHolderSaturnForecastIssue(null)
    setHolderUsd3JointIssue(null)
    setHolderFluidUsdcBridgeJointIssue(null)
    setHolderFluidUsdtBridgeJointIssue(null)
    setHolderUmbrellaGhoJointIssue(null)
    setHolderApyUsdJointIssue(null)
  }, [horizonHours, routeKey])
  useEffect(() => () => liveExitRequest.current?.abort(), [])

  async function checkLiveExit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (scenarioMode !== 'exit') return
    liveExitRequest.current?.abort()
    setHolderCapacityAgreement(null)
    setHolderTimeProcessIssue(null)
    setHolderCometFactsAgreement(null)
    setHolderStusdsProtocolCapacityEvidence(null)
    setHolderMorphoV2ProtocolCapacityEvidence(null)
    setHolderMorphoV2CurrentHolderPositionEvidence(null)
    setHolderMorphoV2HistoricalHolderEaEvidence(null)
    setHolderMorphoV2IdleJointIssue(null)
    setHolderSaturnForecastIssue(null)
    setHolderUsd3JointIssue(null)
    setHolderFluidUsdcBridgeJointIssue(null)
    setHolderFluidUsdtBridgeJointIssue(null)
    setHolderUmbrellaGhoJointIssue(null)
    setHolderApyUsdJointIssue(null)
    const owner = holderAddress.trim()
    const assessmentMarket = Object.values(DIRECT_SUPPLY_MARKETS).find(
      (market) =>
        market.routeKey === routeKey &&
        market.destination.toLowerCase() === destination.toLowerCase(),
    )
    const assessmentKind = assessmentMarket
      ? 'direct'
      : isPyusdStakingSubject(routeKey, destination)
        ? 'pyusd_staking'
        : isApyUsd
          ? 'apy'
          : isTwynePt
            ? 'twyne_pt'
            : isStakedUsdat
              ? 'staked_usdat'
              : isFluidBridgeUsdtLeg
                ? 'fluid'
                : isUmbrellaGho
                  ? 'umbrella_gho'
                  : routeKey === SUSDE_ROUTE && canCheckLiveExit
                    ? 'susde'
                    : routeKey === SGHO_ROUTE && canonicalExitDecimals !== null
                      ? 'sgho'
                      : routeKey === SUSDS_ROUTE && canCheckLiveExit
                        ? 'susds'
                        : routeKey === USD3_ROUTE && canCheckLiveExit
                          ? 'usd3'
                          : isTrackedDirectVault
                            ? 'tracked'
                            : morphoAssessmentTarget &&
                                selected?.routeAssetIdentity === 'factory_verified' &&
                                selected.asset.toLowerCase() ===
                                  morphoAssessmentTarget.asset.toLowerCase()
                              ? 'morpho'
                              : null
    const stakedAmounts = isStakedUsdat ? stakedUsdatExitAmounts(exitSize, stakedUsdatShares) : null
    const assessmentAssetsRaw = stakedAmounts
      ? stakedAmounts.assetsRaw
      : rawExitAmount(exitSize, exitAssetDecimals ?? -1)
    const firstLegUsdcRaw = isFluidBridgeUsdtLeg
      ? rawExitAmount(fluidBridgeUsdcLegSize, 6)
      : undefined
    const sharesRaw = stakedAmounts?.sharesRaw ?? undefined
    const assetsRaw = isStakedUsdat
      ? (sharesRaw ?? null)
      : isFluidBridgeUsdtLeg
        ? (firstLegUsdcRaw ?? null)
        : assessmentAssetsRaw
    const ptRaw = isTwynePt ? rawExitAmount(twynePtSize, 18) : undefined
    const primeSharesRaw =
      assessmentKind === 'pyusd_staking' ? rawExitAmount(primeShares, 6) : undefined
    const collateralVault = isTwynePt ? twyneCollateralVault.trim().toLowerCase() : undefined
    const requestTokenId =
      isStakedUsdat && stakedUsdatTokenId !== '' ? stakedUsdatTokenId : undefined
    const receiptTokenId =
      assessmentKind === 'apy' && apyUsdReceiptTokenId !== '' ? apyUsdReceiptTokenId : undefined
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(owner) ||
      !assetsRaw ||
      exitAssetDecimals === null ||
      !(isStakedUsdat
        ? validStakedUsdatShares
        : isFluidBridgeUsdtLeg
          ? validFluidBridgeUsdcLegSize
          : validExitSize) ||
      (isStakedUsdat && !validStakedUsdatTokenId) ||
      (assessmentKind === 'apy' && !validApyUsdReceiptTokenId) ||
      (isTwynePt && (!validTwyneCollateralVault || !validTwynePtSize || !ptRaw)) ||
      (assessmentKind === 'pyusd_staking' && (!validPrimeShares || !primeSharesRaw)) ||
      (assessmentKind !== null && (!assessmentAssetsRaw || !validExitSize)) ||
      !canCheckLiveExit
    ) {
      setAlertScope(null)
      setLiveExit({ status: 'error' })
      return
    }
    alertRequestId.current += 1
    const alertSupported =
      routeKey === SUSDS_ROUTE ||
      routeKey === USD3_ROUTE ||
      DIRECT_MARKET_ROUTES.has(routeKey) ||
      routeKey.includes('→ VaultV2 [')
    setAlertScope(
      alertSupported
        ? {
            requestId: alertRequestId.current,
            routeKey,
            destination,
            holder: owner.toLowerCase(),
            assetsRaw,
            assetDecimals: exitAssetDecimals,
            assetUnit,
          }
        : null,
    )
    const controller = new AbortController()
    liveExitRequest.current = controller
    setLiveExit({ status: 'loading' })
    try {
      if (assessmentKind && assessmentAssetsRaw) {
        const request: Parameters<typeof isMatchingHolderExitAssessment>[1] = {
          routeKey,
          destinationAddress: destination,
          owner: owner.toLowerCase(),
          assetsRaw: assessmentAssetsRaw,
          horizonHours,
          payoutAsset:
            assessmentMarket?.underlying ??
            (assessmentKind === 'apy'
              ? APXUSD_ASSET
              : assessmentKind === 'pyusd_staking'
                ? PYUSD_TOKEN
                : assessmentKind === 'twyne_pt'
                  ? USDE_ASSET
                  : assessmentKind === 'staked_usdat'
                    ? AUSD_ASSET
                    : assessmentKind === 'susde'
                      ? resolveSusdeCooldownExitTarget(routeKey, destination as `0x${string}`).asset
                      : assessmentKind === 'umbrella_gho'
                        ? ORIGINAL_GHO
                        : assessmentKind === 'sgho'
                          ? GHO_SGHO.borrowAsset
                          : assessmentKind === 'susds'
                            ? USDS_ASSET
                            : assessmentKind === 'usd3'
                              ? USDC_TOKEN
                              : assessmentKind === 'morpho'
                                ? morphoAssessmentTarget!.asset
                                : assessmentKind === 'tracked'
                                  ? TRACKED_DIRECT_VAULT_ROUTES[routeKey].asset
                                  : '0xdac17f958d2ee523a2206206994597c13d831ec7'),
          kind: assessmentKind,
          ...(firstLegUsdcRaw ? { firstLegUsdcRaw } : {}),
          ...(sharesRaw ? { sharesRaw } : {}),
          ...(requestTokenId ? { requestTokenId } : {}),
          ...(receiptTokenId ? { receiptTokenId } : {}),
          ...(collateralVault ? { collateralVault } : {}),
          ...(ptRaw ? { ptRaw } : {}),
          ...(primeSharesRaw ? { primeSharesRaw } : {}),
        }
        const forecastSourceReference = matchingHolderForecastSourceReference(
          selectedRouteForecast?.conditionalGrossFlowHeadroom,
          {
            routeKey,
            destination,
            requestedRaw: assessmentAssetsRaw,
            requestedAssetAddress: request.payoutAsset,
            requestedAssetDecimals: exitAssetDecimals,
            horizonHours,
            asOfMs: Date.now(),
          },
          exitPressureCurrentCash,
          selectedRouteForecast?.conditionalSampledCashPathProjection,
          selectedRouteForecast ?? undefined,
        )
        const assessmentBody = {
          routeKey,
          destinationAddress: destination,
          owner,
          assetsRaw: assessmentAssetsRaw,
          horizonHours,
          ...(firstLegUsdcRaw ? { firstLegUsdcRaw } : {}),
          ...(sharesRaw ? { sharesRaw } : {}),
          ...(requestTokenId ? { requestTokenId } : {}),
          ...(receiptTokenId ? { receiptTokenId } : {}),
          ...(collateralVault ? { collateralVault } : {}),
          ...(ptRaw ? { ptRaw } : {}),
          ...(primeSharesRaw ? { primeSharesRaw } : {}),
          ...(forecastSourceReference ? { forecastSourceReference } : {}),
          chainId: 1,
        }
        const fetched =
          assessmentKind === 'susde'
            ? await fetchSusdeHolderForecastResponse(assessmentBody, controller.signal)
            : await (async () => {
                const response = await fetch('/api/carry/holder-exit-assessment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(assessmentBody),
                  signal: controller.signal,
                })
                return { response, result: (await response.json()) as unknown }
              })()
        const { response, result } = fetched
        if (
          (assessmentKind === 'morpho' ||
            assessmentKind === 'usd3' ||
            assessmentKind === 'umbrella_gho' ||
            assessmentKind === 'apy' ||
            assessmentKind === 'fluid' ||
            (routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]' &&
              destination.toLowerCase() === '0x273da948aca9261043fbdb2a857bc255ecc29012')) &&
          response.status === 503 &&
          isRecord(result) &&
          result.error === 'holder_exit_assessment_unavailable'
        ) {
          if (holderExitRequestCanPublish(controller, liveExitRequest.current)) {
            const receivedAtMs = Date.now()
            setHolderApyUsdJointIssue(
              assessmentKind === 'apy' && exitAssetDecimals === 18
                ? holderApyUsdJointIssueFromResponse(
                    result,
                    response.status,
                    {
                      routeKey,
                      destination: destination.toLowerCase(),
                      requestedRaw: assessmentAssetsRaw,
                      requestedAssetAddress: request.payoutAsset.toLowerCase(),
                      requestedAssetDecimals: exitAssetDecimals,
                      horizonHours,
                      requestedHolderAddress: owner.toLowerCase(),
                      ...(forecastSourceReference
                        ? {
                            independentSource: {
                              chainId: 1 as const,
                              ...forecastSourceReference,
                              finalized: true as const,
                            },
                          }
                        : {}),
                    },
                    receivedAtMs,
                  )
                : null,
            )
            setHolderUmbrellaGhoJointIssue(
              holderUmbrellaGhoJointIssueFromResponse(
                result,
                response.status,
                {
                  routeKey,
                  destination: destination.toLowerCase(),
                  requestedRaw: assessmentAssetsRaw,
                  requestedAssetAddress: request.payoutAsset.toLowerCase(),
                  requestedAssetDecimals: exitAssetDecimals,
                  horizonHours,
                  requestedHolderAddress: owner.toLowerCase(),
                  ...(forecastSourceReference
                    ? { independentSource: { ...forecastSourceReference } }
                    : {}),
                },
                receivedAtMs,
              ),
            )
            setHolderUsd3JointIssue(
              holderUsd3JointIssueFromResponse(
                result,
                response.status,
                {
                  routeKey,
                  destination: destination.toLowerCase(),
                  requestedRaw: assessmentAssetsRaw,
                  requestedAssetAddress: request.payoutAsset.toLowerCase(),
                  requestedAssetDecimals: exitAssetDecimals,
                  horizonHours,
                  requestedHolderAddress: owner.toLowerCase(),
                  ...(forecastSourceReference
                    ? {
                        independentSource: {
                          chainId: 1 as const,
                          ...forecastSourceReference,
                          finalized: true as const,
                        },
                      }
                    : {}),
                },
                receivedAtMs,
              ),
            )
            setHolderFluidUsdcBridgeJointIssue(
              holderFluidUsdcBridgeJointIssueFromResponse(
                result,
                response.status,
                {
                  routeKey,
                  destination: destination.toLowerCase(),
                  requestedRaw: assessmentAssetsRaw,
                  requestedAssetAddress: request.payoutAsset.toLowerCase(),
                  requestedAssetDecimals: exitAssetDecimals,
                  horizonHours,
                  requestedHolderAddress: owner.toLowerCase(),
                  ...(forecastSourceReference
                    ? {
                        independentSource: {
                          chainId: 1 as const,
                          ...forecastSourceReference,
                          finalized: true as const,
                        },
                      }
                    : {}),
                },
                receivedAtMs,
              ),
            )
            setHolderFluidUsdtBridgeJointIssue(
              holderFluidUsdtBridgeJointIssueFromResponse(
                result,
                response.status,
                {
                  routeKey,
                  destination: destination.toLowerCase(),
                  requestedRaw: assessmentAssetsRaw,
                  requestedAssetAddress: request.payoutAsset.toLowerCase(),
                  requestedAssetDecimals: exitAssetDecimals,
                  horizonHours,
                  requestedHolderAddress: owner.toLowerCase(),
                  ...(forecastSourceReference
                    ? {
                        independentSource: {
                          chainId: 1 as const,
                          ...forecastSourceReference,
                          finalized: true as const,
                        },
                      }
                    : {}),
                },
                receivedAtMs,
              ),
            )
            const evidence = holderMorphoV2PositionEvidenceFromResponse(result, response.status)
            setHolderSaturnForecastIssue(holderSaturnForecastIssueFromResponse(result, response.status, {
            routeKey, destination: destination.toLowerCase(), owner: owner.toLowerCase(),
            requestedRaw: assessmentAssetsRaw, horizonHours, ticketId: requestTokenId ?? null,
          }, receivedAtMs))
          setHolderMorphoV2IdleJointIssue(
              holderMorphoV2IdleJointIssueFromResponse(result, response.status, {
                routeKey, destination: destination.toLowerCase(), requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset.toLowerCase(),
                requestedAssetDecimals: exitAssetDecimals, requestedHolderAddress: owner.toLowerCase(),
                horizonHours,
                ...(forecastSourceReference ? { independentSource: {
                  chainId: 1 as const, ...forecastSourceReference, finalized: true as const,
                } } : {}),
              }, receivedAtMs),
            )
            setHolderTimeProcessIssue(
              holderTimeProcessIssueFromResponse(
                result,
                response.status,
                {
                  routeKey,
                  destination,
                  requestedRaw: assessmentAssetsRaw,
                  requestedAssetAddress: request.payoutAsset,
                  requestedAssetDecimals: exitAssetDecimals,
                  horizonHours,
                  requestedHolderAddress: owner,
                  asOfMs: receivedAtMs,
                },
                exitPressureCurrentCash,
                selectedRouteForecast?.conditionalSampledCashPathProjection,
                forecastSourceReference,
              ),
            )
            setHolderCapacityAgreement(holderCapacityAgreementFromResponse(result, response.status))
            setHolderMorphoV2ProtocolCapacityEvidence(
              morphoV2ProtocolEvidenceFromResponse(result, response.status),
            )
            setHolderMorphoV2CurrentHolderPositionEvidence(evidence.holder)
            setHolderMorphoV2HistoricalHolderEaEvidence(evidence.historical)
            setCheckClockMs(receivedAtMs)
            setLiveExit({ status: 'error' })
          }
          return
        }
        if (!response.ok) throw new Error('holder_exit_assessment_unavailable')
        if (!isMatchingHolderExitAssessment(result, request))
          throw new Error('holder_exit_assessment_mismatch')
        if (holderExitRequestCanPublish(controller, liveExitRequest.current)) {
          const receivedAtMs = Date.now()
          setHolderApyUsdJointIssue(
            assessmentKind === 'apy' && exitAssetDecimals === 18
              ? holderApyUsdJointIssueFromResponse(
                  result,
                  response.status,
                  {
                    routeKey,
                    destination: destination.toLowerCase(),
                    requestedRaw: assessmentAssetsRaw,
                    requestedAssetAddress: request.payoutAsset.toLowerCase(),
                    requestedAssetDecimals: exitAssetDecimals,
                    horizonHours,
                    requestedHolderAddress: owner.toLowerCase(),
                    ...(forecastSourceReference
                      ? {
                          independentSource: {
                            chainId: 1 as const,
                            ...forecastSourceReference,
                            finalized: true as const,
                          },
                        }
                      : {}),
                  },
                  receivedAtMs,
                )
              : null,
          )
          setHolderUmbrellaGhoJointIssue(
            holderUmbrellaGhoJointIssueFromResponse(
              result,
              response.status,
              {
                routeKey,
                destination: destination.toLowerCase(),
                requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset.toLowerCase(),
                requestedAssetDecimals: exitAssetDecimals,
                horizonHours,
                requestedHolderAddress: owner.toLowerCase(),
                ...(forecastSourceReference
                  ? { independentSource: { ...forecastSourceReference } }
                  : {}),
              },
              receivedAtMs,
            ),
          )
          setHolderUsd3JointIssue(
            holderUsd3JointIssueFromResponse(
              result,
              response.status,
              {
                routeKey,
                destination: destination.toLowerCase(),
                requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset.toLowerCase(),
                requestedAssetDecimals: exitAssetDecimals,
                horizonHours,
                requestedHolderAddress: owner.toLowerCase(),
                ...(forecastSourceReference
                  ? {
                      independentSource: {
                        chainId: 1 as const,
                        ...forecastSourceReference,
                        finalized: true as const,
                      },
                    }
                  : {}),
              },
              receivedAtMs,
            ),
          )
          setHolderFluidUsdcBridgeJointIssue(
            holderFluidUsdcBridgeJointIssueFromResponse(
              result,
              response.status,
              {
                routeKey,
                destination: destination.toLowerCase(),
                requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset.toLowerCase(),
                requestedAssetDecimals: exitAssetDecimals,
                horizonHours,
                requestedHolderAddress: owner.toLowerCase(),
                ...(forecastSourceReference
                  ? {
                      independentSource: {
                        chainId: 1 as const,
                        ...forecastSourceReference,
                        finalized: true as const,
                      },
                    }
                  : {}),
              },
              receivedAtMs,
            ),
          )
          setHolderFluidUsdtBridgeJointIssue(
            holderFluidUsdtBridgeJointIssueFromResponse(
              result,
              response.status,
              {
                routeKey,
                destination: destination.toLowerCase(),
                requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset.toLowerCase(),
                requestedAssetDecimals: exitAssetDecimals,
                horizonHours,
                requestedHolderAddress: owner.toLowerCase(),
                ...(forecastSourceReference
                  ? {
                      independentSource: {
                        chainId: 1 as const,
                        ...forecastSourceReference,
                        finalized: true as const,
                      },
                    }
                  : {}),
              },
              receivedAtMs,
            ),
          )
          setHolderSaturnForecastIssue(holderSaturnForecastIssueFromResponse(result, response.status, {
            routeKey, destination: destination.toLowerCase(), owner: owner.toLowerCase(),
            requestedRaw: assessmentAssetsRaw, horizonHours, ticketId: requestTokenId ?? null,
          }, receivedAtMs))
          setHolderMorphoV2IdleJointIssue(
            holderMorphoV2IdleJointIssueFromResponse(result, response.status, {
              routeKey, destination: destination.toLowerCase(), requestedRaw: assessmentAssetsRaw,
              requestedAssetAddress: request.payoutAsset.toLowerCase(),
              requestedAssetDecimals: exitAssetDecimals, requestedHolderAddress: owner.toLowerCase(),
              horizonHours,
              ...(forecastSourceReference ? { independentSource: {
                chainId: 1 as const, ...forecastSourceReference, finalized: true as const,
              } } : {}),
            }, receivedAtMs),
          )
          setHolderTimeProcessIssue(
            holderTimeProcessIssueFromResponse(
              result,
              response.status,
              {
                routeKey,
                destination,
                requestedRaw: assessmentAssetsRaw,
                requestedAssetAddress: request.payoutAsset,
                requestedAssetDecimals: exitAssetDecimals,
                horizonHours,
                requestedHolderAddress: owner,
                asOfMs: receivedAtMs,
              },
              exitPressureCurrentCash,
              selectedRouteForecast?.conditionalSampledCashPathProjection,
              forecastSourceReference,
            ),
          )
          setHolderCapacityAgreement(holderCapacityAgreementFromResponse(result, response.status))
          setHolderStusdsProtocolCapacityEvidence(
            holderStusdsProtocolEvidenceFromResponse(result, response.status),
          )
          setHolderMorphoV2ProtocolCapacityEvidence(
            morphoV2ProtocolEvidenceFromResponse(result, response.status),
          )
          const morphoPositionEvidence = holderMorphoV2PositionEvidenceFromResponse(
            result,
            response.status,
          )
          setHolderMorphoV2CurrentHolderPositionEvidence(morphoPositionEvidence.holder)
          setHolderMorphoV2HistoricalHolderEaEvidence(morphoPositionEvidence.historical)
          setHolderCometFactsAgreement(
            holderCometFactsAgreementFromResponse(result, response.status),
          )
          setCheckClockMs(Date.now())
        }
        if (holderExitRequestCanPublish(controller, liveExitRequest.current)) {
          setCheckClockMs(Date.now())
          setLiveExit({
            status: 'assessment_result',
            assessment: withMatchingHolderMechanicalOutlook(
              result as HolderExitAssessmentView,
              owner,
              Date.now(),
            ),
            sample:
              (assessmentKind === 'direct' ||
                assessmentKind === 'morpho' ||
                assessmentKind === 'tracked' ||
                assessmentKind === 'sgho' ||
                assessmentKind === 'susds' ||
                assessmentKind === 'usd3') &&
              result.finalPayout.status === 'simulated'
                ? {
                    routeKey,
                    destination,
                    holder: owner.toLowerCase(),
                    assetsRaw: assessmentAssetsRaw,
                    status: 'success',
                    blockNumber: result.source.blockNumber,
                    blockHash: result.source.blockHash,
                    blockTime: result.source.blockTime,
                  }
                : null,
          })
        }
        return
      }
      const isSgho = routeKey === SGHO_ROUTE
      const isSusds = routeKey === SUSDS_ROUTE
      const isSusde = routeKey === SUSDE_ROUTE
      const isUsd3 = routeKey === USD3_ROUTE
      const isDirect = DIRECT_MARKET_ROUTES.has(routeKey)
      const response = await fetch(liveExitEndpoint(routeKey, isTrackedDirectVault), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isSgho
            ? { address: owner, assetsRaw, chainId: 1 }
            : isStakedUsdat
              ? {
                  routeKey,
                  destinationAddress: destination,
                  holder: owner,
                  sharesRaw: assetsRaw,
                  ...(stakedUsdatTokenId === '' ? {} : { requestTokenId: stakedUsdatTokenId }),
                  chainId: 1,
                }
              : isUmbrellaGho || isApyUsd || isTwynePt
                ? {
                    routeKey,
                    destinationAddress: destination,
                    holder: owner,
                    assetsRaw,
                    chainId: 1,
                  }
                : {
                    routeKey,
                    destinationAddress: destination,
                    owner,
                    assetsRaw,
                    ...(isFluidBridgeUsdtLeg ? { assetUnit: 'USDC' } : {}),
                    chainId: 1,
                  },
        ),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('live_exit_unavailable')
      if (isStakedUsdat) {
        const result = (await response.json()) as {
          status?: unknown
          evidence?: {
            chainId?: unknown
            blockNumber?: unknown
            blockHash?: unknown
            blockTimestamp?: unknown
            vault?: unknown
            vaultImplementation?: unknown
            queue?: unknown
            queueImplementation?: unknown
            underlying?: unknown
            underlyingDecimals?: unknown
            shareDecimals?: unknown
          }
          current?: {
            requestedSharesRaw?: unknown
            vaultPaused?: unknown
            queuePaused?: unknown
            previewUsdatRaw?: unknown
            request?: { status?: unknown }
            requestDelivery?: unknown
            requestMinSharePriceRaw?: unknown
            existingTicket?: null | {
              tokenId?: unknown
              ownership?: unknown
              claimSimulation?: unknown
              simulatedUsdatRaw?: unknown
              requestedLimit?: null | {
                minSharePriceRaw?: unknown
                currentNetSharePriceRaw?: unknown
                comparison?: unknown
                limitUpdateSimulation?: unknown
              }
              delivery?: unknown
            }
            originalAusdConversion?: unknown
            settlementDuration?: unknown
          }
        }
        const evidence = result.evidence
        const current = result.current
        const blockTimeMs = Number(evidence?.blockTimestamp) * 1000
        if (
          result.status !== 'observed' ||
          evidence?.chainId !== 1 ||
          typeof evidence.blockNumber !== 'number' ||
          !Number.isSafeInteger(evidence.blockNumber) ||
          typeof evidence.blockHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(evidence.blockHash) ||
          typeof evidence.blockTimestamp !== 'number' ||
          !Number.isSafeInteger(evidence.blockTimestamp) ||
          !Number.isFinite(blockTimeMs) ||
          blockTimeMs > Date.now() + 120_000 ||
          Date.now() - blockTimeMs > 7_200_000 ||
          typeof evidence.vault !== 'string' ||
          evidence.vault.toLowerCase() !== STAKED_USDAT_VAULT ||
          typeof evidence.vaultImplementation !== 'string' ||
          evidence.vaultImplementation.toLowerCase() !== STAKED_USDAT_IMPLEMENTATION ||
          typeof evidence.queue !== 'string' ||
          evidence.queue.toLowerCase() !== STAKED_USDAT_QUEUE ||
          typeof evidence.queueImplementation !== 'string' ||
          evidence.queueImplementation.toLowerCase() !== STAKED_USDAT_QUEUE_IMPLEMENTATION ||
          typeof evidence.underlying !== 'string' ||
          evidence.underlying.toLowerCase() !== USDAT_ASSET ||
          evidence.underlyingDecimals !== 6 ||
          evidence.shareDecimals !== 18 ||
          current?.requestedSharesRaw !== assetsRaw ||
          typeof current.vaultPaused !== 'boolean' ||
          typeof current.queuePaused !== 'boolean' ||
          !['success', 'evm_revert', 'not_attempted'].includes(String(current.request?.status)) ||
          (current.previewUsdatRaw !== null &&
            (typeof current.previewUsdatRaw !== 'string' ||
              !/^\d+$/.test(current.previewUsdatRaw))) ||
          current.requestDelivery !== 'queue_ticket_only' ||
          current.requestMinSharePriceRaw !== '0' ||
          current.originalAusdConversion !== 'not_assayed' ||
          current.settlementDuration !== 'unestimated' ||
          (stakedUsdatTokenId === ''
            ? current.existingTicket !== null
            : !current.existingTicket ||
              current.existingTicket.tokenId !== stakedUsdatTokenId ||
              !['holder', 'other_owner', 'not_found'].includes(
                String(current.existingTicket.ownership),
              ) ||
              !['success', 'evm_revert', 'not_holder', 'not_found'].includes(
                String(current.existingTicket.claimSimulation),
              ) ||
              (current.existingTicket.claimSimulation === 'success' &&
                (current.existingTicket.ownership !== 'holder' ||
                  typeof current.existingTicket.simulatedUsdatRaw !== 'string' ||
                  !/^\d+$/.test(current.existingTicket.simulatedUsdatRaw))) ||
              (current.existingTicket.requestedLimit !== null &&
                (current.existingTicket.ownership !== 'holder' ||
                  !current.existingTicket.requestedLimit ||
                  typeof current.existingTicket.requestedLimit.minSharePriceRaw !== 'string' ||
                  !/^\d+$/.test(current.existingTicket.requestedLimit.minSharePriceRaw) ||
                  ![
                    'above_current_quote',
                    'at_or_below_current_quote',
                    'quote_unavailable',
                  ].includes(String(current.existingTicket.requestedLimit.comparison)) ||
                  !['success', 'evm_revert'].includes(
                    String(current.existingTicket.requestedLimit.limitUpdateSimulation),
                  ) ||
                  (current.existingTicket.requestedLimit.comparison === 'quote_unavailable'
                    ? current.existingTicket.requestedLimit.currentNetSharePriceRaw !== null
                    : typeof current.existingTicket.requestedLimit.currentNetSharePriceRaw !==
                        'string' ||
                      !/^\d+$/.test(
                        current.existingTicket.requestedLimit.currentNetSharePriceRaw,
                      ) ||
                      BigInt(current.existingTicket.requestedLimit.currentNetSharePriceRaw) <
                        BigInt(current.existingTicket.requestedLimit.minSharePriceRaw) !==
                        (current.existingTicket.requestedLimit.comparison ===
                          'above_current_quote')))) ||
              current.existingTicket.delivery !== 'not_observed')
        )
          throw new Error('live_exit_invalid')
        if (!controller.signal.aborted && liveExitRequest.current === controller)
          setLiveExit({
            status: 'staked_usdat_result',
            blockTime: new Date(blockTimeMs).toISOString(),
            blockNumber: evidence.blockNumber,
            request: current.request?.status as 'success' | 'evm_revert' | 'not_attempted',
            vaultPaused: current.vaultPaused,
            queuePaused: current.queuePaused,
            previewUsdatRaw: current.previewUsdatRaw as string | null,
            requestTokenId: stakedUsdatTokenId === '' ? null : stakedUsdatTokenId,
            claim:
              stakedUsdatTokenId === ''
                ? null
                : (current.existingTicket?.claimSimulation as
                    | 'success'
                    | 'evm_revert'
                    | 'not_holder'
                    | 'not_found'),
            claimUsdatRaw:
              stakedUsdatTokenId === ''
                ? null
                : (current.existingTicket?.simulatedUsdatRaw as string | null),
            requestedLimit:
              stakedUsdatTokenId === ''
                ? null
                : (current.existingTicket?.requestedLimit as Extract<
                    LiveExitState,
                    { status: 'staked_usdat_result' }
                  >['requestedLimit']),
          })
        return
      }
      if (isTwynePt) {
        const result = (await response.json()) as {
          status?: unknown
          reason?: unknown
          routeKey?: unknown
          destination?: unknown
          evidence?: {
            chainId?: unknown
            blockNumber?: unknown
            blockHash?: unknown
            blockTimestamp?: unknown
            ptAsset?: unknown
            aToken?: unknown
            pool?: unknown
            ptDecimals?: unknown
            wrapperDecimals?: unknown
            ptExpiry?: unknown
          }
          amountCheck?: {
            requestedPtRaw?: unknown
            simulation?: { status?: unknown; sharesBurnedRaw?: unknown }
            redeemSimulation?: { status?: unknown; ptAssetsRaw?: unknown }
            ptDelivery?: unknown
            ptToUsde?: unknown
          }
        }
        const evidence = result.evidence
        const check = result.amountCheck
        const blockTimeMs = Number(evidence?.blockTimestamp) * 1000
        const simulation = check?.simulation
        if (
          result.status === 'unsupported' &&
          ['deployment_unattested', 'identity_changed'].includes(String(result.reason)) &&
          result.routeKey === TWYNE_PT_ROUTE &&
          typeof result.destination === 'string' &&
          result.destination.toLowerCase() === TWYNE_PT_WRAPPER &&
          evidence?.chainId === 1 &&
          typeof evidence.blockNumber === 'number' &&
          Number.isSafeInteger(evidence.blockNumber)
        ) {
          if (!controller.signal.aborted && liveExitRequest.current === controller)
            setLiveExit({
              status: 'twyne_pt_unsupported',
              reason: result.reason as 'deployment_unattested' | 'identity_changed',
              blockNumber: evidence.blockNumber,
            })
          return
        }
        if (
          result.status !== 'observed' ||
          result.routeKey !== TWYNE_PT_ROUTE ||
          typeof result.destination !== 'string' ||
          result.destination.toLowerCase() !== TWYNE_PT_WRAPPER ||
          evidence?.chainId !== 1 ||
          typeof evidence.blockNumber !== 'number' ||
          !Number.isSafeInteger(evidence.blockNumber) ||
          typeof evidence.blockHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(evidence.blockHash) ||
          typeof evidence.blockTimestamp !== 'number' ||
          !Number.isSafeInteger(evidence.blockTimestamp) ||
          !Number.isFinite(blockTimeMs) ||
          blockTimeMs > Date.now() + 120_000 ||
          Date.now() - blockTimeMs > 7_200_000 ||
          typeof evidence.ptAsset !== 'string' ||
          evidence.ptAsset.toLowerCase() !== TWYNE_PT_ASSET ||
          typeof evidence.aToken !== 'string' ||
          evidence.aToken.toLowerCase() !== '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545' ||
          typeof evidence.pool !== 'string' ||
          evidence.pool.toLowerCase() !== '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' ||
          evidence.ptDecimals !== 18 ||
          evidence.wrapperDecimals !== 18 ||
          evidence.ptExpiry !== 1_792_627_200 ||
          check?.requestedPtRaw !== assetsRaw ||
          !['success', 'evm_revert', 'position_insufficient'].includes(
            String(simulation?.status),
          ) ||
          !['success', 'below_requested', 'evm_revert', 'not_attempted'].includes(
            String(check?.redeemSimulation?.status),
          ) ||
          (['success', 'below_requested'].includes(String(check?.redeemSimulation?.status)) &&
            (typeof check?.redeemSimulation?.ptAssetsRaw !== 'string' ||
              !/^\d+$/.test(check.redeemSimulation.ptAssetsRaw))) ||
          (simulation?.status === 'success' &&
            (typeof simulation.sharesBurnedRaw !== 'string' ||
              !/^\d+$/.test(simulation.sharesBurnedRaw))) ||
          check?.ptDelivery !== 'not_observed' ||
          check?.ptToUsde !== 'not_assessed'
        )
          throw new Error('live_exit_invalid')
        if (!controller.signal.aborted && liveExitRequest.current === controller)
          setLiveExit({
            status: 'twyne_pt_result',
            blockTime: new Date(blockTimeMs).toISOString(),
            blockNumber: evidence.blockNumber,
            simulation: simulation!.status as 'success' | 'evm_revert' | 'position_insufficient',
            sharesBurnedRaw:
              simulation!.status === 'success' ? (simulation!.sharesBurnedRaw as string) : null,
            redeemedPtRaw: ['success', 'below_requested'].includes(
              String(check.redeemSimulation?.status),
            )
              ? (check.redeemSimulation?.ptAssetsRaw as string)
              : null,
            redeemBelowRequested: check?.redeemSimulation?.status === 'below_requested',
            ptExpiry: evidence.ptExpiry,
          })
        return
      }
      if (isApyUsd) {
        const result = (await response.json()) as {
          status?: unknown
          evidence?: {
            chainId?: unknown
            blockNumber?: unknown
            blockHash?: unknown
            blockTimestamp?: unknown
            vault?: unknown
            implementation?: unknown
            receipt?: unknown
            receiptImplementation?: unknown
            originalAsset?: unknown
            assetDecimals?: unknown
          }
          current?: {
            requestedEscrowRaw?: unknown
            initiation?: { status?: unknown; sharesRaw?: unknown; receiptTokenId?: unknown }
            payout?: unknown
            existingReceipt?: unknown
            currentFeeCurve?: unknown
            currentMinimumClaimDelaySeconds?: unknown
            ifInitiatedAtCheckedBlockClaimableAt?: unknown
            ifInitiatedAtCheckedBlockEarliestNetRaw?: unknown
            ifInitiatedAtCheckedBlockMinimumFeeAt?: unknown
            ifInitiatedAtCheckedBlockMinimumFeeNetRaw?: unknown
          }
        }
        const evidence = result.evidence
        const blockTimeMs = Number(evidence?.blockTimestamp) * 1000
        const initiation = result.current?.initiation
        const curve = result.current?.currentFeeCurve as ApyUsdFeeCurve | undefined
        const validCurve = !!curve && validApyUsdFeeCurve(curve)
        const earliestNet =
          validCurve && curve && initiation?.status === 'success'
            ? (projectApyUsdNet(assetsRaw, curve.minDurationSeconds, curve)?.netRaw ?? null)
            : null
        const minimumFeeNet =
          validCurve && curve && initiation?.status === 'success'
            ? (projectApyUsdNet(assetsRaw, curve.maxDurationSeconds, curve)?.netRaw ?? null)
            : null
        if (
          result.status !== 'observed' ||
          evidence?.chainId !== 1 ||
          typeof evidence.blockNumber !== 'number' ||
          !Number.isSafeInteger(evidence.blockNumber) ||
          typeof evidence.blockHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(evidence.blockHash) ||
          typeof evidence.blockTimestamp !== 'number' ||
          !Number.isSafeInteger(evidence.blockTimestamp) ||
          !Number.isFinite(blockTimeMs) ||
          blockTimeMs > Date.now() + 120_000 ||
          Date.now() - blockTimeMs > 7_200_000 ||
          typeof evidence.vault !== 'string' ||
          evidence.vault.toLowerCase() !== APYUSD_VAULT ||
          typeof evidence.implementation !== 'string' ||
          evidence.implementation.toLowerCase() !== '0xfd616567ecc1607f61073951a1e822f7315bb112' ||
          typeof evidence.receipt !== 'string' ||
          evidence.receipt.toLowerCase() !== APXUSD_RECEIPT ||
          typeof evidence.receiptImplementation !== 'string' ||
          evidence.receiptImplementation.toLowerCase() !==
            '0x54f1c7ffe10bc392f08ae9432a7e21a6e86bb982' ||
          typeof evidence.originalAsset !== 'string' ||
          evidence.originalAsset.toLowerCase() !== APXUSD_ASSET ||
          evidence.assetDecimals !== 18 ||
          result.current?.requestedEscrowRaw !== assetsRaw ||
          !['success', 'evm_revert'].includes(String(initiation?.status)) ||
          (initiation?.status === 'success' &&
            (typeof initiation.sharesRaw !== 'string' ||
              !/^\d+$/.test(initiation.sharesRaw) ||
              typeof initiation.receiptTokenId !== 'string' ||
              !/^\d+$/.test(initiation.receiptTokenId))) ||
          result.current?.payout !== 'not_delivered_by_initiation' ||
          !validCurve ||
          !curve ||
          typeof result.current?.currentMinimumClaimDelaySeconds !== 'number' ||
          !Number.isSafeInteger(result.current.currentMinimumClaimDelaySeconds) ||
          result.current.currentMinimumClaimDelaySeconds < 0 ||
          result.current.currentMinimumClaimDelaySeconds > 90 * 86_400 ||
          result.current.ifInitiatedAtCheckedBlockClaimableAt !==
            (initiation?.status === 'success'
              ? Number(evidence.blockTimestamp) + result.current.currentMinimumClaimDelaySeconds
              : null) ||
          result.current.currentMinimumClaimDelaySeconds !== curve.minDurationSeconds ||
          result.current.ifInitiatedAtCheckedBlockEarliestNetRaw !== earliestNet ||
          result.current.ifInitiatedAtCheckedBlockMinimumFeeAt !==
            (initiation?.status === 'success'
              ? Number(evidence.blockTimestamp) + curve.maxDurationSeconds
              : null) ||
          result.current.ifInitiatedAtCheckedBlockMinimumFeeNetRaw !== minimumFeeNet ||
          result.current?.existingReceipt !== null
        )
          throw new Error('live_exit_invalid')
        if (!controller.signal.aborted && liveExitRequest.current === controller)
          setLiveExit({
            status: 'apyusd_result',
            blockTime: new Date(blockTimeMs).toISOString(),
            blockNumber: evidence.blockNumber,
            initiation: initiation?.status as 'success' | 'evm_revert',
            ifInitiatedAtCheckedBlockClaimableAt: result.current
              .ifInitiatedAtCheckedBlockClaimableAt as number | null,
            ifInitiatedAtCheckedBlockEarliestNetRaw: earliestNet,
            ifInitiatedAtCheckedBlockMinimumFeeAt: result.current
              .ifInitiatedAtCheckedBlockMinimumFeeAt as number | null,
            ifInitiatedAtCheckedBlockMinimumFeeNetRaw: minimumFeeNet,
          })
        return
      }
      if (isUmbrellaGho) {
        const result = (await response.json()) as {
          status?: unknown
          evidence?: {
            chainId?: unknown
            blockNumber?: unknown
            blockHash?: unknown
            blockTimestamp?: unknown
            proxy?: unknown
            implementation?: unknown
            routeAsset?: unknown
          }
          originalAsset?: unknown
          cooldownEnd?: unknown
          windowEndInclusive?: unknown
          amountCheck?: {
            requested?: { unit?: unknown; raw?: unknown }
            gate?: unknown
            simulation?: { status?: unknown; ghoRaw?: unknown }
            slashExposure?: unknown
          }
        }
        const evidence = result.evidence
        const amountCheck = result.amountCheck
        const gate = amountCheck?.gate
        const simulation = amountCheck?.simulation?.status
        const blockTimeMs = Number(evidence?.blockTimestamp) * 1000
        if (
          result.status !== 'observed' ||
          evidence?.chainId !== 1 ||
          typeof evidence.blockNumber !== 'number' ||
          !Number.isSafeInteger(evidence.blockNumber) ||
          typeof evidence.blockHash !== 'string' ||
          !/^0x[0-9a-fA-F]{64}$/.test(evidence.blockHash) ||
          typeof evidence.blockTimestamp !== 'number' ||
          !Number.isSafeInteger(evidence.blockTimestamp) ||
          !Number.isFinite(blockTimeMs) ||
          blockTimeMs > Date.now() + 120_000 ||
          Date.now() - blockTimeMs > 7_200_000 ||
          typeof evidence.proxy !== 'string' ||
          evidence.proxy.toLowerCase() !== destination.toLowerCase() ||
          typeof evidence.implementation !== 'string' ||
          evidence.implementation.toLowerCase() !== VERIFIED_STKGHO_IMPLEMENTATION ||
          typeof evidence.routeAsset !== 'string' ||
          evidence.routeAsset.toLowerCase() !== ORIGINAL_GHO ||
          typeof result.originalAsset !== 'string' ||
          result.originalAsset.toLowerCase() !== ORIGINAL_GHO ||
          amountCheck?.requested?.unit !== 'assets' ||
          amountCheck.requested.raw !== assetsRaw ||
          ![
            'no_shares',
            'cooldown_not_started',
            'waiting',
            'window_expired',
            'paused',
            'amount_exceeds_window',
            'window_open',
          ].includes(String(gate)) ||
          !['success', 'evm_revert', 'not_attempted'].includes(String(simulation)) ||
          (simulation === 'success' &&
            (typeof amountCheck.simulation?.ghoRaw !== 'string' ||
              !/^\d+$/.test(amountCheck.simulation.ghoRaw) ||
              BigInt(amountCheck.simulation.ghoRaw) < BigInt(assetsRaw))) ||
          !['slashable_assets_present', 'no_slashable_assets'].includes(
            String(amountCheck.slashExposure),
          ) ||
          (result.cooldownEnd !== null &&
            (typeof result.cooldownEnd !== 'number' ||
              !Number.isSafeInteger(result.cooldownEnd))) ||
          (result.windowEndInclusive !== null &&
            (typeof result.windowEndInclusive !== 'number' ||
              !Number.isSafeInteger(result.windowEndInclusive))) ||
          (gate === 'waiting' && typeof result.cooldownEnd !== 'number') ||
          (gate === 'window_open' && typeof result.windowEndInclusive !== 'number')
        )
          throw new Error('live_exit_invalid')
        if (!controller.signal.aborted && liveExitRequest.current === controller) {
          setLiveExit({
            status: 'umbrella_result',
            blockTime: new Date(blockTimeMs).toISOString(),
            blockNumber: evidence.blockNumber,
            gate: gate as Extract<LiveExitState, { status: 'umbrella_result' }>['gate'],
            cooldownEnd: result.cooldownEnd as number | null,
            windowEndInclusive: result.windowEndInclusive as number | null,
            simulation: simulation as 'success' | 'evm_revert' | 'not_attempted',
            slashExposure: amountCheck.slashExposure as
              | 'slashable_assets_present'
              | 'no_slashable_assets',
          })
        }
        return
      }
      const result = (await response.json()) as LiveExitResponse
      const source = result.source
      const subjectAddress = isDirect ? result.market?.address : result.vault?.address
      if (
        !source ||
        ((isSgho || routeKey === AAVE_USDE_MARKET.routeKey) &&
          (source.chainId !== 1 ||
            typeof source.blockHash !== 'string' ||
            !/^0x[0-9a-fA-F]{64}$/.test(source.blockHash))) ||
        typeof source.blockNumber !== 'number' ||
        !Number.isSafeInteger(source.blockNumber) ||
        typeof source.blockTime !== 'string' ||
        Number.isNaN(Date.parse(source.blockTime)) ||
        typeof subjectAddress !== 'string' ||
        subjectAddress.toLowerCase() !== destination.toLowerCase() ||
        (isSgho &&
          (typeof result.vault?.assetAddress !== 'string' ||
            result.vault.assetAddress.toLowerCase() !== GHO_SGHO.borrowAsset.toLowerCase() ||
            result.vault.assetDecimals !== CANONICAL_SGHO_DECIMALS)) ||
        (routeKey === AAVE_USDE_MARKET.routeKey &&
          (typeof result.market?.assetAddress !== 'string' ||
            result.market.assetAddress.toLowerCase() !==
              AAVE_USDE_MARKET.underlying.toLowerCase() ||
            result.market.assetDecimals !== AAVE_USDE_MARKET.decimals ||
            result.market.identity !== 'pinned_market_and_live_underlying')) ||
        (isTrackedDirectVault &&
          (source.chainId !== 1 ||
            typeof source.blockHash !== 'string' ||
            !/^0x[0-9a-fA-F]{64}$/.test(source.blockHash) ||
            typeof result.vault?.assetAddress !== 'string' ||
            result.vault.assetAddress.toLowerCase() !== selected?.asset.toLowerCase() ||
            result.vault.assetDecimals !== selected?.assetDecimals ||
            result.vault.implementationSourceAttested !== false))
      ) {
        throw new Error('live_exit_identity_mismatch')
      }
      if (isSusde) {
        const pending = result.pending
        const exitMode = result.exitMode
        const initiationStatus = result.initiation?.status
        const directWithdrawalStatus = result.directWithdrawal?.status
        const claimStatus = result.claim?.status
        if (
          result.status !== 'checked_at_finalized_block' ||
          result.routeKey !== routeKey ||
          result.request?.assetsRaw !== assetsRaw ||
          typeof pending?.assetsRaw !== 'string' ||
          !/^\d+$/.test(pending.assetsRaw) ||
          (pending.cooldownEnd !== null &&
            (typeof pending.cooldownEnd !== 'string' ||
              Number.isNaN(Date.parse(pending.cooldownEnd)))) ||
          !['success', 'evm_revert', 'not_yet_eligible', 'no_pending_claim'].includes(
            String(claimStatus),
          ) ||
          typeof result.vault?.cooldownDurationSeconds !== 'number' ||
          !Number.isSafeInteger(result.vault.cooldownDurationSeconds) ||
          (exitMode === 'direct_withdrawal'
            ? result.vault.cooldownDurationSeconds !== 0 ||
              initiationStatus !== 'not_applicable' ||
              !['success', 'evm_revert'].includes(String(directWithdrawalStatus))
            : exitMode !== 'cooldown' ||
              result.vault.cooldownDurationSeconds <= 0 ||
              !['success', 'evm_revert'].includes(String(initiationStatus)) ||
              result.directWithdrawal !== null) ||
          typeof result.newRequestWouldResetPending !== 'boolean'
        ) {
          throw new Error('live_exit_invalid')
        }
        if (!controller.signal.aborted && liveExitRequest.current === controller)
          setLiveExit({
            status: 'cooldown_result',
            blockTime: source.blockTime,
            blockNumber: source.blockNumber,
            pendingAssetsRaw: pending.assetsRaw,
            cooldownEnd: pending.cooldownEnd,
            exitMode: exitMode as 'cooldown' | 'direct_withdrawal',
            initiationStatus: initiationStatus as 'success' | 'evm_revert' | 'not_applicable',
            directWithdrawalStatus:
              exitMode === 'direct_withdrawal'
                ? (directWithdrawalStatus as 'success' | 'evm_revert')
                : null,
            claimStatus: claimStatus as
              | 'success'
              | 'evm_revert'
              | 'not_yet_eligible'
              | 'no_pending_claim',
            cooldownDurationSeconds: result.vault.cooldownDurationSeconds,
            resetsPending: result.newRequestWouldResetPending,
          })
        return
      }
      if (isFluidBridgeUsdtLeg) {
        if (
          result.status !== 'checked_at_finalized_block' ||
          result.routeKey !== routeKey ||
          result.request?.assetsRaw !== assetsRaw ||
          result.request?.assetUnit !== 'USDC' ||
          result.routeLeg?.checked !== 'same_holder_usdc_vault_withdrawal_simulation' ||
          result.routeLeg.usdcToUsdtConversion !== 'unassessed' ||
          result.routeLeg.usdtReceipt !== 'unassessed' ||
          !['success', 'evm_revert', 'position_insufficient'].includes(
            String(result.simulation?.status),
          )
        )
          throw new Error('live_exit_invalid')
        if (!controller.signal.aborted && liveExitRequest.current === controller)
          setLiveExit({
            status: 'fluid_bridge_usdc_leg_result',
            blockTime: source.blockTime,
            blockNumber: source.blockNumber,
            usdcAmount: fluidBridgeUsdcLegSize,
            simulation: result.simulation?.status as
              | 'success'
              | 'evm_revert'
              | 'position_insufficient',
          })
        return
      }
      let executable: boolean
      if (isSgho) {
        if (
          result.status !== 'ok' ||
          result.request?.assetsRaw !== assetsRaw ||
          !['success', 'evm_revert', 'position_insufficient'].includes(
            String(result.simulation?.status),
          )
        )
          throw new Error('live_exit_invalid')
        executable = result.simulation?.status === 'success'
      } else {
        if (
          result.routeKey !== routeKey ||
          result.request?.assetsRaw !== assetsRaw ||
          result.status !== 'checked_at_finalized_block' ||
          ![
            'success',
            'evm_revert',
            ...(isDirect ? ['not_holder_exit'] : []),
            ...(isSusds || isUsd3 || isTrackedDirectVault ? ['position_insufficient'] : []),
          ].includes(String(result.simulation?.status))
        )
          throw new Error('live_exit_invalid')
        executable = result.simulation?.status === 'success'
      }
      if (!controller.signal.aborted && liveExitRequest.current === controller)
        setLiveExit({
          status: 'result',
          executable,
          method: isSgho
            ? result.simulation?.status === 'position_insufficient'
              ? 'holder_shares'
              : 'simulation'
            : (isSusds || isUsd3 || isTrackedDirectVault) &&
                result.simulation?.status === 'position_insufficient'
              ? 'holder_shares'
              : isDirect
                ? result.simulation?.status === 'not_holder_exit'
                  ? 'holder_balance'
                  : 'pool_simulation'
                : 'simulation',
          blockTime: source.blockTime,
          blockNumber: source.blockNumber,
          sample:
            executable &&
            alertSupported &&
            source.chainId === 1 &&
            typeof source.blockHash === 'string' &&
            /^0x[0-9a-fA-F]{64}$/.test(source.blockHash)
              ? {
                  routeKey,
                  destination,
                  holder: owner.toLowerCase(),
                  assetsRaw,
                  status: 'success',
                  blockNumber: source.blockNumber,
                  blockHash: source.blockHash,
                  blockTime: source.blockTime,
                }
              : null,
        })
    } catch {
      if (holderExitRequestCanPublish(controller, liveExitRequest.current)) {
        setHolderTimeProcessIssue(null)
        setLiveExit({ status: 'error' })
      }
    }
  }
  useEffect(() => {
    setRouteForecastData(null)
    setRouteForecastLiveData(null)
    setInitialDepositIssue(null)
    setRouteForecastError(false)
    setRouteForecastUnavailable(null)
    if (!destination || !validExitSize) {
      setRouteForecastLoading(false)
      return
    }
    const controller = new AbortController()
    setRouteForecastLoading(true)
    const timer = setTimeout(() => {
      let payoutAsset: string | null = null
      try {
        payoutAsset = resolveHolderExitSubject(
          routeKey,
          destination.toLowerCase() as `0x${string}`,
        ).payoutAsset
      } catch {
        // The archive response retains its typed subject abstention.
      }
      const question: RouteForecastQuestion = {
        routeKey,
        destination: destination.toLowerCase(),
        amountUnits: exitSize,
        horizonHours,
        payoutAsset,
        payoutAssetDecimals: registeredConditionalSampledCashIdentity(routeKey, destination)
          ?.assetDecimals,
      }
      void (async () => {
        let archiveDelivered = false
        try {
          const depositQuestion = initialDepositQuestion(
            scenarioMode,
            routeKey,
            destination,
            depositSize,
            exitSize,
            horizonHours,
          )
          if (depositQuestion) {
            const result = await loadInitialDepositForecast(
              question,
              depositQuestion,
              controller.signal,
            )
            if (!controller.signal.aborted && result) {
              setRouteForecastLiveData(result.baseline)
              setInitialDepositIssue(result.issue)
              setCheckClockMs(Date.now())
              setRouteForecastLoading(false)
              archiveDelivered = true
            }
            return
          }
          const live = await loadRouteForecastWithLiveCurrent(
            question,
            controller.signal,
            (archive) => {
              archiveDelivered = true
              if (controller.signal.aborted) return
              if ('forecast' in archive) setRouteForecastData(archive)
              else setRouteForecastUnavailable(archive)
              setRouteForecastLoading(false)
            },
          )
          if (!controller.signal.aborted && live) {
            setCheckClockMs(Date.now())
            setRouteForecastLiveData(live)
          }
        } catch {
          if (!controller.signal.aborted) setRouteForecastError(true)
        } finally {
          if (!controller.signal.aborted && !archiveDelivered) setRouteForecastLoading(false)
        }
      })()
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [
    destination,
    exitSize,
    horizonHours,
    refreshVersion,
    routeKey,
    validExitSize,
    scenarioMode,
    depositSize,
  ])

  useEffect(() => {
    setRouteEventContext(null)
    if (!routeEventQuestion || !routeEventExpectedEnrollment) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const value = await loadRouteEventContext(
            routeEventQuestion,
            routeEventExpectedEnrollment,
            controller.signal,
          )
          if (!controller.signal.aborted && value) setRouteEventContext(value)
        } catch {
          // Context is optional evidence; forecast calculations remain independent.
        }
      })()
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [refreshVersion, routeEventExpectedEnrollment, routeEventQuestion])

  useEffect(() => {
    setHolderEvidence(null)
    if (!routeKey || !destination) return
    const controller = new AbortController()
    const query = new URLSearchParams({ routeKey, destination })
    void (async () => {
      try {
        const response = await fetch(`/api/carry/holder-exit-evidence?${query.toString()}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result = (await response.json()) as HolderExitEvidenceView
        if (
          result.status === 'available' &&
          result.routeKey === routeKey &&
          result.destination === destination.toLowerCase() &&
          result.calibratedForecast === false &&
          Array.isArray(result.cells)
        )
          setHolderEvidence(result)
      } catch {
        // The cash outlook remains usable when local holder evidence is absent.
      }
    })()
    return () => controller.abort()
  }, [destination, refreshVersion, routeKey])

  useEffect(() => {
    setForceabilityEvidence(null)
    if (!routeKey || !destination) return
    const controller = new AbortController()
    const query = new URLSearchParams({ routeKey, destination })
    void (async () => {
      try {
        const response = await fetch(`/api/carry/holder-exit-forceability?${query.toString()}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result = (await response.json()) as HolderExitForceabilityView
        if (
          !controller.signal.aborted &&
          result.status === 'available' &&
          result.routeKey === routeKey &&
          result.destination === destination.toLowerCase() &&
          result.holderExecutableExit === false &&
          result.forecastValidated === false &&
          ['atomic', 'staged'].includes(result.subject?.mechanism ?? '') &&
          Number.isSafeInteger(result.subject.directIssueCellObservations) &&
          Number.isSafeInteger(result.subject.measuredDirectBaselineCellObservations) &&
          Number.isSafeInteger(result.subject.historicalDirectFinalAssetPayoutTransactions) &&
          result.subject.historicalDirectFinalAssetPayoutTransactions >= 0 &&
          Number.isSafeInteger(result.subject.stageIssueObservations) &&
          Number.isSafeInteger(result.subject.terminalSameEpisodeFinalAssetPaidProofs) &&
          (result.subject.historicalReceiptCohort === null ||
            (result.subject.mechanism === 'staged' &&
              Number.isSafeInteger(result.subject.historicalReceiptCohort?.mintedReceipts) &&
              result.subject.historicalReceiptCohort.mintedReceipts > 0 &&
              Number.isSafeInteger(
                result.subject.historicalReceiptCohort.firstEligibleHolderClaimSuccesses,
              ) &&
              result.subject.historicalReceiptCohort.firstEligibleHolderClaimSuccesses <=
                result.subject.historicalReceiptCohort.mintedReceipts &&
              Number.isSafeInteger(
                result.subject.historicalReceiptCohort.sameReceiptHolderPaidClaims,
              ) &&
              Number.isSafeInteger(result.subject.historicalReceiptCohort.openCensoredReceipts) &&
              result.subject.historicalReceiptCohort.sameReceiptHolderPaidClaims +
                result.subject.historicalReceiptCohort.openCensoredReceipts ===
                result.subject.historicalReceiptCohort.mintedReceipts)) &&
          (result.subject.historicalIntermediateQueue === null ||
            (result.subject.mechanism === 'staged' &&
              /^0x[0-9a-fA-F]{40}$/.test(
                result.subject.historicalIntermediateQueue?.intermediateAsset ?? '',
              ) &&
              [
                result.subject.historicalIntermediateQueue.cutoffBlock,
                result.subject.historicalIntermediateQueue.requests,
                result.subject.historicalIntermediateQueue.processed,
                result.subject.historicalIntermediateQueue.paidIntermediate,
                result.subject.historicalIntermediateQueue.processedUnclaimed,
                result.subject.historicalIntermediateQueue.pendingCensored,
                result.subject.historicalIntermediateQueue.pendingAboveCurrentLimit,
                result.subject.historicalIntermediateQueue.pendingBeforeUpgrade,
                result.subject.historicalIntermediateQueue.pendingAfterUpgrade,
              ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
              result.subject.historicalIntermediateQueue.requests > 0 &&
              result.subject.historicalIntermediateQueue.processed +
                result.subject.historicalIntermediateQueue.pendingCensored ===
                result.subject.historicalIntermediateQueue.requests &&
              result.subject.historicalIntermediateQueue.paidIntermediate +
                result.subject.historicalIntermediateQueue.processedUnclaimed ===
                result.subject.historicalIntermediateQueue.processed &&
              result.subject.historicalIntermediateQueue.pendingAboveCurrentLimit <=
                result.subject.historicalIntermediateQueue.pendingCensored &&
              result.subject.historicalIntermediateQueue.pendingBeforeUpgrade +
                result.subject.historicalIntermediateQueue.pendingAfterUpgrade ===
                result.subject.historicalIntermediateQueue.pendingCensored)) &&
          (result.subject.latestPendingTicketObservation == null ||
            (result.subject.mechanism === 'staged' &&
              result.subject.historicalIntermediateQueue !== null &&
              [
                result.subject.latestPendingTicketObservation.sourceCutoffBlock,
                result.subject.latestPendingTicketObservation.block,
                result.subject.latestPendingTicketObservation.blockTime,
                result.subject.latestPendingTicketObservation.cohort,
                result.subject.latestPendingTicketObservation.stillRequested,
                result.subject.latestPendingTicketObservation.noLongerRequested,
                result.subject.latestPendingTicketObservation.priceGated,
                result.subject.latestPendingTicketObservation.quoteEligible,
                result.subject.latestPendingTicketObservation.atLeastSevenDays,
              ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
              (result.subject.latestPendingTicketObservation.priceGated === 0
                ? result.subject.latestPendingTicketObservation.medianElapsedSeconds === null &&
                  result.subject.latestPendingTicketObservation.atLeastSevenDays === 0
                : Number.isSafeInteger(
                    result.subject.latestPendingTicketObservation.medianElapsedSeconds,
                  ) &&
                  result.subject.latestPendingTicketObservation.medianElapsedSeconds !== null &&
                  result.subject.latestPendingTicketObservation.medianElapsedSeconds >= 0 &&
                  result.subject.latestPendingTicketObservation.medianElapsedSeconds <=
                    result.subject.latestPendingTicketObservation.blockTime) &&
              result.subject.latestPendingTicketObservation.atLeastSevenDays <=
                result.subject.latestPendingTicketObservation.priceGated &&
              result.subject.latestPendingTicketObservation.sourceCutoffBlock ===
                result.subject.historicalIntermediateQueue.cutoffBlock &&
              result.subject.latestPendingTicketObservation.block >
                result.subject.latestPendingTicketObservation.sourceCutoffBlock &&
              result.subject.latestPendingTicketObservation.cohort ===
                result.subject.historicalIntermediateQueue.pendingCensored &&
              result.subject.latestPendingTicketObservation.stillRequested +
                result.subject.latestPendingTicketObservation.noLongerRequested ===
                result.subject.latestPendingTicketObservation.cohort &&
              result.subject.latestPendingTicketObservation.priceGated +
                result.subject.latestPendingTicketObservation.quoteEligible ===
                result.subject.latestPendingTicketObservation.stillRequested &&
              (result.subject.latestPendingTicketObservation.gateChange == null ||
                ([
                  result.subject.latestPendingTicketObservation.gateChange.previousBlock,
                  result.subject.latestPendingTicketObservation.gateChange.newlyGated,
                  result.subject.latestPendingTicketObservation.gateChange.newlyQuoteEligible,
                  result.subject.latestPendingTicketObservation.gateChange.stillGatedDeeper,
                ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
                  result.subject.latestPendingTicketObservation.gateChange.previousBlock <
                    result.subject.latestPendingTicketObservation.block &&
                  /^[0-9a-f]{64}$/.test(
                    result.subject.latestPendingTicketObservation.gateChange.previousEvidenceSha256,
                  ) &&
                  result.subject.latestPendingTicketObservation.gateChange.newlyGated +
                    result.subject.latestPendingTicketObservation.gateChange.stillGatedDeeper <=
                    result.subject.latestPendingTicketObservation.priceGated &&
                  result.subject.latestPendingTicketObservation.gateChange.newlyQuoteEligible <=
                    result.subject.latestPendingTicketObservation.quoteEligible)) &&
              /^[0-9a-f]{64}$/.test(
                result.subject.latestPendingTicketObservation.evidenceSha256,
              ))) &&
          Array.isArray(result.subject.observedRequestToPayoutSeconds) &&
          result.subject.observedRequestToPayoutSeconds.length <=
            result.subject.terminalSameEpisodeFinalAssetPaidProofs &&
          result.subject.observedRequestToPayoutSeconds.every(
            (seconds) => Number.isSafeInteger(seconds) && seconds >= 0,
          ) &&
          typeof result.subject.calibratedImpairmentDuration === 'boolean' &&
          result.subject.forecastValidated === false
        )
          setForceabilityEvidence(result)
      } catch {
        // The workbench remains usable when local evidence is absent.
      }
    })()
    return () => controller.abort()
  }, [destination, refreshVersion, routeKey])

  useEffect(() => {
    setApyUsdOpenReceiptCurrent(null)
    if (
      routeKey !== APYUSD_ROUTE ||
      destination.toLowerCase() !== APYUSD_VAULT ||
      subject?.destinationAddress.toLowerCase() !== APYUSD_VAULT
    )
      return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/carry/apyusd-open-receipt-current', {
          signal: controller.signal,
        })
        if (!response.ok) return
        const result: unknown = await response.json()
        if (!controller.signal.aborted && isApyUsdOpenReceiptCurrent(result))
          setApyUsdOpenReceiptCurrent(result)
      } catch {
        // The dated sealed snapshot remains visible when the local check is unavailable.
      }
    })()
    return () => controller.abort()
  }, [destination, refreshVersion, routeKey, subject?.destinationAddress])

  return (
    <Card id="forecast-workbench" mt={SPACING.xl} p={SPACING.lg}>
      <VStack align="stretch" spacing={SPACING.lg}>
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h2}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Exit ability
          </Text>
        </Box>

        {isStakedUsdat && <StakedUsdatQueuePressureCard />}

        {registryLoading ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
            role="status"
          >
            Loading tracked routes…
          </Text>
        ) : registryError || !registry ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.warning}
            role="alert"
          >
            Route inventory unavailable
          </Text>
        ) : (
          <>
            <HStack spacing={SPACING.sm} role="group" aria-label="Scenario">
              <Text {...labelStyle}>Scenario</Text>
              {(['exit', 'initial_deposit'] as const).map((mode) => (
                <Button
                  key={mode}
                  variant="outline"
                  borderRadius={0}
                  aria-pressed={scenarioMode === mode}
                  color={
                    scenarioMode === mode ? SEMANTIC_COLORS.primary : SEMANTIC_COLORS.textSecondary
                  }
                  transition={TRANSITIONS.colorAndBorder}
                  _focusVisible={FOCUS_STYLES.ring}
                  minH={SPACING['2xl']}
                  onClick={() => {
                    setAlertScope(null)
                    if (mode === 'initial_deposit' && !depositInitialized.current) {
                      depositInitialized.current = true
                      setDepositSize(exitSize)
                      plannedExitEdited.current = false
                    }
                    setScenarioMode(mode)
                  }}
                >
                  {mode === 'exit' ? 'Exit' : 'Deposit'}
                </Button>
              ))}
            </HStack>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.base}>
              <FormControl>
                <FormLabel htmlFor="forecast-route" {...labelStyle}>
                  Route
                </FormLabel>
                <Select
                  id="forecast-route"
                  value={routeKey}
                  onChange={(event) => {
                    const nextGroup = registry.routeGroups.find(
                      (entry) => entry.routeKey === event.target.value,
                    )
                    setAlertScope(null)
                    setObservation(null)
                    setRouteKey(event.target.value)
                    setVault(nextGroup?.contractSubjects[0]?.destinationAddress ?? '')
                  }}
                  borderRadius={0}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  color={SEMANTIC_COLORS.textPrimary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                >
                  {registry.routeGroups.map((entry) => (
                    <option key={entry.routeKey} value={entry.routeKey}>
                      {entry.routeKey}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel htmlFor="forecast-vault" {...labelStyle}>
                  Destination
                </FormLabel>
                <Select
                  id="forecast-vault"
                  value={vault}
                  onChange={(event) => {
                    setAlertScope(null)
                    setVault(event.target.value)
                  }}
                  isDisabled={!group?.contractSubjects.length}
                  borderRadius={0}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  color={SEMANTIC_COLORS.textPrimary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                >
                  {!group?.contractSubjects.length && (
                    <option value="">Exact destination unresolved</option>
                  )}
                  {group?.contractSubjects.map((entry) => (
                    <option key={entry.destinationAddress} value={entry.destinationAddress}>
                      {entry.destinationAddress}
                    </option>
                  ))}
                </Select>
              </FormControl>
            </SimpleGrid>
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.base}>
              {scenarioMode === 'initial_deposit' && (
                <FormControl
                  isInvalid={
                    Boolean(initialDepositMarket(routeKey, destination.toLowerCase())) &&
                    !initialDepositNativeRaw(depositSize)
                  }
                >
                  <FormLabel htmlFor="forecast-deposit-size" {...labelStyle}>
                    Deposit size · {assetUnit}
                  </FormLabel>
                  <Input
                    id="forecast-deposit-size"
                    minH={SPACING['2xl']}
                    value={depositSize}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-invalid={
                      Boolean(initialDepositMarket(routeKey, destination.toLowerCase())) &&
                      !initialDepositNativeRaw(depositSize)
                    }
                    onChange={(event) => {
                      const next = changeInitialDepositAmounts(
                        {
                          depositSize,
                          plannedExitSize: exitSize,
                          plannedExitEdited: plannedExitEdited.current,
                        },
                        'deposit',
                        event.target.value,
                      )
                      setDepositSize(next.depositSize)
                      setExitSize(next.plannedExitSize)
                    }}
                    borderRadius={0}
                    borderColor={SEMANTIC_COLORS.hairline}
                    color={SEMANTIC_COLORS.textPrimary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    _focus={FOCUS_STYLES.ring}
                    _invalid={{ borderColor: SEMANTIC_COLORS.danger }}
                    transition={TRANSITIONS.colorAndBorder}
                  />
                </FormControl>
              )}
              <FormControl isInvalid={!validExitSize}>
                <FormLabel htmlFor="forecast-exit-size" {...labelStyle}>
                  {scenarioMode === 'initial_deposit' ? 'Planned exit' : 'Exit size'} · {assetUnit}
                </FormLabel>
                <Input
                  id="forecast-exit-size"
                  value={exitSize}
                  onChange={(event) => {
                    setAlertScope(null)
                    if (scenarioMode === 'initial_deposit' || depositInitialized.current) {
                      const next = changeInitialDepositAmounts(
                        {
                          depositSize,
                          plannedExitSize: exitSize,
                          plannedExitEdited: plannedExitEdited.current,
                        },
                        'planned_exit',
                        event.target.value,
                      )
                      plannedExitEdited.current = next.plannedExitEdited
                      setExitSize(next.plannedExitSize)
                    } else setExitSize(event.target.value)
                  }}
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={!validExitSize}
                  borderRadius={0}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  color={SEMANTIC_COLORS.textPrimary}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  _focus={FOCUS_STYLES.ring}
                  transition={TRANSITIONS.colors}
                />
              </FormControl>
            </SimpleGrid>

            {group && (
              <HStack spacing={SPACING.base} flexWrap="wrap">
                {routeKey === SGHO_ROUTE && (
                  <NextLink
                    href={`/${chainName}/venue/sGHO`}
                    style={{ textDecoration: 'underline' }}
                  >
                    <Text
                      as="span"
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.info}
                    >
                      sGHO detail
                    </Text>
                  </NextLink>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  borderRadius={0}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  transition={TRANSITIONS.colors}
                  _hover={HOVER_EFFECTS.borderHighlight}
                  _active={ACTIVE_EFFECTS.dim}
                  _focus={FOCUS_STYLES.ring}
                  isDisabled={observationLoading}
                  onClick={() => {
                    setAlertScope(null)
                    setRefreshVersion((version) => version + 1)
                  }}
                >
                  Refresh
                </Button>
              </HStack>
            )}
            {alertScope &&
              alertScope.routeKey === routeKey &&
              alertScope.destination.toLowerCase() === destination.toLowerCase() &&
              alertScope.holder === holderAddress.trim().toLowerCase() &&
              alertScope.assetsRaw === rawExitAmount(exitSize, exitAssetDecimals ?? -1) && (
                <ExitEvidenceAlert
                  key={alertScope.requestId}
                  scope={alertScope}
                  currentSample={
                    liveExit.status === 'assessment_result' && selectedAssessment
                      ? liveExit.sample
                      : null
                  }
                />
              )}

            {scenarioMode === 'exit' && canCheckLiveExit && exitAssetDecimals !== null && (
              <Box
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.base}
              >
                <Text {...labelStyle}>
                  {isPyusdStakingSubject(routeKey, destination)
                    ? 'PRIME redemption · finalized block'
                    : isStakedUsdat
                      ? 'sUSDat share probe · separate from Exit size'
                      : isFluidBridgeUsdtLeg
                        ? 'USDC first leg · separate from Exit size'
                        : isTwynePt
                          ? 'PT withdrawal · finalized block'
                          : routeKey === SUSDE_ROUTE
                            ? 'Current queue · finalized block'
                            : 'Current exit · finalized block'}
                </Text>
                <Box as="form" onSubmit={checkLiveExit} mt={SPACING.sm}>
                  <HStack spacing={SPACING.sm} align="end" flexWrap="wrap">
                    <FormControl flex="1 1 280px">
                      <FormLabel htmlFor="forecast-holder-address" {...labelStyle}>
                        Holder address
                      </FormLabel>
                      <Input
                        id="forecast-holder-address"
                        value={holderAddress}
                        onChange={(event) => {
                          setAlertScope(null)
                          setHolderAddress(event.target.value)
                        }}
                        placeholder="0x…"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={42}
                        borderRadius={0}
                        borderColor={SEMANTIC_COLORS.borderSubtle}
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        _focus={FOCUS_STYLES.ring}
                        transition={TRANSITIONS.colors}
                      />
                    </FormControl>
                    {isFluidBridgeUsdtLeg && (
                      <FormControl flex="1 1 180px" isInvalid={!validFluidBridgeUsdcLegSize}>
                        <FormLabel htmlFor="forecast-fluid-bridge-usdc-leg" {...labelStyle}>
                          Vault withdrawal · USDC
                        </FormLabel>
                        <Input
                          id="forecast-fluid-bridge-usdc-leg"
                          value={fluidBridgeUsdcLegSize}
                          onChange={(event) => setFluidBridgeUsdcLegSize(event.target.value)}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={!validFluidBridgeUsdcLegSize}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isPyusdStakingSubject(routeKey, destination) && (
                      <FormControl flex="1 1 180px" isInvalid={!validPrimeShares}>
                        <FormLabel htmlFor="forecast-prime-shares" {...labelStyle}>
                          First leg · PRIME shares
                        </FormLabel>
                        <Input
                          id="forecast-prime-shares"
                          value={primeShares}
                          onChange={(event) => setPrimeShares(event.target.value)}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={!validPrimeShares}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isStakedUsdat && (
                      <FormControl flex="1 1 180px" isInvalid={!validStakedUsdatShares}>
                        <FormLabel htmlFor="forecast-staked-usdat-shares" {...labelStyle}>
                          Request · sUSDat shares
                        </FormLabel>
                        <Input
                          id="forecast-staked-usdat-shares"
                          value={stakedUsdatShares}
                          onChange={(event) => setStakedUsdatShares(event.target.value)}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={!validStakedUsdatShares}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isStakedUsdat && (
                      <FormControl flex="1 1 150px" isInvalid={!validStakedUsdatTokenId}>
                        <FormLabel htmlFor="forecast-staked-usdat-ticket" {...labelStyle}>
                          Existing ticket · optional
                        </FormLabel>
                        <Input
                          id="forecast-staked-usdat-ticket"
                          value={stakedUsdatTokenId}
                          onChange={(event) => setStakedUsdatTokenId(event.target.value)}
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={78}
                          aria-invalid={!validStakedUsdatTokenId}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isApyUsd && (
                      <FormControl flex="1 1 150px" isInvalid={!validApyUsdReceiptTokenId}>
                        <FormLabel htmlFor="forecast-apyusd-receipt" {...labelStyle}>
                          Existing receipt · optional
                        </FormLabel>
                        <Input
                          id="forecast-apyusd-receipt"
                          value={apyUsdReceiptTokenId}
                          onChange={(event) => setApyUsdReceiptTokenId(event.target.value)}
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={78}
                          aria-invalid={!validApyUsdReceiptTokenId}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isTwynePt && (
                      <FormControl flex="1 1 280px" isInvalid={!validTwyneCollateralVault}>
                        <FormLabel htmlFor="forecast-twyne-collateral-vault" {...labelStyle}>
                          Collateral vault
                        </FormLabel>
                        <Input
                          id="forecast-twyne-collateral-vault"
                          value={twyneCollateralVault}
                          onChange={(event) => setTwyneCollateralVault(event.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={42}
                          aria-invalid={!validTwyneCollateralVault}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    {isTwynePt && (
                      <FormControl flex="1 1 180px" isInvalid={!validTwynePtSize}>
                        <FormLabel htmlFor="forecast-twyne-pt-size" {...labelStyle}>
                          First leg · PT
                        </FormLabel>
                        <Input
                          id="forecast-twyne-pt-size"
                          value={twynePtSize}
                          onChange={(event) => setTwynePtSize(event.target.value)}
                          inputMode="decimal"
                          autoComplete="off"
                          aria-invalid={!validTwynePtSize}
                          borderRadius={0}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          color={SEMANTIC_COLORS.textPrimary}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          _focus={FOCUS_STYLES.ring}
                          transition={TRANSITIONS.colors}
                        />
                      </FormControl>
                    )}
                    <Button
                      type="submit"
                      variant="outline"
                      borderRadius={0}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      transition={TRANSITIONS.colors}
                      _hover={HOVER_EFFECTS.borderHighlight}
                      _active={ACTIVE_EFFECTS.dim}
                      _focus={FOCUS_STYLES.ring}
                      isDisabled={liveExit.status === 'loading'}
                    >
                      {liveExit.status === 'loading'
                        ? 'Checking…'
                        : isPyusdStakingSubject(routeKey, destination)
                          ? 'Check PRIME leg'
                          : isStakedUsdat
                            ? 'Check queue'
                            : isTwynePt
                              ? 'Check PT leg'
                              : isFluidBridgeUsdtLeg
                                ? 'Check USDC leg'
                                : 'Check amount'}
                    </Button>
                  </HStack>
                </Box>
                {liveExit.status === 'error' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.warning}
                    role="alert"
                  >
                    Exit check unavailable
                  </Text>
                )}
                {selectedAssessment && (
                  <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.sm} role="status">
                    <Text {...labelStyle}>
                      {selectedAssessment.unsupportedReason
                        ? 'Route identity'
                        : 'Current holder assessment'}{' '}
                      · block {selectedAssessment.source.blockNumber} ·{' '}
                      {timestamp(selectedAssessment.source.blockTime)} ·{' '}
                      {selectedAssessment.source.originValidation === 'two_provider'
                        ? 'two RPCs'
                        : 'one RPC'}
                    </Text>
                    {selectedAssessment.unsupportedReason && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.warning}
                      >
                        {selectedAssessment.unsupportedReason.replaceAll('_', ' ')}
                      </Text>
                    )}
                    {(selectedStageGroups?.existingClaimStages.length
                      ? [
                          {
                            label: 'This exit',
                            stages: selectedStageGroups.routeStages,
                          },
                          {
                            label: 'Earlier claim',
                            stages: selectedStageGroups.existingClaimStages,
                          },
                        ]
                      : [
                          {
                            label:
                              selectedAssessment.stages[0]?.name === 'prime_redemption'
                                ? 'Independent first leg'
                                : null,
                            stages: selectedAssessment.stages,
                          },
                        ]
                    )
                      .filter((group) => group.stages.length > 0)
                      .map((group) => (
                        <VStack
                          key={group.label ?? 'exit-stages'}
                          align="stretch"
                          spacing={SPACING.xs}
                          borderLeft={group.label ? '1px solid' : undefined}
                          borderColor={SEMANTIC_COLORS.borderSubtle}
                          pl={group.label ? SPACING.sm : undefined}
                        >
                          {group.label && <Text {...labelStyle}>{group.label}</Text>}
                          {group.stages.map((stage) => (
                            <Text
                              key={stage.name}
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.small}
                              color={
                                stage.status === 'simulated'
                                  ? SEMANTIC_COLORS.success
                                  : stage.status === 'reverted'
                                    ? SEMANTIC_COLORS.warning
                                    : SEMANTIC_COLORS.textSecondary
                              }
                            >
                              {stage.name === 'withdrawal'
                                ? 'Withdrawal'
                                : stage.name === 'receipt_initiation'
                                  ? 'Receipt initiation'
                                  : stage.name === 'receipt_claim'
                                    ? selectedAssessment.existingReceiptClaim
                                      ? `Receipt #${selectedAssessment.existingReceiptClaim.tokenId} claim`
                                      : 'Existing receipt claim'
                                    : stage.name === 'cooldown_initiation'
                                      ? 'Cooldown initiation'
                                      : stage.name === 'pending_claim'
                                        ? 'Existing pending claim'
                                        : stage.name === 'queue_request'
                                          ? 'Share queue request'
                                          : stage.name === 'existing_ticket_claim'
                                            ? 'Existing USDat ticket claim'
                                            : stage.name === 'pt_redemption'
                                              ? 'PT from collateral vault'
                                              : stage.name === 'prime_redemption'
                                                ? 'PRIME → wYLDS'
                                                : stage.name === 'redeem'
                                                  ? 'Redeem'
                                                  : stage.name === 'usdc_vault_withdrawal'
                                                    ? 'USDC vault withdrawal'
                                                    : stage.name === 'usdc_to_usdt_conversion'
                                                      ? 'USDC → USDT'
                                                      : 'USDT delivery'}
                              {stage.name === 'usdc_vault_withdrawal' && stage.amountRaw
                                ? ` · ${formatExactRawUnits(stage.amountRaw, 6)} USDC`
                                : ''}
                              {stage.name === 'prime_redemption' && stage.amountRaw
                                ? ` · ${formatExactRawUnits(stage.amountRaw, 6)} PRIME`
                                : ''}
                              {stage.name === 'receipt_claim' &&
                              selectedAssessment.existingReceiptClaim
                                ? ` · ${formatExactRawUnits(selectedAssessment.existingReceiptClaim.amountRaw, 18)} apxUSD`
                                : ''}
                              {' · '}
                              {stage.name === 'prime_redemption' &&
                              selectedAssessment.pyusdStakingCondition
                                ? selectedAssessment.pyusdStakingCondition.reason.replaceAll(
                                    '_',
                                    ' ',
                                  )
                                : stage.status}
                              {stage.name === 'prime_redemption' &&
                              selectedAssessment.pyusdStakingCondition?.reason ===
                                'prime_to_wylds_callable' &&
                              selectedAssessment.pyusdStakingCondition.simulatedWyldsRaw
                                ? ` · ${formatExactRawUnits(selectedAssessment.pyusdStakingCondition.simulatedWyldsRaw, 6)} wYLDS`
                                : ''}
                            </Text>
                          ))}
                        </VStack>
                      ))}
                    {selectedAssessment.condition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {selectedAssessment.condition.slashExposure === 'slashable_assets_present'
                          ? 'slashing possible at checked block'
                          : 'no slashable assets at checked block'}
                      </Text>
                    )}
                    {selectedAssessment.cooldownCondition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        Pending{' '}
                        {formatExactRawUnits(
                          selectedAssessment.cooldownCondition.pendingAssetsRaw,
                          18,
                        )}{' '}
                        USDe
                        {selectedAssessment.cooldownCondition.pendingClaimEarliestAt
                          ? ` · eligible ${timestamp(selectedAssessment.cooldownCondition.pendingClaimEarliestAt)}`
                          : ''}
                        {selectedAssessment.cooldownCondition.newRequestWouldResetPending
                          ? ' · new request resets pending cooldown'
                          : ''}
                      </Text>
                    )}
                    {selectedAssessment.pyusdYieldQueueCondition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        Existing wYLDS ·{' '}
                        {formatExactRawUnits(
                          selectedAssessment.pyusdYieldQueueCondition.existingWyldsSharesRaw,
                          6,
                        )}{' '}
                        shares · pending{' '}
                        {formatExactRawUnits(
                          selectedAssessment.pyusdYieldQueueCondition.pendingSharesRaw,
                          6,
                        )}{' '}
                        shares /{' '}
                        {formatExactRawUnits(
                          selectedAssessment.pyusdYieldQueueCondition.pendingUsdcRaw,
                          6,
                        )}{' '}
                        USDC
                        {(BigInt(selectedAssessment.pyusdYieldQueueCondition.pendingSharesRaw) >
                          0n ||
                          BigInt(selectedAssessment.pyusdYieldQueueCondition.pendingUsdcRaw) >
                            0n) &&
                        elapsedAtSourceBlock(
                          selectedAssessment.pyusdYieldQueueCondition.pendingSinceUnix,
                          selectedAssessment.source.blockTime,
                        )
                          ? ` · pending ${elapsedAtSourceBlock(selectedAssessment.pyusdYieldQueueCondition.pendingSinceUnix, selectedAssessment.source.blockTime)} at block`
                          : ''}
                        {' · new request unassessed · admin completion and PYUSD payout unassessed'}
                      </Text>
                    )}
                    {selectedAssessment.cooldownCondition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        Shared USDe silo ·{' '}
                        {formatExactRawUnits(
                          selectedAssessment.cooldownCondition.aggregateSiloUsdeRaw,
                          18,
                        )}{' '}
                        USDe
                      </Text>
                    )}
                    {selectedAssessment.stakedUsdatCondition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {formatExactRawUnits(
                          selectedAssessment.stakedUsdatCondition.requestedSharesRaw,
                          18,
                        )}{' '}
                        sUSDat shares
                        {selectedAssessment.stakedUsdatCondition.previewUsdatRaw
                          ? ` · preview ${formatExactRawUnits(selectedAssessment.stakedUsdatCondition.previewUsdatRaw, 6)} USDat`
                          : ''}
                        {selectedAssessment.stakedUsdatCondition.existingTicketId &&
                        selectedAssessment.stakedUsdatCondition.existingTicketRequestedAtUnix &&
                        elapsedAtSourceBlock(
                          selectedAssessment.stakedUsdatCondition.existingTicketRequestedAtUnix,
                          selectedAssessment.source.blockTime,
                        )
                          ? ` · ticket ${selectedAssessment.stakedUsdatCondition.existingTicketId} pending ${elapsedAtSourceBlock(selectedAssessment.stakedUsdatCondition.existingTicketRequestedAtUnix, selectedAssessment.source.blockTime)} at block`
                          : ''}
                        {' · AUSD conversion unassessed'}
                      </Text>
                    )}
                    {selectedAssessment.stakedUsdatCondition?.existingTicketConversionQuote && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        Existing ticket {selectedAssessment.stakedUsdatCondition.existingTicketId} ·{' '}
                        {formatExactRawUnits(
                          selectedAssessment.stakedUsdatCondition.existingTicketConversionQuote
                            .usdatInputRaw,
                          6,
                        )}{' '}
                        USDat →{' '}
                        {formatExactRawUnits(
                          selectedAssessment.stakedUsdatCondition.existingTicketConversionQuote
                            .usdcQuotedRaw,
                          6,
                        )}{' '}
                        USDC →{' '}
                        {formatExactRawUnits(
                          selectedAssessment.stakedUsdatCondition.existingTicketConversionQuote
                            .ausdQuotedRaw,
                          6,
                        )}{' '}
                        AUSD · conditional quote at check block · swap and delivery unassessed
                      </Text>
                    )}
                    {selectedAssessment.stakedUsdatCondition?.existingTicketRequestedLimit && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={
                          selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                            .comparison === 'above_current_quote'
                            ? SEMANTIC_COLORS.warning
                            : SEMANTIC_COLORS.textSecondary
                        }
                      >
                        Ticket {selectedAssessment.stakedUsdatCondition.existingTicketId} · min{' '}
                        {formatExactRawUnits(
                          selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                            .minSharePriceRaw,
                          6,
                        )}{' '}
                        · quote{' '}
                        {selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                          .currentNetSharePriceRaw === null
                          ? 'unavailable'
                          : formatExactRawUnits(
                              selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                                .currentNetSharePriceRaw,
                              6,
                            )}{' '}
                        USDat / share ·{' '}
                        {selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                          .comparison === 'above_current_quote'
                          ? `PRICE GATED · update call ${selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit.limitUpdateSimulation === 'success' ? 'passes read-only check' : 'reverts'} · until min is met or changed`
                          : selectedAssessment.stakedUsdatCondition.existingTicketRequestedLimit
                                .comparison === 'at_or_below_current_quote'
                            ? 'price gate clear · operator processing still required'
                            : 'comparison unavailable'}
                      </Text>
                    )}
                    {selectedAssessment.twyneCondition && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {formatExactRawUnits(selectedAssessment.twyneCondition.requestedPtRaw, 18)}{' '}
                        PT first leg · USDe conversion unassessed
                      </Text>
                    )}
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={SEMANTIC_COLORS.textSecondary}
                    >
                      {isApyUsd ? 'New request' : `Final ${assetUnit}`} payout ·{' '}
                      {selectedAssessment.finalPayout.status}
                    </Text>
                    {watchScope && (
                      <HStack spacing={SPACING.sm} flexWrap="wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          borderRadius={0}
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.xs}
                          transition={TRANSITIONS.colors}
                          _hover={HOVER_EFFECTS.borderHighlight}
                          _active={ACTIVE_EFFECTS.dim}
                          _focus={FOCUS_STYLES.ring}
                          isDisabled={
                            holderWatch.status === 'loading' && holderWatch.scope === watchScope
                          }
                          onClick={() => void updateHolderWatch()}
                        >
                          {holderWatch.status === 'loading' && holderWatch.scope === watchScope
                            ? 'Checking watch…'
                            : selectedWatch && selectedWatch.state !== 'absent'
                              ? 'Refresh watch'
                              : 'Watch +1h / +24h'}
                        </Button>
                        {selectedWatch && selectedWatch.state !== 'absent' && (
                          <Text
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.xs}
                            color={
                              selectedWatch.state === 'quarantined' ||
                              selectedWatch.state === 'exhausted' ||
                              selectedWatch.horizons.some((entry) => entry.state === 'exhausted')
                                ? SEMANTIC_COLORS.warning
                                : SEMANTIC_COLORS.textSecondary
                            }
                            role="status"
                          >
                            {selectedWatch.state} ·{' '}
                            {selectedWatch.horizons
                              .map(
                                (entry) =>
                                  `+${entry.horizonHours}h ${entry.state.replaceAll('_', ' ')}`,
                              )
                              .join(' · ')}
                          </Text>
                        )}
                        {holderWatch.status === 'error' && holderWatch.scope === watchScope && (
                          <Text
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.xs}
                            color={SEMANTIC_COLORS.warning}
                            role="alert"
                          >
                            {holderWatch.reason === 'limit_reached'
                              ? 'Watch limit reached'
                              : holderWatch.reason === 'rate_limited'
                                ? 'Watch rate limited'
                                : 'Watch unavailable'}
                          </Text>
                        )}
                      </HStack>
                    )}
                  </VStack>
                )}
                {liveExit.status === 'assessment_result' &&
                  !selectedAssessment &&
                  !isCurrentHolderExitAssessment(liveExit.assessment, checkClockMs) && (
                    <Text
                      mt={SPACING.sm}
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={SEMANTIC_COLORS.warning}
                      role="status"
                    >
                      Exit check expired · run again
                    </Text>
                  )}
                {liveExit.status === 'fluid_bridge_usdc_leg_result' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={
                      liveExit.simulation === 'success'
                        ? SEMANTIC_COLORS.info
                        : SEMANTIC_COLORS.warning
                    }
                    role="status"
                  >
                    {liveExit.usdcAmount} USDC vault withdrawal ·{' '}
                    {liveExit.simulation === 'success'
                      ? 'simulated'
                      : liveExit.simulation === 'position_insufficient'
                        ? 'holder shares insufficient'
                        : 'reverted'}
                    {' · '}USDC→USDT conversion and USDT receipt unassessed · block{' '}
                    {liveExit.blockNumber} · {timestamp(liveExit.blockTime)}
                  </Text>
                )}
                {liveExit.status === 'staked_usdat_result' && (
                  <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.sm} role="status">
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={
                        liveExit.request === 'success'
                          ? SEMANTIC_COLORS.info
                          : SEMANTIC_COLORS.warning
                      }
                    >
                      Request ·{' '}
                      {liveExit.request === 'success'
                        ? 'queue ticket simulation passed'
                        : liveExit.request === 'evm_revert'
                          ? 'simulation reverted'
                          : 'holder shares below request'}
                      {' · '}minimum share price 0
                    </Text>
                    {liveExit.requestTokenId !== null && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={
                          liveExit.claim === 'success'
                            ? SEMANTIC_COLORS.info
                            : SEMANTIC_COLORS.warning
                        }
                      >
                        Ticket {liveExit.requestTokenId} claim ·{' '}
                        {liveExit.claim === 'success'
                          ? `simulated ${formatRawUnits(liveExit.claimUsdatRaw ?? '0', 6)} USDat`
                          : liveExit.claim === 'evm_revert'
                            ? 'simulation reverted'
                            : liveExit.claim === 'not_holder'
                              ? 'held by another address'
                              : 'ticket not found'}
                      </Text>
                    )}
                    {liveExit.requestedLimit && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={
                          liveExit.requestedLimit.comparison === 'above_current_quote'
                            ? SEMANTIC_COLORS.warning
                            : SEMANTIC_COLORS.textSecondary
                        }
                      >
                        Ticket {liveExit.requestTokenId} · min{' '}
                        {formatExactRawUnits(liveExit.requestedLimit.minSharePriceRaw, 6)} · quote{' '}
                        {liveExit.requestedLimit.currentNetSharePriceRaw === null
                          ? 'unavailable'
                          : formatExactRawUnits(
                              liveExit.requestedLimit.currentNetSharePriceRaw,
                              6,
                            )}{' '}
                        USDat / share ·{' '}
                        {liveExit.requestedLimit.comparison === 'above_current_quote'
                          ? `PRICE GATED · update call ${liveExit.requestedLimit.limitUpdateSimulation === 'success' ? 'passes read-only check' : 'reverts'} · until min is met or changed`
                          : liveExit.requestedLimit.comparison === 'at_or_below_current_quote'
                            ? 'price gate clear · operator processing still required'
                            : 'comparison unavailable'}
                      </Text>
                    )}
                    <Text {...labelStyle}>
                      Vault {liveExit.vaultPaused ? 'paused' : 'unpaused'} · queue{' '}
                      {liveExit.queuePaused ? 'paused' : 'unpaused'} · USDat payout and AUSD
                      conversion unverified · block {liveExit.blockNumber} ·{' '}
                      {timestamp(liveExit.blockTime)}
                    </Text>
                  </VStack>
                )}
                {liveExit.status === 'twyne_pt_result' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.warning}
                    role="status"
                  >
                    PT withdrawal{' '}
                    {liveExit.simulation === 'success'
                      ? liveExit.redeemedPtRaw !== null
                        ? `simulated · redeem ${formatExactRawUnits(liveExit.redeemedPtRaw, 18)} PT${liveExit.redeemBelowRequested ? ' below requested amount' : ''}`
                        : 'simulated · redeem quote unavailable'
                      : liveExit.simulation === 'evm_revert'
                        ? 'reverted'
                        : 'shares below amount'}
                    {' · '}PT delivery and USDe conversion unverified · PT expiry{' '}
                    {timestamp(new Date(liveExit.ptExpiry * 1000).toISOString())} · block{' '}
                    {liveExit.blockNumber} · {timestamp(liveExit.blockTime)}
                  </Text>
                )}
                {liveExit.status === 'twyne_pt_unsupported' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.warning}
                    role="status"
                  >
                    PT withdrawal unavailable ·{' '}
                    {liveExit.reason === 'identity_changed'
                      ? 'route asset changed'
                      : 'deployment identity changed'}{' '}
                    · block {liveExit.blockNumber}
                  </Text>
                )}
                {liveExit.status === 'apyusd_result' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={
                      liveExit.initiation === 'success'
                        ? SEMANTIC_COLORS.success
                        : SEMANTIC_COLORS.warning
                    }
                    role="status"
                  >
                    Receipt initiation{' '}
                    {liveExit.initiation === 'success' ? 'simulated' : 'reverted'}
                    {liveExit.ifInitiatedAtCheckedBlockClaimableAt !== null
                      ? ` · if initiated at checked block: eligible from ${timestamp(new Date(liveExit.ifInitiatedAtCheckedBlockClaimableAt * 1000).toISOString())} · ${formatExactRawUnits(liveExit.ifInitiatedAtCheckedBlockEarliestNetRaw!, 18)} apxUSD net · minimum fee from ${timestamp(new Date(liveExit.ifInitiatedAtCheckedBlockMinimumFeeAt! * 1000).toISOString())}: ${formatExactRawUnits(liveExit.ifInitiatedAtCheckedBlockMinimumFeeNetRaw!, 18)} apxUSD net · current curve, conditional`
                      : ''}
                    {' · '}claim payout not checked · block {liveExit.blockNumber} ·{' '}
                    {timestamp(liveExit.blockTime)}
                  </Text>
                )}
                {liveExit.status === 'cooldown_result' && (
                  <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.sm} role="status">
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      {BigInt(liveExit.pendingAssetsRaw) > 0n
                        ? liveExit.exitMode === 'direct_withdrawal'
                          ? `Queued ${formatRawUnits(liveExit.pendingAssetsRaw, 18)} USDe · cooldown off`
                          : `Queued ${formatRawUnits(liveExit.pendingAssetsRaw, 18)} USDe · eligible ${timestamp(liveExit.cooldownEnd ?? undefined)}`
                        : 'No pending claim'}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={
                        liveExit.claimStatus === 'success'
                          ? SEMANTIC_COLORS.success
                          : SEMANTIC_COLORS.warning
                      }
                    >
                      Claim ·{' '}
                      {liveExit.claimStatus === 'success'
                        ? 'simulation passed'
                        : liveExit.claimStatus === 'not_yet_eligible'
                          ? 'cooldown active'
                          : liveExit.claimStatus === 'no_pending_claim'
                            ? 'no queue'
                            : 'simulation reverted'}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={
                        (liveExit.exitMode === 'direct_withdrawal'
                          ? liveExit.directWithdrawalStatus
                          : liveExit.initiationStatus) === 'success'
                          ? SEMANTIC_COLORS.success
                          : SEMANTIC_COLORS.warning
                      }
                    >
                      {liveExit.exitMode === 'direct_withdrawal' ? (
                        <>
                          Direct withdrawal ·{' '}
                          {liveExit.directWithdrawalStatus === 'success'
                            ? 'simulation passed'
                            : 'simulation reverted'}
                        </>
                      ) : (
                        <>
                          New cooldown ·{' '}
                          {liveExit.initiationStatus === 'success'
                            ? `initiation passed · ${liveExit.cooldownDurationSeconds / 3600}h from transaction`
                            : 'initiation reverted'}
                          {liveExit.resetsPending && ' · resets existing queue'}
                        </>
                      )}
                    </Text>
                    <Text {...labelStyle}>
                      Block {liveExit.blockNumber} · {timestamp(liveExit.blockTime)}
                    </Text>
                  </VStack>
                )}
                {liveExit.status === 'umbrella_result' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={
                      liveExit.simulation === 'success'
                        ? SEMANTIC_COLORS.success
                        : SEMANTIC_COLORS.warning
                    }
                    role="status"
                  >
                    {liveExit.gate === 'waiting'
                      ? `Cooldown to ${timestamp(new Date((liveExit.cooldownEnd ?? 0) * 1000).toISOString())}`
                      : liveExit.gate === 'window_open'
                        ? `Window open to ${timestamp(new Date((liveExit.windowEndInclusive ?? 0) * 1000).toISOString())}`
                        : liveExit.gate.replace(/_/g, ' ')}
                    {' · '}
                    {liveExit.simulation === 'success'
                      ? 'redeem simulation passed'
                      : liveExit.simulation === 'evm_revert'
                        ? 'redeem simulation reverted'
                        : 'redeem not simulated'}
                    {' · '}
                    {liveExit.slashExposure === 'slashable_assets_present'
                      ? 'slashing possible'
                      : 'no slashable assets'}
                    {' · '}block {liveExit.blockNumber} · {timestamp(liveExit.blockTime)}
                  </Text>
                )}
                {liveExit.status === 'result' && (
                  <Text
                    mt={SPACING.sm}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={liveExit.executable ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
                    role="status"
                  >
                    {liveExit.method === 'limit'
                      ? liveExit.executable
                        ? 'Holder limit covers amount'
                        : 'Holder limit below amount'
                      : liveExit.method === 'holder_balance'
                        ? 'Holder supply below amount'
                        : liveExit.method === 'holder_shares'
                          ? 'Holder shares below amount'
                          : liveExit.method === 'pool_simulation'
                            ? liveExit.executable
                              ? 'Pool withdrawal simulation passed'
                              : 'Pool withdrawal simulation reverted'
                            : liveExit.executable
                              ? 'Withdrawal simulation passed'
                              : 'Withdrawal simulation reverted'}
                    {' · '}block {liveExit.blockNumber} · {timestamp(liveExit.blockTime)}
                  </Text>
                )}
              </Box>
            )}

            {destination && validExitSize && exitPressureRequestedRaw && (
              <ExitPressureCard
                scenarioMode={scenarioMode}
                depositAmount={depositSize}
                initialDepositIssue={initialDepositIssue}
                routeKey={routeKey}
                destination={destination}
                requestedAmount={exitSize}
                requestedRaw={exitPressureRequestedRaw}
                requestedAssetSymbol={assetUnit}
                requestedAssetAddress={routeForecastPayoutAsset}
                requestedAssetDecimals={exitAssetDecimals}
                horizonHours={horizonHours}
                asOfMs={checkClockMs}
                currentCash={exitPressureCurrentCash}
                conditionalGrossFlowHeadroom={selectedRouteForecast?.conditionalGrossFlowHeadroom}
                aaveSparkCapacityProjection={selectedRouteForecast?.aaveSparkCapacityProjection}
                aaveSparkCapacitySource={selectedRouteForecast?.aaveSparkCapacitySource}
                fluidProtocolCapacityProjection={
                  selectedRouteForecast?.fluidProtocolCapacityProjection
                }
                fluidProtocolCapacityProngs={selectedRouteForecast?.fluidProtocolCapacityProngs}
                conditionalSampledCashPathProjection={
                  selectedRouteForecast?.conditionalSampledCashPathProjection
                }
                conditionalEventImpact={selectedRouteForecast?.conditionalEventImpact}
                analogCashScenario={selectedRouteForecast?.analogCashScenario}
                analogCashIssue={analogCashIssue}
                analogCashSourceConflict={
                  selectedRouteForecast?.liveCurrentRead?.status === 'unavailable' &&
                  [
                    'cash_origin_disagreement',
                    'finalized_block_disagreement',
                    'current_source_conflict',
                  ].includes(selectedRouteForecast.liveCurrentRead.reason)
                }
                prospectiveCashModel={selectedProspectiveCashModel}
                localCarryExitV2Evidence={
                  selectedRouteForecast?.localCarryExitV2Evidence ??
                  routeForecastUnavailable?.localCarryExitV2Evidence ??
                  null
                }
                sampledCashPaths={selectedRouteForecast?.sampledCashPaths ?? null}
                historicalBacktest={exitPressureHistoricalBacktest}
                historicalScenario={exitPressureHistoricalScenario}
                grossWithdrawals={exitPressureGrossWithdrawals}
                grossInflows={exitPressureGrossInflows}
                historicalGrossFlow={exitPressureHistoricalGrossFlow}
                historicalMarketGrossFlow={historicalMarketGrossFlow}
                morphoPayout={exitPressureMorphoPayout}
                holderTimeProcessIssue={holderTimeProcessIssue}
                holderMorphoV2IdleJointIssue={holderMorphoV2IdleJointIssue}
                holderSaturnForecastIssue={holderSaturnForecastIssue}
                saturnRequestTokenId={stakedUsdatTokenId || null}
                holderCapacityAgreement={holderCapacityAgreement}
                holderMorphoV2ProtocolCapacityEvidence={holderMorphoV2ProtocolCapacityEvidence}
                holderMorphoV2CurrentHolderPositionEvidence={
                  holderMorphoV2CurrentHolderPositionEvidence
                }
                holderMorphoV2HistoricalHolderEaEvidence={holderMorphoV2HistoricalHolderEaEvidence}
                holderUsd3JointIssue={holderUsd3JointIssue}
                holderFluidUsdcBridgeJointIssue={holderFluidUsdcBridgeJointIssue}
                holderFluidUsdtBridgeJointIssue={holderFluidUsdtBridgeJointIssue}
                holderUmbrellaGhoJointIssue={holderUmbrellaGhoJointIssue}
                holderApyUsdJointIssue={holderApyUsdJointIssue}
                holderCometFactsAgreement={holderCometFactsAgreement}
                holderStusdsProtocolCapacityEvidence={holderStusdsProtocolCapacityEvidence}
                holderAssessment={boundAssessment}
                requestedHolderAddress={holderAddress.trim() || null}
                expectedEventEnrollment={routeEventExpectedEnrollment}
                eventContext={selectedRouteEventContext}
                historicalOutlook={
                  <HolderExitHistoricalOutlook
                    routeKey={routeKey}
                    destination={destination}
                    asset={
                      selectedHistoricalAssayQuestion.status === 'ready'
                        ? selectedHistoricalAssayQuestion.asset
                        : (selected?.asset ?? null)
                    }
                    assetDecimals={
                      selectedHistoricalAssayQuestion.status === 'ready'
                        ? selectedHistoricalAssayQuestion.assetDecimals
                        : (selected?.assetDecimals ?? null)
                    }
                    assetSymbol={
                      selectedHistoricalAssayQuestion.status === 'ready'
                        ? selectedHistoricalAssayQuestion.assetSymbol
                        : historicalAssetSymbol
                    }
                    horizonHours={horizonHours}
                    requestedRaw={
                      selectedHistoricalAssayQuestion.status === 'ready'
                        ? selectedHistoricalAssayQuestion.requestedRaw
                        : null
                    }
                    qAbstentionReason={
                      selectedHistoricalAssayQuestion.status === 'abstain'
                        ? selectedHistoricalAssayQuestion.reason
                        : null
                    }
                    refreshKey={refreshVersion}
                  />
                }
              />
            )}

            <Text {...labelStyle}>{hideIdleCashModel ? 'Vault assets' : 'Market snapshot'}</Text>
            {observationLoading ? (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                role="status"
              >
                Reading destination…
              </Text>
            ) : observationError ? (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.warning}
                role="alert"
              >
                Snapshot unavailable
              </Text>
            ) : selected && observation?.status === 'observed' ? (
              <VStack align="stretch" spacing={SPACING.md}>
                {observation.freshness === 'stale' && (
                  <Text {...labelStyle} color={SEMANTIC_COLORS.warning} role="status">
                    Stale · over 2h
                  </Text>
                )}
                {selected.routeAssetIdentity === 'unverified' && (
                  <Text {...labelStyle} color={SEMANTIC_COLORS.warning} role="status">
                    Asset unverified
                  </Text>
                )}
                {hideIdleCashModel ? (
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.h3}
                    color={SEMANTIC_COLORS.textPrimary}
                    overflowWrap="anywhere"
                  >
                    {formatRawUnits(selected.totalAssetsRaw ?? '', selected.assetDecimals)}{' '}
                    {assetUnit}
                  </Text>
                ) : (
                  <Box>
                    <Text {...labelStyle}>
                      {selected.marketKind ? 'Market total supply' : 'Total vault assets'} ·
                      {assetUnit}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.h3}
                      color={SEMANTIC_COLORS.textPrimary}
                      overflowWrap="anywhere"
                    >
                      {formatRawUnits(
                        selected.totalAssetsRaw ?? selected.totalSupplyRaw,
                        selected.assetDecimals,
                      )}
                    </Text>
                  </Box>
                )}
                <Box as="details">
                  <Text
                    as="summary"
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                    cursor="pointer"
                    _focus={FOCUS_STYLES.ring}
                  >
                    Evidence · {timestamp(observation.observedAt)}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    overflowWrap="anywhere"
                    mt={SPACING.sm}
                  >
                    {selected.source} · block {observation.block ?? 'unavailable'} · asset{' '}
                    {selected.asset} · hash {observation.blockHash ?? 'unavailable'}
                    {selected.firstLocalReceiptAt &&
                      ` · received ${timestamp(selected.firstLocalReceiptAt)}`}
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textSecondary}
                    mt={SPACING.sm}
                  >
                    {selected.routeAssetIdentity}
                    {!hideIdleCashModel && (
                      <>
                        {' · '}
                        {selected.cashInterpretation === 'wrapped_atoken_exit_cash_unassessed' &&
                          'wrapper cash unassessed · '}
                        {selected.exitMechanics === 'async_queue'
                          ? 'Exit queue; duration unknown'
                          : selected.exitMechanics === 'cooldown_required'
                            ? 'Cooldown; duration unknown'
                            : 'Holder exit unverified'}
                      </>
                    )}
                  </Text>
                  {selected.identityEvidenceUrl && (
                    <Text
                      as="a"
                      href={selected.identityEvidenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      textDecoration="underline"
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.info}
                      mt={SPACING.sm}
                    >
                      Identity source
                    </Text>
                  )}
                  {observation.caveat && (
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.textSecondary}
                      mt={SPACING.sm}
                    >
                      {observation.caveat}
                    </Text>
                  )}
                </Box>
              </VStack>
            ) : (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.warning}
                role="status"
              >
                Snapshot unavailable
              </Text>
            )}

            {!hideIdleCashModel && !(observationError && routeForecastError) && (
              <Box
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.base}
              >
                <Text {...labelStyle} mb={SPACING.base}>
                  Market cash outlook
                </Text>
                <FormControl maxW="220px" mb={SPACING.base}>
                  <FormLabel htmlFor="forecast-horizon" {...labelStyle}>
                    Horizon
                  </FormLabel>
                  <Select
                    id="forecast-horizon"
                    value={horizonHours}
                    onChange={(event) =>
                      setHorizonHours(Number(event.target.value) as 1 | 24 | 48 | 168 | 336 | 720)
                    }
                    borderRadius={0}
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    color={SEMANTIC_COLORS.textPrimary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    _focus={FOCUS_STYLES.ring}
                    transition={TRANSITIONS.colors}
                  >
                    <option value={1}>1 hour</option>
                    <option value={24}>24 hours</option>
                    <option value={48}>48 hours</option>
                    <option value={168}>7 days</option>
                    {holderForecastHorizonOptions(routeKey, destination, scenarioMode).includes(
                      336,
                    ) && <option value={336}>14 days</option>}
                    {holderForecastHorizonOptions(routeKey, destination, scenarioMode).includes(
                      720,
                    ) && <option value={720}>30 days</option>}
                  </Select>
                </FormControl>
                <Text {...labelStyle}>
                  {isTwynePtReserve
                    ? 'Aave PT reserve · source'
                    : DIRECT_MARKET_ROUTES.has(routeKey)
                      ? 'Market cash · source'
                      : 'Vault idle cash · source'}{' '}
                  +{horizonHours}h
                </Text>
                {destination && validExitSize ? (
                  <VStack align="stretch" spacing={SPACING.base} mt={SPACING.base}>
                    {routeForecastLoading ? (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.textSecondary}
                        role="status"
                      >
                        Loading cash model…
                      </Text>
                    ) : routeForecastError ? (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.warning}
                        role="alert"
                      >
                        Cash model unavailable
                      </Text>
                    ) : routeForecastUnavailable ? (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.small}
                        color={SEMANTIC_COLORS.warning}
                        role="status"
                      >
                        {readableReason(routeForecastUnavailable.reason)}
                      </Text>
                    ) : routeForecastData &&
                      routeForecastData.routeKey === routeKey &&
                      routeForecastData.destination === destination.toLowerCase() &&
                      routeForecastData.forecast.amountUnits === Number(exitSize) &&
                      routeForecastData.forecast.horizonHours === horizonHours ? (
                      <VStack align="stretch" spacing={SPACING.base}>
                        {routeForecastData.twynePtReserveModel?.status ===
                        'historical_projection' ? (
                          <Box
                            borderLeft="1px solid"
                            borderColor={SEMANTIC_COLORS.info}
                            pl={SPACING.base}
                          >
                            <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                              {timestamp(routeForecastData.twynePtReserveModel.projection.targetAt)}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.h2}
                              color={SEMANTIC_COLORS.textPrimary}
                            >
                              {formatRawUnits(
                                routeForecastData.twynePtReserveModel.projection.pointRaw,
                                routeForecastData.twynePtReserveModel.projection.assetDecimals,
                              )}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.small}
                              color={SEMANTIC_COLORS.textSecondary}
                            >
                              Historical 5–95% range{' '}
                              {formatRawUnits(
                                routeForecastData.twynePtReserveModel.projection.bandLowRaw,
                                routeForecastData.twynePtReserveModel.projection.assetDecimals,
                              )}
                              –
                              {formatRawUnits(
                                routeForecastData.twynePtReserveModel.projection.bandHighRaw,
                                routeForecastData.twynePtReserveModel.projection.assetDecimals,
                              )}{' '}
                              PT
                            </Text>
                          </Box>
                        ) : routeForecastData.historicalModel?.status ===
                          'historical_projection' ? (
                          <Box
                            borderLeft="1px solid"
                            borderColor={SEMANTIC_COLORS.info}
                            pl={SPACING.base}
                          >
                            <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                              {timestamp(routeForecastData.historicalModel.projection.targetAt)} ·{' '}
                              {routeForecastData.forecast.assetSymbol}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.h2}
                              color={SEMANTIC_COLORS.textPrimary}
                            >
                              {formatRawUnits(
                                routeForecastData.historicalModel.projection.pointRaw,
                                routeForecastData.historicalModel.projection.assetDecimals,
                              )}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.small}
                              color={SEMANTIC_COLORS.textSecondary}
                            >
                              Historical 5–95% range{' '}
                              {formatRawUnits(
                                routeForecastData.historicalModel.projection.bandLowRaw,
                                routeForecastData.historicalModel.projection.assetDecimals,
                              )}
                              –
                              {formatRawUnits(
                                routeForecastData.historicalModel.projection.bandHighRaw,
                                routeForecastData.historicalModel.projection.assetDecimals,
                              )}
                            </Text>
                          </Box>
                        ) : routeForecastData.localHistoricalScenario?.status ===
                          'historical_conditional_cash_scenario' ? null : routeForecastData.forecast
                            .status === 'research_projection' &&
                          routeForecastData.forecast.projection ? (
                          <Box
                            borderLeft="1px solid"
                            borderColor={SEMANTIC_COLORS.info}
                            pl={SPACING.base}
                          >
                            <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                              {timestamp(routeForecastData.forecast.projection.targetAt)} ·{' '}
                              {routeForecastData.forecast.assetSymbol}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.h2}
                              color={SEMANTIC_COLORS.textPrimary}
                            >
                              {formatUnits(routeForecastData.forecast.projection.cashUnits)}
                            </Text>
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.small}
                              color={SEMANTIC_COLORS.textSecondary}
                            >
                              Historical 5–95% range{' '}
                              {formatUnits(routeForecastData.forecast.projection.bandLowUnits)}–
                              {formatUnits(routeForecastData.forecast.projection.bandHighUnits)}
                            </Text>
                          </Box>
                        ) : (
                          <Box
                            borderLeft="1px solid"
                            borderColor={SEMANTIC_COLORS.warning}
                            pl={SPACING.base}
                          >
                            <Text
                              fontFamily={TYPOGRAPHY.fontMono}
                              fontSize={TYPOGRAPHY.small}
                              color={SEMANTIC_COLORS.warning}
                              role="status"
                            >
                              {readableReason(routeForecastData.forecast.reason)}
                            </Text>
                          </Box>
                        )}
                        <Box as="details">
                          <Text
                            as="summary"
                            {...labelStyle}
                            cursor="pointer"
                            _focus={FOCUS_STYLES.ring}
                          >
                            Model evidence
                          </Text>
                          <Text {...labelStyle} mt={SPACING.sm}>
                            {routeForecastData.forecast.sourceSpan.completeSnapshots} observations ·
                            fit {routeForecastData.forecast.backtest.fit.eligible} · calibration{' '}
                            {routeForecastData.forecast.backtest.calibration.eligible} · holdout{' '}
                            {routeForecastData.forecast.backtest.holdout.eligible}
                          </Text>
                          {routeForecastData.baselineEvidence?.status === 'available' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Prospective baseline ·{' '}
                              {routeForecastData.baselineEvidence.attempts.issued} issued ·{' '}
                              {routeForecastData.baselineEvidence.outcomes.observed} observed
                              {' · '}
                              {routeForecastData.baselineEvidence.outcomes.censoredMissing} censored
                              · {routeForecastData.baselineEvidence.outcomes.pending} pending
                              {routeForecastData.baselineEvidence.attempts.unassessed > 0 &&
                                ` · ${routeForecastData.baselineEvidence.attempts.unassessed} unassessed`}
                            </Text>
                          )}
                          {routeForecastData.historicalModel?.status ===
                            'historical_projection' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Historical fit {routeForecastData.historicalModel.backtest.fit} ·
                              calibration {routeForecastData.historicalModel.backtest.calibration}
                              {routeForecastData.historicalModel.backtest.selection !== null &&
                              routeForecastData.historicalModel.backtest.selectionCovered !== null
                                ? ` · selection ${routeForecastData.historicalModel.backtest.selection} · covered ${routeForecastData.historicalModel.backtest.selectionCovered} · untouched test ${routeForecastData.historicalModel.backtest.holdout} · covered ${routeForecastData.historicalModel.backtest.holdoutCovered}`
                                : ` · legacy holdout ${routeForecastData.historicalModel.backtest.holdout} · covered ${routeForecastData.historicalModel.backtest.holdoutCovered}`}
                              {routeForecastData.historicalModel.backtest
                                .holdoutPointBeatsPersistence !== null &&
                                ` · point vs persistence ${routeForecastData.historicalModel.backtest.holdoutPointBeatsPersistence ? 'PASS' : 'FAIL'}`}
                              {' · '}live scores{' '}
                              {routeForecastData.historicalModel.prospective.observed}
                            </Text>
                          )}
                          {routeForecastData.localHistoricalScenario?.status ===
                            'historical_conditional_cash_scenario' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Historical {routeForecastData.localHistoricalScenario.method} · fit{' '}
                              {routeForecastData.localHistoricalScenario.fit} · calibration{' '}
                              {routeForecastData.localHistoricalScenario.calibration} · selection{' '}
                              {routeForecastData.localHistoricalScenario.selection} · covered{' '}
                              {routeForecastData.localHistoricalScenario.selectionCovered}
                              {' · '}untouched test{' '}
                              {routeForecastData.localHistoricalScenario.holdout} · covered{' '}
                              {routeForecastData.localHistoricalScenario.holdoutCovered}
                            </Text>
                          )}
                          {routeForecastData.liveCurrentRead?.status === 'unavailable' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Current cash read ·{' '}
                              {readableReason(routeForecastData.liveCurrentRead.reason)}
                            </Text>
                          )}
                          {routeForecastData.twynePtReserveModel?.status ===
                            'historical_projection' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Aave PT reserve · fit{' '}
                              {routeForecastData.twynePtReserveModel.backtest.fit} · calibration{' '}
                              {routeForecastData.twynePtReserveModel.backtest.calibration} · holdout{' '}
                              {routeForecastData.twynePtReserveModel.backtest.holdout} · covered{' '}
                              {routeForecastData.twynePtReserveModel.backtest.covered} · live scores{' '}
                              {routeForecastData.twynePtReserveModel.prospective.observed}
                            </Text>
                          )}
                          {routeForecastData.baselineEvidence?.status === 'not_enrolled' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Prospective baseline · 1h and 24h only
                            </Text>
                          )}
                          {routeForecastData.baselineEvidence?.status === 'unavailable' && (
                            <Text {...labelStyle} mt={SPACING.sm}>
                              Prospective ledger unavailable
                            </Text>
                          )}
                        </Box>
                      </VStack>
                    ) : null}
                  </VStack>
                ) : null}
              </Box>
            )}
            {forceabilityEvidence &&
              forceabilityEvidence.routeKey === routeKey &&
              forceabilityEvidence.destination === destination.toLowerCase() && (
                <Box
                  borderTop="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                  pt={SPACING.base}
                >
                  <HolderExitForceabilityGate
                    evidence={forceabilityEvidence}
                    apyUsdOpenReceiptStatus={
                      routeKey === APYUSD_ROUTE &&
                      destination.toLowerCase() === APYUSD_VAULT &&
                      subject?.destinationAddress.toLowerCase() === APYUSD_VAULT &&
                      apyUsdOpenReceiptCurrent &&
                      isApyUsdOpenReceiptBlockFreshAt(
                        apyUsdOpenReceiptCurrent.block.timestamp,
                        Date.now(),
                      )
                        ? apyUsdOpenReceiptCurrent
                        : undefined
                    }
                  />
                </Box>
              )}
            {(holderEvidenceSummary ||
              queueRequestEvidenceCell ||
              receiptInitiationEvidenceCell ||
              fluidHolderEvidenceCell ||
              primeFirstStageCell) && (
              <Box
                as="details"
                borderTop="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                pt={SPACING.base}
              >
                <Text as="summary" {...labelStyle} cursor="pointer" _focus={FOCUS_STYLES.ring}>
                  Holder evidence
                </Text>
                {holderEvidenceSummary && (
                  <Text {...labelStyle} mt={SPACING.sm}>
                    Route Q cases at {horizonHours}h · {holderEvidenceSummary.issued} issued ·{' '}
                    {holderEvidenceSummary.eligible} eligible · {holderEvidenceSummary.measured}{' '}
                    measured ({holderEvidenceSummary.success} success,{' '}
                    {holderEvidenceSummary.nonSuccess} non-success) ·{' '}
                    {holderEvidenceSummary.unknown} unknown · {holderEvidenceSummary.attrition}{' '}
                    holder attrition · {holderEvidenceSummary.unavailable} unavailable ·{' '}
                    {holderEvidenceSummary.missing} missing · {holderEvidenceSummary.pending}{' '}
                    pending · sizes and episodes correlated
                  </Text>
                )}
                {holderEvidenceSummary && holderEvidenceSummary.impaired > 0 && (
                  <Text {...labelStyle} mt={SPACING.sm}>
                    Baseline impaired · {holderEvidenceSummary.impaired} Q cases · by +
                    {horizonHours}h: {holderEvidenceSummary.recovered} simulated recoveries,{' '}
                    {holderEvidenceSummary.stillReverting} still reverting,{' '}
                    {holderEvidenceSummary.impairedAttrition} holder attrition,{' '}
                    {holderEvidenceSummary.impairedInconclusive} inconclusive,{' '}
                    {holderEvidenceSummary.impairedPending} pending,{' '}
                    {holderEvidenceSummary.impairedMissing} missing,{' '}
                    {holderEvidenceSummary.impairedUnavailable} unavailable · recovery time interval
                    only
                  </Text>
                )}
                {queueRequestEvidenceCell && (
                  <Text {...labelStyle} mt={SPACING.sm}>
                    sUSDat request call · stress-enriched holder sample · +{horizonHours}h ·{' '}
                    {queueRequestEvidenceCell.issued} issued (
                    {queueRequestEvidenceCell.baselineCallable} callable,{' '}
                    {queueRequestEvidenceCell.baselineReverted} reverted) ·{' '}
                    {queueRequestEvidenceCell.onTimeStateScored} holder states scored,{' '}
                    {queueRequestEvidenceCell.requestCallMeasured} request calls measured:{' '}
                    {queueRequestEvidenceCell.stillCallable} still callable,{' '}
                    {queueRequestEvidenceCell.becameReverting} newly reverting,{' '}
                    {queueRequestEvidenceCell.simulatedCallRecovery} call recoveries,{' '}
                    {queueRequestEvidenceCell.stillReverting} still reverting,{' '}
                    {queueRequestEvidenceCell.holderAttrition} holder attrition ·{' '}
                    {queueRequestEvidenceCell.requestUnavailable} request unavailable ·{' '}
                    {queueRequestEvidenceCell.regimeChangeCensored} upgrade censored ·{' '}
                    {queueRequestEvidenceCell.missed} missed · {queueRequestEvidenceCell.pending}{' '}
                    pending · no ticket or payout measured
                  </Text>
                )}
                {fluidHolderEvidenceCell && (
                  <Box
                    borderLeft="1px solid"
                    borderColor={SEMANTIC_COLORS.info}
                    pl={SPACING.sm}
                    mt={SPACING.sm}
                  >
                    <HStack justifyContent="space-between">
                      <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                        Holder callability
                      </Text>
                      <Text {...labelStyle}>+{horizonHours}h</Text>
                    </HStack>
                    <SimpleGrid columns={{ base: 2, md: 4 }} gap={SPACING.md} mt={SPACING.sm}>
                      <Box>
                        <Text {...labelStyle}>Baseline</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {fluidHolderEvidenceCell.baselineCallable}/
                          {fluidHolderEvidenceCell.issuedCases}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Target callable</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {fluidHolderEvidenceCell.simulatedSuccess}/
                          {fluidHolderEvidenceCell.measuredCases}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Pending</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {fluidHolderEvidenceCell.pending}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Excluded</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {fluidHolderEvidenceCell.holderIneligible +
                            fluidHolderEvidenceCell.entitlementUnassessed +
                            fluidHolderEvidenceCell.identityChanged +
                            fluidHolderEvidenceCell.censored +
                            fluidHolderEvidenceCell.outcomeMissing}
                        </Text>
                      </Box>
                    </SimpleGrid>
                  </Box>
                )}
                {primeFirstStageCell && (
                  <Box
                    borderLeft="1px solid"
                    borderColor={SEMANTIC_COLORS.info}
                    pl={SPACING.sm}
                    mt={SPACING.sm}
                  >
                    <HStack justifyContent="space-between">
                      <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                        PRIME → wYLDS callability
                      </Text>
                      <Text {...labelStyle}>+{horizonHours}h</Text>
                    </HStack>
                    <SimpleGrid columns={{ base: 2, md: 4 }} gap={SPACING.md} mt={SPACING.sm}>
                      <Box>
                        <Text {...labelStyle}>Baseline</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {primeFirstStageCell.baselineCallable}/{primeFirstStageCell.issued}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Target callable</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {primeFirstStageCell.callable}/{primeFirstStageCell.measured}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Pending</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {primeFirstStageCell.pending}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Missed</Text>
                        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
                          {primeFirstStageCell.missedWindow + primeFirstStageCell.outcomeMissing}
                        </Text>
                      </Box>
                    </SimpleGrid>
                    <Text {...labelStyle} mt={SPACING.sm}>
                      First stage only · USDC and PYUSD payout unassessed
                    </Text>
                  </Box>
                )}
                {receiptInitiationEvidenceCell && (
                  <Box
                    borderLeft="1px solid"
                    borderColor={SEMANTIC_COLORS.info}
                    pl={SPACING.sm}
                    mt={SPACING.sm}
                  >
                    <HStack justifyContent="space-between">
                      <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
                        Receipt request
                      </Text>
                      <Text {...labelStyle}>+{horizonHours}h</Text>
                    </HStack>
                    <SimpleGrid columns={{ base: 2, md: 4 }} gap={SPACING.md} mt={SPACING.sm}>
                      <Box>
                        <Text {...labelStyle}>Baseline callable</Text>
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          color={SEMANTIC_COLORS.textPrimary}
                        >
                          {receiptInitiationEvidenceCell.baselineCallable}/
                          {receiptInitiationEvidenceCell.issued}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Future callable</Text>
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          color={SEMANTIC_COLORS.textPrimary}
                        >
                          {receiptInitiationEvidenceCell.initiationSuccess}/
                          {receiptInitiationEvidenceCell.initiationMeasured}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Pending</Text>
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          color={SEMANTIC_COLORS.textPrimary}
                        >
                          {receiptInitiationEvidenceCell.outcomePending}
                        </Text>
                      </Box>
                      <Box>
                        <Text {...labelStyle}>Claim payout</Text>
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.small}
                          color={SEMANTIC_COLORS.warning}
                        >
                          Unmeasured
                        </Text>
                      </Box>
                      {receiptInitiationEvidenceCell.outcomeMissing +
                        receiptInitiationEvidenceCell.outcomeCensored >
                        0 && (
                        <Box>
                          <Text {...labelStyle}>Unavailable</Text>
                          <Text
                            fontFamily={TYPOGRAPHY.fontMono}
                            fontSize={TYPOGRAPHY.small}
                            color={SEMANTIC_COLORS.textPrimary}
                          >
                            {receiptInitiationEvidenceCell.outcomeMissing +
                              receiptInitiationEvidenceCell.outcomeCensored}
                          </Text>
                        </Box>
                      )}
                    </SimpleGrid>
                  </Box>
                )}
              </Box>
            )}
          </>
        )}
      </VStack>
    </Card>
  )
}

export default ForecastWorkbench
