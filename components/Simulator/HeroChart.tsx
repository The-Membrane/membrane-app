// THE OCT-10 COMPARISON.
//
// The old hero tried to animate thousands of per-minute points. It was visually tall,
// slow to settle, and made the important comparison hard to read. This is the measured
// cohort instead: the same 2,350 Aave accounts, the same day, and the debt each engine
// would have closed. The constants are re-derived from the evidence JSON in unit tests.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { tabular } from '@/components/Builder/styles'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { Comparison } from '@/lib/position-sim'
import { OCT10_TOTALS } from '@/lib/position-sim/oct10Totals'
import { LABEL, NEWS, NEWS_FONT, ONE_DAY_TITLE, useNewsEdition } from '@/components/NewsEdition'

const usdMillions = (value: number): string => `$${Math.round(value / 1_000_000)}M`

const AAVE_CLOSED = OCT10_TOTALS.aaveClosedUsd
const MEMBRANE_CLOSED = OCT10_TOTALS.membraneClosedUsd
const PROTECTED_DEBT = AAVE_CLOSED - MEMBRANE_CLOSED

const rows = [
  {
    label: 'Aave',
    value: AAVE_CLOSED,
    color: SEMANTIC_COLORS.textPrimary,
  },
  {
    label: 'Membrane',
    value: MEMBRANE_CLOSED,
    color: SEMANTIC_COLORS.success,
  },
] as const

export interface HeroChartProps {
  /** Retained for the verdict hero's stable component API; this chart is cohort evidence. */
  comparison: Comparison | null
  startTs: number | null
  stepSeconds: number | null
  isDemo: boolean
}

/**
 * THE NEWS EDITION'S BOX (canvas "Landing", section 02). The protected figure leads in
 * money green; the two bars are what each engine closed — Aave's in the danger colour,
 * Membrane's in money green. The title moves to the masthead index, which links here.
 */
const NewsHeroChart: React.FC = () => (
  <Box
    as="section"
    id="oneday"
    data-news-section=""
    aria-label={ONE_DAY_TITLE}
    data-testid="sim-oct10-comparison"
    border="1px solid"
    borderColor={NEWS.accent}
    borderRadius={0}
    px={{ base: '16px', md: '26px' }}
    py="24px"
    display="flex"
    flexWrap="wrap"
    gap="28px"
    minW={0}
  >
    <Box flex="1 1 260px" minW={0}>
      <Text
        fontFamily={NEWS_FONT.mono}
        fontWeight={700}
        fontSize="clamp(52px, 8vw, 76px)"
        lineHeight={1}
        letterSpacing="-0.02em"
        color={NEWS.up}
        {...tabular}
      >
        {usdMillions(PROTECTED_DEBT)}
      </Text>
      <Text
        mt="10px"
        fontFamily={NEWS_FONT.display}
        fontWeight={700}
        fontSize={{ base: '22px', md: '26px' }}
        lineHeight={1.2}
        color={NEWS.accent}
      >
        protected from forced debt closure
      </Text>
    </Box>
    <Box flex="999 1 520px" minW={0} display="flex" flexDirection="column" gap="14px">
      <Text fontFamily={NEWS_FONT.mono} fontSize="12px" letterSpacing="0.1em" color={NEWS.muted} {...tabular}>
        10 Oct 2025 · {OCT10_TOTALS.accounts.toLocaleString('en-US')} liquidated accounts
      </Text>
      <Box
        role="img"
        aria-label={`On 10 October 2025, Aave closed ${usdMillions(AAVE_CLOSED)} of debt and Membrane would have closed ${usdMillions(MEMBRANE_CLOSED)} across the same ${OCT10_TOTALS.accounts.toLocaleString('en-US')} accounts.`}
        display="grid"
        gridTemplateColumns={{ base: '84px minmax(0, 1fr)', md: '110px minmax(0, 1fr)' }}
        gap="12px 14px"
        alignItems="center"
      >
        {rows.map((row) => {
          const bar = row.label === 'Aave' ? NEWS.danger : NEWS.up
          return (
            <React.Fragment key={row.label}>
              <Text {...LABEL} fontSize="13px" letterSpacing="0.1em" color={NEWS.ink2}>
                {row.label}
              </Text>
              {/* One track width for both rows, so the bars stay to scale. */}
              <Box display="flex" alignItems="center" gap="10px" minW={0}>
                <Box flex="1 1 auto" minW={0}>
                  <Box h="30px" w={`${(row.value / AAVE_CLOSED) * 100}%`} bg={bar} />
                </Box>
                <Text
                  fontFamily={NEWS_FONT.mono}
                  fontWeight={700}
                  fontSize="15px"
                  color={NEWS.ink}
                  flexShrink={0}
                  minW="5ch"
                  textAlign="right"
                  {...tabular}
                >
                  {usdMillions(row.value)}
                </Text>
              </Box>
            </React.Fragment>
          )
        })}
      </Box>
      <Text
        fontFamily={NEWS_FONT.mono}
        fontSize="12px"
        lineHeight={1.5}
        color={NEWS.muted}
        borderTop="1px solid"
        borderColor={NEWS.rule}
        pt="10px"
      >
        Debt closed across the measured Oct. 10 cohort. Lower is less forced repayment.
      </Text>
    </Box>
  </Box>
)

