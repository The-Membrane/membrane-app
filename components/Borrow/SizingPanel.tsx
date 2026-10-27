import React, { useMemo } from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'

import {
  CONTEXT_ODDS_FEED,
  HISTORY_SOURCE,
  HORIZONS,
  carryCost,
  contextOddsLevel,
  distancePercentFloor,
  historyCount,
  liquidationDistance,
  liquidationPrice,
  stressLines,
  underlyingFor,
} from './drawdownHistory'
import type { HorizonDays, StressLine } from './drawdownHistory'
import { fmt } from './utils'
import type { CollateralAsset } from './types'

export interface SizingPanelProps {
  asset: CollateralAsset
  /** The slider LTV after the cap clamp, whole percent. */
  ltvPercent: number
  /** CDT minted at that LTV, USD. */
  debt: number
  /** Borrow rate, percent/yr (the page's rate source). */
  rate: number
  /** Provenance of `rate` for its stamp. */
  rateStamp: string
  /** Live underlying spot (ETH, BTC), USD, when fetched. */
  refPx: Partial<Record<string, number>>
  /** ISO time the prices were fetched, or null when none was. */
  pxFetchedAt: string | null
  /** True when this asset's price came from the live fetch (else it is the wallet fixture). */
  pxLive: boolean
}

const label = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.label,
  letterSpacing: '0.28em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

const dayWord = (d: HorizonDays) => (d === 1 ? '1 day' : `${d} days`)

/** `HH:MM UTC` from an ISO time. */
export const hhmmUtc = (iso: string) => `${iso.slice(11, 16)} UTC`

/** Dollars with cents under $100 (a $0.22 carry or a $0.74 share price must not read as $0 or $1), whole above. */
const fmtUsd = (n: number) => (n >= 100 ? fmt(n) : `$${n.toFixed(2)}`)

const listEvents = (lines: StressLine[]) =>
  lines.map((l) => `${l.label} (−${l.dropPct}%)`).join(', ')

/**
 * Sizing panel (board ruling Q26-S1, honest form): the liquidation price and the
 * drop to reach it, then how often history fell that far, then carry cost. It helps a
 * borrower choose leverage WITHOUT a better forecast: no "borrow at most" sentence
 * (the review did not show its 5% target holds) and no odds number until a live D12
 * feed is wired.
 */
