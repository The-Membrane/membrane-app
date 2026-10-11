import React, { useEffect, useState } from 'react'
import { Box, SimpleGrid, Skeleton, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

type HistoricalOutlookEvidence = {
  evidenceId: string
  evidenceClass: 'historical_endpoint' | 'historical_proxy'
  title: string
  headline: string
  endpoint: string
  proxyLabel: string | null
  samples: Array<{ label: string; value: string }>
  method: string
  window: {
    fromUtc: string | null
    throughUtc: string | null
    fromBlock: string | null
    throughBlock: string | null
  }
}

type TestedAmountAtHorizon = {
  assertion: 'historical_tested_callable_lower_bounds'
  horizonHours: number
  unit: 'asset_raw'
  orderStatistic: 'min_lower_median_max'
  descriptiveSample: true
  populationQuantile: false
  minRawLowerBound: string
  medianRawLowerBound: string
  maxRawLowerBound: string
  eligibleCohortCount: number
  measuredCellCount: number
  noCallableCohortCount: number
  aboveTestCeilingUnknownCohortCount: number
}

type SampledState = {
  assertion: 'historical_sampled_state_only'
  attemptedTrajectoryCount: number
  measuredTrajectoryCount: number
  differentStateWindowCount: number
  differentStateWithoutWindowCount: number
  sameStateAtLastSampleCount: number
  lastSameStateSampleCheckpointCounts: Array<{ hours: number; count: number }>
  maxLastSameStateSampleHours: number | null
  observations: Array<{
    baselineState: 'simulated_callable' | 'simulated_impaired'
    lastSameStateSampleHours: number | null
    lastSameStateObservedAtUtc: string | null
    differentStateObservedAtUtc: string | null
    firstObservedDifferentStateWindow: {
      afterObservedAtUtc: string
      byObservedAtUtc: string
      lastSameStatePlannedHorizonHours: number | null
      differentStatePlannedHorizonHours: number
    } | null
    sameStateAtLastSample: boolean
  }>
  durationProjection: null
}

type ExactQAtHorizon = {
  assertion: 'historical_exact_q_primary_assays'
  recordedPrimaryCells: number
  uniqueIssueClustersUpperBound: number
  correlatedRowsNonIndependent: true
  transitions: {
    callableToCallable: number
    callableToImpaired: number
    impairedToImpaired: number
    impairedToCallable: number
  }
  censorReasons: Record<string, number>
}

type QLadderRelation = {
  assertion: 'historical_monotone_tested_ladder_relation'
  eligibleCohorts: number
  uniqueIssueClustersUpperBound: number
  correlatedRowsNonIndependent: true
  counts: {
    withinCallableLowerBound: number
    atOrAboveImpairedTier: number
    betweenTestedTiers: number
    aboveTestedCeiling: number
    belowImpairedFloor: number
  }
}

export type HolderExitTestedBoundsResponse = {
  status: 'available'
  routeKey: string
  destination: string
  asset: string
  stageScope: string
  subjectStatus:
    | 'no_episodes'
    | 'historical_tested_bounds'
    | 'no_eligible_tested_bounds'
    | 'no_fully_measured_present_cohorts'
  requestedHorizonHours: number
  requestedRaw: string
  exactQAtHorizon: ExactQAtHorizon | null
  qLadderRelation: QLadderRelation | null
  testedAmountAtHorizon: TestedAmountAtHorizon | null
  amountReason: 'no_exact_horizon' | 'ambiguous_unit' | 'unit_not_comparable' | null
  sampledState: SampledState | null
  stateReason: 'no_measured_samples' | null
  durationProjection: null
  provenance: {
    source: 'local_sealed_panel_reader'
    sourceVerification: 'offline_sealed_replay'
    sourceVerificationBasis: 'forwarded_producer_assertion'
    scope: 'historical_tested_amount_bounds'
    claimClass: 'historical_tested_callable_lower_bounds'
    manifestSha256: string
    historicalDataThroughUtc: string
    historicalDataThroughClockBasis: 'saved_local_panel_clocks'
    historicalDataThroughIndependentlyWitnessed: false
    routeGroups: 25
    exactSubjects: 67
    rawRows: number
  }
}

export type HistoricalOutlookResponse = {
  status: 'available'
  routeKey: string
  destination: string
  requestedRaw: string | null
  routeGroup: {
    mechanism: 'atomic' | 'staged'
    exactSubjects: number
    scope: 'route_group' | 'exact_destination_route'
    historicalOutlook: 'eligible_exact_endpoint_history' | 'eligible_proxy_history' | 'abstain'
  }
  evidence: HistoricalOutlookEvidence | null
  provenance: {
    source: 'local_historical_artifacts'
    claimClass: 'retrospective_historical_outlook'
    manifestSha256: string | null
    mechanismVersion: string | null
    routeGroups: number
    exactSubjects: number
    frozenCohortRouteGroups: number
    frozenCohortExactSubjects: number
    supplementalRouteGroups: number
    supplementalExactSubjects: number
    exactEndpointHistoryRouteGroups: number
    proxyOnlyHistoryRouteGroups: number
    abstainingRouteGroups: number
  }
}

export type HistoricalOutlookView =
  | { status: 'loading' }
  | { status: 'abstain'; reason: 'thin_history' | 'read_error' }
  | {
      status: 'exact' | 'proxy'
      response: HistoricalOutlookResponse
      evidence: HistoricalOutlookEvidence
    }

export type HistoricalQAbstentionReason =
  | 'stage_units_differ'
  | 'assay_not_user_amount'
  | 'asset_identity_unverified'
  | 'amount_invalid'

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

const ADDRESS = /^0x[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const RAW_AMOUNT = /^(0|[1-9]\d*)$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_COUNT = 20_000

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNT
}

function isBoundedText(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

export function historicalExitAssetSymbol(routeKey: string): string | null {
  if (!isBoundedText(routeKey)) return null
  const bracketed = routeKey.match(/\[([^\[\]]+)\]$/)?.[1]
  if (bracketed) return isBoundedText(bracketed, 32) ? bracketed : null
  if (routeKey.includes('[') || routeKey.includes(']')) return null
  const [left, right] = routeKey.split('→')
  if (right === undefined) return null
  const symbol = left.trim()
  return isBoundedText(symbol, 32) ? symbol : null
}

export function historicalOutlookSelectionKey(
  routeKey: string,
  destination: string,
  refreshKey: number,
  requestedRaw: string | null = '',
): string | null {
  const normalizedDestination = destination.toLowerCase()
  if (
    !isBoundedText(routeKey) ||
    !ADDRESS.test(normalizedDestination) ||
    !Number.isSafeInteger(refreshKey) ||
    refreshKey < 0
  )
    return null
  return [
    routeKey,
    normalizedDestination,
    requestedRaw ?? 'endpoint_only',
    String(refreshKey),
  ].join('\u0000')
}

type HistoricalOutlookState = {
  selectionKey: string
  view: HistoricalOutlookView
}

export function selectedHistoricalOutlookView(
  state: HistoricalOutlookState | null,
  selectionKey: string | null,
): HistoricalOutlookView {
  return selectionKey && state?.selectionKey === selectionKey ? state.view : { status: 'loading' }
}

function isRawAmount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 78 &&
    RAW_AMOUNT.test(value) &&
    BigInt(value) <= MAX_UINT256
  )
}

function isUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
}

function parseTestedAmount(value: unknown, horizonHours: number): TestedAmountAtHorizon | null {
  if (!value || typeof value !== 'object') return null
  const amount = value as Partial<TestedAmountAtHorizon>
  if (
    amount.assertion !== 'historical_tested_callable_lower_bounds' ||
    amount.horizonHours !== horizonHours ||
    amount.unit !== 'asset_raw' ||
    amount.orderStatistic !== 'min_lower_median_max' ||
    amount.descriptiveSample !== true ||
    amount.populationQuantile !== false ||
    !isRawAmount(amount.minRawLowerBound) ||
    !isRawAmount(amount.medianRawLowerBound) ||
    !isRawAmount(amount.maxRawLowerBound) ||
    BigInt(amount.minRawLowerBound) > BigInt(amount.medianRawLowerBound) ||
    BigInt(amount.medianRawLowerBound) > BigInt(amount.maxRawLowerBound) ||
    !isBoundedCount(amount.eligibleCohortCount) ||
    amount.eligibleCohortCount < 1 ||
    !isBoundedCount(amount.measuredCellCount) ||
    !isBoundedCount(amount.noCallableCohortCount) ||
    !isBoundedCount(amount.aboveTestCeilingUnknownCohortCount) ||
    amount.noCallableCohortCount > amount.eligibleCohortCount ||
    amount.aboveTestCeilingUnknownCohortCount > amount.eligibleCohortCount
  )
    return null
  return amount as TestedAmountAtHorizon
}

