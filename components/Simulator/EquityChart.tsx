// Two equity curves over the measured window, drawn as inline SVG. No chart library.
//
// Both series come from the SAME price path, so any gap between the lines is the
// engine and nothing else. Gaps in the data stay gaps: a null minute breaks the line
// rather than being bridged.
//
// The landing at `/` (components/Landing) mounts this as its one double-line chart and
// passes the optional layers below: event marks with glyphs (DESIGN_RULES §2), amber
// armed-window bands, size-skew ghost lines and forecast ticks. With none of them passed
// the chart renders exactly as it always has.

import React, { useId } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import type { Comparison, SimEvent } from '@/lib/position-sim'

import { equityRange, makeScales, pathD, toRuns, type ChartBox } from './chartGeometry'

import Stamp from './Stamp'
import { usd, utcClock } from './format'

const BOX: ChartBox = { w: 900, h: 300, padL: 8, padR: 8, padT: 16, padB: 26 }
const W = BOX.w
const H = BOX.h
const PAD_L = BOX.padL
const PAD_R = BOX.padR
const PAD_T = BOX.padT
const PAD_B = BOX.padB
/** The window is 2,880 minutes; drawing every one is pointless at this width. */
const TARGET_POINTS = 480

export interface ChartMark {
  minute: number
  engine: 'venue' | 'membrane'
  tone: 'sold' | 'armed' | 'cleared' | 'recalled'
  glyph: string
  label: string
}

export interface ChartGhost {
  key: string
  /** On-chart label, e.g. "10× size, per 1×". */
  label: string
  venue: (number | null)[]
  membrane: (number | null)[]
}

export interface ChartBand {
  start: number
  end: number
  label?: string
}

export interface ChartTick {
  minute: number
  /** Short label drawn above the axis, e.g. a forecast reading. */
  text: string
}

export interface EquityChartProps {
  comparison: Comparison
  /** Path start, for the axis labels. */
  startTs: number
  stepSeconds: number
  /** Eyebrow over the chart. Defaults to the simulator's own. */
  title?: string
  /** Replaces the dashed event verticals with glyph marks labelled on the chart. */
  marks?: ChartMark[]
  /** Amber bands: minutes the Membrane 8h window was armed. */
  bands?: ChartBand[]
  /** Size-skew ghost lines, drawn per 1× on the same axis. */
  ghosts?: ChartGhost[]
  /** Forecast readings, drawn as ink ticks. */
  ticks?: ChartTick[]
  /** Replaces the default caption. `null` hides it. */
  caption?: React.ReactNode | null
  /** Hide the outer card (the landing draws its own rules). */
  bare?: boolean
}

const toneColor = (t: ChartMark['tone']) =>
  t === 'sold' ? SEMANTIC_COLORS.danger : t === 'armed' ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.success

