// Two equity curves over the measured window, drawn as inline SVG. No chart library.
//
// Both series come from the SAME price path, so any gap between the lines is the
// engine and nothing else. Gaps in the data stay gaps: a null minute breaks the line
// rather than being bridged.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import type { Comparison, SimEvent } from '@/lib/position-sim'

import Stamp from './Stamp'
import { usd, utcClock } from './format'

const W = 900
const H = 300
const PAD_L = 8
const PAD_R = 8
const PAD_T = 16
const PAD_B = 26
/** The window is 2,880 minutes; drawing every one is pointless at this width. */
const TARGET_POINTS = 480

interface Pt {
  x: number
  y: number
  i: number
}

/** Picks every nth minute so the polyline stays under TARGET_POINTS, keeping the last. */
function sample(series: (number | null)[]): { i: number; v: number | null }[] {
  const step = Math.max(1, Math.ceil(series.length / TARGET_POINTS))
  const out: { i: number; v: number | null }[] = []
  for (let i = 0; i < series.length; i += step) out.push({ i, v: series[i] })
  const last = series.length - 1
  if (out.length === 0 || out[out.length - 1].i !== last) out.push({ i: last, v: series[last] })
  return out
}

/** Splits into unbroken runs so null minutes leave a visible break in the line. */
function toRuns(series: (number | null)[], min: number, max: number, count: number): Pt[][] {
  const span = max - min || 1
  const runs: Pt[][] = []
  let run: Pt[] = []
  for (const { i, v } of sample(series)) {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    const x = PAD_L + ((W - PAD_L - PAD_R) * i) / Math.max(1, count - 1)
    const y = PAD_T + (H - PAD_T - PAD_B) * (1 - (v - min) / span)
    run.push({ x, y, i })
  }
  if (run.length) runs.push(run)
  return runs
}

const path = (run: Pt[]) =>
  run.map((p, k) => `${k === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

export interface EquityChartProps {
  comparison: Comparison
  /** Path start, for the axis labels. */
  startTs: number
  stepSeconds: number
}

export const EquityChart: React.FC<EquityChartProps> = ({ comparison, startTs, stepSeconds }) => {
  const { source, membrane } = comparison
  const count = Math.max(source.equitySeries.length, membrane.equitySeries.length)

  const finite = [...source.equitySeries, ...membrane.equitySeries].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  )
  const rawMin = finite.length ? Math.min(...finite) : 0
  const rawMax = finite.length ? Math.max(...finite) : 1
  // Always include zero so "equity went to nothing" is readable as a distance, not a
  // rescaled line that looks the same as a mild drawdown.
  const min = Math.min(0, rawMin)
  const max = Math.max(rawMax, min + 1)

  const srcRuns = toRuns(source.equitySeries, min, max, count)
  const memRuns = toRuns(membrane.equitySeries, min, max, count)

  const xOf = (i: number) => PAD_L + ((W - PAD_L - PAD_R) * i) / Math.max(1, count - 1)
  const yOf = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - min) / (max - min || 1))

  const zeroY = yOf(0)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (count - 1)))

  const markers = (run: typeof source, color: string) =>
    run.events.map((e: SimEvent, k: number) => (
      <line
        key={`${run.engine}-${k}`}
        x1={xOf(e.minute)}
        x2={xOf(e.minute)}
        y1={PAD_T}
        y2={H - PAD_B}
        stroke={color}
        strokeWidth={1}
        strokeDasharray="2 4"
        opacity={0.45}
      />
    ))

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.base}
      display="grid"
      gap={SPACING.md}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...eyebrow}>04 / equity through the window</Text>
        <Stamp provenance={comparison.source.provenance} />
      </Box>

      <Box display="flex" gap={SPACING.base} flexWrap="wrap">
        {[
          {
            label: comparison.position.label,
            color: SEMANTIC_COLORS.textPrimary,
            end: source.endEquityUsd,
          },
          { label: 'Membrane', color: SEMANTIC_COLORS.success, end: membrane.endEquityUsd },
        ].map((s) => (
          <Box key={s.label} display="flex" alignItems="center" gap={SPACING.sm}>
            <Box w="14px" h="2px" bg={s.color} />
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.textSecondary}
              {...tabular}
            >
              {s.label} · ends {usd(s.end)}
            </Text>
          </Box>
        ))}
      </Box>

      <Box
        as="svg"
        viewBox={`0 0 ${W} ${H}`}
        w="100%"
        h="auto"
        preserveAspectRatio="none"
        role="img"
        aria-label="Equity over the measured window for both liquidation engines"
        display="block"
      >
        {/* zero line — only drawn when zero is inside the plotted range */}
        {zeroY >= PAD_T && zeroY <= H - PAD_B && (
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={zeroY}
            y2={zeroY}
            stroke={SEMANTIC_COLORS.borderStrong}
            strokeWidth={1}
          />
        )}
        {ticks.map((i) => (
          <line
            key={`t${i}`}
            x1={xOf(i)}
            x2={xOf(i)}
            y1={PAD_T}
            y2={H - PAD_B}
            stroke={SEMANTIC_COLORS.borderSubtle}
            strokeWidth={1}
          />
        ))}
        {markers(source, SEMANTIC_COLORS.danger)}
        {markers(membrane, SEMANTIC_COLORS.success)}
        {srcRuns.map((r, k) => (
          <path
            key={`s${k}`}
            d={path(r)}
            fill="none"
            stroke={SEMANTIC_COLORS.textPrimary}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {memRuns.map((r, k) => (
          <path
            key={`m${k}`}
            d={path(r)}
            fill="none"
            stroke={SEMANTIC_COLORS.success}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </Box>

      <Box display="flex" justifyContent="space-between" gap={SPACING.sm}>
        {ticks.map((i) => (
          <Text key={`l${i}`} {...monoXs} {...tabular}>
            {utcClock(startTs + i * stepSeconds)}
          </Text>
        ))}
      </Box>

      <Text {...monoXs} lineHeight={1.7}>
        Dashed verticals mark liquidation, recall and cure events — blood for the source protocol,
        phosphor for Membrane. Both lines are priced off the same minute-by-minute oracle series, so
        the vertical distance between them is the engine, not the market. The y-axis includes zero,
        so a line reaching the base line is a position with nothing left.
      </Text>
    </Box>
  )
}

export default EquityChart
