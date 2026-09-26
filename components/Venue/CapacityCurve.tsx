import React, { useMemo, useState } from 'react'
import { Box, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { Card } from '@/components/ui/Card'
import { lazyChart } from '@/components/ui/lazyChart'
import { Eyebrow, Stamp } from '@/components/Carry/atoms'
import { fmtUsd } from '@/components/Radar/radarLogic'
import { CHART_DIMENSIONS, CHART_THEME } from '@/config/chartTheme'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  CAPACITY_PRESETS_PCT,
  CAPACITY_SLIDER_MAX_PCT,
  CAPACITY_SLIDER_MIN_PCT,
  SLIDER_STEPS,
  capacityAt,
  costAtSize,
  costToSlider,
  sliderToCost,
  type CapacityCurveResponse,
  type CapacityReading,
  type CurvePoint,
} from '@/lib/venueCapacity/capacityCurve'

// SWAP-OUT CAPACITY — owner ask 2026-09-26: "Is swap-out depth 1:1? Show the
// capacity as a cost range that includes fees." One component, two variants:
//   full    — the venue page: line chart (x = max cost incl. fees, log scale;
//             y = exit capacity), area under the line filled, the 0.5/1/5% points
//             marked, the bracket between quoted points drawn as a band (the true
//             curve lies inside it — interpolation is a guess, the band says how
//             big a guess), then the text row + lever + provenance.
//   compact — Radar rows and the landing capacity card: the text row + lever,
//             and (with sizeUsd) the cost of exiting THAT size.
// Every number is an on-chain quote from /api/venues/[venue]/capacity-curve.

const LINE = SEMANTIC_COLORS.primary // phosphor: the measured capacity
const BAND = SEMANTIC_COLORS.info // teal: informational bracket
const MARK = SEMANTIC_COLORS.warning // gold: the preset markers

export const useCapacityCurve = (venue: string | null | undefined) =>
  useQuery<CapacityCurveResponse>({
    queryKey: ['capacity_curve', venue],
    enabled: !!venue,
    queryFn: async () => {
      const r = await fetch(`/api/venues/${encodeURIComponent(venue!)}/capacity-curve`)
      if (!r.ok) throw new Error(`capacity curve ${r.status}`)
      return r.json()
    },
    staleTime: 1000 * 60 * 5,
    refetchOnMount: true,
  })

const fmtPct = (c: number): string => `${Number(c.toPrecision(2))}%`

/** "$X" for a quoted reading, "≈$X (interpolated)" between quotes, a reason otherwise. */
export const readingText = (r: CapacityReading): string => {
  if (r.kind === 'quoted') return fmtUsd(r.capacityUsd)
  if (r.kind === 'interpolated') return `≈${fmtUsd(r.capacityUsd)} (interpolated)`
  if (r.kind === 'below-range') return 'below the first quote'
  if (r.kind === 'beyond-range') return 'past the last quote'
  return 'no quote'
}

const provenanceLine = (curve: NonNullable<CapacityCurveResponse['curve']>): string => {
  const sources = Array.from(new Set(curve.markets.map((m) => m.source).filter(Boolean)))
    .map((s) => (s === 'curve get_dy' ? 'Curve get_dy' : s === 'psm tout' ? 'PSM tout' : s))
    .join(' / ')
  return `on-chain quotes (${sources || 'none'}) · block ${curve.block.toLocaleString('en-US')} · ${curve.observedAt.slice(0, 10)}`
}

const feeLine = (m: NonNullable<CapacityCurveResponse['curve']>['markets'][number]): string =>
  m.feeBps == null ? 'fee not read' : m.source === 'psm tout' ? `PSM tout ${Number(m.feeBps.toPrecision(2))} bp` : `pool fee ${Number(m.feeBps.toPrecision(2))} bp, inside get_dy`

type ChartDatum = { c: number; cap: number | null; band: [number, number] | null }

/** Dense log-spaced samples so linear-in-cost interpolation draws true on a log axis. */
function sample(points: CurvePoint[]): ChartDatum[] {
  const q = points.filter((p) => p.capacityUsd !== null).sort((a, b) => a.costPct - b.costPct)
  if (q.length === 0) return []
  const lo = q[0].costPct
  const hi = q[q.length - 1].costPct
  const out: ChartDatum[] = []
  const N = 120
  for (let k = 0; k <= N; k++) {
    const c = lo * (hi / lo) ** (k / N)
    const r = capacityAt(points, c)
    out.push({
      c,
      cap: r.capacityUsd,
      band: r.kind === 'interpolated' ? [r.lowerUsd, r.upperUsd] : r.kind === 'quoted' ? [r.capacityUsd, r.capacityUsd] : null,
    })
  }
  for (const p of q) out.push({ c: p.costPct, cap: p.capacityUsd, band: [p.capacityUsd!, p.capacityUsd!] })
  return out.sort((a, b) => a.c - b.c)
}

type ChartProps = { points: CurvePoint[]; costPct: number }