export const EquityChart: React.FC<EquityChartProps> = ({
  comparison,
  startTs,
  stepSeconds,
  title = '04 / equity through the window',
  marks,
  bands,
  ghosts,
  ticks,
  caption,
  bare = false,
}) => {
  const { source, membrane } = comparison
  const count = Math.max(source.equitySeries.length, membrane.equitySeries.length)
  const hatchId = `armed-${useId().replace(/:/g, '')}`

  // Zero is always inside the range (chartGeometry.equityRange), so a line reaching the
  // base line reads as a position with nothing left rather than a mild drawdown.
  const range = equityRange(
    source.equitySeries,
    membrane.equitySeries,
    ...(ghosts ?? []).flatMap((g) => [g.venue, g.membrane]),
  )
  const scales = makeScales(BOX, count, range.min, range.max)
  const { xOf, yOf } = scales

  const srcRuns = toRuns(source.equitySeries, scales, TARGET_POINTS)
  const memRuns = toRuns(membrane.equitySeries, scales, TARGET_POINTS)

  const zeroY = yOf(0)
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (count - 1)))

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

  /** The y of a series at a minute, for placing a glyph on its own line. */
  const yAt = (series: (number | null)[], i: number): number => {
    for (let k = Math.min(i, series.length - 1); k >= 0; k--) {
      const v = series[k]
      if (v !== null && Number.isFinite(v)) return yOf(v)
    }
    return yOf(0)
  }

  const defaultCaption = (
    <Text {...monoXs} lineHeight={1.7}>
      Dashed verticals mark liquidation, recall and cure events — blood for the source protocol,
      phosphor for Membrane. Both lines are priced off the same minute-by-minute oracle series, so
      the vertical distance between them is the engine, not the market. The y-axis includes zero,
      so a line reaching the base line is a position with nothing left.
    </Text>
  )

  const endSrc = yAt(source.equitySeries, count - 1)
  const endMem = yAt(membrane.equitySeries, count - 1)
  // Labels on the chart, not a legend (DESIGN_RULES §6). Pushed apart when the ends meet.
  const labelGap = 7
  const [srcLabelY, memLabelY] =
    Math.abs(endSrc - endMem) < labelGap
      ? endSrc <= endMem
        ? [endSrc - labelGap / 2, endMem + labelGap / 2]
        : [endSrc + labelGap / 2, endMem - labelGap / 2]
      : [endSrc, endMem]

  return (
    <Box
      bg={bare ? undefined : SEMANTIC_COLORS.bgSecondary}
      border={bare ? undefined : '1px solid'}
      borderColor={bare ? undefined : SEMANTIC_COLORS.borderSubtle}
      p={bare ? 0 : SPACING.base}
      display="grid"
      gridTemplateColumns="minmax(0, 1fr)"
      gap={SPACING.md}
      minW={0}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...eyebrow}>{title}</Text>
        <Box minW={0} maxW="100%" overflow="hidden" sx={{ '& *': { whiteSpace: 'normal', maxWidth: '100%' } }}>
          <Stamp provenance={comparison.source.provenance} />
        </Box>
      </Box>

      {!marks && (
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
      )}

      <Box position="relative" minW={0}>
        <Box
          as="svg"
          viewBox={`0 0 ${W} ${H}`}
          w="100%"
          h={marks ? { base: '220px', md: 'auto' } : 'auto'}
          preserveAspectRatio="none"
          role="img"
          aria-label="Equity over the measured window for both liquidation engines"
          display="block"
        >
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke={SEMANTIC_COLORS.warning} strokeWidth="1" opacity="0.35" />
            </pattern>
          </defs>
          {(bands ?? []).map((b, k) => (
            <rect
              key={`band-${k}`}
              data-testid="chart-armed-band"
              x={xOf(b.start)}
              y={PAD_T}
              width={Math.max(1, xOf(b.end) - xOf(b.start))}
              height={H - PAD_T - PAD_B}
              fill={`url(#${hatchId})`}
            />
          ))}
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
          {axisTicks.map((i) => (
            <line
              key={`t${i}`}
              x1={xOf(i)}
              x2={xOf(i)}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke={SEMANTIC_COLORS.borderSubtle}
              strokeWidth={1}
              strokeDasharray={marks ? '1 3' : undefined}
            />
          ))}
          {!marks && markers(source, SEMANTIC_COLORS.danger)}
          {!marks && markers(membrane, SEMANTIC_COLORS.success)}
          {(ghosts ?? []).flatMap((g) =>
            [
              { s: g.venue, c: SEMANTIC_COLORS.textSecondary, k: 'v' },
              { s: g.membrane, c: SEMANTIC_COLORS.success, k: 'm' },
            ].flatMap(({ s, c, k }) =>
              toRuns(s, scales, TARGET_POINTS).map((r, j) => (
                <path
                  key={`g-${g.key}-${k}-${j}`}
                  data-testid="chart-ghost"
                  d={pathD(r)}
                  fill="none"
                  stroke={c}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.5}
                  vectorEffect="non-scaling-stroke"
                />
              )),
            ),
          )}
          {(ticks ?? []).map((t, k) => (
            <line
              key={`ft-${k}`}
              x1={xOf(t.minute)}
              x2={xOf(t.minute)}
              y1={H - PAD_B - 8}
              y2={H - PAD_B}
              stroke={SEMANTIC_COLORS.textSecondary}
              strokeWidth={1}
            />
          ))}
          {srcRuns.map((r, k) => (
            <path
              key={`s${k}`}
              d={pathD(r)}
              fill="none"
              stroke={SEMANTIC_COLORS.textPrimary}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {memRuns.map((r, k) => (
            <path
              key={`m${k}`}
              d={pathD(r)}
              fill="none"
              stroke={SEMANTIC_COLORS.success}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </Box>

        {/* HTML overlay: glyphs and labels stay crisp, since the SVG stretches. */}
        {marks &&
          marks.map((m, k) => {
            const series = m.engine === 'venue' ? source.equitySeries : membrane.equitySeries
            const left = (xOf(m.minute) / W) * 100
            const top = (yAt(series, m.minute) / H) * 100
            return (
              <Text
                key={`mk-${k}`}
                as="span"
                data-testid={`chart-mark-${m.engine}-${m.tone}`}
                title={m.label}
                aria-label={m.label}
                position="absolute"
                left={`${left}%`}
                top={`${top}%`}
                transform="translate(-50%, -50%)"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="12px"
                lineHeight={1}
                color={toneColor(m.tone)}
                pointerEvents="auto"
              >
                {m.glyph}
              </Text>
            )
          })}
        {marks && (
          <>
            <Text
              as="span"
              position="absolute"
              right={0}
              top={`${(srcLabelY / H) * 100}%`}
              transform="translateY(-120%)"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.textPrimary}
              bg={bare ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.bgSecondary}
              px={SPACING.xs}
              {...tabular}
            >
              {comparison.position.label} · {usd(source.endEquityUsd)}
            </Text>
            <Text
              as="span"
              position="absolute"
              right={0}
              top={`${(memLabelY / H) * 100}%`}
              transform={memLabelY >= srcLabelY ? 'translateY(20%)' : 'translateY(-120%)'}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.success}
              bg={bare ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.bgSecondary}
              px={SPACING.xs}
              {...tabular}
            >
              Membrane (simulator) · {usd(membrane.endEquityUsd)}
            </Text>
          </>
        )}
      </Box>

      <Box display="flex" justifyContent="space-between" gap={SPACING.sm}>
        {axisTicks.map((i, k) => (
          <Text
            key={`l${i}`}
            {...monoXs}
            {...tabular}
            textAlign={k === axisTicks.length - 1 ? 'right' : undefined}
            display={k % 2 === 1 ? { base: 'none', md: 'block' } : undefined}
          >
            {utcClock(startTs + i * stepSeconds)}
          </Text>
        ))}
      </Box>

      {caption === undefined ? defaultCaption : caption}
    </Box>
  )
}

export default EquityChart