export const HeroChart: React.FC<HeroChartProps> = () =>
  useNewsEdition() ? (
    <NewsHeroChart />
  ) : (
  <Box
    data-testid="sim-oct10-comparison"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgPrimary}
    borderRadius={0}
    px={{ base: SPACING.base, md: SPACING.lg }}
    py={{ base: SPACING.base, md: SPACING.lg }}
    display="grid"
    gap={{ base: SPACING.lg, md: SPACING.xl }}
    minW={0}
  >
    <Box
      display="flex"
      alignItems={{ base: 'start', md: 'end' }}
      justifyContent="space-between"
      gap={SPACING.base}
      flexDirection={{ base: 'column', md: 'row' }}
    >
      <Box display="grid" gap={SPACING.xs}>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(22px, 2.8vw, 34px)"
          lineHeight={1}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {ONE_DAY_TITLE}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          lineHeight={1.5}
          color={SEMANTIC_COLORS.textSecondary}
          {...tabular}
        >
          10 Oct 2025 · {OCT10_TOTALS.accounts.toLocaleString('en-US')} liquidated accounts
        </Text>
      </Box>

      <Box display="grid" gap={SPACING.xs} textAlign={{ base: 'left', md: 'right' }}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="clamp(22px, 3vw, 34px)"
          lineHeight={1}
          color={SEMANTIC_COLORS.warning}
          {...tabular}
        >
          {usdMillions(PROTECTED_DEBT)} protected
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          letterSpacing="0.12em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          from forced debt closure
        </Text>
      </Box>
    </Box>

    <Box
      role="img"
      aria-label={`On 10 October 2025, Aave closed ${usdMillions(AAVE_CLOSED)} of debt and Membrane would have closed ${usdMillions(MEMBRANE_CLOSED)} across the same ${OCT10_TOTALS.accounts.toLocaleString('en-US')} accounts.`}
      display="grid"
      gap={SPACING.lg}
    >
      {rows.map((row) => {
        const width = `${(row.value / AAVE_CLOSED) * 100}%`
        return (
          <Box key={row.label} display="grid" gap={SPACING.sm}>
            <Box display="flex" justifyContent="space-between" gap={SPACING.base}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={row.color}
                fontWeight={700}
              >
                {row.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={row.color}
                fontWeight={700}
                {...tabular}
              >
                {usdMillions(row.value)}
              </Text>
            </Box>
            <Box
              h={{ base: '32px', md: '40px' }}
              bg={SEMANTIC_COLORS.bgTertiary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              overflow="hidden"
            >
              <Box h="100%" w={width} bg={row.color} />
            </Box>
          </Box>
        )
      })}
    </Box>

    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      lineHeight={1.5}
      color={SEMANTIC_COLORS.textTertiary}
      {...tabular}
    >
      Debt closed across the measured Oct. 10 cohort. Lower is less forced repayment.
    </Text>
  </Box>
)

export default HeroChart