const CurveChart = lazyChart<ChartProps>((RC) => {
  const { ResponsiveContainer, ComposedChart, CartesianGrid, XAxis, YAxis, Area, ReferenceLine, ReferenceDot, Tooltip } = RC
  return function CapacityCurveChart({ points, costPct }: ChartProps) {
    const data = useMemo(() => sample(points), [points])
    const ticks = points.map((p) => p.costPct)
    const presets = CAPACITY_PRESETS_PCT.map((c) => ({ c, r: capacityAt(points, c) })).filter((x) => x.r.capacityUsd !== null)
    const HoverCard = ({ active, payload }: { active?: boolean; payload?: any[] }) => {
      if (!active || !payload?.length) return null
      const d = payload[0]?.payload as ChartDatum | undefined
      if (!d) return null
      const r = capacityAt(points, d.c)
      return (
        <div style={{ ...(CHART_THEME.tooltip.contentStyle as object), padding: '8px 10px', fontFamily: TYPOGRAPHY.fontMono, fontSize: 11 }}>
          <div style={{ color: SEMANTIC_COLORS.textSecondary, fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            within {fmtPct(d.c)} cost incl. fees
          </div>
          <div style={{ color: SEMANTIC_COLORS.textPrimary }}>{readingText(r)}</div>
          {r.kind === 'interpolated' && (
            <div style={{ color: SEMANTIC_COLORS.textTertiary, fontSize: 10 }}>
              quoted: {fmtUsd(r.lowerUsd)} at {fmtPct(r.fromPct)} · {fmtUsd(r.upperUsd)} at {fmtPct(r.toPct)}
            </div>
          )}
        </div>
      )
    }
    return (
      <ResponsiveContainer width="100%" height={CHART_DIMENSIONS.heights.sm}>
        <ComposedChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid {...CHART_THEME.grid} />
          <XAxis
            {...CHART_THEME.xAxis}
            dataKey="c"
            type="number"
            scale="log"
            domain={[ticks[0] ?? CAPACITY_SLIDER_MIN_PCT, ticks[ticks.length - 1] ?? CAPACITY_SLIDER_MAX_PCT]}
            ticks={ticks}
            interval={0}
            allowDataOverflow
            tickFormatter={(c: number) => `${c}%`}
            tick={{ ...CHART_THEME.xAxis.tick, fontFamily: TYPOGRAPHY.fontMono }}
          />
          <YAxis
            {...CHART_THEME.yAxis}
            tickFormatter={(v: number) => fmtUsd(v)}
            width={52}
            domain={[0, 'auto']}
            tick={{ ...CHART_THEME.yAxis.tick, fontFamily: TYPOGRAPHY.fontMono }}
          />
          <Tooltip content={<HoverCard />} cursor={{ stroke: SEMANTIC_COLORS.borderStrong, strokeWidth: 1 }} />
          {/* The bracket between quotes: the true curve is somewhere inside it. */}
          <Area dataKey="band" stroke="none" fill={BAND} fillOpacity={0.16} isAnimationActive={false} connectNulls={false} />
          {/* Capacity: area under the line, flat fill (BRAND_CHARTS §3). */}
          <Area dataKey="cap" stroke={LINE} strokeWidth={2} fill={LINE} fillOpacity={0.3} dot={false} isAnimationActive={false} connectNulls={false} />
          {presets.map(({ c, r }) => (
            <ReferenceDot key={`p${c}`} x={c} y={r.capacityUsd as number} r={3} fill={MARK} stroke="none" ifOverflow="visible" />
          ))}
          <ReferenceLine x={costPct} stroke={SEMANTIC_COLORS.textPrimary} strokeOpacity={0.5} strokeDasharray="2 3" ifOverflow="hidden" />
        </ComposedChart>
      </ResponsiveContainer>
    )
  }
}, `${CHART_DIMENSIONS.heights.sm}px`)

const Mono: React.FC<{ children: React.ReactNode; color?: string; size?: string; mt?: string | number }> = ({ children, color, size = '11px', mt }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={size} color={color ?? SEMANTIC_COLORS.textSecondary} mt={mt} sx={{ fontVariantNumeric: 'tabular-nums' }}>
    {children}
  </Text>
)

/** "0.5% → $X · 1% → $Y · 5% → $Z" */
export const PresetRow: React.FC<{ points: CurvePoint[]; size?: string }> = ({ points, size }) => (
  <Mono color={SEMANTIC_COLORS.textPrimary} size={size}>
    {CAPACITY_PRESETS_PCT.map((c) => `${c}% → ${readingText(capacityAt(points, c))}`).join(' · ')}
  </Mono>
)

const Lever: React.FC<{ points: CurvePoint[]; costPct: number; onChange: (c: number) => void; size?: string }> = ({ points, costPct, onChange, size }) => {
  const r = capacityAt(points, costPct)
  const levels = points.map((p) => p.costPct)
  return (
    <Box mt={SPACING.sm}>
      <Slider
        aria-label="maximum exit cost including fees"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={costToSlider(costPct)}
        onChange={(s) => onChange(sliderToCost(s, levels))}
      >
        <SliderTrack bg={SEMANTIC_COLORS.borderMedium} borderRadius={0}>
          <SliderFilledTrack bg={LINE} />
        </SliderTrack>
        <SliderThumb borderRadius={0} />
      </Slider>
      <Mono size={size}>
        within {fmtPct(costPct)} cost → {readingText(r)}
        {r.kind === 'interpolated' ? ` · between ${fmtUsd(r.lowerUsd)} (${fmtPct(r.fromPct)}) and ${fmtUsd(r.upperUsd)} (${fmtPct(r.toPct)}), both quoted` : ''}
      </Mono>
    </Box>
  )
}

/** The cost of exiting `sizeUsd` in one go, read off the curve — never extrapolated. */
export const YourSizeLine: React.FC<{ points: CurvePoint[]; sizeUsd: number; size?: string }> = ({ points, sizeUsd, size }) => {
  const r = costAtSize(points, sizeUsd)
  const text =
    r.kind === 'within-first'
      ? `≤ ${fmtPct(r.atMostPct)} cost (quoted)`
      : r.kind === 'quoted'
        ? `${fmtPct(r.costPct)} cost (quoted)`
        : r.kind === 'interpolated'
          ? `≈${fmtPct(r.costPct)} cost (interpolated, between ${fmtPct(r.fromPct)} and ${fmtPct(r.toPct)})`
          : r.kind === 'beyond-quoted-depth'
            ? `beyond quoted depth (last quote ${fmtUsd(r.lastQuotedUsd)} at ${fmtPct(r.lastQuotedPct)})`
            : 'no quote'
  return (
    <Mono size={size} color={r.kind === 'beyond-quoted-depth' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}>
      exit your {fmtUsd(sizeUsd)} in one swap: {text}
    </Mono>
  )
}

export interface CapacityCurveProps {
  venue: string
  variant?: 'full' | 'compact'
  /** A holder's own size, USD: adds the cost of exiting it. */
  sizeUsd?: number
}

export const CapacityCurve: React.FC<CapacityCurveProps> = ({ venue, variant = 'full', sizeUsd }) => {
  const { data, isLoading } = useCapacityCurve(venue)
  const [costPct, setCostPct] = useState<number>(1)
  const curve = data?.curve ?? null

  if (variant === 'compact') {
    if (!curve) return null // no swap market recorded (e.g. a lending reserve): nothing to add
    return (
      <Box data-testid="capacity-curve-compact" mt={SPACING.sm}>
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          swap-out capacity · cost incl. fees
        </Mono>
        <PresetRow points={curve.points} size="11px" />
        {sizeUsd != null && sizeUsd > 0 && <YourSizeLine points={curve.points} sizeUsd={sizeUsd} size="11px" />}
        <Lever points={curve.points} costPct={costPct} onChange={setCostPct} size="10px" />
        <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
          {provenanceLine(curve)}
        </Mono>
      </Box>
    )
  }

  return (
    <Card variant="default" p={SPACING.base} mt={SPACING.base}>
      <Eyebrow>swap-out capacity · what exits within a cost, fees included</Eyebrow>
      {!curve ? (
        <Mono mt={SPACING.sm}>
          {isLoading ? '' : 'No quoted exit curve for this venue — it has no recorded swap market (a lending reserve exits through its instant liquidity above).'}
        </Mono>
      ) : (
        <>
          <Box mt={SPACING.sm}>
            <CurveChart points={curve.points} costPct={costPct} />
          </Box>
          <Mono size="10px" color={SEMANTIC_COLORS.textTertiary}>
            x = max cost incl. fees (log) · y = exit capacity · gold = 0.5 / 1 / 5% · teal band = range between quotes
          </Mono>
          <Box mt={SPACING.sm}>
            <PresetRow points={curve.points} size="13px" />
          </Box>
          {sizeUsd != null && sizeUsd > 0 && <YourSizeLine points={curve.points} sizeUsd={sizeUsd} />}
          <Lever points={curve.points} costPct={costPct} onChange={setCostPct} />
          <Box mt={SPACING.sm}>
            {curve.markets.map((m) => (
              <Mono key={m.market} size="11px">
                {m.route ?? m.market}
                {m.error ? ` · read failed: ${m.error}` : ` · ${feeLine(m)} · raw reserve ${m.reserveUsd != null ? fmtUsd(m.reserveUsd) : '—'}`}
              </Mono>
            ))}
          </Box>
          <Stamp>
            {provenanceLine(curve)}. Cost = 1 − received ÷ (tokens × redemption value). The raw reserve is a ceiling, not an exit at par.
            {curve.markets.length > 1 ? ' Markets are independent pools, so their capacities add at each cost.' : ''}
          </Stamp>
        </>
      )}
    </Card>
  )
}

export default CapacityCurve
