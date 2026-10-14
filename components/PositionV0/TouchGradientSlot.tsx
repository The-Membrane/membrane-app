// THE CURVE (FORECAST_VISUALS.md, option C "Move down the curve"). One drawn surface:
//   x  how far the asset moves from today (−5% … −30%, widened to the reader's line and
//      to where each action moves it, up to the table's 60%);
//   y  the chance it touches that line within the selected horizon.
// Ink line = the point forecast at each whole level. Dotted halftone = the 90% band (an
// SVG <pattern> of dots, id unique per instance). Gold ring = the reader's line. Paper
// dots, ink-stroked = where each action row moves the line, labelled on the chart. Calm is
// ink only; gold marks the reader and their actions; nothing is red (nothing is sold).
//
// THE Y SCALE IS SQUARE-ROOT, and says so on the axis. The levers live at 1–15% while the
// shallow end of the shown range reaches 50%+; on a linear axis every mark sat on the
// floor. Gridlines at 1, 5, 10, 25, 50% keep every height readable as a chance. Mark
// labels sit in lanes at the top of the plot with a dotted leader to their point, so they
// never collide however close the marks are.
//
// The component boundary is the swap point for Q26's outputs: it takes forecast rows
// (horizon, level, pct, lo/hi, n, period, confidence) and marks, nothing page-specific.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import type { TouchFrequency } from '@/lib/position/touch'
import type { Direction, HistoryAsset } from '@/lib/position/touchHistory'

import { TYPE_PX } from './typeScale'

export interface CurveMark {
  level: number
  pct: number
  label: string
}

export interface TouchGradientSlotProps {
  asset: HistoryAsset
  direction: Direction
  /** One forecast per whole level over `range`, ascending. */
  curve: TouchFrequency[]
  range: { from: number; to: number }
  /** The reader's line, when it is inside the table. */
  you: CurveMark | null
  /** Where each action moves the line. */
  actions: CurveMark[]
  /** Accessible summary of what the curve shows. */
  summary: string
}

/** The SVG is drawn at its real pixel width so 11px labels stay 11px at 390px. */
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

/** The smallest of these at or above the band's highest point. */
const Y_MAXES = [5, 10, 20, 40, 60, 80, 100]
const niceMax = (v: number) => Y_MAXES.find((m) => m >= v) ?? 100
/** Candidate gridlines; those under the top and not crowding a neighbour are drawn. */
const Y_GRID = [0, 1, 5, 10, 25, 50, 75, 100]
/** Vertical spacing of the mark-label lanes. */
const LANE = 14

const M = { left: 34, right: 10, top: 18, bottom: 40 }

export const TouchGradientSlot: React.FC<TouchGradientSlotProps> = (props) => {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  // 170px on a phone, growing with the column to 260px.
  const height = width === null ? 170 : Math.round(Math.min(260, Math.max(170, width * 0.42)))

  return (
    // The box holds the chart's height before the width is known (no layout shift).
    <Box ref={ref} w="100%" minW={0} h={`${height}px`} position="relative">
      {width !== null && props.curve.length > 1 && <Curve {...props} uid={uid} width={width} height={height} />}
    </Box>
  )
}

/** Gold mark labels: right of a point in the left half, left of it in the right half. */
const anchorAt = (px: number, left: number, pw: number) => (px > left + pw * 0.55 ? 'end' : 'start')

