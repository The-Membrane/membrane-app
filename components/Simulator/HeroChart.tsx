// THE HERO GRAPHIC.
//
// The same two equity curves EquityChart draws (shared scales — chartGeometry.ts), but
// drawn left→right on mount so the eye is caught by the divergence rather than by a
// paragraph. The source line goes first; Membrane follows 250ms behind, so the gap
// opens in front of you.
//
// Nothing here is decorative-only: every stroke and dot is a value out of the run. If
// the run has no data the frame renders empty and says nothing.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import type { Comparison, SimEvent } from '@/lib/position-sim'

import { equityRange, makeScales, pathD, toRuns, type ChartBox } from './chartGeometry'
import { fmtLocalDayClock, useLocalZone } from './localClock'

const BOX: ChartBox = { w: 560, h: 320, padL: 46, padR: 14, padT: 18, padB: 28 }
const PLOT_W = BOX.w - BOX.padL - BOX.padR
/** 2,880 minutes is more than this width can resolve. */
const TARGET_POINTS = 360
const DRAW_MS = 2600
const MEMBRANE_DELAY_MS = 250

const CSS = `
@keyframes simHeroDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes simHeroFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes simHeroPulse { 0% { opacity: 0.18; } 50% { opacity: 0.6; } 100% { opacity: 0.18; } }
`

