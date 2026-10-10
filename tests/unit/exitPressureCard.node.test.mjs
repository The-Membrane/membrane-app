import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import sampledModule from '../../lib/carry/historicalSampledCashPaths.ts'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import fixturesModule from '../../components/Carry/fixtures.ts'
import registryModule from '../../lib/carry/forecastRegistry.ts'
import registryMarketsModule from '../../lib/carry/forecastRegistryMarkets.ts'
import grossPinsModule from '../../lib/carry/frozenGrossFlowPins.ts'
import stressModule from '../../lib/carry/historicalGrossFlowStress.ts'
import { GHO_SGHO } from '../../scripts/route-rates/exact-leg-spread.mjs'

const {
  ExitPressureCard,
  formatExitPressureRaw,
  formatRequestedCashShare,
  selectedHistoricalBacktest,
  selectedHistoricalGrossFlow,
  selectHistoricalMarketGrossFlow,
} = cardModule
const { ROUTES } = fixturesModule
const { buildCarryForecastRegistry } = registryModule
const { verifiedDirectSupplyDestinations } = registryMarketsModule
const seed = JSON.parse(
  readFileSync(new URL('../../scripts/route-cohort/aug-2026-ab-vault-seed.json', import.meta.url)),
)
const recorderConfig = JSON.parse(
  readFileSync(new URL('../../tools/venue-recorder.config.json', import.meta.url)),
)

const routeKey = 'USDC → supply on Aave V3'
const destination = `0x${'a'.repeat(40)}`
const scope = { routeKey, destination }
const grossDestination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const grossAsset = `0x${'c'.repeat(40)}`
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const grossPins = grossPinsModule.default ?? grossPinsModule

function marketDirection(state, overrides = {}) {
  const source = {
    coverageStartMs: Date.parse('2026-08-01T00:00:00.000Z'),
    coverageEndMs: Date.parse('2026-08-04T00:00:00.000Z'),
  }
  const defaults = {
    two_provider_corroborated_sample: {
      state,
      reason: null,
      source,
      corroboratedDisjointIntervalCount: 3,
      observedMaximumWithinRecordedCoverage: {
        amountRaw: '9000000',
        eventCount: 3,
        horizonHours: 24,
        startMs: source.coverageStartMs,
        endMs: source.coverageStartMs + 86_400_000,
      },
      historicalFlowDistribution: {
        status: 'historical_descriptive',
        method: 'p10_median_p90_of_nonoverlapping_corroborated_intervals',
        intervalCount: 3,
        lowRaw: '1000000',
        middleRaw: '2000000',
        highRaw: '4000000',
      },
    },
    partial_corroborated_range: {
      state,
      reason: 'coverage_shorter_than_horizon',
      source: { ...source, coverageEndMs: source.coverageStartMs + 43_200_000 },
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: {
        status: 'unavailable',
        reason: 'no_corroborated_horizon_interval',
      },
    },
    ambiguous_event_volume: {
      state,
      reason: 'unclassified_compound_withdraw_events',
      source,
      ambiguousEventCount: 7,
      observedEventVolumeWithinRecordedCoverage: {
        status: 'observed',
        amountRaw: '8000000',
        eventCount: 7,
        startMs: source.coverageStartMs,
        endMs: source.coverageStartMs + 86_400_000,
      },
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: {
        status: 'unavailable',
        reason: 'unclassified_compound_withdraw_events',
      },
    },
    aggregate_net_only_context: {
      state,
      reason: 'gross_flow_not_integrated_in_this_report',
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: {
        status: 'unavailable',
        reason: 'gross_flow_not_integrated_in_this_report',
      },
    },
    unavailable: {
      state,
      reason: 'no_integrated_gross_flow_source',
      observedMaximumWithinRecordedCoverage: null,
      historicalFlowDistribution: {
        status: 'unavailable',
        reason: 'no_integrated_gross_flow_source',
      },
    },
  }
  return { ...defaults[state], ...overrides }
}

function marketGrossFlow(inflow, outflow, market = null, horizonHours = 24) {
  const marketRouteKey = market?.routeKey ?? routeKey
  const marketDestination = market?.destination ?? grossDestination
  const marketKey = market?.marketKey ?? 'aaveV3Usdc'
  const bindSource = (direction, flowKind) => {
    if (!direction.source) return direction
    const segmentSha256 = ['a'.repeat(64)]
    const source = {
      ...direction.source,
      kind: 'sealed_public_receipt_replay',
      completenessBasis: 'two_public_rpc_origins_agree_not_absolute_completeness',
      marketKey,
      flowKind,
      asset: grossAsset,
      assetDecimals: 6,
      segmentSha256,
      sourceSetSha256: sha(segmentSha256),
      evidenceBindingSha256: sha({
        routeKey: marketRouteKey,
        destination: marketDestination,
        asset: grossAsset,
        assetDecimals: 6,
        horizonHours,
        flowKind,
        coverageStartMs: direction.source.coverageStartMs,
        coverageEndMs: direction.source.coverageEndMs,
        segmentSha256,
      }),
    }
    const bound = {
      ...direction,
      source,
      zeroMeaning:
        direction.state === 'two_provider_corroborated_sample'
          ? 'zero_matching_events_returned_within_recorded_coverage'
          : undefined,
    }
    const distribution = bound.historicalFlowDistribution
    const maximum = bound.observedMaximumWithinRecordedCoverage
    const event = bound.observedEventVolumeWithinRecordedCoverage
    bound.directionBindingSha256 = sha({
      schema: 'carry_direct_flow_direction_binding_v1',
      routeKey: marketRouteKey,
      destination: marketDestination,
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
      state: bound.state,
      reason: bound.reason,
      observedMaximumWithinRecordedCoverage: maximum
        ? {
            amountRaw: maximum.amountRaw,
            startMs: maximum.startMs,
            endMs: maximum.endMs,
            horizonHours: maximum.horizonHours,
            eventCount: maximum.eventCount,
          }
        : null,
      historicalFlowDistribution:
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
            },
      ambiguousEventCount: bound.ambiguousEventCount ?? null,
      observedEventVolumeWithinRecordedCoverage: event
        ? event.status === 'unavailable'
          ? { status: event.status, reason: event.reason }
          : {
              status: event.status,
              amountRaw: event.amountRaw,
              eventCount: event.eventCount,
              startMs: event.startMs,
              endMs: event.endMs,
            }
        : null,
      corroboratedDisjointIntervalCount: bound.corroboratedDisjointIntervalCount ?? null,
      zeroMeaning: bound.zeroMeaning ?? null,
    })
    return bound
  }
  return {
    schema: 'carry-historical-gross-flow-outlook-v3',
    claimClass: 'retrospective_recorded_gross_flow_only',
    manifestSha256: grossPins.manifestSha256,
    identitySetSha256: grossPins.identitySetSha256,
    coverage: {
      routeGroups: 25,
      exactSubjects: 67,
      corroboratedGrossInflowSubjects: 3,
      corroboratedGrossOutflowSubjects: 2,
      ambiguousOutflowSubjects: 1,
      aggregateNetOnlySubjects: 63,
      morphoRecordedRangeSubjects: 49,
      secondaryRouteFlowSubjects: 2,
    },
    subject: {
      routeKey: marketRouteKey,
      destination: marketDestination,
      asset: grossAsset,
      assetDecimals: 6,
      horizonHours,
      holderExecutableCapacity: false,
      forecastValidated: false,
      morphoRecordedRange: null,
      secondaryRouteFlow: null,
      inflow: bindSource(inflow, 'supply'),
      outflow: bindSource(outflow, 'withdraw'),
      aggregateCashContext:
        inflow.state === 'aggregate_net_only_context' ||
        outflow.state === 'aggregate_net_only_context'
          ? {
              state: 'aggregate_net_only_context',
              metric: 'aggregate_underlying_cash_raw_proxy',
              grossFlowMeasured: false,
              snapshotCount: 3,
              assetDecimals: 6,
              firstReceiptSha256: 'a'.repeat(64),
              latestReceiptSha256: 'b'.repeat(64),
              sourceSetSha256: 'c'.repeat(64),
            }
          : null,
    },
  }
}

function renderMarketGrossFlow(evidence, overrides = {}) {
  return render({
    routeKey: evidence.subject.routeKey,
    destination: evidence.subject.destination,
    currentCash: null,
    historicalBacktest: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    historicalMarketGrossFlow: evidence,
    morphoPayout: null,
    holderAssessment: null,
    eventContext: null,
    historicalOutlook: null,
    ...overrides,
  })
}

function morphoRangeFixture(subject) {
  const total = (amountRaw, eventCount, reconciliation = false) => ({
    recordedTotalWithinCoverage: { amountRaw, eventCount },
    observedMaximumWithinRecordedCoverage: null,
    historicalFlowDistribution: {
      status: 'unavailable',
      reason: 'per_event_timestamps_not_recorded',
      intervalCount: 0,
    },
    ...(reconciliation
      ? { reconciliation: 'receiver_not_vault_only_holder_payout_unreconciled' }
      : {}),
  })
  const rangeSha256 = ['d'.repeat(64)]
  const source = {
    kind: 'sealed_local_morpho_v2_range_replay',
    completenessBasis: 'single_provider_rpc_returned_not_independently_proven',
    eventTimeResolution: 'range_boundaries_only',
    enrollmentSha256: grossPins.morpho.enrollmentSha256,
    rangeSha256,
    sourceSetSha256: sha(rangeSha256),
    coverageStartBlock: '100',
    coverageEndBlock: '200',
    coverageStartMs: 1785542400000,
    coverageEndMs: 1785715200000,
  }
  const grossDeposit = total('1000000', 2)
  const grossExternalReceiverWithdraw = total('500000', 1, true)
  const excludedInternalWithdrawals = {
    amountRaw: '100000',
    eventCount: 1,
    reason: 'vault_receiver_or_force_deallocation_internal_flow',
  }
  return {
    state: 'single_provider_recorded_range',
    reason: null,
    requestedHorizonHours: 24,
    source,
    grossDeposit,
    grossExternalReceiverWithdraw,
    excludedInternalWithdrawals,
    holderPayoutMeasured: false,
    holderExecutableCapacity: false,
    forecastValidated: false,
    evidenceBindingSha256: sha({
      schema: 'carry_morpho_recorded_range_binding_v1',
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      requestedHorizonHours: 24,
      source: {
        enrollmentSha256: source.enrollmentSha256,
        rangeSha256,
        sourceSetSha256: source.sourceSetSha256,
        coverageStartBlock: source.coverageStartBlock,
        coverageEndBlock: source.coverageEndBlock,
        coverageStartMs: source.coverageStartMs,
        coverageEndMs: source.coverageEndMs,
      },
      grossDeposit,
      grossExternalReceiverWithdraw,
      excludedInternalWithdrawals,
    }),
  }
}