function parseSampledState(value: unknown): SampledState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<SampledState>
  if (
    state.assertion !== 'historical_sampled_state_only' ||
    !isBoundedCount(state.attemptedTrajectoryCount) ||
    !isBoundedCount(state.measuredTrajectoryCount) ||
    state.measuredTrajectoryCount > state.attemptedTrajectoryCount ||
    !isBoundedCount(state.differentStateWindowCount) ||
    !isBoundedCount(state.differentStateWithoutWindowCount) ||
    !isBoundedCount(state.sameStateAtLastSampleCount) ||
    state.differentStateWindowCount +
      state.differentStateWithoutWindowCount +
      state.sameStateAtLastSampleCount !==
      state.measuredTrajectoryCount ||
    state.durationProjection !== null ||
    !Array.isArray(state.lastSameStateSampleCheckpointCounts) ||
    !Array.isArray(state.observations) ||
    state.observations.length !== state.measuredTrajectoryCount ||
    !state.observations.every((row) => {
      if (!['simulated_callable', 'simulated_impaired'].includes(row?.baselineState)) return false
      if (row.sameStateAtLastSample === true)
        return (
          row.differentStateObservedAtUtc === null &&
          row.firstObservedDifferentStateWindow === null &&
          Number.isSafeInteger(row.lastSameStateSampleHours) &&
          isUtc(row.lastSameStateObservedAtUtc)
        )
      if (row.sameStateAtLastSample !== false) return false
      if (!isUtc(row.differentStateObservedAtUtc)) return false
      if (row.firstObservedDifferentStateWindow === null)
        return row.lastSameStateSampleHours === null && row.lastSameStateObservedAtUtc === null
      return (
        isUtc(row.firstObservedDifferentStateWindow.afterObservedAtUtc) &&
        row.firstObservedDifferentStateWindow.byObservedAtUtc === row.differentStateObservedAtUtc &&
        Date.parse(row.firstObservedDifferentStateWindow.afterObservedAtUtc) <
          Date.parse(row.firstObservedDifferentStateWindow.byObservedAtUtc)
      )
    })
  )
    return null

  let previousHours = 0
  let checkpointTotal = 0
  for (const checkpoint of state.lastSameStateSampleCheckpointCounts) {
    if (
      !checkpoint ||
      !Number.isSafeInteger(checkpoint.hours) ||
      checkpoint.hours < 1 ||
      checkpoint.hours > 720 ||
      checkpoint.hours <= previousHours ||
      !isBoundedCount(checkpoint.count) ||
      checkpoint.count < 1
    )
      return null
    previousHours = checkpoint.hours
    checkpointTotal += checkpoint.count
  }
  if (
    checkpointTotal > state.measuredTrajectoryCount ||
    (state.maxLastSameStateSampleHours === null
      ? state.lastSameStateSampleCheckpointCounts.length !== 0
      : !Number.isSafeInteger(state.maxLastSameStateSampleHours) ||
        state.maxLastSameStateSampleHours !== previousHours)
  )
    return null
  return state as SampledState
}

export function parseHolderExitTestedBoundsResponse(
  value: unknown,
  routeKey: string,
  destination: string,
  asset: string,
  horizonHours: number,
  requestedRaw = '500000000',
): HolderExitTestedBoundsResponse | null {
  if (!value || typeof value !== 'object') return null
  const response = value as Partial<HolderExitTestedBoundsResponse>
  const provenance = response.provenance
  const normalizedDestination = destination.toLowerCase()
  const normalizedAsset = asset.toLowerCase()
  if (
    response.status !== 'available' ||
    response.routeKey !== routeKey ||
    response.destination !== normalizedDestination ||
    !ADDRESS.test(response.destination) ||
    response.asset !== normalizedAsset ||
    !ADDRESS.test(response.asset) ||
    !isBoundedText(response.stageScope) ||
    ![
      'no_episodes',
      'historical_tested_bounds',
      'no_eligible_tested_bounds',
      'no_fully_measured_present_cohorts',
    ].includes(response.subjectStatus ?? '') ||
    response.requestedHorizonHours !== horizonHours ||
    response.requestedRaw !== requestedRaw ||
    !isRawAmount(requestedRaw) ||
    requestedRaw === '0' ||
    !Number.isSafeInteger(response.requestedHorizonHours) ||
    response.requestedHorizonHours < 1 ||
    response.requestedHorizonHours > 720 ||
    response.durationProjection !== null ||
    !provenance ||
    provenance.source !== 'local_sealed_panel_reader' ||
    provenance.sourceVerification !== 'offline_sealed_replay' ||
    provenance.sourceVerificationBasis !== 'forwarded_producer_assertion' ||
    provenance.scope !== 'historical_tested_amount_bounds' ||
    provenance.claimClass !== 'historical_tested_callable_lower_bounds' ||
    !SHA256.test(provenance.manifestSha256 ?? '') ||
    !isUtc(provenance.historicalDataThroughUtc) ||
    provenance.historicalDataThroughClockBasis !== 'saved_local_panel_clocks' ||
    provenance.historicalDataThroughIndependentlyWitnessed !== false ||
    provenance.routeGroups !== 25 ||
    provenance.exactSubjects !== 67 ||
    !isBoundedCount(provenance.rawRows)
  )
    return null

  const amount =
    response.testedAmountAtHorizon === null
      ? null
      : parseTestedAmount(response.testedAmountAtHorizon, horizonHours)
  if (
    (response.testedAmountAtHorizon !== null && !amount) ||
    (amount === null &&
      !['no_exact_horizon', 'ambiguous_unit', 'unit_not_comparable'].includes(
        response.amountReason ?? '',
      )) ||
    (amount !== null && response.amountReason !== null)
  )
    return null

  const sampled = response.sampledState === null ? null : parseSampledState(response.sampledState)
  if (
    (response.sampledState !== null && !sampled) ||
    (sampled === null && response.stateReason !== 'no_measured_samples') ||
    (sampled !== null && response.stateReason !== null)
  )
    return null
  const exact = response.exactQAtHorizon
  if (exact !== null) {
    if (
      !exact ||
      exact.assertion !== 'historical_exact_q_primary_assays' ||
      !isBoundedCount(exact.recordedPrimaryCells) ||
      exact.recordedPrimaryCells === 0 ||
      !isBoundedCount(exact.uniqueIssueClustersUpperBound) ||
      exact.uniqueIssueClustersUpperBound > exact.recordedPrimaryCells ||
      exact.correlatedRowsNonIndependent !== true ||
      !exact.transitions ||
      !Object.values(exact.transitions).every(isBoundedCount) ||
      !exact.censorReasons ||
      !Object.entries(exact.censorReasons).every(
        ([key, count]) => isBoundedText(key, 80) && isBoundedCount(count),
      ) ||
      Object.values(exact.transitions).reduce((sum, count) => sum + count, 0) +
        Object.values(exact.censorReasons).reduce((sum, count) => sum + count, 0) !==
        exact.recordedPrimaryCells
    )
      return null
  }
  const relation = response.qLadderRelation
  if (relation !== null) {
    if (
      !relation ||
      relation.assertion !== 'historical_monotone_tested_ladder_relation' ||
      !isBoundedCount(relation.eligibleCohorts) ||
      relation.eligibleCohorts === 0 ||
      !isBoundedCount(relation.uniqueIssueClustersUpperBound) ||
      relation.uniqueIssueClustersUpperBound > relation.eligibleCohorts ||
      relation.correlatedRowsNonIndependent !== true ||
      !relation.counts ||
      !Object.values(relation.counts).every(isBoundedCount) ||
      Object.values(relation.counts).reduce((sum, count) => sum + count, 0) !==
        relation.eligibleCohorts
    )
      return null
  }
  return response as HolderExitTestedBoundsResponse
}

