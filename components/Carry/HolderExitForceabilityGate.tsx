import React from 'react'
import { Box, SimpleGrid, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

export type ApyUsdOpenReceiptCurrent = {
  status: 'fresh'
  scope: 'historical_open_receipts'
  prospectiveQForecast: false
  block: { number: number; hash: string; timestamp: number }
  observedAtUtc: string
  openReceiptCount: number
  noCurrentOwnerCount: number
  holderChangedCount: number
  claimSimulationPassCount: number
  fullEscrowSimulationCount: number
  noCodeHolderCount: number
  delegatedEoaHolderCount: number
  contractHolderCount: number
  sourceHosts: string[]
}

export type HolderExitForceabilityView = {
  status: 'available'
  routeKey: string
  destination: string
  forecastValidated: boolean
  holderExecutableExit: boolean
  subject: {
    mechanism: 'atomic' | 'staged'
    directIssueCellObservations: number
    measuredDirectBaselineCellObservations: number
    historicalDirectFinalAssetPayoutTransactions: number
    historicalStableSimulatedReverts?: {
      anchorBlock: number
      anchorAtUtc: string
      qLabel: 'fixed_10k'
      sampledHours: number[]
      provenance: 'saved_cell_disk_integrity_only'
    }[]
    stageIssueObservations: number
    terminalSameEpisodeFinalAssetPaidProofs: number
    historicalReceiptCohort: null | {
      mintedReceipts: number
      firstEligibleHolderClaimSuccesses: number
      mechanicalClaimGateSeconds?: number | null
      sameReceiptHolderPaidClaims: number
      openCensoredReceipts: number
      historicalRequestToMinedPaymentTiming?: {
        scope: 'historical_holder_action_influenced_request_to_mined_payment'
        denominator: number
        paidWithin7Days: number
        paidWithin21Days: number
        paidWithin28Days: number
        medianRequestToMinedPayoutSeconds: number | null
        openRightCensored: number
        censorTimestamp: number
      }
    }
    latestOpenReceiptObservation?: null | {
      block: number
      blockTime: number
      cohort: number
      sameHolder: number
      claimCallable: number
      fullEscrowClaimable: number
      noCurrentOwner: number
      holderChanged: number
      evidenceSha256: string
    }
    historicalIntermediateQueue: null | {
      intermediateAsset: string
      cutoffBlock: number
      requests: number
      processed: number
      paidIntermediate: number
      processedUnclaimed: number
      pendingCensored: number
      pendingAboveCurrentLimit: number
      pendingBeforeUpgrade: number
      pendingAfterUpgrade: number
      processingWithin24h?: {
        horizonSeconds: 86400
        confirmedProcessed: number
        possibleProcessed: number
        censoredBeforeHorizon: number
      }
      processingRegimeDiagnostic?: {
        scope: 'request_to_operator_processing_only'
        horizonSeconds: 86400
        split: { atUtc: string }
        train: { evaluable: number; processedWithinHorizon: number }
        later: { evaluable: number; processedWithinHorizon: number }
        prospectiveValidated: false
        fullRouteExitAssessed: false
      }
    }
    latestPendingTicketObservation?: null | {
      sourceCutoffBlock: number
      block: number
      blockTime: number
      cohort: number
      stillRequested: number
      noLongerRequested: number
      priceGated: number
      quoteEligible: number
      medianElapsedSeconds: number | null
      atLeastSevenDays: number
      gateChange?: {
        previousBlock: number
        previousEvidenceSha256: string
        newlyGated: number
        newlyQuoteEligible: number
        stillGatedDeeper: number
      }
      evidenceSha256: string
    }
    observedRequestToPayoutSeconds: number[]
    calibratedImpairmentDuration: boolean
    forecastValidated: boolean
  }
}

function formatSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(remainder).padStart(2, '0')}s`
}

function formatObservedRange(samples: number[]): string | null {
  if (samples.length === 0) return null
  let min = samples[0]
  let max = samples[0]
  for (const seconds of samples) {
    min = Math.min(min, seconds)
    max = Math.max(max, seconds)
  }
  return min === max ? formatSeconds(min) : `${formatSeconds(min)}–${formatSeconds(max)}`
}

function formatPendingPriceGate(
  observation: NonNullable<HolderExitForceabilityView['subject']['latestPendingTicketObservation']>,
): string {
  const seconds = observation.medianElapsedSeconds
  const median =
    seconds === null
      ? '—'
      : `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
  return `${observation.priceGated}/${observation.cohort} · median ${median} waited · ${observation.atLeastSevenDays} ≥7d · B${observation.block}`
}