function secondaryRouteFixture(subject, pin) {
  const flow = (totalRaw, maximumRaw) => ({
    recordedTotalWithinCoverage: { amountRaw: totalRaw, eventCount: 4 },
    observedMaximumWithinRecordedCoverage: {
      amountRaw: maximumRaw,
      eventCount: 2,
      startMs: 1785542400000,
      endMs: 1785628800000,
      horizonHours: 24,
    },
    historicalFlowDistribution: {
      status: 'historical_descriptive_single_provider',
      method: 'p10_median_p90_of_nonoverlapping_single_provider_intervals',
      intervalCount: 3,
      lowRaw: '1000000',
      middleRaw: '2000000',
      highRaw: '3000000',
    },
    zeroMeaning: 'zero_matching_events_returned_by_single_provider_within_recorded_coverage',
  })
  const recordSha256 = [pin.genesisSha256]
  const source = {
    kind: 'sealed_local_route_flow_v3_replay',
    completenessBasis: 'single_provider_rpc_returned_not_independently_proven',
    genesisSha256: pin.genesisSha256,
    recordSha256,
    sourceSetSha256: sha(recordSha256),
    coverageStartBlock: '100',
    coverageEndBlock: '200',
    coverageStartMs: 1785542400000,
    coverageEndMs: 1785801600000,
    windowBoundaryConvention: 'open_start_closed_end_utc_ms',
  }
  const legs = pin.legs.map((leg) => ({
    ...leg,
    grossExit: flow('9000000', '4000000'),
    grossEntry: flow('8000000', '4000000'),
  }))
  return {
    state: 'single_provider_recorded_range',
    reason: null,
    requestedHorizonHours: 24,
    venue: pin.venue,
    attribution: pin.attribution,
    source,
    legs,
    subjectUnderlyingGrossFlowMeasured: false,
    holderAttributionAvailable: false,
    holderExecutableCapacity: false,
    forecastValidated: false,
    evidenceBindingSha256: sha({
      schema: 'carry_secondary_route_flow_binding_v1',
      routeKey: subject.routeKey,
      destination: subject.destination,
      asset: subject.asset,
      requestedHorizonHours: 24,
      venue: pin.venue,
      attribution: pin.attribution,
      source: {
        genesisSha256: source.genesisSha256,
        recordSha256,
        sourceSetSha256: source.sourceSetSha256,
        coverageStartBlock: source.coverageStartBlock,
        coverageEndBlock: source.coverageEndBlock,
        coverageStartMs: source.coverageStartMs,
        coverageEndMs: source.coverageEndMs,
        windowBoundaryConvention: source.windowBoundaryConvention,
      },
      legs,
    }),
  }
}

function historicalScenario(overrides = {}) {
  return {
    ...scope,
    horizonHours: 24,
    pointRaw: '4600000000000',
    bandLowRaw: '3000000000000',
    bandHighRaw: '6100000000000',
    assetDecimals: 6,
    assetSymbol: 'USDC',
    assetAddress: `0x${'c'.repeat(40)}`,
    currentBlockAt: '2026-10-05T02:00:00.000Z',
    currentBlock: '26123032',
    currentBlockHash: `0x${'d'.repeat(64)}`,
    targetAt: '2026-10-06T02:00:00.000Z',
    sampleCount: 60,
    method: 'learned_delta',
    claim: 'aggregate_underlying_cash_proxy_only',
    prospectiveValidated: false,
    holderExecutableExit: false,
    requestedRaw: '1250000000000',
    requestedAssetAddress: `0x${'c'.repeat(40)}`,
    requestedAssetSymbol: 'USDC',
    requestScope: 'route_exit',
    currentCashRaw: '5000000000000',
    validation: {
      fit: 20,
      calibration: 20,
      holdout: 10,
      covered: 9,
      coveragePassed: true,
      pointBeatsPersistence: true,
    },
    ...overrides,
  }
}

function historicalBacktest(overrides = {}) {
  return {
    schemaVersion: 1,
    identity: {
      routeKey,
      destination,
      asset: `0x${'c'.repeat(40)}`,
      assetDecimals: 6,
    },
    question: { requestedRaw: '1250000000000', horizonHours: 24 },
    claimClass: 'route_proxy',
    holderExecutableExit: false,
    prospectiveValidated: false,
    forecastValidated: false,
    probabilityQExecutable: {
      status: 'unavailable',
      reason: 'prospective_holder_outcomes_missing',
    },
    duration: {
      status: 'historical_interval_outlook',
      claim: 'aggregate_endpoint_cash_proxy_only',
      intervalCensored: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
      requestedRaw: '1250000000000',
      observations: 120,
      observedBelowQSamples: 105,
      timelineSegments: 1,
      verifiedTimelineCoverageSeconds: 10_281_600,
      samplingCadenceSeconds: 86400,
      samplingToleranceSeconds: 5400,
      interpretation: 'completed_sampled_below_q_runs_with_censored_observed_spans',
      sampledRuns: 8,
      completedSampledRuns: 7,
      leftCensoredRuns: 0,
      rightCensoredRuns: 1,
      bothBoundaryCensoredRuns: 0,
      completedSampledRunDurationSeconds: {
        median: { low: 0, high: 172800 },
        p90: { low: 86400, high: 259200 },
        longest: { low: 172800, high: 345600 },
      },
      censoredRunObservedSpanLowerBoundSeconds: {
        leftLongest: null,
        rightLongest: 7_344_000,
      },
    },
    expectedCompetingFlow: {
      status: 'unavailable',
      reason: 'already_embedded_in_net_cash_endpoints',
    },
    newsImpact: { status: 'unavailable', reason: 'no_causal_news_event_model' },
    status: 'historical_backtest',
    analysisKind: 'retrospective_backtest',
    reference: {
      basis: 'historical_tail_endpoint',
      at: '2026-09-01T00:00:00.000Z',
      cashRaw: '5000000000000',
      marginAfterQRaw: '3750000000000',
      state: 'cash_covers_q',
    },
    absoluteQBacktest: {
      status: 'historical_backtest',
      reason: null,
      claim: 'aggregate_endpoint_cash_proxy_only',
      historicalBacktestOnly: true,
      prospectiveValidated: false,
      holderExecutableExit: false,
      requestedRaw: '1250000000000',
      counts: { total: 60, fit: 20, calibration: 20, holdout: 20 },
      outcomes: {
        fitBelowQ: { numerator: 8, denominator: 20 },
        calibrationBelowQ: { numerator: 7, denominator: 20 },
        holdoutBelowQ: { numerator: 9, denominator: 20 },
      },
      scoring: {
        method: 'fit_absolute_q_breach_frequency',
        calibrationBrier: { numerator: '2400', denominator: 8000 },
        calibrationPersistenceBrier: { numerator: '4000', denominator: 8000 },
        holdoutBrier: { numerator: '2600', denominator: 8000 },
        holdoutPersistenceBrier: { numerator: '4200', denominator: 8000 },
        calibrationStable: true,
        calibrationBeatsPersistence: true,
        holdoutBeatsPersistence: true,
      },
      retrospectiveSignal: { status: 'supported', reason: null },
    },
    cashBand: { status: 'unavailable', reason: 'no_skill_over_persistence' },
    alert: { status: 'unavailable', reason: 'retrospective_only' },
    ...overrides,
  }
}

