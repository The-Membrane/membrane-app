import React, { useMemo } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { MockStamp } from '@/components/demo'
import { CHART_THEME, CHART_DIMENSIONS } from '@/config/chartTheme'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { lazyChart } from '@/components/ui/lazyChart'

import { SectionHeading } from './atoms'
import { CROSSING_STAMP, EXIT_MODEL } from './fixtures'
import { CROSSING_TIERS, CrossingPoint, buildCrossingSeries, crossingSizeUsd, formatUSD, twoSigFigs } from './utils'

/**
 * The crossing chart (BADASS_RULESET §4, rendered to BRAND_CHARTS §6):
 * chosen venue vs the one the board tempts you with, at the user's size and
 * ghosted ×10 / ×100. Y is realized value NET OF EXIT COST, % of principal —
 * never APY (§4.2). Each series is a band (the model's cost range) plus a
 * midline. The payload is that the ordering inverts with size; the gold
 * callout names the dollar figure where it does.
 */

const HORIZON_DAYS = 90

// §6: chosen = phosphor, alternative = cyber teal; tiers by opacity + dash.
const CHOSEN_COLOR = SEMANTIC_COLORS.primary
const ALT_COLOR = SEMANTIC_COLORS.secondary
const TIER_OPACITY: Record<number, number> = { 1: 1.0, 10: 0.72, 100: 0.5 }
const TIER_DASH: Record<number, string | undefined> = { 1: undefined, 10: '6 3', 100: '2 3' }
const BAND_OPACITY = 0.24

interface ChartBodyProps {
  data: CrossingPoint[]
}

const ChartBody = lazyChart<ChartBodyProps>((RC) => {
  const { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Area, Line } = RC
  return function CrossingChartBody({ data }: ChartBodyProps) {
    return (
      <ResponsiveContainer width="100%" height={CHART_DIMENSIONS.heights.md}>
        <ComposedChart data={data} margin={CHART_DIMENSIONS.margins.default}>
          <CartesianGrid {...CHART_THEME.grid} />
          <XAxis
            {...CHART_THEME.xAxis}
            dataKey="t"
            tickFormatter={(t: number) => `${t}d`}
          />
          <YAxis
            {...CHART_THEME.yAxis}
            tickFormatter={(v: number) => `${v.toFixed(1)}%`}
            width={44}
          />
          {/* Flat array, no Fragments — recharts identifies children by type. */}
          {CROSSING_TIERS.flatMap((mult) => [
            <Area
              key={`cb${mult}`}
              dataKey={`chosenBand${mult}`}
              stroke="none"
              fill={CHOSEN_COLOR}
              fillOpacity={BAND_OPACITY * TIER_OPACITY[mult]}
              isAnimationActive={false}
            />,
            <Area
              key={`ab${mult}`}
              dataKey={`altBand${mult}`}
              stroke="none"
              fill={ALT_COLOR}
              fillOpacity={BAND_OPACITY * TIER_OPACITY[mult]}
              isAnimationActive={false}
            />,
            <Line
              key={`cl${mult}`}
              dataKey={`chosen${mult}`}
              stroke={CHOSEN_COLOR}
              strokeOpacity={TIER_OPACITY[mult]}
              strokeWidth={2}
              strokeDasharray={TIER_DASH[mult]}
              dot={false}
              isAnimationActive={false}
            />,
            <Line
              key={`al${mult}`}
              dataKey={`alt${mult}`}
              stroke={ALT_COLOR}
              strokeOpacity={TIER_OPACITY[mult]}
              strokeWidth={2}
              strokeDasharray={TIER_DASH[mult]}
              dot={false}
              isAnimationActive={false}
            />,
          ])}
        </ComposedChart>
      </ResponsiveContainer>
    )
  }
})

export interface CrossingChartProps {
  /** The user's dialled size, USD — tiers render at ×1 / ×10 / ×100 of this. */
  amountUsd: number
}

export const CrossingChart: React.FC<CrossingChartProps> = ({ amountUsd }) => {
  const size = amountUsd > 0 ? amountUsd : 10_000

  const data = useMemo(
    () => buildCrossingSeries(EXIT_MODEL.chosen, EXIT_MODEL.alt, size, HORIZON_DAYS),
    [size],
  )
  const crossing = useMemo(
    () => crossingSizeUsd(EXIT_MODEL.chosen, EXIT_MODEL.alt, HORIZON_DAYS),
    [],
  )

  return (
    <Box>
      <SectionHeading
        index="04 /"
        title="The board's best yield, at your size and beyond"
        note={`${EXIT_MODEL.alt.name} vs ${EXIT_MODEL.chosen.name} · ${HORIZON_DAYS}d · value net of exit cost, % of principal`}
      />
      <Card p={SPACING.base}>
        <ChartBody data={data} />

        {/* Legend: venue by color, tier by dash/opacity */}
        <HStack spacing={SPACING.lg} mt={SPACING.sm} flexWrap="wrap">
          <HStack spacing={SPACING.sm}>
            <Box w="18px" h="2px" bg={ALT_COLOR} />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              {EXIT_MODEL.alt.name}
            </Text>
          </HStack>
          <HStack spacing={SPACING.sm}>
            <Box w="18px" h="2px" bg={CHOSEN_COLOR} />
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
              {EXIT_MODEL.chosen.name}
            </Text>
          </HStack>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
            solid {formatUSD(size)} · dashed ×10 · dotted ×100 · band = model cost range
          </Text>
        </HStack>

        {/* The takeaway, in dollars, gold-bordered (§6) */}
        {crossing !== null && (
          <Box
            mt={SPACING.md}
            p={SPACING.md}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.warning}
            borderRadius={0}
          >
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.warning}>
              Above ~{formatUSD(twoSigFigs(crossing))}, this ranking inverts — exit depth eats the spread.
            </Text>
          </Box>
        )}

        <HStack spacing={SPACING.sm} mt={SPACING.md} align="baseline">
          <MockStamp label="modelled" />
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.03em">
            {CROSSING_STAMP}
          </Text>
        </HStack>
      </Card>
    </Box>
  )
}

export default CrossingChart