function latestHistoricalStableRevert(
  episodes: HolderExitForceabilityView['subject']['historicalStableSimulatedReverts'],
) {
  if (!Array.isArray(episodes) || episodes.length === 0) return null
  const anchors = new Set<number>()
  for (const episode of episodes) {
    if (
      episode?.provenance !== 'saved_cell_disk_integrity_only' ||
      episode.qLabel !== 'fixed_10k' ||
      !Number.isSafeInteger(episode.anchorBlock) ||
      episode.anchorBlock <= 0 ||
      typeof episode.anchorAtUtc !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(episode.anchorAtUtc) ||
      !Number.isFinite(Date.parse(episode.anchorAtUtc)) ||
      anchors.has(episode.anchorBlock) ||
      !Array.isArray(episode.sampledHours) ||
      episode.sampledHours[0] !== 0 ||
      episode.sampledHours.some(
        (hour, index) =>
          index > 0 &&
          (![1, 4, 24, 48, 168].includes(hour) || hour <= episode.sampledHours[index - 1]),
      )
    )
      return null
    anchors.add(episode.anchorBlock)
  }
  return {
    latest: episodes.reduce((a, b) => (b.anchorBlock > a.anchorBlock ? b : a)),
    sampledAnchors: anchors.size,
  }
}

function formatBlockTime(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export const HolderExitForceabilityGate: React.FC<{
  evidence: HolderExitForceabilityView
  apyUsdOpenReceiptStatus?: ApyUsdOpenReceiptCurrent | null
}> = ({ evidence, apyUsdOpenReceiptStatus }) => {
  const { subject } = evidence
  const issues =
    subject.mechanism === 'atomic'
      ? subject.directIssueCellObservations
      : subject.stageIssueObservations
  const routeAssays =
    subject.mechanism === 'atomic'
      ? subject.measuredDirectBaselineCellObservations
      : subject.terminalSameEpisodeFinalAssetPaidProofs
  const observed = subject.observedRequestToPayoutSeconds
  const observedRange = formatObservedRange(observed)
  const historicalStableRevert = latestHistoricalStableRevert(
    subject.historicalStableSimulatedReverts,
  )
  const gateChange = subject.latestPendingTicketObservation?.gateChange
  const gatePressure = Boolean(
    gateChange && (gateChange.newlyGated > 0 || gateChange.stillGatedDeeper > 0),
  )
  const items = [
    {
      label: subject.mechanism === 'atomic' ? 'Q CASES' : 'STAGE ISSUES',
      value: String(issues),
      observed: issues > 0,
    },
    {
      label: subject.mechanism === 'atomic' ? 'HOLDER ASSAY' : 'PAID FROM ISSUES',
      value: String(routeAssays),
      observed: routeAssays > 0,
    },
    ...(subject.mechanism === 'atomic' && subject.historicalDirectFinalAssetPayoutTransactions > 0
      ? [
          {
            label: 'SAMPLED PAID TX',
            value: String(subject.historicalDirectFinalAssetPayoutTransactions),
            observed: true,
          },
        ]
      : []),
    ...(historicalStableRevert
      ? [
          {
            label: 'HIST. SIMULATED REVERT',
            value: `Q $10k · B${historicalStableRevert.latest.anchorBlock} · ${historicalStableRevert.latest.anchorAtUtc.slice(0, 16).replace('T', ' ')} UTC · sampled ${historicalStableRevert.latest.sampledHours.join('/')}h${historicalStableRevert.sampledAnchors > 1 ? ` · ${historicalStableRevert.sampledAnchors} anchors` : ''} · SHA-checked · no RPC replay`,
            observed: true,
            warning: true,
          },
        ]
      : []),
    ...(subject.historicalReceiptCohort
      ? [
          {
            label: 'HIST. RECEIPTS',
            value: `${subject.historicalReceiptCohort.mintedReceipts} · ${subject.historicalReceiptCohort.sameReceiptHolderPaidClaims} paid · ${subject.historicalReceiptCohort.openCensoredReceipts} open`,
            observed: true,
          },
          {
            label: subject.historicalReceiptCohort.mechanicalClaimGateSeconds
              ? 'HIST. CLAIM GATE'
              : 'FIRST ELIGIBLE',
            value: subject.historicalReceiptCohort.mechanicalClaimGateSeconds
              ? `${formatSeconds(subject.historicalReceiptCohort.mechanicalClaimGateSeconds)} · ${subject.historicalReceiptCohort.firstEligibleHolderClaimSuccesses}/${subject.historicalReceiptCohort.mintedReceipts}`
              : `${subject.historicalReceiptCohort.firstEligibleHolderClaimSuccesses}/${subject.historicalReceiptCohort.mintedReceipts}`,
            observed: true,
          },
          ...(subject.historicalReceiptCohort.historicalRequestToMinedPaymentTiming
            ? [
                {
                  label: 'PAST REQUEST→PAID',
                  value: (() => {
                    const timing =
                      subject.historicalReceiptCohort.historicalRequestToMinedPaymentTiming!
                    const median = timing.medianRequestToMinedPayoutSeconds
                    return `7d ${timing.paidWithin7Days}/${timing.denominator} · 21d ${timing.paidWithin21Days}/${timing.denominator} · 28d ${timing.paidWithin28Days}/${timing.denominator} · median ${median === null ? 'unreached' : `${(median / 86_400).toFixed(3)}d`} · ${timing.openRightCensored} open at cutoff`
                  })(),
                  observed: true,
                },
              ]
            : []),
          ...(apyUsdOpenReceiptStatus?.status === 'fresh'
            ? [
                {
                  label: 'CLAIM CHECK',
                  value: `${apyUsdOpenReceiptStatus.claimSimulationPassCount}/${apyUsdOpenReceiptStatus.openReceiptCount} claim simulations passed · ${apyUsdOpenReceiptStatus.fullEscrowSimulationCount}/${apyUsdOpenReceiptStatus.openReceiptCount} full escrow · ${apyUsdOpenReceiptStatus.noCodeHolderCount} no-code · ${apyUsdOpenReceiptStatus.delegatedEoaHolderCount} delegated EOA${apyUsdOpenReceiptStatus.contractHolderCount ? ` · ${apyUsdOpenReceiptStatus.contractHolderCount} contract-held` : ''}${apyUsdOpenReceiptStatus.noCurrentOwnerCount ? ` · ${apyUsdOpenReceiptStatus.noCurrentOwnerCount} absent, payout unverified` : ''}${apyUsdOpenReceiptStatus.holderChangedCount ? ` · ${apyUsdOpenReceiptStatus.holderChangedCount} transferred` : ''} · B${apyUsdOpenReceiptStatus.block.number} · sampled ${formatBlockTime(apyUsdOpenReceiptStatus.block.timestamp)}`,
                  observed: true,
                  warning:
                    apyUsdOpenReceiptStatus.noCurrentOwnerCount > 0 ||
                    apyUsdOpenReceiptStatus.holderChangedCount > 0 ||
                    apyUsdOpenReceiptStatus.claimSimulationPassCount <
                      apyUsdOpenReceiptStatus.openReceiptCount,
                },
              ]
            : subject.latestOpenReceiptObservation
              ? [
                  {
                    label: 'LAST CLAIM CHECK',
                    value: `${subject.latestOpenReceiptObservation.claimCallable}/${subject.latestOpenReceiptObservation.sameHolder} claim simulations passed · ${subject.latestOpenReceiptObservation.fullEscrowClaimable}/${subject.latestOpenReceiptObservation.sameHolder} full escrow${subject.latestOpenReceiptObservation.noCurrentOwner ? ` · ${subject.latestOpenReceiptObservation.noCurrentOwner} absent, payout unverified` : ''}${subject.latestOpenReceiptObservation.holderChanged ? ` · ${subject.latestOpenReceiptObservation.holderChanged} transferred` : ''} · B${subject.latestOpenReceiptObservation.block} · sampled ${formatBlockTime(subject.latestOpenReceiptObservation.blockTime)}`,
                    observed: true,
                  },
                ]
              : []),
        ]
      : []),
    ...(subject.historicalIntermediateQueue
      ? [
          {
            label: 'USDat QUEUE',
            value: `${subject.historicalIntermediateQueue.requests} requests · ${subject.historicalIntermediateQueue.processed} processed · ${subject.historicalIntermediateQueue.paidIntermediate} USDat paid`,
            observed: true,
          },
          ...(subject.historicalIntermediateQueue.processingWithin24h
            ? [
                {
                  label: 'PAST 24H PROCESS',
                  value: `${subject.historicalIntermediateQueue.processingWithin24h.confirmedProcessed}–${subject.historicalIntermediateQueue.processingWithin24h.possibleProcessed} / ${subject.historicalIntermediateQueue.requests} · ${subject.historicalIntermediateQueue.processingWithin24h.censoredBeforeHorizon} unknown`,
                  observed: true,
                },
              ]
            : []),
          ...(subject.historicalIntermediateQueue.processingRegimeDiagnostic
            ? [
                {
                  label: '24H QUEUE SHIFT',
                  value: `${subject.historicalIntermediateQueue.processingRegimeDiagnostic.train.processedWithinHorizon}/${subject.historicalIntermediateQueue.processingRegimeDiagnostic.train.evaluable} → ${subject.historicalIntermediateQueue.processingRegimeDiagnostic.later.processedWithinHorizon}/${subject.historicalIntermediateQueue.processingRegimeDiagnostic.later.evaluable} · split ${subject.historicalIntermediateQueue.processingRegimeDiagnostic.split.atUtc.slice(5, 10)} · retrospective`,
                  observed: true,
                  warning:
                    subject.historicalIntermediateQueue.processingRegimeDiagnostic.train
                      .processedWithinHorizon *
                      subject.historicalIntermediateQueue.processingRegimeDiagnostic.later
                        .evaluable >
                    subject.historicalIntermediateQueue.processingRegimeDiagnostic.later
                      .processedWithinHorizon *
                      subject.historicalIntermediateQueue.processingRegimeDiagnostic.train
                        .evaluable,
                },
              ]
            : []),
          {
            label: 'PRICE GATE',
            value: subject.latestPendingTicketObservation
              ? formatPendingPriceGate(subject.latestPendingTicketObservation)
              : `${subject.historicalIntermediateQueue.pendingAboveCurrentLimit}/${subject.historicalIntermediateQueue.pendingCensored} pending · B${subject.historicalIntermediateQueue.cutoffBlock}`,
            observed: true,
            warning: subject.latestPendingTicketObservation
              ? subject.latestPendingTicketObservation.priceGated > 0
              : subject.historicalIntermediateQueue.pendingAboveCurrentLimit > 0,
          },
          ...(gateChange && subject.latestPendingTicketObservation
            ? [
                {
                  label: gatePressure ? 'COHORT GATE PRESSURE' : 'COHORT GATE CHANGE',
                  value: `+${gateChange.newlyGated} gated · ${gateChange.stillGatedDeeper} further below min · +${gateChange.newlyQuoteEligible} quote eligible · B${gateChange.previousBlock}→B${subject.latestPendingTicketObservation.block} · ${formatBlockTime(subject.latestPendingTicketObservation.blockTime)}`,
                  observed: true,
                  warning: gatePressure,
                },
              ]
            : []),
        ]
      : []),
    ...(observedRange === null
      ? []
      : [
          {
            label: 'REQUEST→PAYOUT',
            value: `${observedRange} · n=${observed.length}`,
            observed: true,
          },
        ]),
    ...(subject.calibratedImpairmentDuration
      ? [{ label: 'LIKELY DURATION', value: 'CALIBRATED', observed: true }]
      : []),
    ...(subject.forecastValidated
      ? [{ label: 'FORECAST', value: 'VALIDATED', observed: true }]
      : []),
  ]
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        textTransform="uppercase"
        letterSpacing="0.28em"
        color={SEMANTIC_COLORS.textSecondary}
      >
        Route exit evidence
      </Text>
      <SimpleGrid
        columns={{
          base: 2,
          md: items.length > 4 ? 3 : 4,
          lg: items.length > 4 ? 5 : 4,
        }}
        spacing={SPACING.base}
      >
        {items.map((item) => (
          <Box
            key={`${item.label}:${item.value}`}
            role={gatePressure && item.label === 'COHORT GATE PRESSURE' ? 'status' : undefined}
            borderLeft="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            pl={SPACING.sm}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              color={SEMANTIC_COLORS.textSecondary}
            >
              {item.label}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={
                item.warning || !item.observed ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.info
              }
            >
              {item.value}
            </Text>
          </Box>
        ))}
      </SimpleGrid>
    </VStack>
  )
}