function render(overrides = {}) {
  const pairedWindow = (
    originBlock,
    rank,
    grossReserveInRaw,
    grossReserveOutRaw,
    troughMarginAfterQRaw,
  ) => ({
    originBlock,
    targetBlock: originBlock + 7200,
    sourceCashRaw: '5000000000000',
    targetCashRaw: (
      5000000000000n +
      BigInt(grossReserveInRaw) -
      BigInt(grossReserveOutRaw)
    ).toString(),
    grossReserveInRaw,
    grossReserveOutRaw,
    endpointCashDeltaRaw: (BigInt(grossReserveInRaw) - BigInt(grossReserveOutRaw)).toString(),
    troughCashRaw: (1250000000000n + BigInt(troughMarginAfterQRaw)).toString(),
    troughCashDeltaRaw: (
      1250000000000n +
      BigInt(troughMarginAfterQRaw) -
      5000000000000n
    ).toString(),
    troughBlock: originBlock + 3600,
    endpointCashRaw: (
      5000000000000n +
      BigInt(grossReserveInRaw) -
      BigInt(grossReserveOutRaw)
    ).toString(),
    endpointMarginAfterQRaw: (
      3750000000000n +
      BigInt(grossReserveInRaw) -
      BigInt(grossReserveOutRaw)
    ).toString(),
    endpointDeficitAfterQRaw: '0',
    troughCashRawReplayed: (1250000000000n + BigInt(troughMarginAfterQRaw)).toString(),
    troughMarginAfterQRaw,
    troughDeficitAfterQRaw:
      BigInt(troughMarginAfterQRaw) < 0n ? (-BigInt(troughMarginAfterQRaw)).toString() : '0',
    rank,
    sampleCount: 41,
  })
  const props = {
    ...scope,
    requestedAmount: '1250000',
    requestedRaw: '1250000000000',
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: `0x${'c'.repeat(40)}`,
    requestedAssetDecimals: 6,
    requestedHolderAddress: `0x${'b'.repeat(40)}`,
    horizonHours: 24,
    asOfMs: Date.parse('2026-10-05T02:10:00.000Z'),
    currentCash: {
      ...scope,
      cashRaw: '5000000000000',
      assetDecimals: 6,
      assetSymbol: 'USDC',
      assetAddress: `0x${'c'.repeat(40)}`,
      observedAt: '2026-10-05T02:00:00.000Z',
      block: '26123032',
      blockHash: `0x${'d'.repeat(64)}`,
      freshness: 'fresh',
      label: 'Market cash',
    },
    historicalBacktest: null,
    historicalScenario: historicalScenario(),
    grossWithdrawals: {
      ...scope,
      direction: 'withdrawal',
      amountRaw: '3000000000000',
      assetDecimals: 6,
      assetSymbol: 'USDC',
      window: 'maximum_24h',
      eventCount: 41,
      eventCountScope: 'source',
      windowStartAt: '2026-08-10T00:00:00.000Z',
      windowEndAt: '2026-08-11T00:00:00.000Z',
      interpretation: 'gross_withdrawal',
    },
    grossInflows: {
      ...scope,
      direction: 'inflow',
      amountRaw: '4400000000000',
      assetDecimals: 6,
      assetSymbol: 'USDC',
      window: 'maximum_24h',
      eventCount: 19,
      eventCountScope: 'window',
      windowStartAt: '2026-08-17T00:00:00.000Z',
      windowEndAt: '2026-08-18T00:00:00.000Z',
      interpretation: 'gross_underlying_inflow_not_net_replenishment',
      mayIncludeDebtRepayment: true,
    },
    historicalGrossFlow: {
      ...scope,
      requestedRaw: '1250000000000',
      archiveVerification: 'full_sealed_replay',
      validation: 'not_validated',
      holderExecutableExit: false,
      horizonBlocks: 7200,
      windowCount: 41,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      assetAddress: `0x${'c'.repeat(40)}`,
      startingCashRaw: '5000000000000',
      source: { fromBlock: 100, toBlock: 100000 },
      startingAt: '2026-10-05T02:00:00.000Z',
      startingBlock: 26123032,
      startingBlockHash: `0x${'d'.repeat(64)}`,
      requestedAmountRaw: '1250000000000',
      currentMarginAfterQRaw: '3750000000000',
      pairedScenarios: {
        sampleCount: 41,
        p10Trough: pairedWindow(100, 5, '1000000000', '2000000000', '1500000000000'),
        worstTrough: pairedWindow(200, 1, '500000000', '3000000000', '-50000000000'),
        highestGrossOutflow: pairedWindow(300, 1, '800000000', '4000000000', '250000000000'),
      },
    },
    morphoPayout: {
      ...scope,
      receiptMatchedTransactions: 10,
      externalPayoutRows: 12,
      pendingTransactions: 7,
      ambiguousTransactions: 2,
      sourceCompleteness: 'not_independently_proven',
      sameHolderExit: 'not_established',
      calibratedForecast: false,
    },
    holderAssessment: {
      status: 'partial',
      routeKey,
      destinationAddress: destination,
      owner: `0x${'b'.repeat(40)}`,
      request: {
        assetsRaw: '1250000000000',
        assetAddress: `0x${'c'.repeat(40)}`,
        horizonHours: 24,
      },
      source: {
        chainId: 1,
        blockNumber: 26123032,
        blockHash: `0x${'d'.repeat(64)}`,
        blockTime: '2026-10-05T02:00:00.000Z',
        originValidation: 'two_provider',
      },
      stages: [
        {
          name: 'withdrawal',
          assetAddress: `0x${'c'.repeat(40)}`,
          status: 'simulated',
          amountRaw: '1250000000000',
          relatedToRequest: true,
        },
        {
          name: 'redeem',
          assetAddress: `0x${'c'.repeat(40)}`,
          status: 'unassessed',
          amountRaw: null,
          relatedToRequest: true,
        },
      ],
      finalPayout: {
        assetAddress: `0x${'c'.repeat(40)}`,
        status: 'unassessed',
        amountRaw: null,
      },
      forecast: {
        status: 'unvalidated',
        futureExit: null,
        exitDurationHours: null,
        prospectiveValidated: false,
      },
    },
    expectedEventEnrollment: { status: 'enrolled', venue: 'aave-v3-usde' },
    eventContext: null,
    historicalOutlook: React.createElement('div', null, 'HISTORICAL TEST FIXTURE'),
    ...overrides,
  }
  return renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, props)),
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}

function renderHistoricalBacktest(value) {
  return render({
    asOfMs: Date.parse('2030-01-01T00:00:00.000Z'),
    currentCash: null,
    historicalBacktest: value,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    historicalOutlook: null,
  })
}

test('renders the exact-Q historical backtest without a current read or live scenario', () => {
  const html = renderHistoricalBacktest(historicalBacktest())

  assert.match(html, /HISTORICAL Q BACKTEST · \+24H/)
  assert.match(html, /Split · fit \/ calibration \/ holdout/)
  assert.match(html, /20 \/ 20 \/ 20/)
  assert.match(html, /60 NONOVERLAPPING ENDPOINT PAIRS/)
  assert.match(html, /Endpoints below Q · fit \/ calibration \/ holdout/)
  assert.match(html, /8\/20 \/ 7\/20 \/ 9\/20/)
  assert.match(html, /Signal eligibility/)
  assert.match(html, /ELIGIBLE/)
  assert.match(html, /RETROSPECTIVE ONLY/)
  assert.match(html, /Completed sampled spans · median \/ P90 \/ longest/)
  assert.match(html, /0D–2D \/ 1D–3D \/ 2D–4D/)
  assert.match(html, /7 COMPLETED · AGGREGATE CASH · BETWEEN-SAMPLE RECOVERY UNKNOWN/)
  assert.match(html, /Censored sampled spans · left \/ right/)
  assert.match(html, /0 \/ 1 \(≥85D\)/)
  assert.match(html, /AGGREGATE CASH SAMPLE SPAN ONLY/)
  assert.match(html, /PROVENANCE \/ LOCAL HISTORY · CLAIM \/ RETROSPECTIVE/)
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  assert.doesNotMatch(html, /PROJECTED SHRINK/)
})

test('Aave and Morpho model-selection abstentions still show exact-Q history', () => {
  const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const subjects = [
    {
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    },
    {
      routeKey: 'USDC → VaultV2 [USDC]',
      destination: '0x069662d2588fcac24b5c209456db965d151556f0',
    },
  ]
  for (const subject of subjects) {
    const backtest = historicalBacktest({
      identity: {
        routeKey: subject.routeKey,
        destination: subject.destination,
        asset: usdc,
        assetDecimals: 6,
      },
    })
    const historicalOnlyResponse = {
      exitImpact: { historicalBacktest: backtest, conditionalProjection: null },
      localHistoricalScenario: { status: 'unavailable', reason: 'model_selection_failed' },
    }
    const base = {
      ...subject,
      requestedAssetAddress: usdc,
      historicalScenario: null,
      currentCash: null,
      grossWithdrawals: null,
      grossInflows: null,
      historicalGrossFlow: null,
      historicalMarketGrossFlow: null,
      morphoPayout: null,
      holderAssessment: null,
      historicalOutlook: null,
    }
    const html = render({
      ...base,
      historicalBacktest: historicalOnlyResponse.exitImpact.historicalBacktest,
    })
    assert.match(html, /data-testid="exit-pressure-historical-backtest"/)
    assert.match(html, /8\/20 \/ 7\/20 \/ 9\/20/)
    assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
    assert.doesNotMatch(html, /PROJECTED SHRINK/)

    for (const invalid of [
      null,
      { ...backtest, identity: { ...backtest.identity, destination: `0x${'e'.repeat(40)}` } },
      { ...backtest, identity: { ...backtest.identity, asset: `0x${'e'.repeat(40)}` } },
      { ...backtest, question: { ...backtest.question, requestedRaw: '1' } },
    ]) {
      const rejected = render({ ...base, historicalBacktest: invalid })
      assert.doesNotMatch(rejected, /data-testid="exit-pressure-historical-backtest"/)
    }
  }
})

test('renders boundary-censored sampled evidence when no run has both observed boundaries', () => {
  const valid = historicalBacktest()
  const value = {
    ...valid,
    duration: {
      ...valid.duration,
      observedBelowQSamples: 120,
      sampledRuns: 1,
      completedSampledRuns: 0,
      leftCensoredRuns: 1,
      rightCensoredRuns: 1,
      bothBoundaryCensoredRuns: 1,
      completedSampledRunDurationSeconds: null,
      censoredRunObservedSpanLowerBoundSeconds: {
        leftLongest: 10_281_600,
        rightLongest: 10_281_600,
      },
    },
  }
  const html = renderHistoricalBacktest(value)

  assert.match(html, /Completed sampled spans · median \/ P90 \/ longest/)
  assert.match(html, />NONE</)
  assert.match(html, /1 \(≥119D\) \/ 1 \(≥119D\)/)
  assert.match(html, /AGGREGATE CASH SAMPLE SPAN ONLY/)
})

test('rounds sampled-span lows down and highs up without overstating lower bounds', () => {
  const valid = historicalBacktest()
  const interval = { low: 5_400, high: 9_000 }
  const html = renderHistoricalBacktest({
    ...valid,
    duration: {
      ...valid.duration,
      completedSampledRunDurationSeconds: {
        median: interval,
        p90: interval,
        longest: interval,
      },
      censoredRunObservedSpanLowerBoundSeconds: {
        leftLongest: null,
        rightLongest: 5_400,
      },
    },
  })

  assert.match(html, /1H–3H \/ 1H–3H \/ 1H–3H/)
  assert.match(html, /0 \/ 1 \(≥1H\)/)
  assert.doesNotMatch(html, /≥2H/)
})

