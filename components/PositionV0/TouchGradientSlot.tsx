// THE CURVE (FORECAST_VISUALS.md, option C "Move down the curve"): the detailed view under
// the forecast block's chance strip. One drawn surface:
//   x  how far the asset moves from today (−5% … −30%, widened to the reader's line and
//      to where each action moves it, up to the table's 60%);
//   y  the chance it touches that line within the selected horizon.
//
// EMPHASIS (owner, 2026-10-16: the chart was "too much of an info blast"). The reader's line
// and chance lead: a red ring (the edition's danger token; owner: "it's not a positive
// event"), a red drop to the axis and a bold red label. Everything else recedes into muted
// ink: the forecast line, the halftone band (the 90% range, an SVG <pattern> with an id
// unique per instance), the axes, and fewer tick labels.
//
// LEVERS. A distinct marker per kind, ■ repay and ◆ add, named by the legend in the rows'
// own words ("if you repay"). Each label sits beside its own marker, and no marker covers
// the ring or another marker. A crowded marker group moves off its point, and a leader
// runs back to it (curveLayout.ts lays this out; its unit test covers coincident points).
//
// THE Y SCALE IS SQUARE-ROOT, and says so on the axis. The levers live at 1–15% while the
// shallow end of the shown range reaches 50%+; on a linear axis every mark sat on the
// floor.
//
// The component boundary is the swap point for Q26's outputs: it takes forecast rows
// (horizon, level, pct, lo/hi, n, period, confidence) and marks, nothing page-specific.

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import type { TouchFrequency } from '@/lib/position/touch'
import type { Direction, HistoryAsset } from '@/lib/position/touchHistory'

import { LEGEND_SEP, LEGEND_TEXT, LEVER_KINDS, MARK, layoutCurveMarks, legendWidth, type LeverKind, type Rect } from './curveLayout'
import type { LeverPoint, YouMark } from './forecastMarks'
import { TYPE_PX } from './typeScale'