export const SizingPanel: React.FC<SizingPanelProps> = ({
  asset,
  ltvPercent,
  debt,
  rate,
  rateStamp,
  refPx,
  pxFetchedAt,
  pxLive,
}) => {
  const info = underlyingFor(asset.sym)
  const distance = liquidationDistance(ltvPercent, asset.M)
  const distPct = distancePercentFloor(distance)
  const linePx = liquidationPrice(asset.px, ltvPercent, asset.M)
  const underPx = info ? refPx[info.underlying] : undefined
  const odds = contextOddsLevel(distance)

  const rows = useMemo(
    () =>
      info
        ? HORIZONS.map((h) => ({
            h,
            count: historyCount(info.underlying, h, distance),
            stress: stressLines(info.underlying, h, distance),
          }))
        : [],
    [info, distance],
  )
  const levelPct = rows[0]?.count.levelPct
  const closer = rows[0]?.count.lineCloserThanGrid

  const pxStamp =
    pxLive && pxFetchedAt ? `coins.llama.fi · fetched ${hhmmUtc(pxFetchedAt)}` : 'price: mock'

  return (
    <Box mt={SPACING['2xl']}>
      <HStack spacing={SPACING.md} align="baseline" flexWrap="wrap" mb={SPACING.sm}>
        <Text {...label}>01 /</Text>
        <Text
          as="h2"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h2}
          color={SEMANTIC_COLORS.textPrimary}
        >
          Where your line sits
        </Text>
      </HStack>

      <Card variant="default" p={SPACING.lg} data-testid="sizing-panel">
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.small}
          fontStyle="italic"
          color={SEMANTIC_COLORS.textSecondary}
          maxW="72ch"
        >
          Your liquidation price, and how often the market has fallen that far before. This is
          history, not a forecast: nothing here says how likely the next fall is.
        </Text>

        {/* Facts: line, distance, carry */}
        <Grid
          templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          mt={SPACING.base}
        >
          <Box
            p={SPACING.md}
            borderRightWidth={{ base: 0, md: '1px' }}
            borderBottomWidth={{ base: '1px', md: 0 }}
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <Text {...label}>Liquidation price</Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h4}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
              data-testid="sizing-line-price"
            >
              {fmtUsd(linePx)}{' '}
              <Text as="span" color={SEMANTIC_COLORS.textSecondary} fontSize={TYPOGRAPHY.xs}>
                per {asset.sym}
              </Text>
            </Text>
            {info?.wrapper && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.55}
              >
                {underPx
                  ? `≈ ${info.underlying} ${fmt(underPx * (1 - distance))} · ${info.underlying} today ${fmt(underPx)}`
                  : `${info.underlying}-price equivalent: waiting for a live ${info.underlying} price`}
              </Text>
            )}
            <MockStamp label={pxStamp} display="block" mt={SPACING.xs} />
          </Box>

          <Box
            p={SPACING.md}
            borderRightWidth={{ base: 0, md: '1px' }}
            borderBottomWidth={{ base: '1px', md: 0 }}
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <Text {...label}>Drop to reach it</Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h4}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
              data-testid="sizing-distance"
            >
              {distPct}% below today
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.55}
            >
              LTV {ltvPercent.toFixed(0)}% reaches the {(asset.M * 100).toFixed(0)}% line after a{' '}
              {distPct}% fall
            </Text>
          </Box>

          <Box p={SPACING.md}>
            <Text {...label}>Borrow cost</Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.h4}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.xs}
              data-testid="sizing-carry"
            >
              {fmtUsd(carryCost(debt, rate, 7))} over 7 days
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.55}
            >
              {fmtUsd(carryCost(debt, rate, 1))} / 1 day · {fmtUsd(carryCost(debt, rate, 30))} / 30
              days · {rate.toFixed(1)}% / yr on {fmt(debt)}
            </Text>
            <MockStamp label={rateStamp} display="block" mt={SPACING.xs} />
          </Box>
        </Grid>

        {info ? (
          <Box mt={SPACING.lg} data-testid="sizing-history">
            <HStack justify="space-between" align="baseline" flexWrap="wrap" spacing={SPACING.sm}>
              <Text {...label}>History, not a forecast</Text>
              <MockStamp
                label={`history (Binance, ${HISTORY_SOURCE.span}), not a forecast`}
                letterSpacing="0.12em"
              />
            </HStack>

            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textPrimary}
              mt={SPACING.sm}
              lineHeight={1.6}
            >
              Since Sep 2017, {info.underlying} has fallen at least {levelPct}%
              {closer ? ` (your line is closer, at ${distPct}%)` : ''} within 1 day / 7 days / 30
              days in this many separate windows:
            </Text>

            <Box border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.sm}>
              {rows.map(({ h, count, stress }, i) => {
                const reach = stress.filter((s) => s.reachesLine)
                const short = stress.filter((s) => !s.reachesLine)
                return (
                  <Grid
                    key={h}
                    templateColumns={{ base: '1fr', md: '9rem 12rem minmax(0, 1fr)' }}
                    gap={{ base: SPACING.xs, md: SPACING.base }}
                    p={SPACING.md}
                    borderTop={i === 0 ? 'none' : '1px solid'}
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    data-testid={`sizing-row-${h}d`}
                  >
                    <Text {...label} alignSelf="baseline">
                      Within {dayWord(h)}
                    </Text>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      {count.windows} separate {count.windows === 1 ? 'window' : 'windows'}
                    </Text>
                    <Box>
                      {reach.length > 0 && (
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.xs}
                          color={SEMANTIC_COLORS.textPrimary}
                          lineHeight={1.55}
                        >
                          a repeat of {listEvents(reach)} in {dayWord(h)} would reach your line
                        </Text>
                      )}
                      {short.length > 0 && (
                        <Text
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.xs}
                          color={SEMANTIC_COLORS.textTertiary}
                          lineHeight={1.55}
                        >
                          fell less than {distPct}% in {dayWord(h)}: {listEvents(short)}
                        </Text>
                      )}
                    </Box>
                  </Grid>
                )
              })}
            </Box>

            {/* Context odds: only the graded 7 d cells, only from a live feed. None is wired. */}
            <Grid
              templateColumns={{ base: '1fr', md: '9rem 12rem minmax(0, 1fr)' }}
              gap={{ base: SPACING.xs, md: SPACING.base }}
              p={SPACING.md}
              mt={SPACING.sm}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              data-testid="sizing-odds"
            >
              <Text {...label}>7-day odds</Text>
              {odds ? (
                <>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.small}
                    color={SEMANTIC_COLORS.textTertiary}
                  >
                    at {odds.levelPct}% · —
                  </Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    lineHeight={1.55}
                  >
                    {odds.label} ·{' '}
                    {CONTEXT_ODDS_FEED
                      ? 'loading'
                      : 'no live feed in the app yet, so no number is shown'}
                  </Text>
                </>
              ) : (
                <Text
                  gridColumn={{ md: 'span 2' }}
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                  lineHeight={1.55}
                >
                  your line is closer than the 10% level; no odds are shown this close
                </Text>
              )}
            </Grid>

            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
              mt={SPACING.sm}
              lineHeight={1.6}
              maxW="96ch"
            >
              Counted on the market price (Binance hourly low touching the level), non-overlapping
              windows; a count is not a chance. Membrane&apos;s oracle is a 1-hour average and lags
              the market. A wrapper can also trade below its underlying; the counts do not include
              that.
            </Text>
            {info.basis && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                mt={SPACING.xs}
                lineHeight={1.6}
                maxW="96ch"
                data-testid="sizing-basis"
              >
                Basis: {info.basis}
              </Text>
            )}
          </Box>
        ) : (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            mt={SPACING.lg}
            lineHeight={1.6}
            data-testid="sizing-no-history"
          >
            No price history is shown for {asset.sym}: it is priced from a vault share rate, not a
            market the ETH/BTC history describes.
          </Text>
        )}
      </Card>
    </Box>
  )
}

export default SizingPanel