test('historical backtest fails closed on scope, question, flags, or count mismatch', () => {
  const valid = historicalBacktest()
  const invalid = [
    { ...valid, identity: null },
    { ...valid, identity: { ...valid.identity, destination: null } },
    { ...valid, identity: { ...valid.identity, routeKey: 'USDT → supply on Spark' } },
    { ...valid, identity: { ...valid.identity, destination: `0x${'e'.repeat(40)}` } },
    { ...valid, identity: { ...valid.identity, asset: `0x${'e'.repeat(40)}` } },
    { ...valid, identity: { ...valid.identity, assetDecimals: 18 } },
    { ...valid, question: { ...valid.question, requestedRaw: '1' } },
    { ...valid, question: { ...valid.question, horizonHours: 1 } },
    { ...valid, forecastValidated: true },
    {
      ...valid,
      absoluteQBacktest: { ...valid.absoluteQBacktest, historicalBacktestOnly: false },
    },
    {
      ...valid,
      absoluteQBacktest: {
        ...valid.absoluteQBacktest,
        counts: { ...valid.absoluteQBacktest.counts, total: 61 },
      },
    },
    {
      ...valid,
      absoluteQBacktest: {
        ...valid.absoluteQBacktest,
        outcomes: {
          ...valid.absoluteQBacktest.outcomes,
          holdoutBelowQ: { numerator: 9, denominator: 19 },
        },
      },
    },
    {
      ...valid,
      duration: { ...valid.duration, requestedRaw: '1' },
    },
    { ...valid, duration: null },
    {
      ...valid,
      duration: {
        ...valid.duration,
        completedSampledRunDurationSeconds: {
          ...valid.duration.completedSampledRunDurationSeconds,
          p90: { low: 1, high: 1 },
        },
      },
    },
    {
      ...valid,
      duration: { ...valid.duration, sampledRuns: 121 },
    },
    {
      ...valid,
      duration: { ...valid.duration, verifiedTimelineCoverageSeconds: 99_999_999 },
    },
    {
      ...valid,
      duration: {
        ...valid.duration,
        censoredRunObservedSpanLowerBoundSeconds: {
          ...valid.duration.censoredRunObservedSpanLowerBoundSeconds,
          rightLongest: null,
        },
      },
    },
    {
      ...valid,
      duration: {
        ...valid.duration,
        censoredRunObservedSpanLowerBoundSeconds: undefined,
      },
    },
    {
      ...valid,
      duration: {
        ...valid.duration,
        observedBelowQSamples: 1,
        sampledRuns: 1,
        completedSampledRuns: 1,
        leftCensoredRuns: 0,
        rightCensoredRuns: 0,
        bothBoundaryCensoredRuns: 0,
        completedSampledRunDurationSeconds: {
          median: { low: 2_592_000, high: 3_456_000 },
          p90: { low: 2_592_000, high: 3_456_000 },
          longest: { low: 2_592_000, high: 3_456_000 },
        },
        censoredRunObservedSpanLowerBoundSeconds: {
          leftLongest: null,
          rightLongest: null,
        },
      },
    },
    {
      ...valid,
      duration: {
        ...valid.duration,
        observedBelowQSamples: 1,
        sampledRuns: 1,
        completedSampledRuns: 0,
        leftCensoredRuns: 0,
        rightCensoredRuns: 1,
        bothBoundaryCensoredRuns: 0,
        completedSampledRunDurationSeconds: null,
        censoredRunObservedSpanLowerBoundSeconds: {
          leftLongest: null,
          rightLongest: 2_592_000,
        },
      },
    },
  ]

  assert.equal(
    selectedHistoricalBacktest(
      valid,
      routeKey,
      destination,
      '1250000000000',
      24,
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T02:10:00.000Z'),
    ),
    valid,
  )
  assert.equal(
    selectedHistoricalBacktest(
      valid,
      routeKey,
      destination,
      '1250000000000',
      24,
      `0x${'e'.repeat(40)}`,
      6,
    ),
    null,
  )
  assert.equal(
    selectedHistoricalBacktest(
      valid,
      routeKey,
      destination,
      '1250000000000',
      24,
      `0x${'c'.repeat(40)}`,
      18,
    ),
    null,
  )
  for (const value of invalid) {
    assert.equal(
      selectedHistoricalBacktest(
        value,
        routeKey,
        destination,
        '1250000000000',
        24,
        `0x${'c'.repeat(40)}`,
        6,
      ),
      null,
    )
    const html = renderHistoricalBacktest(value)
    assert.doesNotMatch(html, /data-testid="exit-pressure-historical-backtest"/)
    assert.doesNotMatch(html, /data-testid="exit-pressure-provenance"/)
  }
})

test('renders one exact-subject pressure card with Q, H24 scenario, and separate flow directions', () => {
  const html = render()
  assert.match(html, /EXIT PRESSURE · \+24H/)
  assert.match(html, /Q 1250000 USDC/)
  assert.match(html, /USDC → supply on Aave V3/)
  assert.match(html, /0xaaaa…aaaa/)
  assert.match(html, /5,000,000 USDC/)
  assert.match(html, /Q \/ current cash/)
  assert.match(html, /25%/)
  assert.match(
    html,
    /ROUTE EXIT PROJECTION · Q 1,250,000 USDC · \+24H · TARGET 2026-10-06 02:00 UTC/,
  )
  assert.match(
    html,
    /LEARNED DELTA · 60 ENDPOINT PAIRS · UNTOUCHED TEST 9\/10 · COVERAGE PASS · POINT SKILL PASS · PROSPECTIVE UNVALIDATED/,
  )
  assert.match(html, /ROUTE CASH PROXY · HOLDER CALL UNASSESSED/)
  assert.match(html, /3,000,000–6,100,000 USDC/)
  assert.match(html, /POINT 4,600,000 USDC/)
  assert.match(html, /\+1,750,000–\+4,850,000 USDC/)
  assert.match(html, /POINT \+3,350,000 USDC/)
  assert.match(html, /Band at or above Q at \+24h/)
  assert.match(html, /SHRINKING −400,000 USDC/)
  assert.match(html, /DIRECTION WINDOWS MAY DIFFER/)
  assert.match(html, /Gross withdrawals/)
  assert.match(html, /3,000,000 USDC/)
  assert.match(html, /2026-08-10 00:00 UTC–2026-08-11 00:00 UTC/)
  assert.match(html, /Gross underlying inflow/)
  assert.match(html, /4,400,000 USDC/)
  assert.match(html, /2026-08-17 00:00 UTC–2026-08-18 00:00 UTC/)
  assert.match(html, /NOT NET REPLENISHMENT · MAY INCLUDE DEBT REPAYMENT/)
  assert.match(html, /HISTORICAL FLOW · 7200 BLOCKS · 41 WINDOWS/)
  assert.match(html, /Heavy flow/)
  assert.match(html, /IN 1,000 \/ OUT 2,000 · MARGIN AFTER Q \+1,500,000 USDC/)
  assert.match(html, /Worst recorded flow/)
  assert.match(html, /IN 500 \/ OUT 3,000 · MARGIN AFTER Q −50,000 USDC/)
  assert.match(html, /Largest outflow/)
  assert.match(html, /IN 800 \/ OUT 4,000 · MARGIN AFTER Q \+250,000 USDC/)
  assert.match(html, /Starting headroom/)
  assert.match(html, /1\/2 request stages simulated/)
  assert.match(html, /FINAL PAYOUT · UNASSESSED · BLOCK 26123032/)
  assert.match(html, /OBSERVED VAULT PAYOUTS/)
  assert.match(html, /SOURCE COMPLETENESS UNPROVEN · SAME-HOLDER EXIT UNESTABLISHED · UNCALIBRATED/)
  assert.match(html, /HISTORICAL TEST FIXTURE/)
  assert.equal((html.match(/data-testid="exit-pressure-provenance"/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Current margin after Q/)
  assert.doesNotMatch(html, /duration/i)
  assert.doesNotMatch(html, /forecast unavailable/i)
})

test('paired flow uses its own fresh cash baseline instead of the main card cash read', () => {
  const html = render({
    currentCash: {
      ...scope,
      cashRaw: '4000000000000',
      assetDecimals: 6,
      assetSymbol: 'USDC',
      assetAddress: `0x${'c'.repeat(40)}`,
      observedAt: '2026-10-05T02:05:00.000Z',
      block: '26123050',
      blockHash: `0x${'e'.repeat(64)}`,
      freshness: 'fresh',
      label: 'Market cash',
    },
  })
  assert.match(html, /Market cash[\s\S]*4,000,000 USDC/)
  assert.match(html, /Starting headroom[\s\S]*\+3,750,000 USDC[\s\S]*SOURCE · 2026-10-05 02:00 UTC/)
})

test('sealed flow scenarios expose matched conditional end-of-block durations and reject a reused cash baseline', () => {
  const summary = JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json',
        import.meta.url,
      ),
    ),
  )
  const stress = stressModule.projectHistoricalGrossFlowStress(
    summary,
    '5000000000000',
    '1250000000000',
  )
  const historicalGrossFlow = {
    ...scope,
    requestedRaw: '1250000000000',
    requestedAmountRaw: '1250000000000',
    archiveVerification: 'full_sealed_replay',
    validation: 'not_validated',
    holderExecutableExit: false,
    horizonBlocks: stress.horizonBlocks,
    windowCount: stress.nonoverlappingWindowCount,
    assetDecimals: 6,
    assetSymbol: 'USDC',
    assetAddress: `0x${'c'.repeat(40)}`,
    startingCashRaw: '5000000000000',
    startingBlock: 26123032,
    startingBlockHash: `0x${'d'.repeat(64)}`,
    startingAt: '2026-10-05T02:00:00.000Z',
    currentMarginAfterQRaw: stress.currentCashMarginToRequestedRaw,
    source: stress.source,
    pairedScenarios: stress.historicalScenarios,
  }
  const html = render({ historicalGrossFlow })
  assert.match(html, /CONDITIONAL HISTORICAL FLOW · 256 BLOCKS · 78 WINDOWS/)
  assert.match(html, /FIRST BELOW Q|ALREADY BELOW Q|BELOW Q NOT SEEN/)
  assert.match(html, /END-OF-BLOCK/)
  const tampered = structuredClone(historicalGrossFlow)
  tampered.pairedScenarios.p10Trough.duration.currentCashRaw = '5000000000001'
  assert.doesNotMatch(render({ historicalGrossFlow: tampered }), /CONDITIONAL HISTORICAL FLOW/)
})

test('turns a Q-crossing route band into one projected shrink warning', () => {
  const html = render({
    requestedAmount: '2500000',
    requestedRaw: '2500000000000',
    historicalScenario: historicalScenario({
      pointRaw: '5000000000000',
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
      method: 'persistence_band',
      requestedRaw: '2500000000000',
      validation: {
        fit: 20,
        calibration: 20,
        holdout: 10,
        covered: 8,
        coveragePassed: true,
        pointBeatsPersistence: null,
      },
    }),
  })
  assert.match(html, /Q inside band at \+24h/)
  assert.match(html, /PROJECTED SHRINK/)
  assert.match(html, /−500,000–\+500,000 USDC/)
  assert.match(html, /POINT \+2,500,000 USDC/)
  assert.equal((html.match(/PROJECTED SHRINK/g) ?? []).length, 1)
})

test('withholds the whole route projection when untouched testing fails', () => {
  const html = render({
    requestedAmount: '2500000',
    requestedRaw: '2500000000000',
    historicalScenario: historicalScenario({
      pointRaw: '1800000000000',
      bandLowRaw: '1000000000000',
      bandHighRaw: '2000000000000',
      requestedRaw: '2500000000000',
      validation: {
        fit: 20,
        calibration: 20,
        holdout: 10,
        covered: 0,
        coveragePassed: false,
        pointBeatsPersistence: false,
      },
    }),
  })
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  assert.doesNotMatch(html, /1,000,000–2,000,000 USDC/)
  assert.doesNotMatch(html, /Band below Q at \+24h/)
  assert.doesNotMatch(html, /PROJECTED SHRINK/)
})

test('fails closed when projected cash and Q are different asset identities', () => {
  const html = render({
    historicalScenario: historicalScenario({
      requestedAssetAddress: `0x${'e'.repeat(40)}`,
    }),
  })
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  assert.doesNotMatch(html, /Margin after Q/)
})

