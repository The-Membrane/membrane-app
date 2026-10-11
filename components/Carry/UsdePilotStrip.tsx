import React, { useState } from 'react'
import { Box, Grid, Text, Tooltip } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { describeRouteReading } from '@/lib/carry/liveRouteFreshness'

type ReadingTime = { observedAt: string; ageSeconds: number; stale: boolean }
export type UsdePilot = {
  matchedCapital: ({ matchedUsde: string; completeWalletCount: number } & ReadingTime) | null
  destinationVaultTvl: ({ totalAssetsUsde: string } & ReadingTime) | null
  exactSpread: ({ borrowApy: number; yieldApy: number; spread: number } & ReadingTime) | null
}

const compactUsde = (raw: string) => {
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount < 0) return 'Reading unavailable'
  return `${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(amount)} USDe`
}
const stamp = (reading: ReadingTime, nowMs: number) => {
  const { ageSeconds, stale } = describeRouteReading(reading.observedAt, nowMs)
  const age =
    ageSeconds < 3600
      ? `${Math.floor(ageSeconds / 60)}m`
      : ageSeconds < 86_400
        ? `${Math.floor(ageSeconds / 3600)}h`
        : `${Math.floor(ageSeconds / 86_400)}d`
  const asOf = new Date(reading.observedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `${stale ? 'Stale · last measured' : 'Measured'} ${asOf} · ${age} ago`
}

export default function UsdePilotStrip({
  pilot,
  nowMs,
}: {
  pilot: UsdePilot | null
  nowMs: number
}) {
  const spread = pilot?.exactSpread
  const [tipOpen, setTipOpen] = useState(false)
  const displaySpreadPoints = spread ? Number((spread.spread * 100).toFixed(2)) : null
  return (
    <Box
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.md}
      mb={SPACING.md}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h4}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Aave USDe → sUSDe
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        A daily exact-leg comparison. Each number has a different scope.
      </Text>
      <Grid
        templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
        gap={SPACING.md}
        mt={SPACING.md}
      >
        <Box minW={0}>
          {spread ? (
            <Tooltip
              isOpen={tipOpen}
              hasArrow
              placement="top"
              bg={SEMANTIC_COLORS.bgSecondary}
              color={SEMANTIC_COLORS.textPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              p={SPACING.sm}
              label={`Aave variable borrow ${(spread.borrowApy * 100).toFixed(2)}% APY · trailing seven-day sUSDe share growth ${(spread.yieldApy * 100).toFixed(2)}% annualized · before incentives, gas, and exit costs`}
            >
              <Box
                as="button"
                type="button"
                cursor="help"
                aria-label={`Spread ${displaySpreadPoints?.toFixed(2)} percentage points. Borrow ${(spread.borrowApy * 100).toFixed(2)} percent APY; trailing yield ${(spread.yieldApy * 100).toFixed(2)} percent annualized.`}
                onMouseEnter={() => setTipOpen(true)}
                onMouseLeave={() => setTipOpen(false)}
                onFocus={() => setTipOpen(true)}
                onBlur={() => setTipOpen(false)}
                onClick={() => setTipOpen(true)}
                textDecoration="underline"
                textDecorationStyle="dotted"
                textUnderlineOffset="3px"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h4}
                color={
                  displaySpreadPoints != null && displaySpreadPoints < 0
                    ? SEMANTIC_COLORS.danger
                    : displaySpreadPoints != null && displaySpreadPoints > 0
                      ? SEMANTIC_COLORS.success
                      : SEMANTIC_COLORS.textPrimary
                }
                sx={{ fontVariantNumeric: 'tabular-nums' }}
                _focusVisible={{ boxShadow: `0 0 0 2px ${SEMANTIC_COLORS.textPrimary}` }}
              >
                {displaySpreadPoints != null && displaySpreadPoints > 0
                  ? '+'
                  : displaySpreadPoints != null && displaySpreadPoints < 0
                    ? '−'
                    : ''}
                {Math.abs(displaySpreadPoints ?? 0).toFixed(2)} pp
              </Box>
            </Tooltip>
          ) : (
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
              No reading yet
            </Text>
          )}
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            trailing yield minus current borrow
          </Text>
          {spread && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {stamp(spread, nowMs)}
            </Text>
          )}
        </Box>
        <Box minW={0}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h4}
            color={SEMANTIC_COLORS.textPrimary}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {pilot?.destinationVaultTvl
              ? compactUsde(pilot.destinationVaultTvl.totalAssetsUsde)
              : 'No reading yet'}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            sUSDe vault assets · all depositors
          </Text>
          {pilot?.destinationVaultTvl && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {stamp(pilot.destinationVaultTvl, nowMs)}
            </Text>
          )}
        </Box>
        <Box minW={0}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h4}
            color={SEMANTIC_COLORS.textPrimary}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {pilot?.matchedCapital
              ? compactUsde(pilot.matchedCapital.matchedUsde)
              : 'No reading yet'}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            debt/holding overlap · fixed {pilot?.matchedCapital?.completeWalletCount ?? 25} August
            wallets
          </Text>
          {pilot?.matchedCapital && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {stamp(pilot.matchedCapital, nowMs)}
            </Text>
          )}
        </Box>
      </Grid>
      <Text
        mt={SPACING.md}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
      >
        Fixed-wallet overlap is not strategy TVL or a census of current borrowers. Vault assets
        include unrelated depositors.
      </Text>
    </Box>
  )
}