const Curve: React.FC<TouchGradientSlotProps & { uid: string; width: number; height: number }> = ({
  uid,
  width,
  height,
  asset,
  direction,
  curve,
  range,
  you,
  actions,
  summary,
}) => {
  const pw = width - M.left - M.right
  const ph = height - M.top - M.bottom
  const yMax = niceMax(Math.max(...curve.map((c) => c.hiPct), you?.pct ?? 0))
  const x = (level: number) => M.left + ((level - range.from) / Math.max(1, range.to - range.from)) * pw
  const y = (pct: number) => M.top + ph * (1 - Math.sqrt(Math.max(0, Math.min(pct, yMax)) / yMax))
  const sign = direction === 'fall' ? '−' : '+'
  const step = range.to - range.from > 30 ? 10 : 5
  const raw: number[] = []
  for (let L = Math.ceil(range.from / step) * step; L <= range.to; L += step) raw.push(L)
  if (!raw.includes(range.from)) raw.unshift(range.from)
  if (!raw.includes(range.to)) raw.push(range.to)
  // Drop a tick that crowds a neighbour; the first and the right-anchored last stay.
  const lastX = x(raw[raw.length - 1])
  const ticks = raw.filter((L, i) => i === 0 || i === raw.length - 1 || (x(L) - x(raw[i - 1]) > 26 && lastX - x(L) > 26))
  const yTicks: number[] = []
  for (const v of [...Y_GRID.filter((g) => g < yMax), yMax]) {
    if (yTicks.length === 0 || y(yTicks[yTicks.length - 1]) - y(v) >= 12) yTicks.push(v)
  }
  const pt = (level: number, pct: number) => `${x(level).toFixed(1)},${y(pct).toFixed(1)}`
  const line = curve.map((c) => pt(c.level, c.pct)).join(' ')
  const band = [...curve.map((c) => pt(c.level, c.hiPct)), ...[...curve].reverse().map((c) => pt(c.level, c.loPct))].join(' ')
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  const pctTxt = (v: number) => `${v}%`
  const anchor = (px: number) => anchorAt(px, M.left, pw)
  const dx = (px: number) => (anchor(px) === 'end' ? -10 : 10)

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={summary}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <title>{summary}</title>
      <defs>
        <pattern id={`dots-${uid}`} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="0.75" fill={NEWS.ink} />
        </pattern>
      </defs>

      {/* dotted gridlines and the y labels */}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={M.left} x2={M.left + pw} y1={y(v)} y2={y(v)} stroke={NEWS.rule} strokeDasharray="1 3" />
          {/* The floor stays unlabelled: no chance on this page is ever shown as 0%. */}
          {v > 0 && (
            <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fill={NEWS.muted} style={font}>
              {pctTxt(v)}
            </text>
          )}
        </g>
      ))}
      <text x={M.left} y={M.top - 7} fill={NEWS.muted} style={font}>
        chance (√ scale)
      </text>

      {/* the band, then the forecast line over it, each labelled on the chart */}
      <polygon points={band} fill={`url(#dots-${uid})`} stroke="none" />
      <polyline points={line} fill="none" stroke={NEWS.ink} strokeWidth={1.5} strokeLinejoin="round" />
      {/* The full key fits beside "chance (√ scale)" only on a wide chart; a phone keeps the band's. */}
      <text x={M.left + pw} y={M.top - 7} textAnchor="end" fill={NEWS.ink2} style={font}>
        {width >= 520 ? 'line = forecast · dots = likely range' : 'dots = likely range'}
      </text>

      {/* x axis: ticks below, the last label right-anchored */}
      <line x1={M.left} x2={M.left + pw} y1={M.top + ph} y2={M.top + ph} stroke={NEWS.ink} strokeWidth={1} />
      {ticks.map((L, i) => (
        <g key={L}>
          <line x1={x(L)} x2={x(L)} y1={M.top + ph} y2={M.top + ph + 4} stroke={NEWS.ink} />
          <text
            x={x(L)}
            y={M.top + ph + 16}
            textAnchor={i === ticks.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
            fill={NEWS.ink2}
            style={font}
          >
            {sign}
            {L}%
          </text>
        </g>
      ))}
      <text x={M.left + pw} y={height - 4} textAnchor="end" fill={NEWS.muted} style={font}>
        how far {asset} {direction === 'fall' ? 'falls' : 'rises'} from today
      </text>

      {/* where each action moves the line: paper dots, ink stroke; labels in lanes below
          the reader's, each with a dotted leader down to its dot */}
      {actions.map((a, i) => {
        const px = x(a.level)
        const py = y(a.pct)
        const ly = M.top + LANE * (i + (you ? 2 : 1))
        return (
          <g key={`${a.level}-${a.label}`}>
            <line x1={px} x2={px} y1={ly + 3} y2={py - 5} stroke={NEWS.accent} strokeDasharray="1 2" />
            <circle cx={px} cy={py} r={4} fill={NEWS.paper} stroke={NEWS.ink} strokeWidth={1.5} />
            <text x={px + dx(px) / 2} y={ly} textAnchor={anchor(px)} fill={NEWS.accent} style={font}>
              {a.label}
            </text>
          </g>
        )
      })}

      {/* the reader's line: a gold ring, its label in the top lane */}
      {you && (
        <g>
          <line x1={x(you.level)} x2={x(you.level)} y1={M.top + LANE + 3} y2={y(you.pct) - 8} stroke={NEWS.accent} strokeDasharray="1 2" />
          <circle cx={x(you.level)} cy={y(you.pct)} r={7} fill="none" stroke={NEWS.accent} strokeWidth={2} />
          <text
            x={x(you.level) + dx(x(you.level)) / 2}
            y={M.top + LANE}
            textAnchor={anchor(x(you.level))}
            fill={NEWS.accent}
            style={{ ...font, fontWeight: 700 }}
          >
            {you.label}
          </text>
        </g>
      )}
    </svg>
  )
}