test('requires the displayed current read to match the projection baseline exactly', () => {
  for (const historical of [
    historicalScenario({ currentCashRaw: '4999999999999' }),
    historicalScenario({ currentBlock: '26123031' }),
    historicalScenario({ currentBlockHash: `0x${'e'.repeat(64)}` }),
  ]) {
    const html = render({ historicalScenario: historical })
    assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  }
})

test('does not place an H24 projection inside an H1 card', () => {
  const html = render({ horizonHours: 1 })
  assert.match(html, /EXIT PRESSURE · \+1H/)
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
})

test('expires the projection and fresh cash label as the page clock advances', () => {
  const html = render({ asOfMs: Date.parse('2026-10-05T02:31:00.000Z') })
  assert.doesNotMatch(html, /ROUTE EXIT PROJECTION/)
  assert.match(html, /STALE · 2026-10-05 02:00 UTC/)
  assert.doesNotMatch(html, /FRESH · 2026-10-05 02:00 UTC/)
})

test('does not publish unvalidated historical net-change quantiles as a forward projection', () => {
  const html = render({
    requestedAmount: '2500000',
    requestedRaw: '2500000000000',
    historicalScenario: historicalScenario({
      method: 'historical_net_change',
      pointRaw: '2600000000000',
      bandLowRaw: '2000000000000',
      bandHighRaw: '3000000000000',
      requestedRaw: '2500000000000',
      validation: null,
    }),
  })
  assert.doesNotMatch(html, /Projected cash · worst \/ P10 \/ P90/)
  assert.doesNotMatch(html, /Margin after Q · worst \/ P10 \/ P90/)
  assert.doesNotMatch(html, /Historical route net flow · worst \/ P10 \/ P90/)
  assert.doesNotMatch(html, /Expected route net flow/)
  assert.doesNotMatch(html, /−3,000,000 \/ −2,400,000 \/ −2,000,000 USDC/)
  assert.doesNotMatch(html, /PROJECTED SHRINK/)
})

test('labels an independently sized matching-asset bridge stage as a first-leg projection', () => {
  const html = render({
    historicalScenario: historicalScenario({
      requestedRaw: '900000000000',
      requestScope: 'first_leg',
    }),
  })
  assert.match(html, /FIRST LEG PROJECTION · Q 900,000 USDC · \+24H/)
  assert.match(html, /STAGE CASH PROXY · HOLDER CALL UNASSESSED/)
  assert.match(html, /Margin after first-leg Q/)
  assert.match(html, /\+2,100,000–\+5,200,000 USDC/)
  assert.match(html, /POINT \+3,700,000 USDC/)
})

test('drops stale cross-route evidence while keeping the selected subject card', () => {
  const other = { routeKey: 'USDT → supply on Spark', destination }
  const html = render({
    currentCash: other,
    historicalScenario: other,
    grossWithdrawals: other,
    grossInflows: other,
    historicalGrossFlow: other,
    morphoPayout: other,
    holderAssessment: null,
  })
  assert.match(html, /EXIT PRESSURE · \+24H/)
  assert.match(html, /HISTORICAL TEST FIXTURE/)
  assert.doesNotMatch(html, /Q \/ current cash/)
  assert.doesNotMatch(html, /Gross withdrawals/)
  assert.doesNotMatch(html, /Gross underlying inflow/)
  assert.doesNotMatch(html, /HISTORICAL FLOW/)
  assert.doesNotMatch(html, /OBSERVED VAULT PAYOUTS/)
  assert.doesNotMatch(html, /unavailable/i)
})

test('rejects historical gross flow when route, destination, or Q changes before cleanup', () => {
  const paired = {
    originBlock: 100,
    targetBlock: 7300,
    sourceCashRaw: '5000000000000',
    targetCashRaw: '5000000000000',
    grossReserveInRaw: '0',
    grossReserveOutRaw: '0',
    endpointCashDeltaRaw: '0',
    troughCashRaw: '4900000000000',
    troughCashDeltaRaw: '-100000000000',
    troughBlock: 7300,
    endpointCashRaw: '5000000000000',
    endpointMarginAfterQRaw: '3750000000000',
    endpointDeficitAfterQRaw: '0',
    troughCashRawReplayed: '4900000000000',
    troughMarginAfterQRaw: '3650000000000',
    troughDeficitAfterQRaw: '0',
    rank: 1,
    sampleCount: 1,
  }
  const evidence = {
    ...scope,
    requestedRaw: '1250000000000',
    archiveVerification: 'full_sealed_replay',
    validation: 'not_validated',
    holderExecutableExit: false,
    horizonBlocks: 7200,
    windowCount: 1,
    assetDecimals: 6,
    assetSymbol: 'USDC',
    assetAddress: `0x${'c'.repeat(40)}`,
    startingCashRaw: '5000000000000',
    source: { fromBlock: 100, toBlock: 100000 },
    startingAt: '2026-10-05T02:00:00.000Z',
    startingBlock: 26123032,
    startingBlockHash: `0x${'d'.repeat(64)}`,
    requestedAmountRaw: '1250000000000',
    pairedScenarios: {
      sampleCount: 1,
      p10Trough: paired,
      worstTrough: paired,
      highestGrossOutflow: paired,
    },
    currentMarginAfterQRaw: '3750000000000',
    grossInP90Raw: '900000000000',
    maxGrossInRaw: '1100000000000',
    grossOutP90Raw: '800000000000',
    maxGrossOutRaw: '1200000000000',
    troughP10AfterQRaw: '1500000000000',
    lowestAfterQRaw: '-50000000000',
  }
  assert.equal(
    selectedHistoricalGrossFlow(
      evidence,
      routeKey,
      destination,
      '1250000000000',
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T02:10:00.000Z'),
    ),
    evidence,
  )
  assert.equal(
    selectedHistoricalGrossFlow(
      evidence,
      'USDT → supply on Spark',
      destination,
      evidence.requestedRaw,
      `0x${'c'.repeat(40)}`,
      6,
    ),
    null,
  )
  assert.equal(
    selectedHistoricalGrossFlow(
      evidence,
      routeKey,
      `0x${'e'.repeat(40)}`,
      evidence.requestedRaw,
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T02:10:00.000Z'),
    ),
    null,
  )
  assert.equal(
    selectedHistoricalGrossFlow(
      evidence,
      routeKey,
      destination,
      '2',
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T02:10:00.000Z'),
    ),
    null,
  )
  assert.equal(
    selectedHistoricalGrossFlow(
      { ...evidence, startingCashRaw: '4000000000000' },
      routeKey,
      destination,
      evidence.requestedRaw,
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T02:10:00.000Z'),
    ),
    null,
  )
  assert.equal(
    selectedHistoricalGrossFlow(
      evidence,
      routeKey,
      destination,
      evidence.requestedRaw,
      `0x${'c'.repeat(40)}`,
      6,
      Date.parse('2026-10-05T03:00:00.000Z'),
    ),
    null,
  )
})

test('renders corroborated gross inflow and outflow with separate coverage and recorded maxima', () => {
  const evidence = marketGrossFlow(
    marketDirection('two_provider_corroborated_sample'),
    marketDirection('two_provider_corroborated_sample', {
      observedMaximumWithinRecordedCoverage: {
        amountRaw: '7000000',
        eventCount: 2,
        horizonHours: 24,
        startMs: Date.parse('2026-08-01T00:00:00.000Z'),
        endMs: Date.parse('2026-08-02T00:00:00.000Z'),
      },
    }),
  )
  const html = renderMarketGrossFlow(evidence)
  assert.match(html, /GROSS INFLOW COVERAGE · 3\/67/)
  assert.match(html, /GROSS OUTFLOW COVERAGE · 2\/67/)
  assert.equal((html.match(/CORROBORATED HISTORY/g) ?? []).length, 2)
  assert.match(html, /P10 \/ MEDIAN \/ P90 1 \/ 2 \/ 4 USDC/)
  assert.match(html, /RECORDED COVERAGE MAX 9 USDC/)
  assert.match(html, /RECORDED COVERAGE MAX 7 USDC/)
  assert.match(html, /3 DISJOINT INTERVALS/)
  assert.doesNotMatch(
    html,
    /forecast|predicted|expected flow|complete history|holder.executable capacity/i,
  )
})

test('keeps gross-flow direction states independent and suppresses unsupported bands', () => {
  const states = [
    ['partial_corroborated_range', /PARTIAL RECORDED RANGE · NO FULL-HORIZON INTERVAL/],
    ['ambiguous_event_volume', /UNCLASSIFIED EVENT VOLUME · NO SUPPLIER OUTFLOW BAND/],
    ['aggregate_net_only_context', /AGGREGATE CASH CONTEXT · GROSS FLOW NOT MEASURED/],
    ['unavailable', /GROSS FLOW UNAVAILABLE/],
  ]
  for (const [state, label] of states) {
    const market =
      state === 'ambiguous_event_volume'
        ? {
            routeKey: 'USDC → supply on Compound v3',
            destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
            marketKey: 'compoundV3Usdc',
          }
        : null
    const html = renderMarketGrossFlow(
      marketGrossFlow(
        marketDirection('two_provider_corroborated_sample'),
        marketDirection(state),
        market,
      ),
    )
    assert.match(html, label)
    assert.match(html, /GROSS OUTFLOW COVERAGE · 2\/67/)
    assert.match(html, /RECORDED COVERAGE MAX 9 USDC/)
    assert.equal((html.match(/RECORDED COVERAGE MAX/g) ?? []).length, 1)
    assert.equal((html.match(/P10 \/ MEDIAN \/ P90/g) ?? []).length, 1)
    assert.doesNotMatch(
      html,
      /forecast|predicted|expected flow|complete history|holder.executable capacity/i,
    )
  }
  const noGrossAmount = renderMarketGrossFlow(
    marketGrossFlow(
      marketDirection('aggregate_net_only_context'),
      marketDirection('aggregate_net_only_context'),
    ),
  )
  assert.doesNotMatch(noGrossAmount, /RECORDED COVERAGE MAX|P10 \/ MEDIAN \/ P90/)
})

