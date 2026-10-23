// THE OCT-10 COMPARISON.
//
// The old hero tried to animate thousands of per-minute points. It was visually tall,
// slow to settle, and made the important comparison hard to read. This is the measured
// census instead: every Aave and Morpho position liquidated on 10-11 Oct 2025 on four
// chains, and the debt each engine would have closed — with the per-protocol split on the
// chart itself, so the blended bar never stands alone. The figures are imported from the
// census headline file (OCT10_TOTALS) and re-derived from its rows by the unit test.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { tabular } from '@/components/Builder/styles'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { Comparison } from '@/lib/position-sim'
import { MODELLED_FOOTNOTE } from '@/lib/position-sim/guarantee'
import { OCT10_SCALE_LINE, OCT10_TOTALS } from '@/lib/position-sim/oct10Totals'

const usdMillions = (value: number): string => `$${Math.round(value / 1_000_000)}M`
const usdM1 = (value: number): string => `$${(value / 1_000_000).toFixed(1)}M`

const REAL_CLOSED = OCT10_TOTALS.realClosedUsd
const MEMBRANE_CLOSED = OCT10_TOTALS.membraneClosedUsd
/** NET: Membrane closes less on some positions and more on others (OCT10_SCALE_LINE.gross). */
const NET_LESS = OCT10_TOTALS.keptUsd
const { aave, morpho } = OCT10_TOTALS.byProtocol
const pctLess = (s: { realClosedUsd: number; keptUsd: number }) =>
  `${Math.abs((100 * s.keptUsd) / s.realClosedUsd).toFixed(1)}% ${s.keptUsd >= 0 ? 'less' : 'more'}`

const rows = [
  {
    label: 'Aave + Morpho',
    value: REAL_CLOSED,
    color: SEMANTIC_COLORS.textPrimary,
    mark: '',
  },
  {
    label: 'Membrane',
    value: MEMBRANE_CLOSED,
    color: SEMANTIC_COLORS.success,
    mark: '†',
  },
] as const

export interface HeroChartProps {
  /** Retained for the verdict hero's stable component API; this chart is cohort evidence. */
  comparison: Comparison | null
  startTs: number | null
  stepSeconds: number | null
  isDemo: boolean
}

export const HeroChart: React.FC<HeroChartProps> = () => (
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
          Two days. Same positions.
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          lineHeight={1.5}
          color={SEMANTIC_COLORS.textSecondary}
          {...tabular}
        >
          {OCT10_TOTALS.window} · {OCT10_TOTALS.positions.toLocaleString('en-US')} liquidated
          positions · Aave and Morpho · four chains
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
          {usdMillions(NET_LESS)} less, net†
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="10px"
          letterSpacing="0.12em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textSecondary}
        >
          debt force-closed · {OCT10_SCALE_LINE.gross}
        </Text>
      </Box>
    </Box>

    <Box
      role="img"
      aria-label={`On 10-11 October 2025, Aave and Morpho force-closed ${usdMillions(REAL_CLOSED)} of debt and Membrane would have closed ${usdMillions(MEMBRANE_CLOSED)} (modelled) across the same ${OCT10_TOTALS.positions.toLocaleString('en-US')} positions.`}
      display="grid"
      gap={SPACING.lg}
    >
      {rows.map((row) => {
        const width = `${(row.value / REAL_CLOSED) * 100}%`
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
                {row.mark}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                color={row.color}
                fontWeight={700}
                {...tabular}
              >
                {usdMillions(row.value)}
                {row.mark}
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
      Aave {usdM1(aave.realClosedUsd)} → {usdM1(aave.membraneClosedUsd)}† ({pctLess(aave)}) · Morpho{' '}
      {usdM1(morpho.realClosedUsd)} → {usdM1(morpho.membraneClosedUsd)}† ({pctLess(morpho)}). Debt
      closed across the measured census; lower is less forced repayment. {MODELLED_FOOTNOTE}
    </Text>
  </Box>
)

export default HeroChart
