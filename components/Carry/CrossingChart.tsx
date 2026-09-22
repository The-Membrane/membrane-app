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
// Venue identity only. Good/bad is carried by the SIGN colouring of every number and
// the zero line, never by the venue hue (owner 2026-09-22).
const CHOSEN_COLOR = SEMANTIC_COLORS.primary
const ALT_COLOR = SEMANTIC_COLORS.textPrimary
const TIER_OPACITY: Record<number, number> = { 1: 1.0, 10: 0.72, 100: 0.5 }
const TIER_DASH: Record<number, string | undefined> = { 1: undefined, 10: '6 3', 100: '2 3' }
const BAND_OPACITY = 0.24

interface ChartBodyProps {
  data: CrossingPoint[]
  sizeUsd: number
  altName: string
  chosenName: string
}

const ChartBody = lazyChart<ChartBodyProps>((RC) => {
  const { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Area, Line, Tooltip, ReferenceLine, ReferenceArea } = RC
  return function CrossingChartBody({ data, sizeUsd, altName, chosenName }: ChartBodyProps) {
    // Hover: the day, then per tier (your size, ×10, ×100) what each venue leaves you
    // after exit costs, with the model's cost range in brackets. Numbers only.
    const HoverCard = ({ active, payload, label }: { active?: boolean; payload?: any[]; label?: number }) => {
      if (!active || !payload?.length) return null
      const p = payload[0]?.payload as CrossingPoint | undefined
      if (!p) return null
      const pct = (v: unknown) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
      const signColor = (v: unknown) => (Number(v) >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger)
      const Row = ({ name, color, mid, band: b }: { name: string; color: string; mid: unknown; band: unknown }) => (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: 12, alignItems: 'baseline' }}>
          <span style={{ color }}>{name}</span>
          <span style={{ color: signColor(mid), fontWeight: 600 }}>{pct(mid)}</span>
          <span style={{ color: SEMANTIC_COLORS.textTertiary, fontSize: 10 }}>{band(b).trim()}</span>
        </div>
      )
      const band = (b: unknown) => (Array.isArray(b) ? ` [${Number(b[0]).toFixed(1)} … ${Number(b[1]).toFixed(1)}]` : '')
      return (
        <div style={{ ...(CHART_THEME.tooltip.contentStyle as object), padding: '10px 12px', fontFamily: TYPOGRAPHY.fontMono, fontSize: 11 }}>
          <div style={{ color: SEMANTIC_COLORS.textSecondary, letterSpacing: '0.14em', textTransform: 'uppercase', fontSize: 9, marginBottom: 6 }}>
            day {label} · kept after exit costs
          </div>
          {CROSSING_TIERS.map((mult) => (
            <div key={mult} style={{ marginBottom: 6 }}>
              <div style={{ color: SEMANTIC_COLORS.textTertiary, fontSize: 9, letterSpacing: '0.1em' }}>
                {mult === 1 ? 'your size' : `×${mult}`} · {formatUSD(sizeUsd * mult)}
              </div>
              <Row name={altName.split(' · ')[0]} color={ALT_COLOR} mid={p[`alt${mult}`]} band={p[`altBand${mult}`]} />
              <Row name={chosenName.split(' · ')[0]} color={CHOSEN_COLOR} mid={p[`chosen${mult}`]} band={p[`chosenBand${mult}`]} />
            </div>
          ))}
        </div>
      )
    }
    return (
      <ResponsiveContainer width="100%" height={CHART_DIMENSIONS.heights.md}>
        <ComposedChart data={data} margin={CHART_DIMENSIONS.margins.default}>
          <CartesianGrid {...CHART_THEME.grid} />
          {/* Good/bad cue on the chart: a faint blood wash below zero and a zero line. */}
          <ReferenceArea y1={-1000} y2={0} fill={SEMANTIC_COLORS.danger} fillOpacity={0.06} strokeOpacity={0} ifOverflow="hidden" />
          <ReferenceLine y={0} stroke={SEMANTIC_COLORS.success} strokeOpacity={0.6} strokeWidth={1} label={{ value: 'ahead ↑ · behind ↓', position: 'insideTopRight', fill: SEMANTIC_COLORS.textTertiary, fontSize: 9, fontFamily: TYPOGRAPHY.fontMono }} />
          <Tooltip content={<HoverCard />} cursor={{ stroke: SEMANTIC_COLORS.borderStrong, strokeWidth: 1 }} />
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
        title="Where the higher yield stops paying"
        note={`${EXIT_MODEL.alt.name} vs ${EXIT_MODEL.chosen.name} · what you keep after exit costs, over ${HORIZON_DAYS} days, at your size, ×10 and ×100`}
      />
      <Card p={SPACING.base}>
        <ChartBody data={data} sizeUsd={size} altName={EXIT_MODEL.alt.name} chosenName={EXIT_MODEL.chosen.name} />

        {/* Legend: what the axes are, then the two venues, then the three sizes. */}
        <Box mt={SPACING.sm} display="grid" gap={SPACING.xs}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
            Each line: what a deposit is worth after paying to exit, as % of what you put in, day by
            day. Above zero you are ahead; the shaded band is the model’s cost range. Hover for numbers.
          </Text>
          <HStack spacing={SPACING.lg} flexWrap="wrap">
            <HStack spacing={SPACING.sm}>
              <Box w="18px" h="2px" bg={ALT_COLOR} />
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                {EXIT_MODEL.alt.name} — higher yield, thinner exit
              </Text>
            </HStack>
            <HStack spacing={SPACING.sm}>
              <Box w="18px" h="2px" bg={CHOSEN_COLOR} />
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
                {EXIT_MODEL.chosen.name} — lower yield, deeper exit
              </Text>
            </HStack>
          </HStack>
          <HStack spacing={SPACING.lg} flexWrap="wrap">
            {CROSSING_TIERS.map((mult) => (
              <HStack key={mult} spacing={SPACING.sm}>
                <Box w="18px" h="0" borderTop="2px" borderStyle={mult === 1 ? 'solid' : mult === 10 ? 'dashed' : 'dotted'} borderColor={SEMANTIC_COLORS.textSecondary} />
                <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
                  {mult === 1 ? 'your size' : `×${mult}`} · {formatUSD(size * mult)}
                </Text>
              </HStack>
            ))}
          </HStack>
        </Box>

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
              Past ~{formatUSD(twoSigFigs(crossing))} the cheaper venue wins: the higher yield costs more to leave than it pays.
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