test('historical market gross flow fails closed on identity, horizon, schema, coverage, and claims', () => {
  const valid = marketGrossFlow(
    marketDirection('two_provider_corroborated_sample'),
    marketDirection('aggregate_net_only_context'),
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(valid, routeKey, grossDestination, 24, grossAsset, 6),
    valid,
  )
  for (const invalid of [
    { ...valid, schema: 'carry-historical-gross-flow-outlook-v1' },
    { ...valid, claimClass: 'forecast' },
    { ...valid, manifestSha256: undefined },
    { ...valid, manifestSha256: 'f'.repeat(64) },
    { ...valid, identitySetSha256: 'f'.repeat(64) },
    { ...valid, coverage: { ...valid.coverage, exactSubjects: 68 } },
    { ...valid, subject: { ...valid.subject, routeKey: 'USDT → supply on Spark' } },
    { ...valid, subject: { ...valid.subject, destination: `0x${'e'.repeat(40)}` } },
    { ...valid, subject: { ...valid.subject, horizonHours: 168 } },
    { ...valid, subject: { ...valid.subject, holderExecutableCapacity: true } },
    { ...valid, subject: { ...valid.subject, forecastValidated: true } },
    {
      ...valid,
      subject: { ...valid.subject, outflow: { ...valid.subject.outflow, state: 'unknown' } },
    },
  ]) {
    assert.equal(
      selectHistoricalMarketGrossFlow(invalid, routeKey, grossDestination, 24, grossAsset, 6),
      null,
    )
    assert.doesNotMatch(renderMarketGrossFlow(invalid), /RECORDED MARKET GROSS FLOW/)
  }
  assert.equal(
    selectHistoricalMarketGrossFlow(valid, routeKey, grossDestination, 1, grossAsset, 6),
    null,
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(valid, routeKey, grossDestination, 168, grossAsset, 6),
    null,
  )
  const weekStart = Date.parse('2026-08-01T00:00:00.000Z')
  const weekly = marketGrossFlow(
    marketDirection('two_provider_corroborated_sample', {
      source: { coverageStartMs: weekStart, coverageEndMs: weekStart + 21 * 86_400_000 },
      observedMaximumWithinRecordedCoverage: {
        amountRaw: '9000000',
        eventCount: 3,
        horizonHours: 168,
        startMs: weekStart,
        endMs: weekStart + 7 * 86_400_000,
      },
    }),
    marketDirection('unavailable'),
    null,
    168,
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(weekly, routeKey, grossDestination, 168, grossAsset, 6),
    weekly,
  )
})

test('rejects crossed measured assets and decimals while keeping amount-free staged context', () => {
  const measured = marketGrossFlow(
    marketDirection('two_provider_corroborated_sample'),
    marketDirection('unavailable'),
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(
      measured,
      routeKey,
      grossDestination,
      24,
      `0x${'d'.repeat(40)}`,
      6,
    ),
    null,
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(measured, routeKey, grossDestination, 24, grossAsset, 18),
    null,
  )
  assert.doesNotMatch(
    renderMarketGrossFlow(measured, { requestedAssetAddress: `0x${'d'.repeat(40)}` }),
    /RECORDED MARKET GROSS FLOW/,
  )
  const staged = marketGrossFlow(
    marketDirection('aggregate_net_only_context'),
    marketDirection('aggregate_net_only_context'),
  )
  const html = renderMarketGrossFlow(staged, {
    requestedAssetAddress: `0x${'d'.repeat(40)}`,
    requestedAssetDecimals: 18,
  })
  assert.match(html, /AGGREGATE CASH CONTEXT · GROSS FLOW NOT MEASURED/)
  assert.doesNotMatch(html, /RECORDED COVERAGE MAX|P10 \/ MEDIAN \/ P90/)
})

test('rejects forged gross-flow quantiles, maxima, source provenance, and aggregate context', () => {
  const valid = marketGrossFlow(
    marketDirection('two_provider_corroborated_sample'),
    marketDirection('aggregate_net_only_context'),
  )
  const mutations = [
    (row) => (row.subject.inflow.historicalFlowDistribution.lowRaw = '5000000'),
    (row) => (row.subject.inflow.historicalFlowDistribution.method = 'estimated'),
    (row) => (row.subject.inflow.historicalFlowDistribution.intervalCount = 2),
    (row) => (row.subject.inflow.observedMaximumWithinRecordedCoverage.amountRaw = '3000000'),
    (row) => (row.subject.inflow.observedMaximumWithinRecordedCoverage.horizonHours = 168),
    (row) => (row.subject.inflow.observedMaximumWithinRecordedCoverage.eventCount = -1),
    (row) => (row.subject.inflow.source.marketKey = 'compoundV3Usdc'),
    (row) => (row.subject.inflow.source.flowKind = 'withdraw'),
    (row) => (row.subject.inflow.source.completenessBasis = 'one_provider'),
    (row) => (row.subject.inflow.source.asset = `0x${'d'.repeat(40)}`),
    (row) => (row.subject.inflow.source.assetDecimals = 18),
    (row) => (row.subject.inflow.source.segmentSha256 = ['b'.repeat(64)]),
    (row) => (row.subject.inflow.source.evidenceBindingSha256 = 'f'.repeat(64)),
    (row) => (row.subject.inflow.corroboratedDisjointIntervalCount = 2),
    (row) => (row.subject.aggregateCashContext.grossFlowMeasured = true),
    (row) => (row.subject.aggregateCashContext = null),
  ]
  for (const mutate of mutations) {
    const invalid = structuredClone(valid)
    mutate(invalid)
    assert.equal(
      selectHistoricalMarketGrossFlow(invalid, routeKey, grossDestination, 24, grossAsset, 6),
      null,
    )
  }
})

test('renders Morpho whole-range totals without a horizon band or holder payout claim', () => {
  const evidence = marketGrossFlow(
    marketDirection('aggregate_net_only_context'),
    marketDirection('aggregate_net_only_context'),
    { routeKey: 'USDC → VaultV2 [USDC]', destination: `0x${'e'.repeat(40)}` },
  )
  evidence.subject.morphoRecordedRange = morphoRangeFixture(evidence.subject)
  assert.equal(
    selectHistoricalMarketGrossFlow(
      evidence,
      evidence.subject.routeKey,
      evidence.subject.destination,
      24,
      evidence.subject.asset,
      6,
    ),
    evidence,
  )
  const html = renderMarketGrossFlow(evidence)
  assert.match(html, /MORPHO VAULT · SINGLE-PROVIDER RECORDED RANGE/)
  assert.match(html, /RANGE TOTALS ONLY · EVENT TIMES UNRECORDED/)
  assert.match(html, /Recorded deposits/)
  assert.match(html, /External-receiver withdrawals/)
  assert.match(html, /1 USDC/)
  assert.match(html, /0\.5 USDC/)
  assert.doesNotMatch(html, new RegExp(grossAsset))
  assert.doesNotMatch(html, /P10 \/ MEDIAN \/ P90|RECORDED COVERAGE MAX/)
  for (const mutate of [
    (row) => (row.subject.morphoRecordedRange.holderPayoutMeasured = true),
    (row) => (row.subject.morphoRecordedRange.source.rangeSha256 = ['f'.repeat(64)]),
    (row) =>
      (row.subject.morphoRecordedRange.grossDeposit.recordedTotalWithinCoverage.amountRaw = '2'),
    (row) => (row.coverage.morphoRecordedRangeSubjects = -1),
  ]) {
    const invalid = structuredClone(evidence)
    mutate(invalid)
    assert.equal(
      selectHistoricalMarketGrossFlow(
        invalid,
        invalid.subject.routeKey,
        invalid.subject.destination,
        24,
        invalid.subject.asset,
        6,
      ),
      null,
    )
  }
})

test('renders secondary route flow in pinned output-token units with attribution limits', () => {
  const pin = grossPins.secondaryRouteFlows.sUSDS
  const evidence = marketGrossFlow(
    marketDirection('aggregate_net_only_context'),
    marketDirection('aggregate_net_only_context'),
    { routeKey: pin.routeKey, destination: pin.destination },
  )
  evidence.subject.asset = pin.subjectAsset
  evidence.subject.assetDecimals = 18
  evidence.subject.aggregateCashContext.assetDecimals = 18
  evidence.subject.secondaryRouteFlow = secondaryRouteFixture(evidence.subject, pin)
  assert.equal(
    selectHistoricalMarketGrossFlow(
      evidence,
      pin.routeKey,
      pin.destination,
      24,
      pin.subjectAsset,
      18,
    ),
    evidence,
  )
  assert.equal(
    selectHistoricalMarketGrossFlow(evidence, pin.routeKey, pin.destination, 24, grossAsset, 6),
    null,
  )
  const html = renderMarketGrossFlow(evidence, {
    requestedAssetAddress: pin.subjectAsset,
    requestedAssetDecimals: 18,
  })
  assert.match(html, /sUSDS ROUTE FLOW · SINGLE-PROVIDER RECORDED RANGE/)
  assert.match(html, /OUTPUT-TOKEN UNITS · NOT HOLDER-ATTRIBUTED/)
  assert.match(html, /9 USDC/)
  assert.match(html, /8 USDC/)
  assert.doesNotMatch(html, new RegExp(pin.legs[0].outputAsset))
  assert.doesNotMatch(html, /P10 \/ MEDIAN \/ P90|RECORDED COVERAGE MAX/)
  for (const mutate of [
    (row) => (row.subject.secondaryRouteFlow.holderAttributionAvailable = true),
    (row) => (row.subject.secondaryRouteFlow.legs[0].outputAsset = grossAsset),
    (row) => (row.subject.secondaryRouteFlow.legs[0].outputSymbol = 'DOLA'),
    (row) => delete row.subject.secondaryRouteFlow.legs[0].outputSymbol,
    (row) =>
      (row.subject.secondaryRouteFlow.legs[0].grossExit.recordedTotalWithinCoverage.amountRaw =
        '1'),
    (row) => (row.subject.secondaryRouteFlow.source.recordSha256 = ['f'.repeat(64)]),
    (row) => (row.coverage.secondaryRouteFlowSubjects = 68),
  ]) {
    const invalid = structuredClone(evidence)
    mutate(invalid)
    assert.equal(
      selectHistoricalMarketGrossFlow(
        invalid,
        pin.routeKey,
        pin.destination,
        24,
        pin.subjectAsset,
        18,
      ),
      null,
    )
  }
})

test('renders the pinned DOLA output unit for the sUSDe route', () => {
  const pin = grossPins.secondaryRouteFlows.sUSDe
  const evidence = marketGrossFlow(
    marketDirection('aggregate_net_only_context'),
    marketDirection('aggregate_net_only_context'),
    { routeKey: pin.routeKey, destination: pin.destination },
  )
  evidence.subject.asset = pin.subjectAsset
  evidence.subject.assetDecimals = 18
  evidence.subject.aggregateCashContext.assetDecimals = 18
  evidence.subject.secondaryRouteFlow = secondaryRouteFixture(evidence.subject, pin)
  assert.equal(
    selectHistoricalMarketGrossFlow(
      evidence,
      pin.routeKey,
      pin.destination,
      24,
      pin.subjectAsset,
      18,
    ),
    evidence,
  )
  const html = renderMarketGrossFlow(evidence, {
    requestedAssetAddress: pin.subjectAsset,
    requestedAssetDecimals: 18,
    requestedAssetSymbol: 'USDe',
  })
  assert.match(html, /DOLA/)
  assert.doesNotMatch(html, new RegExp(pin.legs[0].outputAsset))
})

