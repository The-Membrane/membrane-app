// TIME TO TOUCH (owner, 2026-10-17): one chart for "when", replacing the horizon tabs.
//   x  time from now, 1 hour to 7 days, log scale (1 h is the hourly history's resolution);
//   y  the chance the line has been touched BY then (cumulative, so it only rises).
// The curve is the forecast table's own outcome counted at more window lengths
// (lib/position/touchTime.ts); nothing is fitted.
//
// CHECKED vs MODEL-ONLY, drawn, not footnoted (chart rules: uncertainty is a band, and no
// confidence without realized outcomes). The band and the line between the marks are
// model-only: a light halftone. At 1, 3 and 7 days, the figures the page quotes, a solid
// mark with its own range bar stands on the curve: those have a realized-outcome check
// (2024–26, preliminary). The key under the chart names both.
//
// ALWAYS A FRAME. The chart's box is drawn at its full height in every state: with the
// curve; "reading…" while the venues answer; and withheld, with the reason in the frame
// (STALE hatched), so the place for the visual never collapses to nothing.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { formatChance } from '@/lib/position/touch'
import { TIME_AXIS, type TimeToTouch } from '@/lib/position/touchTime'

import { STALE_HATCH } from './forecastMarks'
import { Small } from './primitives'
import { TYPE_PX } from './typeScale'

/** One drawn series. `tone` sets its ink: the reader's line is ink, a market level lighter. */
export interface TimeSeries {
  tt: TimeToTouch
  /** Right-end label for a multi-series chart ("−10%"); none for the reader's single line. */
  endLabel?: string
  tone: 'ink' | 'ink2' | 'muted'
}

export type TimeChartState =
  | { kind: 'ready'; series: TimeSeries[]; summary: string; marks: boolean }
  | { kind: 'reading' }
  | { kind: 'withheld'; reason: string; stale?: boolean }

/** The x ticks: hours and their short labels. */
export const TIME_TICKS: { h: number; label: string }[] = [
  { h: 1, label: '1h' },
  { h: 6, label: '6h' },
  { h: 12, label: '12h' },
  { h: 24, label: '1d' },
  { h: 48, label: '2d' },
  { h: 72, label: '3d' },
  { h: 168, label: '7d' },
]

const Y_MAXES = [2, 5, 10, 20, 40, 60, 80, 100]
/** The smallest axis top at or above v. */
export const timeYMax = (v: number): number => Y_MAXES.find((m) => m >= v) ?? 100

/** x position of an hour on the log axis, as a fraction of the plot width. */
export const timeX = (hours: number): number =>
  Math.log(Math.max(TIME_AXIS.fromHours, Math.min(TIME_AXIS.toHours, hours)) / TIME_AXIS.fromHours) /
  Math.log(TIME_AXIS.toHours / TIME_AXIS.fromHours)

const CHAR_W = TYPE_PX.label * 0.6

/** Greedy word wrap to `max` characters a line (mono: every character the same width). */
export function wrapWords(text: string, max: number): string[] {
  const out: string[] = []
  let line = ''
  for (const w of text.split(' ')) {
    if (line && (line + ' ' + w).length > max) {
      out.push(line)
      line = w
    } else line = line ? `${line} ${w}` : w
  }
  if (line) out.push(line)
  return out
}
const M = { left: 34, right: 12, top: 22, bottom: 30 }
export const timeChartHeight = (width: number | null): number =>
  width === null ? 190 : Math.round(Math.min(250, Math.max(190, width * 0.4)))

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number | null] {
  const ref = useRef<T>(null)
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width
      if (cw && cw > 0) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const TONE = { ink: NEWS.ink, ink2: NEWS.ink2, muted: NEWS.muted } as const

export const TimeToTouchChart: React.FC<{ state: TimeChartState; caption: string }> = ({ state, caption }) => {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const height = timeChartHeight(width)
  const stale = state.kind === 'withheld' && state.stale
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      <Box
        ref={ref}
        w="100%"
        minW={0}
        h={`${height}px`}
        position="relative"
        bgImage={stale ? STALE_HATCH : undefined}
        data-time-chart={state.kind}
      >
        {width !== null && <Frame state={state} width={width} height={height} uid={uid} caption={caption} />}
      </Box>
      {state.kind === 'ready' && <Key marks={state.marks} uid={uid} />}
    </Box>
  )
}