export function formatTestedRawAmount(raw: string, decimals: number): string | null {
  if (!isRawAmount(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  if (decimals === 0) return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

export function parseHistoricalOutlookResponse(
  value: unknown,
  routeKey: string,
  destination: string,
  requestedRaw?: string | null,
): HistoricalOutlookResponse | null {
  if (!value || typeof value !== 'object') return null
  const response = value as Partial<HistoricalOutlookResponse>
  const group = response.routeGroup
  const provenance = response.provenance
  if (
    response.status !== 'available' ||
    response.routeKey !== routeKey ||
    response.destination !== destination.toLowerCase() ||
    (requestedRaw !== undefined && response.requestedRaw !== requestedRaw) ||
    (response.requestedRaw !== null && !isRawAmount(response.requestedRaw)) ||
    (response.requestedRaw === null &&
      response.evidence?.evidenceId === 'morpho_fixed_10k_holder_call_ledger') ||
    !group ||
    !['atomic', 'staged'].includes(group.mechanism) ||
    !Number.isSafeInteger(group.exactSubjects) ||
    group.exactSubjects < 1 ||
    group.scope !==
      (response.evidence?.evidenceId === 'morpho_fixed_10k_holder_call_ledger' ||
      group.exactSubjects === 1
        ? 'exact_destination_route'
        : 'route_group') ||
    !['eligible_exact_endpoint_history', 'eligible_proxy_history', 'abstain'].includes(
      group.historicalOutlook,
    ) ||
    !provenance ||
    provenance.source !== 'local_historical_artifacts' ||
    provenance.claimClass !== 'retrospective_historical_outlook' ||
    !isNullableString(provenance.manifestSha256) ||
    !isNullableString(provenance.mechanismVersion) ||
    provenance.routeGroups !== 26 ||
    provenance.exactSubjects !== 68 ||
    provenance.frozenCohortRouteGroups !== 25 ||
    provenance.frozenCohortExactSubjects !== 67 ||
    provenance.supplementalRouteGroups !== 1 ||
    provenance.supplementalExactSubjects !== 1 ||
    !isBoundedCount(provenance.exactEndpointHistoryRouteGroups) ||
    !isBoundedCount(provenance.proxyOnlyHistoryRouteGroups) ||
    !isBoundedCount(provenance.abstainingRouteGroups) ||
    provenance.exactEndpointHistoryRouteGroups +
      provenance.proxyOnlyHistoryRouteGroups +
      provenance.abstainingRouteGroups !==
      provenance.routeGroups ||
    provenance.frozenCohortRouteGroups + provenance.supplementalRouteGroups !==
      provenance.routeGroups ||
    provenance.frozenCohortExactSubjects + provenance.supplementalExactSubjects !==
      provenance.exactSubjects
  )
    return null

  if (group.historicalOutlook === 'abstain')
    return response.evidence === null ? (response as HistoricalOutlookResponse) : null
  const evidence = response.evidence
  if (
    !evidence ||
    !['historical_endpoint', 'historical_proxy'].includes(evidence.evidenceClass) ||
    evidence.evidenceClass !==
      (group.historicalOutlook === 'eligible_exact_endpoint_history'
        ? 'historical_endpoint'
        : 'historical_proxy') ||
    typeof evidence.evidenceId !== 'string' ||
    typeof evidence.title !== 'string' ||
    typeof evidence.headline !== 'string' ||
    typeof evidence.endpoint !== 'string' ||
    !isNullableString(evidence.proxyLabel) ||
    typeof evidence.method !== 'string' ||
    !evidence.window ||
    !isNullableString(evidence.window.fromUtc) ||
    !isNullableString(evidence.window.throughUtc) ||
    !isNullableString(evidence.window.fromBlock) ||
    !isNullableString(evidence.window.throughBlock) ||
    !Array.isArray(evidence.samples) ||
    evidence.samples.length > 4 ||
    evidence.samples.some(
      (sample) => !sample || typeof sample.label !== 'string' || typeof sample.value !== 'string',
    )
  )
    return null
  return response as HistoricalOutlookResponse
}

export function historicalOutlookView(response: HistoricalOutlookResponse): HistoricalOutlookView {
  if (response.routeGroup.historicalOutlook === 'abstain' || !response.evidence)
    return { status: 'abstain', reason: 'thin_history' }
  return {
    status: response.evidence.evidenceClass === 'historical_endpoint' ? 'exact' : 'proxy',
    response,
    evidence: response.evidence,
  }
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ')
}

function windowLabel(window: HistoricalOutlookEvidence['window']): string | null {
  if (window.fromUtc && window.throughUtc) {
    const from = window.fromUtc.slice(0, 10)
    const through = window.throughUtc.slice(0, 10)
    return from === through ? through : `${from}–${through}`
  }
  if (window.throughUtc) return `through ${window.throughUtc.slice(0, 10)}`
  if (window.fromBlock && window.throughBlock)
    return `blocks ${window.fromBlock}–${window.throughBlock}`
  if (window.throughBlock) return `through block ${window.throughBlock}`
  return null
}

const labelStyle = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
  color: SEMANTIC_COLORS.textSecondary,
}

export const HolderExitTestedBoundsPresentation: React.FC<{
  evidence: HolderExitTestedBoundsResponse | null
  assetDecimals: number
  assetSymbol: string
}> = ({ evidence, assetDecimals, assetSymbol }) => {
  const amount = evidence?.testedAmountAtHorizon ?? null
  const floor = amount ? formatTestedRawAmount(amount.minRawLowerBound, assetDecimals) : null
  const highest = amount ? formatTestedRawAmount(amount.maxRawLowerBound, assetDecimals) : null
  const sampled = evidence?.sampledState ?? null
  const exact = evidence?.exactQAtHorizon ?? null
  const relation = evidence?.qLadderRelation ?? null
  if (!evidence || ((!floor || !highest) && !sampled && !exact && !relation)) return null

  const requested = formatTestedRawAmount(evidence.requestedRaw, assetDecimals)

  const archiveAsOf = evidence.provenance.historicalDataThroughUtc.slice(0, 16).replace('T', ' ')
  return (
    <Box
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.base}
      mt={SPACING.base}
      data-testid="holder-exit-tested-bounds"
    >
      <Text {...labelStyle} color={SEMANTIC_COLORS.info}>
        HISTORICAL TEST · {requested ?? 'RAW Q'} {assetSymbol}
        {evidence.stageScope.startsWith('fluid_bridge_') ? ' FIRST LEG' : ''} · +
        {evidence.requestedHorizonHours}H
      </Text>
      {exact && (
        <Box mt={SPACING.sm}>
          <Text {...labelStyle}>EXACT Q AT EXACT H / PRIMARY ASSAYS</Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Callable → callable {exact.transitions.callableToCallable} · Callable → impaired{' '}
            {exact.transitions.callableToImpaired} · Impaired → impaired{' '}
            {exact.transitions.impairedToImpaired} · Impaired → callable{' '}
            {exact.transitions.impairedToCallable}
          </Text>
          {Object.entries(exact.censorReasons).map(([reason, count]) => (
            <Text key={reason} {...labelStyle} color={SEMANTIC_COLORS.warning}>
              CENSORED / {humanize(reason)} / {count}
            </Text>
          ))}
          <Text {...labelStyle}>
            PRIMARY CELLS / {exact.recordedPrimaryCells} · UNIQUE ISSUE CLUSTERS ≤{' '}
            {exact.uniqueIssueClustersUpperBound}
          </Text>
        </Box>
      )}
      {relation && (
        <Box mt={SPACING.sm}>
          <Text {...labelStyle}>REQUESTED Q / TESTED LADDER RELATION ONLY</Text>
          <Text {...labelStyle}>
            WITHIN CALLABLE LOWER BOUND / {relation.counts.withinCallableLowerBound} · AT OR ABOVE
            IMPAIRED TIER / {relation.counts.atOrAboveImpairedTier}
          </Text>
          <Text {...labelStyle}>
            BETWEEN TESTED TIERS / {relation.counts.betweenTestedTiers} · ABOVE TESTED CEILING /{' '}
            {relation.counts.aboveTestedCeiling} · BELOW IMPAIRED FLOOR /{' '}
            {relation.counts.belowImpairedFloor}
          </Text>
          <Text {...labelStyle}>
            ELIGIBLE COHORTS / {relation.eligibleCohorts} · UNIQUE ISSUE CLUSTERS ≤{' '}
            {relation.uniqueIssueClustersUpperBound}
          </Text>
        </Box>
      )}
      {(exact || relation) && (
        <Text {...labelStyle} mt={SPACING.xs}>
          CORRELATED ROWS / NON-INDEPENDENT · NO EXACT-Q RATE OR PROBABILITY
        </Text>
      )}
      {amount && floor && highest && (
        <>
          <Text {...labelStyle} mt={SPACING.sm}>
            VARIABLE-Q COHORT LOWER BOUNDS / NOT AN EXACT-Q OUTCOME
          </Text>
          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.sm} mt={SPACING.sm}>
            <Box>
              <Text {...labelStyle}>Lowest tested</Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h4}
                color={SEMANTIC_COLORS.textPrimary}
              >
                ≥ {floor} {assetSymbol}
              </Text>
            </Box>
            <Box>
              <Text {...labelStyle}>Highest tested</Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h4}
                color={SEMANTIC_COLORS.textPrimary}
              >
                ≥ {highest} {assetSymbol}
              </Text>
            </Box>
          </SimpleGrid>
          <Text {...labelStyle} mt={SPACING.sm}>
            COHORTS / {amount.eligibleCohortCount} · MEASURED CELLS / {amount.measuredCellCount}
          </Text>
          {amount.aboveTestCeilingUnknownCohortCount > 0 && (
            <Text {...labelStyle} mt={SPACING.xs} color={SEMANTIC_COLORS.warning}>
              TEST LIMIT / {amount.aboveTestCeilingUnknownCohortCount} COHORTS
            </Text>
          )}
          {amount.noCallableCohortCount > 0 && (
            <Text {...labelStyle} mt={SPACING.xs} color={SEMANTIC_COLORS.warning}>
              NO CALLABLE TESTED TIER / {amount.noCallableCohortCount} COHORTS
            </Text>
          )}
        </>
      )}
      {sampled && (
        <>
          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.sm} mt={SPACING.sm}>
            {sampled.maxLastSameStateSampleHours !== null && (
              <Box>
                <Text {...labelStyle}>Latest same-state checkpoint</Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  +{sampled.maxLastSameStateSampleHours}H
                </Text>
              </Box>
            )}
            <Box>
              <Text {...labelStyle}>Same state at last sample</Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
              >
                {sampled.sameStateAtLastSampleCount} / {sampled.measuredTrajectoryCount}
              </Text>
            </Box>
            <Box>
              <Text {...labelStyle}>First different-state sample windows</Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
              >
                {sampled.differentStateWindowCount}
              </Text>
            </Box>
            {sampled.differentStateWithoutWindowCount > 0 && (
              <Box>
                <Text {...labelStyle}>Different state · no bounded window</Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {sampled.differentStateWithoutWindowCount}
                </Text>
              </Box>
            )}
          </SimpleGrid>
          <Text {...labelStyle} mt={SPACING.xs}>
            EXACT-Q SAMPLES / OBSERVATION WINDOWS ONLY; NO DURATION ESTIMATE
          </Text>
          {sampled.observations.map((row, index) => (
            <Text key={index} {...labelStyle}>
              {row.firstObservedDifferentStateWindow
                ? `FIRST DIFFERENT-STATE SAMPLE / ${row.firstObservedDifferentStateWindow.afterObservedAtUtc} → ${row.firstObservedDifferentStateWindow.byObservedAtUtc}`
                : row.sameStateAtLastSample
                  ? `SAME STATE AT LAST SAMPLE / +${row.lastSameStateSampleHours}H · ${row.lastSameStateObservedAtUtc}`
                  : 'DIFFERENT STATE SAMPLED / NO BOUNDED WINDOW'}
            </Text>
          ))}
        </>
      )}
      <Box as="details" mt={SPACING.sm}>
        <Text as="summary" {...labelStyle} cursor="pointer" _focus={FOCUS_STYLES.ring}>
          Evidence
        </Text>
        <VStack align="stretch" spacing={SPACING.xs} mt={SPACING.sm}>
          <Text {...labelStyle}>SAVED LOCAL REPLAY / {archiveAsOf} UTC</Text>
          <Text {...labelStyle}>VERIFICATION BASIS / FORWARDED PRODUCER ASSERTION</Text>
          <Text {...labelStyle}>CLOCK / SAVED LOCAL PANEL CLOCKS</Text>
          <Text {...labelStyle}>INDEPENDENTLY WITNESSED / NO</Text>
          <Text {...labelStyle}>STAGE / {humanize(evidence.stageScope)}</Text>
          <Text {...labelStyle}>DESTINATION / {evidence.destination}</Text>
          <Text {...labelStyle}>ASSET / {evidence.asset}</Text>
          <Text {...labelStyle}>
            SIMULATED STAGE ONLY / NO MINED EXECUTION, FINAL PAYOUT, OR PROSPECTIVE VALIDATION
          </Text>
        </VStack>
      </Box>
    </Box>
  )
}