test('renders pending-only Morpho evidence and suppresses blanket provenance without evidence', () => {
  const pendingOnly = render({
    currentCash: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    holderAssessment: null,
    historicalOutlook: null,
    morphoPayout: {
      ...scope,
      receiptMatchedTransactions: 0,
      externalPayoutRows: 0,
      pendingTransactions: 3,
      ambiguousTransactions: 2,
      sourceCompleteness: 'not_independently_proven',
      sameHolderExit: 'not_established',
      calibratedForecast: false,
    },
  })
  assert.match(pendingOnly, /OBSERVED VAULT PAYOUTS/)
  assert.match(pendingOnly, /Pending/)
  assert.match(pendingOnly, />3</)
  assert.match(pendingOnly, /Ambiguous/)
  assert.match(pendingOnly, />2</)

  const empty = render({
    currentCash: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    historicalOutlook: null,
  })
  assert.doesNotMatch(empty, /data-testid="exit-pressure-provenance"/)
})

test('renders one compact factual context block and rejects identity or URL drift', () => {
  const contextRouteKey = 'USDe → supply on Aave V3'
  const contextDestination = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
  const context = {
    status: 'route_event_context',
    question: {
      routeKey: contextRouteKey,
      destination: contextDestination,
      requestedRaw: '1250000000000',
      payoutAsset: `0x${'c'.repeat(40)}`,
      assetDecimals: 6,
      horizonHours: 24,
    },
    venue: 'aave-v3-usde',
    newsSource: 'aave-v3-usde',
    association: 'contemporaneous_facts_no_causal_attribution',
    event: {
      status: 'observed',
      kind: 'liquidity_shift',
      at: '2026-10-05T02:00:00.000Z',
      provenance: 'observed',
    },
    news: {
      status: 'observed',
      title: 'Raw venue headline',
      source: 'Publisher',
      url: 'https://news.example.com/story?id=1',
      publishedAt: '2026-10-05T01:00:00.000Z',
      observedAt: '2026-10-05T02:00:00.000Z',
      treatment: 'raw_headline',
      coverage: 'latest_items_only',
      observedItemCount: 25,
    },
    capacity: {
      status: 'observed',
      metric: 'aggregate_cash_raw',
      direction: 'shrinking',
      beforeRaw: '5000000000000',
      afterRaw: '2500000000000',
      assetDecimals: 6,
      requestedShareBefore: '25%',
      requestedShareAfter: '50%',
      elapsedSourceSeconds: 3600,
      beforeAt: '2026-10-05T01:00:00.000Z',
      afterAt: '2026-10-05T02:00:00.000Z',
      verification: 'local_hash_chain_replay',
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
    },
    newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
    forecastValidated: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
    coverage: {
      routeGroups: { enrolled: 4, total: 26 },
      subjects: { enrolled: 4, total: 68 },
    },
    newsCoverage: {
      routeGroups: { enrolled: 26, total: 26 },
      subjects: { enrolled: 68, total: 68 },
    },
  }
  const html = render({
    routeKey: contextRouteKey,
    destination: contextDestination,
    eventContext: context,
  })
  assert.match(html, /data-testid="exit-pressure-context"/)
  assert.match(html, />CONTEXT</)
  assert.match(html, />Event</)
  assert.match(html, /LIQUIDITY SHIFT/)
  assert.match(html, /Raw venue headline/)
  assert.match(html, /LATEST 25 · RAW GOOGLE NEWS/)
  assert.match(html, /2026-10-05 02:00 UTC/)
  assert.match(html, /href="https:\/\/news\.example\.com\/story\?id=1"/)
  assert.match(html, /5,000,000 USDC → 2,500,000 USDC/)
  assert.match(html, /Aggregate cash proxy/)
  assert.match(html, /Q \/ CASH PROXY 25% → 50% · CASH PROXY SHRINKING · NOT HOLDER EXIT/)
  assert.doesNotMatch(html, /Q SHARE/)
  assert.doesNotMatch(html, /caused|because/i)

  for (const drift of [
    { ...context, question: { ...context.question, requestedRaw: '1' } },
    { ...context, venue: 'sUSDe' },
    { ...context, status: 'unavailable', reason: 'route_event_feed_not_enrolled' },
    {
      ...context,
      news: { ...context.news, url: 'https://127.0.0.1/private' },
    },
    {
      ...context,
      news: { ...context.news, coverage: 'complete_feed' },
    },
    { ...context, forecastValidated: true },
  ]) {
    assert.doesNotMatch(
      render({ routeKey: contextRouteKey, destination: contextDestination, eventContext: drift }),
      /data-testid="exit-pressure-context"/,
    )
  }
})

test('renders none, source-unavailable, and unenrolled context as distinct compact states', () => {
  const contextRouteKey = 'USDe → supply on Aave V3'
  const contextDestination = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
  const question = {
    routeKey: contextRouteKey,
    destination: contextDestination,
    requestedRaw: '1250000000000',
    payoutAsset: `0x${'c'.repeat(40)}`,
    assetDecimals: 6,
    horizonHours: 24,
  }
  const common = {
    question,
    newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
    forecastValidated: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
    coverage: {
      routeGroups: { enrolled: 4, total: 26 },
      subjects: { enrolled: 4, total: 68 },
    },
    newsCoverage: {
      routeGroups: { enrolled: 26, total: 26 },
      subjects: { enrolled: 68, total: 68 },
    },
  }
  const html = render({
    routeKey: contextRouteKey,
    destination: contextDestination,
    eventContext: {
      ...common,
      status: 'route_event_context',
      venue: 'aave-v3-usde',
      newsSource: 'aave-v3-usde',
      association: 'contemporaneous_facts_no_causal_attribution',
      event: { status: 'none', reason: 'no_recent_observed_event' },
      news: { status: 'source_unavailable', reason: 'source_unavailable' },
      capacity: { status: 'none', reason: 'no_verified_capacity_move' },
    },
  })
  assert.equal((html.match(/>NONE</g) ?? []).length, 2)
  assert.equal((html.match(/>SOURCE UNAVAILABLE</g) ?? []).length, 1)

  const unenrolled = render({
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    expectedEventEnrollment: { status: 'not_enrolled' },
    eventContext: {
      ...common,
      question: {
        ...question,
        routeKey,
        destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      },
      status: 'route_event_context',
      venue: null,
      newsSource: 'aave-v3-usdc',
      association: 'contemporaneous_facts_no_causal_attribution',
      event: { status: 'not_recorded', reason: 'recorder_not_enrolled' },
      news: { status: 'source_unavailable', reason: 'source_unavailable' },
      capacity: {
        status: 'observed',
        metric: 'aggregate_cash_raw',
        direction: 'shrinking',
        beforeRaw: '5000000000000',
        afterRaw: '2500000000000',
        assetDecimals: 6,
        requestedShareBefore: '25%',
        requestedShareAfter: '50%',
        elapsedSourceSeconds: 3600,
        beforeAt: '2026-10-05T01:00:00.000Z',
        afterAt: '2026-10-05T02:00:00.000Z',
        verification: 'local_hash_chain_replay',
        meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
      },
    },
  })
  assert.match(unenrolled, /data-testid="exit-pressure-context"/)
  assert.equal((unenrolled.match(/>NOT RECORDED</g) ?? []).length, 1)
  assert.match(unenrolled, /Protocol headlines/)
  assert.doesNotMatch(unenrolled, /4\/26|4\/68|FEED NOT ENROLLED/)
  assert.match(unenrolled, /5,000,000 USDC → 2,500,000 USDC/)
  assert.match(unenrolled, /Aggregate cash proxy/)
  assert.match(unenrolled, /Q \/ CASH PROXY 25% → 50% · CASH PROXY SHRINKING · NOT HOLDER EXIT/)
  assert.doesNotMatch(unenrolled, /Q SHARE/)
})

test('empty-evidence cards render for every subject in the 25 tracked route groups', () => {
  const registry = buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )
  const trackedRouteKeys = new Set(ROUTES.map((route) => route.routeKey))
  const subjects = registry.routeGroups
    .filter((group) => trackedRouteKeys.has(group.routeKey))
    .flatMap((group) =>
      group.contractSubjects.map((subject) => ({
        group,
        subject,
        destination: subject.destinationAddress,
      })),
    )
  assert.equal(trackedRouteKeys.size, 25)
  assert.equal(subjects.length, 67)

  const html = renderToStaticMarkup(
    React.createElement(
      ChakraProvider,
      null,
      React.createElement(
        React.Fragment,
        null,
        ...subjects.map(({ group, subject, destination: subjectDestination }) =>
          React.createElement(ExitPressureCard, {
            key: `${group.routeKey}:${subjectDestination}`,
            routeKey: group.routeKey,
            destination: subjectDestination,
            requestedAmount: '1',
            requestedRaw: '1',
            requestedAssetSymbol: group.borrowAsset,
            requestedAssetAddress: null,
            requestedAssetDecimals: null,
            horizonHours: 24,
            asOfMs: Date.parse('2026-10-05T02:10:00.000Z'),
            currentCash: null,
            historicalScenario: null,
            grossWithdrawals: null,
            grossInflows: null,
            historicalGrossFlow: null,
            morphoPayout: null,
            holderAssessment: null,
            expectedEventEnrollment:
              subject.sourceCoverage.recorderVenues.length === 0
                ? { status: 'not_enrolled' }
                : subject.sourceCoverage.recorderVenues.length === 1
                  ? {
                      status: 'enrolled',
                      venue: subject.sourceCoverage.recorderVenues[0],
                    }
                  : null,
            eventContext: null,
            historicalOutlook: null,
          }),
        ),
      ),
    ),
  )
  assert.equal((html.match(/data-testid="exit-pressure-card"/g) ?? []).length, 67)
  assert.equal((html.match(/data-testid="exit-pressure-provenance"/g) ?? []).length, 0)
})