/** Equity in $k, which is how the y-axis is labelled. */
const kUsd = (v: number): string => {
  const sign = v < 0 ? '−' : ''
  const a = Math.abs(v)
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 100_000 ? 0 : 1)}k`
  return `${sign}$${Math.round(a)}`
}

/** "10 Oct, 12:00 AM PDT" for the outer ticks, "12:00 PM" for the inner one — the
 *  reader's own zone (UTC until mounted), matching the hero's clock. */
const tickLabel = (ts: number, withDay: boolean, zone: string | undefined): string => {
  if (!withDay) {
    return new Date(ts * 1000)
      .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone })
      .replace(/\u202f/g, ' ')
  }
  return fmtLocalDayClock(ts, zone)
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export interface HeroChartProps {
  /** Null while the measured price path is still loading. */
  comparison: Comparison | null
  startTs: number | null
  stepSeconds: number | null
  isDemo: boolean
}

export const HeroChart: React.FC<HeroChartProps> = ({
  comparison,
  startTs,
  stepSeconds,
  isDemo,
}) => {
  const reduced = usePrefersReducedMotion()
  const zone = useLocalZone()

  // Remounts the drawn group whenever a new run lands, so the draw replays for the new
  // numbers instead of showing them already finished.
  const [runId, setRunId] = React.useState(0)
  React.useEffect(() => setRunId((n) => n + 1), [comparison])

  const geo = React.useMemo(() => {
    if (!comparison) return null
    const { source, membrane } = comparison
    const count = Math.max(source.equitySeries.length, membrane.equitySeries.length)
    if (count === 0) return null
    const { min, max } = equityRange(source.equitySeries, membrane.equitySeries)
    const scales = makeScales(BOX, count, min, max)
    return {
      count,
      min,
      max,
      scales,
      srcRuns: toRuns(source.equitySeries, scales, TARGET_POINTS),
      memRuns: toRuns(membrane.equitySeries, scales, TARGET_POINTS),
    }
  }, [comparison])

  const drawStyle = (delayMs: number): React.CSSProperties | undefined =>
    reduced
      ? undefined
      : {
          animation: `simHeroDraw ${DRAW_MS}ms ease-out both`,
          animationDelay: `${delayMs}ms`,
        }

  const dotStyle = (x: number, delayMs: number): React.CSSProperties | undefined => {
    if (reduced) return undefined
    const frac = Math.min(1, Math.max(0, (x - BOX.padL) / PLOT_W))
    return {
      animation: 'simHeroFade 320ms ease-out both',
      animationDelay: `${Math.round(delayMs + DRAW_MS * frac)}ms`,
    }
  }

  const dots = (
    series: (number | null)[],
    events: SimEvent[],
    kinds: SimEvent['kind'][],
    color: string,
    delayMs: number,
    tag: string,
  ) => {
    if (!geo) return null
    return events
      .filter((e) => kinds.includes(e.kind))
      .map((e, k) => {
        const v = series[e.minute]
        if (v === null || v === undefined || !Number.isFinite(v)) return null
        const x = geo.scales.xOf(e.minute)
        return (
          <circle
            key={`${tag}-${k}`}
            cx={x}
            cy={geo.scales.yOf(v)}
            r={3.5}
            fill={color}
            stroke={SEMANTIC_COLORS.bgSecondary}
            strokeWidth={1}
            style={dotStyle(x, delayMs)}
          />
        )
      })
  }

  const yTicks = geo ? [geo.max, (geo.max + geo.min) / 2, geo.min] : []
  const xTicks = geo ? [0, Math.round((geo.count - 1) / 2), geo.count - 1] : []

  return (
    <Box display="grid" gap={SPACING.sm} alignContent="start">
      <Box
        position="relative"
        bg={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        {isDemo && (
          <Text
            position="absolute"
            top={SPACING.sm}
            right={SPACING.sm}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="9px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.warning}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.warning}
            px={SPACING.sm}
            py="2px"
            pointerEvents="none"
          >
            worked example
          </Text>
        )}
        <Box
          as="svg"
          viewBox={`0 0 ${BOX.w} ${BOX.h}`}
          w="100%"
          h="auto"
          display="block"
          role="img"
          aria-label={
            comparison
              ? `Equity through the measured window for ${comparison.position.label} and Membrane`
              : 'Equity chart loading'
          }
        >
          <style>{CSS}</style>

          {/* frame */}
          <line
            x1={BOX.padL}
            x2={BOX.padL}
            y1={BOX.padT}
            y2={BOX.h - BOX.padB}
            stroke={SEMANTIC_COLORS.borderStrong}
            strokeWidth={1}
          />
          <line
            x1={BOX.padL}
            x2={BOX.w - BOX.padR}
            y1={BOX.h - BOX.padB}
            y2={BOX.h - BOX.padB}
            stroke={SEMANTIC_COLORS.borderStrong}
            strokeWidth={1}
          />

          {!geo ? (
            /* loading — an empty frame with a breathing baseline, and no words */
            <line
              x1={BOX.padL}
              x2={BOX.w - BOX.padR}
              y1={(BOX.padT + BOX.h - BOX.padB) / 2}
              y2={(BOX.padT + BOX.h - BOX.padB) / 2}
              stroke={SEMANTIC_COLORS.success}
              strokeWidth={1}
              style={
                reduced
                  ? { opacity: 0.3 }
                  : { animation: 'simHeroPulse 1600ms ease-in-out infinite' }
              }
            />
          ) : (
            <g key={runId}>
              {yTicks.map((v, k) => (
                <g key={`y${k}`}>
                  <line
                    x1={BOX.padL}
                    x2={BOX.w - BOX.padR}
                    y1={geo.scales.yOf(v)}
                    y2={geo.scales.yOf(v)}
                    stroke={SEMANTIC_COLORS.borderSubtle}
                    strokeWidth={1}
                  />
                  <text
                    x={BOX.padL - 6}
                    y={geo.scales.yOf(v) + 3}
                    textAnchor="end"
                    fill={SEMANTIC_COLORS.textTertiary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={9}
                  >
                    {kUsd(v)}
                  </text>
                </g>
              ))}

              {startTs !== null &&
                stepSeconds !== null &&
                xTicks.map((i, k) => (
                  <text
                    key={`x${k}`}
                    x={geo.scales.xOf(i)}
                    y={BOX.h - BOX.padB + 14}
                    textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}
                    fill={SEMANTIC_COLORS.textTertiary}
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize={9}
                  >
                    {tickLabel(startTs + i * stepSeconds, k !== 1, zone)}
                  </text>
                ))}

              {geo.srcRuns.map((r, k) => (
                <path
                  key={`s${k}`}
                  d={pathD(r)}
                  fill="none"
                  stroke={SEMANTIC_COLORS.danger}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  pathLength={reduced ? undefined : 1}
                  strokeDasharray={reduced ? undefined : '1'}
                  style={drawStyle(0)}
                />
              ))}
              {geo.memRuns.map((r, k) => (
                <path
                  key={`m${k}`}
                  d={pathD(r)}
                  fill="none"
                  stroke={SEMANTIC_COLORS.success}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  pathLength={reduced ? undefined : 1}
                  strokeDasharray={reduced ? undefined : '1'}
                  style={drawStyle(MEMBRANE_DELAY_MS)}
                />
              ))}

              {comparison &&
                dots(
                  comparison.source.equitySeries,
                  comparison.source.events,
                  ['liquidation'],
                  SEMANTIC_COLORS.danger,
                  0,
                  'src',
                )}
              {comparison &&
                dots(
                  comparison.membrane.equitySeries,
                  comparison.membrane.events,
                  ['cure', 'recall'],
                  SEMANTIC_COLORS.success,
                  MEMBRANE_DELAY_MS,
                  'mem',
                )}
            </g>
          )}
        </Box>
      </Box>

      {comparison && (
        <Box display="flex" gap={SPACING.base} flexWrap="wrap">
          {[
            { label: comparison.position.label, color: SEMANTIC_COLORS.danger },
            { label: 'Membrane', color: SEMANTIC_COLORS.success },
          ].map((s) => (
            <Box key={s.label} display="flex" alignItems="center" gap={SPACING.xs}>
              <Box as="span" w="7px" h="7px" bg={s.color} flexShrink={0} />
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10.5px"
                color={SEMANTIC_COLORS.textSecondary}
                {...tabular}
              >
                {s.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default HeroChart