export const HolderExitHistoricalOutlookPresentation: React.FC<{
  view: HistoricalOutlookView
  testedBounds?: HolderExitTestedBoundsResponse | null
  assetDecimals?: number | null
  assetSymbol?: string | null
  qAbstentionReason?: HistoricalQAbstentionReason | null
}> = ({
  view,
  testedBounds = null,
  assetDecimals = null,
  assetSymbol = null,
  qAbstentionReason = null,
}) => {
  const bounds =
    testedBounds &&
    Number.isInteger(assetDecimals) &&
    Number(assetDecimals) >= 0 &&
    Number(assetDecimals) <= 36 &&
    isBoundedText(assetSymbol, 32) ? (
      <HolderExitTestedBoundsPresentation
        evidence={testedBounds}
        assetDecimals={Number(assetDecimals)}
        assetSymbol={assetSymbol}
      />
    ) : null
  const qNotice = qAbstentionReason ? (
    <Text {...labelStyle} color={SEMANTIC_COLORS.warning} mt={SPACING.sm} role="status">
      HISTORICAL Q /{' '}
      {qAbstentionReason === 'stage_units_differ'
        ? 'STAGE UNITS DIFFER'
        : qAbstentionReason === 'assay_not_user_amount'
          ? 'ASSAY AMOUNT DIFFERS'
          : qAbstentionReason === 'amount_invalid'
            ? 'INVALID STAGE AMOUNT'
            : 'ASSET IDENTITY UNVERIFIED'}
    </Text>
  ) : null
  if (view.status === 'loading') {
    return (
      <Box
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.base}
        role="status"
        aria-label="Loading historical outlook"
      >
        <Text {...labelStyle}>Historical outlook</Text>
        <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.sm}>
          <Skeleton height={TYPOGRAPHY.small} borderRadius={0} />
          <Skeleton height={TYPOGRAPHY.h3} borderRadius={0} />
          <Skeleton height={TYPOGRAPHY.xs} borderRadius={0} />
        </VStack>
        {qNotice}
        {bounds}
      </Box>
    )
  }

  if (view.status === 'abstain') {
    return (
      <Box
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        pt={SPACING.base}
        role="status"
      >
        <Text {...labelStyle}>Historical outlook</Text>
        {bounds ? (
          <Text {...labelStyle} mt={SPACING.sm} color={SEMANTIC_COLORS.warning}>
            ENDPOINT HISTORY / {view.reason === 'thin_history' ? 'INSUFFICIENT' : 'READ FAILED'}
          </Text>
        ) : (
          <Box
            borderLeft="1px solid"
            borderColor={SEMANTIC_COLORS.warning}
            pl={SPACING.sm}
            mt={SPACING.sm}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.warning}
            >
              {view.reason === 'thin_history'
                ? 'History is too thin for this route.'
                : 'Historical evidence could not be read.'}
            </Text>
          </Box>
        )}
        {qNotice}
        {bounds}
      </Box>
    )
  }

  const { response, evidence } = view
  const proxy = view.status === 'proxy'
  const accent = proxy ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info
  const period = windowLabel(evidence.window)
  const manifest = response.provenance.manifestSha256?.slice(0, 10) ?? 'local'
  return (
    <Box
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.base}
      data-testid="holder-exit-historical-outlook"
    >
      <Text {...labelStyle}>Historical outlook</Text>
      <Box borderLeft="1px solid" borderColor={accent} pl={SPACING.sm} mt={SPACING.sm}>
        <Text {...labelStyle} color={accent}>
          {proxy ? 'Proxy history' : 'Exact endpoint history'}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.h4}
          color={SEMANTIC_COLORS.textPrimary}
          mt={SPACING.xs}
        >
          {evidence.title}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
          mt={SPACING.xs}
        >
          {evidence.headline}
        </Text>
        {proxy && evidence.proxyLabel && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.warning}
            mt={SPACING.xs}
          >
            {humanize(evidence.proxyLabel)}
          </Text>
        )}
        {response.routeGroup.scope === 'route_group' && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.xs}
          >
            Route group evidence · {response.routeGroup.exactSubjects} exact subjects
          </Text>
        )}
        {response.routeGroup.scope === 'exact_destination_route' && (
          <Text {...labelStyle}>Exact destination evidence · {response.destination}</Text>
        )}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.xs}
        >
          Local archive · tracked {response.provenance.routeGroups} route groups /{' '}
          {response.provenance.exactSubjects} exact subjects · frozen August core{' '}
          {response.provenance.frozenCohortRouteGroups} groups /{' '}
          {response.provenance.frozenCohortExactSubjects} subjects · supplemental{' '}
          {response.provenance.supplementalRouteGroups} group /{' '}
          {response.provenance.supplementalExactSubjects} subject · manifest {manifest}
        </Text>
        <Box as="details" mt={SPACING.sm}>
          <Text as="summary" {...labelStyle} cursor="pointer" _focus={FOCUS_STYLES.ring}>
            Samples & method
          </Text>
          <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING.sm} mt={SPACING.sm}>
            {evidence.samples.map((sample) => (
              <Box key={`${sample.label}:${sample.value}`}>
                <Text {...labelStyle}>{sample.label}</Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {sample.value}
                </Text>
              </Box>
            ))}
          </SimpleGrid>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.sm}
          >
            {humanize(evidence.method)}
            {period ? ` · ${period}` : ''}
          </Text>
        </Box>
      </Box>
      {qNotice}
      {bounds}
    </Box>
  )
}