/** The key, in words the reader can repeat: what is checked, what is model-only. */
const Key: React.FC<{ marks: boolean; uid: string }> = ({ marks, uid }) => (
  <Box display="flex" flexWrap="wrap" columnGap={SPACING.md} rowGap={SPACING.xs} minW={0}>
    {marks && (
      <Small display="inline-flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2}>
        <svg width="10" height="12" aria-hidden="true" focusable="false">
          <line x1="5" x2="5" y1="1" y2="11" stroke={NEWS.ink} strokeWidth={1} />
          <rect x="2" y="3" width="6" height="6" fill={NEWS.ink} />
        </svg>
        1 · 3 · 7 days: checked against 2024–26 outcomes (preliminary)
      </Small>
    )}
    <Small display="inline-flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2}>
      <svg width="12" height="10" aria-hidden="true" focusable="false">
        <defs>
          <pattern id={`key-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.6" fill={NEWS.muted} />
          </pattern>
        </defs>
        <rect x="0.5" y="0.5" width="11" height="9" fill={`url(#key-${uid})`} stroke={NEWS.muted} strokeWidth={0.5} />
      </svg>
      {marks ? 'band and curve between: model-only, no outcome check' : 'likely range (90%): model-only between 1 · 3 · 7 days'}
    </Small>
  </Box>
)

const Frame: React.FC<{ state: TimeChartState; width: number; height: number; uid: string; caption: string }> = ({
  state,
  width,
  height,
  uid,
  caption,
}) => {
  const pw = width - M.left - M.right
  const ph = height - M.top - M.bottom
  const floorY = M.top + ph
  const series = state.kind === 'ready' ? state.series : []
  const top = timeYMax(Math.max(1, ...series.flatMap((s) => s.tt.points.map((p) => p.hiPct))))
  const x = (h: number) => M.left + timeX(h) * pw
  const y = (pct: number) => M.top + ph * (1 - Math.max(0, Math.min(pct, top)) / top)
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  const halo = { ...font, paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }
  // Drop a middle tick whose label would come within 6px of the one kept before it.
  let keptRight = -Infinity
  const ticks = TIME_TICKS.filter((t, i) => {
    const w = t.label.length * CHAR_W
    const l = i === 0 ? x(t.h) : i === TIME_TICKS.length - 1 ? x(t.h) - w : x(t.h) - w / 2
    if (l - keptRight < 6) return false
    keptRight = l + w
    return true
  })
  const label =
    state.kind === 'ready' ? state.summary : state.kind === 'reading' ? 'Chance over time: reading' : `Chance over time withheld: ${state.reason}`

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={{ display: 'block', overflow: 'visible' }}>
      <title>{label}</title>
      <defs>
        <pattern id={`tt-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" fill={NEWS.muted} />
        </pattern>
      </defs>

      {/* y: the floor and the top, labelled; a dotted midline */}
      {[top / 2, top].map((v) => (
        <g key={v}>
          <line x1={M.left} x2={M.left + pw} y1={y(v)} y2={y(v)} stroke={NEWS.rule} strokeDasharray="1 3" />
          {state.kind === 'ready' && (
            <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fill={NEWS.muted} style={font}>
              {Number.isInteger(v) ? v : v.toFixed(1)}%
            </text>
          )}
        </g>
      ))}
      <text x={M.left} y={M.top - 9} fill={NEWS.muted} style={font}>
        {caption}
      </text>

      {/* x: time from now, log scale */}
      <line x1={M.left} x2={M.left + pw} y1={floorY} y2={floorY} stroke={NEWS.muted} />
      {ticks.map((t, i) => (
        <g key={t.h}>
          <line x1={x(t.h)} x2={x(t.h)} y1={floorY} y2={floorY + 4} stroke={NEWS.muted} />
          <text
            x={x(t.h)}
            y={floorY + 16}
            textAnchor={i === 0 ? 'start' : t.h === TIME_AXIS.toHours ? 'end' : 'middle'}
            fill={NEWS.muted}
            style={font}
          >
            {t.label}
          </text>
        </g>
      ))}
      <text x={M.left + pw} y={height - 1} textAnchor="end" fill={NEWS.muted} style={font}>
        time from now (log)
      </text>

      {state.kind !== 'ready' &&
        wrapWords(
          state.kind === 'reading' ? 'reading…' : state.stale ? `░ STALE · ${state.reason}` : `withheld · ${state.reason}`,
          Math.floor(pw / (TYPE_PX.body * 0.6)),
        ).map((ln, i, all) => (
          <text
            key={i}
            x={M.left + pw / 2}
            y={M.top + ph / 2 + (i - (all.length - 1) / 2) * 17}
            textAnchor="middle"
            fill={NEWS.ink2}
            style={{ ...halo, fontSize: TYPE_PX.body, fontWeight: state.kind === 'withheld' && state.stale ? 700 : 400 }}
          >
            {ln}
          </text>
        ))}

      {series.map((s, k) => {
        const pts = s.tt.points
        const line = pts.map((p) => `${x(p.hours).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')
        const band = [
          ...pts.map((p) => `${x(p.hours).toFixed(1)},${y(p.hiPct).toFixed(1)}`),
          ...[...pts].reverse().map((p) => `${x(p.hours).toFixed(1)},${y(p.loPct).toFixed(1)}`),
        ].join(' ')
        const end = pts[pts.length - 1]
        return (
          <g key={k}>
            <polygon points={band} fill={`url(#tt-${uid})`} stroke="none" />
            <polyline points={line} fill="none" stroke={TONE[s.tone]} strokeWidth={1.25} strokeLinejoin="round" />
            {s.endLabel && (
              <text x={x(end.hours) - 4} y={y(end.pct) - 5} textAnchor="end" fill={TONE[s.tone]} style={halo}>
                {s.endLabel}
              </text>
            )}
          </g>
        )
      })}

      {/* the checked points: solid, with their own range bar and the figure the page quotes */}
      {state.kind === 'ready' &&
        state.marks &&
        series.map((s, k) =>
          s.tt.points
            .filter((p) => p.checked)
            .map((p) => {
              const cx = x(p.hours)
              const last = p.hours === TIME_AXIS.toHours
              return (
                <g key={`${k}-${p.hours}`}>
                  <line x1={cx} x2={cx} y1={y(p.hiPct)} y2={y(p.loPct)} stroke={NEWS.ink} strokeWidth={1} />
                  <line x1={cx - 3} x2={cx + 3} y1={y(p.hiPct)} y2={y(p.hiPct)} stroke={NEWS.ink} strokeWidth={1} />
                  <line x1={cx - 3} x2={cx + 3} y1={y(p.loPct)} y2={y(p.loPct)} stroke={NEWS.ink} strokeWidth={1} />
                  <rect x={cx - 3} y={y(p.pct) - 3} width={6} height={6} fill={NEWS.ink} stroke={NEWS.paper} strokeWidth={1} />
                  <text
                    x={last ? cx - 6 : cx}
                    y={Math.max(M.top + 2, y(p.hiPct) - 6)}
                    textAnchor={last ? 'end' : 'middle'}
                    fill={NEWS.ink}
                    style={{ ...halo, fontWeight: 700 }}
                  >
                    {p.horizon} {formatChance((p.pct * p.n) / 100, p.n)}
                  </text>
                </g>
              )
            }),
        )}
    </svg>
  )
}