export interface TouchGradientSlotProps {
  asset: HistoryAsset
  direction: Direction
  /** One forecast per whole level over `range`, ascending. */
  curve: TouchFrequency[]
  range: { from: number; to: number }
  /** The reader's line, when it is inside the table. */
  you: YouMark | null
  /** Where the levers move the line: one point per level, with the kinds that reach it. */
  levers: LeverPoint[]
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
/** Labelled, dotted gridlines under the top (which is always labelled): few, but enough to
 *  read a height on the √ scale. */
const Y_GRID = [1, 10, 50]

/** Mono label metrics: JetBrains Mono advances 0.6em. */
const CHAR_W = TYPE_PX.label * 0.6
const LINE_H = 12
/** A second key row, when the legend does not fit beside "chance (√ scale)". */
const KEY_ROW = 14
const CHANCE_KEY = 'chance (√ scale)'

const M = { left: 34, right: 10, top: 18, bottom: 40 }
const BASE_HEIGHT = (width: number | null) => (width === null ? 170 : Math.round(Math.min(260, Math.max(170, width * 0.42))))

const kindsOf = (levers: LeverPoint[]): LeverKind[] => LEVER_KINDS.filter((k) => levers.some((p) => p.kinds.includes(k)))

/** Does the legend need its own row at this width? */
const legendWraps = (width: number, kinds: LeverKind[]) =>
  kinds.length > 0 && M.left + CHANCE_KEY.length * CHAR_W + LEGEND_SEP > width - M.right - legendWidth(kinds, CHAR_W)

/**
 * The chart's height and its plot's top at a width: 170px on a phone, growing with the
 * column to 260px, plus one key row when the legend cannot sit beside "chance (√ scale)".
 */
export function curveFrame(width: number | null, levers: LeverPoint[]): { height: number; top: number } {
  const extra = width !== null && legendWraps(width, kindsOf(levers)) ? KEY_ROW : 0
  return { height: BASE_HEIGHT(width) + extra, top: M.top + extra }
}

export const TouchGradientSlot: React.FC<TouchGradientSlotProps> = (props) => {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const { height, top } = curveFrame(width, props.levers)

  return (
    // The box holds the chart's height before the width is known (no layout shift).
    <Box ref={ref} w="100%" minW={0} h={`${height}px`} position="relative">
      {width !== null && props.curve.length > 1 && (
        <TouchGradientCurve {...props} uid={uid} width={width} height={height} top={top} />
      )}
    </Box>
  )
}

/** One lever marker: ■ for a repay, ◆ for a top-up. A paper halo keeps it off the curve. */
const Marker: React.FC<{ kind: LeverKind; x: number; y: number }> = ({ kind, x, y }) => {
  const style = { fill: NEWS.accent, stroke: NEWS.paper, strokeWidth: 2, paintOrder: 'stroke' as const }
  if (kind === 'repay') return <rect x={x - 4} y={y - 4} width={8} height={8} style={style} />
  const h = MARK.lever / 2
  return <polygon points={`${x},${y - h} ${x + h},${y} ${x},${y + h} ${x - h},${y}`} style={style} />
}

/** The chart itself at a known width (curveFrame gives its height and top). */
export const TouchGradientCurve: React.FC<TouchGradientSlotProps & { uid: string; width: number; height: number; top: number }> = ({
  uid,
  width,
  height,
  top,
  asset,
  direction,
  curve,
  range,
  you,
  levers,
  summary,
}) => {
  const pw = width - M.left - M.right
  const ph = height - top - M.bottom
  const floorY = top + ph
  const yMax = niceMax(Math.max(...curve.map((c) => c.hiPct), you?.pct ?? 0))
  const x = (level: number) => M.left + ((level - range.from) / Math.max(1, range.to - range.from)) * pw
  const y = (pct: number) => top + ph * (1 - Math.sqrt(Math.max(0, Math.min(pct, yMax)) / yMax))
  const sign = direction === 'fall' ? '−' : '+'
  const step = range.to - range.from > 20 ? 10 : 5
  const raw: number[] = []
  for (let L = Math.ceil(range.from / step) * step; L <= range.to; L += step) raw.push(L)
  if (!raw.includes(range.from)) raw.unshift(range.from)
  if (!raw.includes(range.to)) raw.push(range.to)
  // Each tick label's extent: the first is left-anchored, the last right-anchored, the rest
  // centred. A middle tick whose label comes within 8px of a kept neighbour's is dropped.
  const tickW = (L: number) => (String(L).length + 2) * CHAR_W // "−35%"
  const first = raw[0]
  const last = raw[raw.length - 1]
  let keptRight = x(first) + tickW(first)
  const lastLeft = x(last) - tickW(last)
  const middle = raw.slice(1, -1).filter((L) => {
    const [l, r] = [x(L) - tickW(L) / 2, x(L) + tickW(L) / 2]
    if (l - keptRight < 8 || lastLeft - r < 8) return false
    keptRight = r
    return true
  })
  const ticks = raw.length > 1 ? [first, ...middle, last] : raw
  // The top is always labelled; a gridline that would crowd the one above it is dropped.
  const yTicks: number[] = [yMax]
  for (const v of Y_GRID.filter((g) => g < yMax).reverse()) {
    if (y(v) - y(yTicks[yTicks.length - 1]) >= 12) yTicks.push(v)
  }
  const pt = (level: number, pct: number) => `${x(level).toFixed(1)},${y(pct).toFixed(1)}`
  const line = curve.map((c) => pt(c.level, c.pct)).join(' ')
  const band = [...curve.map((c) => pt(c.level, c.hiPct)), ...[...curve].reverse().map((c) => pt(c.level, c.loPct))].join(' ')
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  // Labels can cross the curve or the band: a paper halo keeps them legible.
  const halo = { ...font, paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }

  // The reader's drop to the axis is a footprint too: no lever or label sits on it.
  const youX = you ? x(you.level) : 0
  const youY = you ? y(you.pct) : 0
  const ringOuter = MARK.ringR + MARK.ringStroke / 2
  const drop: Rect | null = you && floorY - (youY + ringOuter) > 4 ? { x: youX - 1, y: youY + ringOuter, w: 2, h: floorY - youY - ringOuter } : null
  const layout = layoutCurveMarks({
    bounds: { x: M.left, y: top, w: pw, h: ph },
    you: you ? { x: youX, y: youY, label: you.label } : null,
    levers: levers.map((p) => ({ id: String(p.level), x: x(p.level), y: y(p.pct), kinds: p.kinds, label: p.label })),
    obstacles: drop ? [drop] : [],
    curve: curve.map((c) => ({ x: x(c.level), y: y(c.pct) })),
    outer: { x: 0, y: 0, w: width, h: height },
    charW: CHAR_W,
    lineH: LINE_H,
  })

  // The keys: "chance (√ scale)" top left, the lever legend top right (or on its own row),
  // the band's swatch bottom left, the x caption bottom right.
  const kinds = kindsOf(levers)
  const legendRowY = top - 7
  const keyY = top - 7 - (top > M.top ? KEY_ROW : 0)
  let lx = M.left + pw - legendWidth(kinds, CHAR_W)

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
          <circle cx="1.5" cy="1.5" r="0.75" fill={NEWS.muted} />
        </pattern>
      </defs>

      {/* dotted gridlines at 1%, 10%, 50% and the top. The floor has no label and no
          gridline: no chance on this page is ever shown as 0%. */}
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={M.left} x2={M.left + pw} y1={y(v)} y2={y(v)} stroke={NEWS.rule} strokeDasharray="1 3" />
          <text x={M.left - 6} y={y(v) + 4} textAnchor="end" fill={NEWS.muted} style={font}>
            {v}%
          </text>
        </g>
      ))}
      <text x={M.left} y={keyY} fill={NEWS.muted} style={font}>
        {CHANCE_KEY}
      </text>

      {/* the band, then the forecast line over it: both in muted ink, behind the marks */}
      <polygon points={band} fill={`url(#dots-${uid})`} stroke="none" />
      <polyline points={line} fill="none" stroke={NEWS.muted} strokeWidth={1.5} strokeLinejoin="round" />

      {/* x axis: ticks below, the last label right-anchored */}
      <line x1={M.left} x2={M.left + pw} y1={floorY} y2={floorY} stroke={NEWS.muted} strokeWidth={1} />
      {ticks.map((L, i) => (
        <g key={L}>
          <line x1={x(L)} x2={x(L)} y1={floorY} y2={floorY + 4} stroke={NEWS.muted} />
          <text
            x={x(L)}
            y={floorY + 16}
            textAnchor={i === ticks.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
            fill={NEWS.muted}
            style={font}
          >
            {sign}
            {L}%
          </text>
        </g>
      ))}
      <rect x={M.left} y={height - 12} width={8} height={8} fill={`url(#dots-${uid})`} stroke={NEWS.muted} strokeWidth={0.5} />
      <text x={M.left + 8 + MARK.labelGap} y={height - 4} fill={NEWS.muted} style={font}>
        likely range
      </text>
      <text x={M.left + pw} y={height - 4} textAnchor="end" fill={NEWS.muted} style={font}>
        {/* Under 330px the full caption would run into the band's key. */}
        how far {asset} {direction === 'fall' ? 'falls' : 'rises'}
        {width >= 330 ? ' from today' : ''}
      </text>

      {/* the lever legend, in the rows' wording */}
      {kinds.map((k) => {
        const at = lx
        lx += MARK.lever + MARK.labelGap + LEGEND_TEXT[k].length * CHAR_W + LEGEND_SEP
        return (
          <g key={k}>
            <Marker kind={k} x={at + MARK.lever / 2} y={legendRowY - 4} />
            <text x={at + MARK.lever + MARK.labelGap} y={legendRowY} fill={NEWS.ink2} style={font}>
              {LEGEND_TEXT[k]}
            </text>
          </g>
        )
      })}

      {/* the reader's line: a red ring on the curve and a red drop to the axis */}
      {layout.you && (
        <g>
          {drop && <line x1={youX} x2={youX} y1={drop.y} y2={floorY} stroke={NEWS.danger} strokeDasharray="1 2" />}
          <circle cx={youX} cy={youY} r={MARK.ringR} fill="none" stroke={NEWS.danger} strokeWidth={MARK.ringStroke} />
        </g>
      )}

      {/* where each lever moves the line: its markers, and a leader when they moved off the point */}
      {layout.levers.map((p) => (
        <g key={p.id}>
          {p.leader && (
            <line x1={p.leader.x1} y1={p.leader.y1} x2={p.leader.x2} y2={p.leader.y2} stroke={NEWS.accent} strokeWidth={1} />
          )}
          {p.dot && <circle cx={p.point.x} cy={p.point.y} r={MARK.dotR} fill={NEWS.accent} />}
          {p.markers.map((m) => (
            <Marker key={m.kind} kind={m.kind} x={m.x} y={m.y} />
          ))}
        </g>
      ))}
      {layout.levers.map((p, i) => (
        <text key={p.id} x={p.label.x} y={p.label.y} textAnchor={p.label.anchor} fill={NEWS.accent} style={halo}>
          {levers[i].label}
        </text>
      ))}

      {/* the reader's label last, so it sits on top */}
      {layout.you && you && (
        <text
          x={layout.you.label.x}
          y={layout.you.label.y}
          textAnchor={layout.you.label.anchor}
          fill={NEWS.danger}
          style={{ ...halo, fontWeight: 700 }}
        >
          {you.label}
        </text>
      )}
    </svg>
  )
}
