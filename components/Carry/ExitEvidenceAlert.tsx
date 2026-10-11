import React, { useEffect, useState } from 'react'
import { Box, HStack, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

export type ExitEvidenceScope = {
  requestId: number
  routeKey: string
  destination: string
  holder: string
  assetsRaw: string
  assetDecimals: number
  assetUnit: string
}

export type CurrentExitSample = {
  routeKey: string
  destination: string
  holder: string
  assetsRaw: string
  status: 'success'
  blockNumber: number
  blockHash: string
  blockTime: string
}

type Point = { block: string; hash: string; blockTime: string }
type SampledLoss = {
  kind: 'sampled_exit_loss'
  scope: 'one_sampled_holder_and_amount'
  routeKey: string
  destination: string
  holder: string
  assetsRaw: string
  baseline: Point
  lossObserved: Point
  outcome: 'holder_covered_evm_revert'
  recovery: null | {
    status: 'later_same_holder_amount_success'
    point: Point
  }
  duration: 'interval_censored' | 'unavailable'
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validPoint(value: unknown): value is Point {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return (
    typeof point.block === 'string' &&
    /^[1-9]\d*$/.test(point.block) &&
    typeof point.hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(point.hash) &&
    validTime(point.blockTime)
  )
}

export function matchingSampledLosses(input: unknown, scope: ExitEvidenceScope): SampledLoss[] {
  if (!input || typeof input !== 'object') return []
  const feed = input as Record<string, unknown>
  if (
    feed.status !== 'bounded_sampled_exit_evidence' ||
    feed.futureExitForecast !== false ||
    feed.prospectiveValidated !== false ||
    feed.likelyDuration !== 'unavailable' ||
    !Array.isArray(feed.alerts)
  )
    return []
  const bound = feed.scope as Record<string, unknown> | undefined
  if (
    !bound ||
    bound.completeHistory !== false ||
    !Number.isInteger(bound.maxRecentIssuedBaselinesPerLedger) ||
    Number(bound.maxRecentIssuedBaselinesPerLedger) < 1
  )
    return []

  return feed.alerts
    .filter((value): value is SampledLoss => {
      if (!value || typeof value !== 'object') return false
      const alert = value as Record<string, unknown>
      const baseline = alert.baseline
      const loss = alert.lossObserved
      const recovery = alert.recovery as SampledLoss['recovery']
      const recovered =
        recovery !== null &&
        typeof recovery === 'object' &&
        recovery.status === 'later_same_holder_amount_success' &&
        validPoint(recovery.point) &&
        validPoint(loss) &&
        BigInt(recovery.point.block) > BigInt(loss.block) &&
        Date.parse(recovery.point.blockTime) > Date.parse(loss.blockTime)
      return (
        alert.kind === 'sampled_exit_loss' &&
        alert.scope === 'one_sampled_holder_and_amount' &&
        alert.outcome === 'holder_covered_evm_revert' &&
        alert.routeKey === scope.routeKey &&
        String(alert.destination).toLowerCase() === scope.destination.toLowerCase() &&
        String(alert.holder).toLowerCase() === scope.holder.toLowerCase() &&
        alert.assetsRaw === scope.assetsRaw &&
        validPoint(baseline) &&
        validPoint(loss) &&
        BigInt(loss.block) > BigInt(baseline.block) &&
        Date.parse(loss.blockTime) > Date.parse(baseline.blockTime) &&
        (recovery === null
          ? alert.duration === 'unavailable'
          : recovered && alert.duration === 'interval_censored')
      )
    })
    .slice(0, 3)
}

export function currentSampleRecovery(
  alert: SampledLoss,
  scope: ExitEvidenceScope,
  sample: CurrentExitSample | null,
): CurrentExitSample | null {
  if (
    !sample ||
    sample.status !== 'success' ||
    sample.routeKey !== scope.routeKey ||
    sample.destination.toLowerCase() !== scope.destination.toLowerCase() ||
    sample.holder.toLowerCase() !== scope.holder.toLowerCase() ||
    sample.assetsRaw !== scope.assetsRaw ||
    !Number.isSafeInteger(sample.blockNumber) ||
    sample.blockNumber < 1 ||
    !/^0x[0-9a-fA-F]{64}$/.test(sample.blockHash) ||
    !validTime(sample.blockTime) ||
    BigInt(sample.blockNumber) <= BigInt(alert.lossObserved.block) ||
    Date.parse(sample.blockTime) <= Date.parse(alert.lossObserved.blockTime)
  )
    return null
  return sample
}

export function formatExitEvidenceAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return raw
  const unit = 10n ** BigInt(decimals)
  const whole = (BigInt(raw) / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (BigInt(raw) % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function time(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const labelStyle = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.28em',
}

export const ExitEvidenceAlert: React.FC<{
  scope: ExitEvidenceScope
  currentSample: CurrentExitSample | null
}> = ({ scope, currentSample }) => {
  const [alerts, setAlerts] = useState<SampledLoss[]>([])

  useEffect(() => {
    const controller = new AbortController()
    setAlerts([])
    const query = new URLSearchParams({
      chainId: '1',
      routeKey: scope.routeKey,
      destinationAddress: scope.destination,
      owner: scope.holder,
      assetsRaw: scope.assetsRaw,
      limit: '3',
    })
    void fetch(`/api/carry/exit-evidence-alerts?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('exit_evidence_unavailable')
        return matchingSampledLosses(await response.json(), scope)
      })
      .then((matching) => {
        if (!controller.signal.aborted) setAlerts(matching)
      })
      .catch(() => {
        if (!controller.signal.aborted) setAlerts([])
      })
    return () => controller.abort()
  }, [scope])

  if (alerts.length === 0) return null
  return (
    <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} pt={SPACING.md}>
      <Text {...labelStyle} color={SEMANTIC_COLORS.textSecondary}>
        Sampled H1 exit evidence · not a forecast
      </Text>
      <VStack align="stretch" spacing={SPACING.md} mt={SPACING.sm}>
        {alerts.map((alert) => {
          const quoteRecovery = currentSampleRecovery(alert, scope, currentSample)
          const ledgerRecovery = alert.recovery?.point
          const recovery =
            ledgerRecovery &&
            (!quoteRecovery ||
              Date.parse(ledgerRecovery.blockTime) <= Date.parse(quoteRecovery.blockTime))
              ? ledgerRecovery
              : quoteRecovery
          const recoveredByCurrentCheck = recovery === quoteRecovery && quoteRecovery !== null
          return (
            <Box
              key={`${alert.destination}:${alert.holder}:${alert.lossObserved.blockTime}`}
              role="status"
            >
              <HStack spacing={SPACING.sm} flexWrap="wrap" align="baseline">
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={recovery ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
                  fontWeight={TYPOGRAPHY.semibold}
                >
                  Sampled H1 withdrawal reverted
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {formatExitEvidenceAmount(alert.assetsRaw, scope.assetDecimals)} {scope.assetUnit}
                </Text>
              </HStack>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                overflowWrap="anywhere"
              >
                {alert.holder} · success {time(alert.baseline.blockTime)} → revert{' '}
                {time(alert.lossObserved.blockTime)}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
              >
                {recovery
                  ? `${recoveredByCurrentCheck ? 'Current check succeeded' : 'Later sampled success'} ${time(recovery.blockTime)} · exact duration unknown`
                  : 'Historical sample · recovery status and duration unknown'}
              </Text>
            </Box>
          )
        })}
      </VStack>
    </Box>
  )
}