test('keeps the Q heading wrap-safe at mobile width', () => {
  const source = readFileSync(
    new URL('../../components/Carry/ExitPressureCard.tsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /maxW="100%"\s+overflowWrap="anywhere"/)
})

test('formats large raw values and Q share without Number precision loss', () => {
  assert.equal(
    formatExitPressureRaw('1234567890123456789012345', 18),
    '1,234,567.890123456789012345',
  )
  assert.equal(formatRequestedCashShare('9007199254740993', '36028797018963972'), '25%')
  assert.equal(formatRequestedCashShare('1', '0'), null)
})

function sampledFixture(requestedRaw = '1250000000000') {
  const identity = { ...scope, asset: `0x${'c'.repeat(40)}`, assetDecimals: 6 }
  const subjectKey = `${routeKey}\0${destination}\0${identity.asset}`
  const current = {
    subjectKey,
    asset: identity.asset,
    assetDecimals: 6,
    cashRaw: '5000000000000',
    blockAt: '2026-10-05T02:00:00.000Z',
    block: '26123032',
    blockHash: `0x${'d'.repeat(64)}`,
  }
  const value = sampledModule.replaySampledHistoricalCashPaths({
    identity,
    requestedRaw,
    current,
    timelineIdentity: { subjectKey, asset: identity.asset, assetDecimals: 6 },
    asOfMs: Date.parse('2026-10-05T02:10:00.000Z'),
    timeline: Array.from({ length: 8 }, (_, i) => ({
      subjectKey,
      at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 86400000).toISOString(),
      cashRaw: i === 0 ? '5000000000000' : '1000000000000',
    })),
  })
  const displayed = {
    ...scope,
    cashRaw: current.cashRaw,
    assetDecimals: 6,
    assetAddress: identity.asset,
    assetSymbol: 'USDC',
    observedAt: current.blockAt,
    block: current.block,
    blockHash: current.blockHash,
    freshness: 'fresh',
    label: 'Market cash',
  }
  const question = {
    ...scope,
    requestedRaw: value.requestedRaw,
    requestedAssetAddress: identity.asset,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: Date.parse('2026-10-05T02:10:00.000Z'),
  }
  return { value, displayed, question }
}

test('sampled examples require exact current source, native asset and Q', () => {
  const { value, displayed, question } = sampledFixture()
  assert.equal(value.status, 'conditional_historical_sampled_cash_paths')
  const select = cardModule.selectedSampledCashPaths
  assert.equal(select(value, question, displayed), value)
  assert.equal(select(value, { ...question, requestedRaw: '1' }, displayed), null)
  assert.equal(
    select(value, { ...question, requestedAssetAddress: `0x${'e'.repeat(40)}` }, displayed),
    null,
  )
  assert.equal(select(value, question, { ...displayed, cashRaw: '1' }), null)
  assert.equal(select(value, question, { ...displayed, blockHash: `0x${'e'.repeat(64)}` }), null)
  assert.equal(
    select(value, { ...question, asOfMs: question.asOfMs + 3 * 3600000 }, displayed),
    null,
  )
  assert.equal(select(value, question, { ...displayed, freshness: 'stale' }), null)
})

test('sampled paths render censored next-above observations without a recovery claim', () => {
  const { value } = sampledFixture()
  const html = render({
    sampledCashPaths: value,
    prospectiveCashModel: null,
    historicalScenario: null,
  })
  assert.match(html, /exit-pressure-sampled-cash-paths/)
  assert.match(html, /Next sampled above Q unobserved/)
  assert.match(html, /No subsequent above-Q sample; recovery unobserved/)
  assert.match(html, /Below Q 0.0d–1.0d/)
  assert.equal((html.match(/Margin after Q/g) ?? []).length, 1)
  assert.match(html, /Historical scenarios · 7d/)
  assert.match(html, /Worst cash drop/)
  assert.match(html, /Heavy cash drop/)
  assert.match(html, /Lowest ending cash/)
  assert.match(html, /−250,000 \/ −250,000/)
  assert.doesNotMatch(html, /null \/ null/)
  const stale = render({ sampledCashPaths: value, asOfMs: Date.parse('2026-10-06T02:00:00.000Z') })
  assert.doesNotMatch(stale, /exit-pressure-sampled-cash-paths/)
})

test('sampled paths keep an unobserved onset explicit when cash starts below Q', () => {
  const { value } = sampledFixture('6000000000000')
  const html = render({
    sampledCashPaths: value,
    requestedRaw: '6000000000000',
    requestedAmount: '6000000',
    historicalScenario: null,
    prospectiveCashModel: null,
  })
  assert.match(html, /Below Q at start/)
  assert.match(html, /onset unobserved/)
  assert.match(html, /Next sampled above Q unobserved/)
  assert.doesNotMatch(html, /Below Q 0.0d–0.0d/)
})

test('a recovered ending cash sample does not erase an earlier sampled shortfall', () => {
  const fixture = sampledFixture()
  const identity = fixture.value.identity
  const current = { ...fixture.value.current, cashRaw: '100000000' }
  const path = [100, 80, 110, 110, 110, 110, 10, 100]
  const value = sampledModule.replaySampledHistoricalCashPaths({
    identity,
    current,
    requestedRaw: '90000000',
    asOfMs: Date.parse(fixture.value.asOfAt),
    timelineIdentity: { subjectKey: current.subjectKey, asset: identity.asset, assetDecimals: 6 },
    timeline: path.map((cash, index) => ({
      subjectKey: current.subjectKey,
      at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + index * 86400000).toISOString(),
      cashRaw: String(cash * 1000000),
    })),
  })
  assert.equal(value.status, 'conditional_historical_sampled_cash_paths')
  assert.equal(value.examples.worstEndpoint.selectedTarget, 'endpoint')
  assert.equal(value.examples.worstEndpoint.troughMarginAfterQRaw, '-80000000')
  assert.equal(value.examples.worstEndpoint.endpointMarginAfterQRaw, '10000000')
  assert.equal(value.examples.worstEndpoint.sampledBelowQ.firstBelowAt, null)
  const html = render({
    sampledCashPaths: value,
    requestedRaw: '90000000',
    requestedAmount: '90',
    currentCash: { ...fixture.displayed, cashRaw: current.cashRaw },
    historicalScenario: null,
    historicalBacktest: null,
    prospectiveCashModel: null,
  })
  const endpointRow = html.slice(html.indexOf('Lowest ending cash'))
  assert.match(endpointRow, /Ending cash covers Q/)
  assert.doesNotMatch(html, /No sampled shortfall/)
  assert.match(html, /Below Q 5.0d–6.0d/)
  assert.match(html, /Next sampled above Q 6.0d–7.0d/)
  assert.match(endpointRow, /−80 \/ 10/)
})

async function mechanicalCardFixture() {
  const coreModule = await import('../../lib/carry/holderExitMechanicalOutlook.ts')
  const core = coreModule.default ?? coreModule
  const umbrellaModule = await import('../../lib/carry/umbrellaGhoExit.ts')
  const umbrella = umbrellaModule.default ?? umbrellaModule
  const now = Date.parse('2026-10-07T12:00:00.000Z')
  const assessment = {
    status: 'partial',
    routeKey: umbrella.UMBRELLA_GHO_ROUTE,
    destinationAddress: umbrella.UMBRELLA_STKGHO,
    owner: `0x${'b'.repeat(40)}`,
    request: { assetsRaw: '100', assetAddress: umbrella.ORIGINAL_GHO, horizonHours: 24 },
    source: {
      chainId: 1,
      blockNumber: 1,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(now).toISOString(),
      originValidation: 'two_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'unassessed',
        amountRaw: null,
        assetAddress: umbrella.ORIGINAL_GHO,
      },
    ],
    finalPayout: { status: 'unassessed', amountRaw: null, assetAddress: umbrella.ORIGINAL_GHO },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    condition: {
      gate: 'waiting',
      cooldownEnd: now / 1000 + 613,
      windowEndInclusive: now / 1000 + 937,
      currentCooldownSeconds: 600,
      currentUnstakeWindowSeconds: 300,
      slashExposure: 'no_slashable_assets',
    },
  }
  assessment.mechanicalOutlook = {
    issuedAt: new Date(now).toISOString(),
    horizonSeconds: 86400,
    assessmentRequest: { ...assessment.request },
    outlook: core.projectHolderExitMechanicalOutlook(assessment, {
      routeKey: assessment.routeKey,
      destinationAddress: assessment.destinationAddress,
      owner: assessment.owner,
      assetsRaw: '100',
      assetAddress: umbrella.ORIGINAL_GHO,
      horizonSeconds: 86400,
      nowMs: now,
    }),
  }
  return {
    now,
    assessment,
    props: {
      routeKey: assessment.routeKey,
      destination: assessment.destinationAddress,
      requestedAmount: '100',
      requestedRaw: '100',
      requestedAssetAddress: umbrella.ORIGINAL_GHO,
      requestedAssetDecimals: 0,
      requestedAssetSymbol: 'GHO',
      requestedHolderAddress: assessment.owner,
      holderAssessment: assessment,
      asOfMs: now,
    },
  }
}

test('holder row shows a known stage lower bound and closes the inclusive window', async () => {
  const { props, now } = await mechanicalCardFixture()
  const html = render(props)
  assert.match(html, /Known stage timing/)
  assert.match(html, /Not before 2026-10-07 12:10:13 UTC/)
  assert.match(html, /Window ends 2026-10-07 12:15:37 UTC/)
  assert.doesNotMatch(html, /Timing unassessed|future payout|calibrated exit/)
  const inclusive = render({ ...props, asOfMs: now + 937999 })
  assert.match(inclusive, /Not before 2026-10-07 12:10:13 UTC/)
  assert.doesNotMatch(inclusive, />Closed</)
  const closed = render({ ...props, asOfMs: now + 938000 })
  assert.match(closed, /Holder window/)
  assert.match(closed, />Closed</)
  assert.match(closed, /Ended 2026-10-07 12:15:37 UTC/)
  assert.doesNotMatch(closed, /Not before 2026-10-07 12:10:13 UTC/)
})

test('standalone holder row rejects absent or changed owner, payout, Q, and aged source', async () => {
  const { props, now } = await mechanicalCardFixture()
  for (const changed of [
    { requestedHolderAddress: null },
    { requestedHolderAddress: `0x${'c'.repeat(40)}` },
    { requestedRaw: '101', requestedAmount: '101' },
    { requestedAssetAddress: `0x${'c'.repeat(40)}` },
    { asOfMs: now + 1800001 },
  ])
    assert.doesNotMatch(
      render({ ...props, ...changed }),
      /Known stage timing|Holder window|Not before 2026/,
    )
  const altered = structuredClone(props.holderAssessment)
  altered.mechanicalOutlook.assessmentRequest.receiptTokenId = '4'
  const html = render({ ...props, holderAssessment: altered })
  assert.doesNotMatch(html, /Known stage timing|Not before 2026/)
  assert.match(html, /Current holder check/)
})
