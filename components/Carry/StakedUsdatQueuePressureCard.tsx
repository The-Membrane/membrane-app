import { useEffect, useState } from 'react'
import { HStack, Text, VStack } from '@chakra-ui/react'
import { formatUnits } from 'viem'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { StakedUsdatQueuePressure } from '@/lib/carry/stakedUsdatQueuePressure'

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function amount(raw: string, decimals = 6): string {
  return number.format(Number(formatUnits(BigInt(raw), decimals)))
}

function signed(value: number | string): string {
  const raw = String(value)
  return raw.startsWith('-') ? raw : `+${raw}`
}

export function StakedUsdatQueuePressureCard() {
  const [snapshot, setSnapshot] = useState<StakedUsdatQueuePressure | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    let inFlight = false
    const refresh = async () => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      try {
        const response = await fetch('/api/carry/staked-usdat-queue-pressure', {
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('queue_pressure_unavailable')
        const result = (await response.json()) as StakedUsdatQueuePressure
        const age = Date.now() - Date.parse(result.source.blockTime)
        if (
          !controller.signal.aborted &&
          result.status === 'observed' &&
          result.source.origins === 2 &&
          result.forecastValidated === false &&
          Number.isFinite(age) &&
          age >= -120_000 &&
          age <= 2 * 60 * 60_000
        ) {
          setSnapshot(result)
          setUnavailable(false)
        } else {
          throw new Error('queue_pressure_stale')
        }
      } catch {
        if (!controller.signal.aborted) {
          setSnapshot(null)
          setUnavailable(true)
        }
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!snapshot && !unavailable) return null

  return (
    <Card variant="subtle" p={SPACING.base}>
      <VStack align="stretch" spacing={SPACING.sm}>
        <HStack justify="space-between" flexWrap="wrap" gap={SPACING.sm}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h4}>
            Saturn queue
          </Text>
          {snapshot && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              Block {snapshot.source.blockNumber} · 2 sources
            </Text>
          )}
        </HStack>
        {snapshot ? (
          <>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.warning}
            >
              {snapshot.requested.tickets} requested · {snapshot.requested.belowLimitTickets}/
              {snapshot.requested.quotedTickets} below ticket minimum ·{' '}
              {amount(snapshot.requested.sharesRaw, 18)} shares pending
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
            >
              {snapshot.processed.tickets} processed, unclaimed ·{' '}
              {amount(snapshot.processed.owedUsdatRaw)} USDat owed
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {amount(snapshot.vaultCashUsdatRaw)} USDat in vault ·{' '}
              {amount(snapshot.requested.quotedUsdatRaw)} USDat requested at current quote
            </Text>
            {snapshot.change && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={
                  BigInt(snapshot.change.vaultCashUsdatRawDelta) < 0n ||
                  BigInt(snapshot.change.requestedSharesRawDelta) > 0n
                    ? SEMANTIC_COLORS.warning
                    : SEMANTIC_COLORS.textSecondary
                }
              >
                {Math.round(snapshot.change.windowSeconds / 60)}m change · requests{' '}
                {signed(snapshot.change.requestedTicketsDelta)} · pending shares{' '}
                {signed(amount(snapshot.change.requestedSharesRawDelta, 18))} · processed, unclaimed{' '}
                {signed(snapshot.change.processedTicketsDelta)} · cash{' '}
                {signed(amount(snapshot.change.vaultCashUsdatRawDelta))} USDat
              </Text>
            )}
          </>
        ) : (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.warning}
          >
            Queue snapshot unavailable
          </Text>
        )}
      </VStack>
    </Card>
  )
}