export const HolderExitHistoricalOutlook: React.FC<{
  routeKey: string
  destination: string
  asset: string | null
  assetDecimals: number | null
  assetSymbol: string | null
  horizonHours: number
  requestedRaw: string | null
  qAbstentionReason?: HistoricalQAbstentionReason | null
  refreshKey?: number
}> = ({
  routeKey,
  destination,
  asset,
  assetDecimals,
  assetSymbol,
  horizonHours,
  requestedRaw,
  qAbstentionReason = null,
  refreshKey = 0,
}) => {
  const [historicalState, setHistoricalState] = useState<HistoricalOutlookState | null>(null)
  const [testedBoundsState, setTestedBoundsState] = useState<{
    selectionKey: string
    response: HolderExitTestedBoundsResponse
  } | null>(null)

  const normalizedDestination = destination.toLowerCase()
  const normalizedAsset = asset?.toLowerCase() ?? ''
  const historicalSelectionKey = historicalOutlookSelectionKey(
    routeKey,
    normalizedDestination,
    refreshKey,
    requestedRaw,
  )
  const view = selectedHistoricalOutlookView(historicalState, historicalSelectionKey)
  const testedBoundsSelectionKey =
    isBoundedText(routeKey) &&
    ADDRESS.test(normalizedDestination) &&
    ADDRESS.test(normalizedAsset) &&
    Number.isInteger(assetDecimals) &&
    Number(assetDecimals) >= 0 &&
    Number(assetDecimals) <= 36 &&
    isBoundedText(assetSymbol, 32) &&
    Number.isSafeInteger(horizonHours) &&
    horizonHours >= 1 &&
    horizonHours <= 720 &&
    isRawAmount(requestedRaw) &&
    requestedRaw !== '0'
      ? [
          routeKey,
          normalizedDestination,
          normalizedAsset,
          String(assetDecimals),
          assetSymbol,
          String(horizonHours),
          requestedRaw,
          String(refreshKey),
        ].join('\u0000')
      : null
  const testedBounds =
    testedBoundsState?.selectionKey === testedBoundsSelectionKey ? testedBoundsState.response : null

  useEffect(() => {
    setHistoricalState(null)
    if (
      !historicalSelectionKey ||
      (requestedRaw !== null && (!isRawAmount(requestedRaw) || requestedRaw === '0'))
    )
      return
    const controller = new AbortController()
    const query = new URLSearchParams({ routeKey, destination: normalizedDestination })
    if (requestedRaw !== null) query.set('requestedRaw', requestedRaw)
    void (async () => {
      try {
        const response = await fetch(`/api/carry/holder-exit-historical-outlook?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('historical_outlook_read_failed')
        const value: unknown = await response.json()
        const parsed = parseHistoricalOutlookResponse(
          value,
          routeKey,
          normalizedDestination,
          requestedRaw,
        )
        if (!parsed) throw new Error('historical_outlook_invalid')
        if (!controller.signal.aborted)
          setHistoricalState({
            selectionKey: historicalSelectionKey,
            view: historicalOutlookView(parsed),
          })
      } catch {
        if (!controller.signal.aborted)
          setHistoricalState({
            selectionKey: historicalSelectionKey,
            view: { status: 'abstain', reason: 'read_error' },
          })
      }
    })()
    return () => controller.abort()
  }, [historicalSelectionKey, normalizedDestination, requestedRaw, routeKey])

  useEffect(() => {
    setTestedBoundsState(null)
    if (!testedBoundsSelectionKey || !asset || !isRawAmount(requestedRaw)) return
    const controller = new AbortController()
    const query = new URLSearchParams({
      routeKey,
      destination: normalizedDestination,
      horizonHours: String(horizonHours),
      requestedRaw,
    })
    void (async () => {
      try {
        const response = await fetch(`/api/carry/holder-exit-tested-bounds?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const value: unknown = await response.json()
        const parsed = parseHolderExitTestedBoundsResponse(
          value,
          routeKey,
          normalizedDestination,
          normalizedAsset,
          horizonHours,
          requestedRaw,
        )
        if (!parsed || controller.signal.aborted) return
        setTestedBoundsState({ selectionKey: testedBoundsSelectionKey, response: parsed })
      } catch {
        // Tested evidence is optional and renders nothing when its local reader is unavailable.
      }
    })()
    return () => controller.abort()
  }, [
    asset,
    horizonHours,
    normalizedAsset,
    normalizedDestination,
    routeKey,
    requestedRaw,
    testedBoundsSelectionKey,
  ])

  return (
    <HolderExitHistoricalOutlookPresentation
      view={view}
      testedBounds={testedBounds}
      assetDecimals={assetDecimals}
      assetSymbol={assetSymbol}
      qAbstentionReason={qAbstentionReason}
    />
  )
}
