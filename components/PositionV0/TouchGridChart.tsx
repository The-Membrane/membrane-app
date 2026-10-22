// THE ONE CHANCE CHART (owner, 2026-10-17: "I'm unsure if we need both chance charts since
// they overlap … is there a better way to combine them?"). A time × depth grid; the model is
// lib/position/touchGrid.ts:
//   columns  time from now, 1 h → 7 days (log): the touch-time grid's windows
//   rows     how far the price moves, one per whole percent, −5% → −35% (widened)
//   cell     the chance the line is touched by then, in six ink bands
// CHECKED vs MODEL-ONLY, drawn: the 1 / 3 / 7-day columns are the forecast table's own cells
// (realized-outcome check, preliminary) and are SOLID; every other cell is HALFTONE, the dot
// size giving the same ink coverage as the solid tint, so the eye reads one surface and can
// still tell what is checked.
// THE READER'S ROW is outlined in the danger ink with its 1 / 3 / 7-day chances read along
// it; THE LEVERS sit in the right margin at the row each one moves the reader's row to,
// with a bracket from the reader's row. A tap (or arrow keys) reads a cell out under the
// chart, its likely range drawn as a band on a √ scale (uncertainty as geometry).

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { CHANCE_BANDS, cellAt, cellBand, cellChance, readCell, rowReading, stepCell, type GridCell, type TouchGrid } from '@/lib/position/touchGrid'

import { LEGEND_TEXT, type LeverKind } from './curveLayout'
import { STALE_HATCH } from './forecastMarks'
import { Mono, Small } from './primitives'
import { TIME_TICKS, wrapWords } from './TimeToTouchChart'
import { TYPE_PX } from './typeScale'

/** A lever's row: where the reader's row moves to, and the action rows that get it there. */
export interface GridLever {
  level: number
  kinds: LeverKind[]
  /** The rows' own lines: "If you repay 460 USDC → 5%". */
  detail: string[]
}

export type GridChartState =
  | {
      kind: 'ready'
      grid: TouchGrid
      /** The reader's row level, or null (the market grid). */
      you: number | null
      levers: GridLever[]
      /** The cell read out before any tap. */
      initial: { level: number; hours: number }
      summary: string
    }
  | { kind: 'reading' }
  | { kind: 'withheld'; reason: string; stale?: boolean }

/** Ink coverage per band, solid and halftone alike (dot area / pitch²). */
export const BAND_COVER = [0.04, 0.16, 0.3, 0.46, 0.64, 0.82] as const
const PITCH = 3
const dotR = (cover: number) => Math.sqrt((cover * PITCH * PITCH) / Math.PI)

const M = { left: 40, right: 22, top: 30, bottom: 34 }

/** Row height for a width and a row count: 7px on a phone, 8px wide, the plot capped at 320px. */
export function gridFrame(width: number | null, rows: number): { rowH: number; height: number } {
  const want = width !== null && width >= 560 ? 8 : 7
  const rowH = Math.max(4, Math.min(want, 320 / Math.max(1, rows)))
  return { rowH, height: Math.round(M.top + rows * rowH + M.bottom) }
}

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

/** Column edges on the log axis: each window's cell spans the midpoints to its neighbours. */
function columnScale(hours: number[], x0: number, pw: number) {
  const ln = hours.map(Math.log)
  const n = ln.length
  const lo = n > 1 ? ln[0] - (ln[1] - ln[0]) / 2 : ln[0] - 0.5
  const hi = n > 1 ? ln[n - 1] + (ln[n - 1] - ln[n - 2]) / 2 : ln[0] + 0.5
  const X = (v: number) => x0 + ((v - lo) / (hi - lo)) * pw
  const edges = ln.map((v, j) => ({
    left: X(j === 0 ? lo : (ln[j - 1] + v) / 2),
    right: X(j === n - 1 ? hi : (v + ln[j + 1]) / 2),
    mid: X(v),
  }))
  return edges
}

export const TouchGridChart: React.FC<{ state: GridChartState }> = ({ state }) => {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const rows = state.kind === 'ready' ? state.grid.levels.length : 31
  const { rowH, height } = gridFrame(width, rows)
  const stale = state.kind === 'withheld' && state.stale
  const [sel, setSel] = useState<{ level: number; hours: number } | null>(null)
  const grid = state.kind === 'ready' ? state.grid : null
  const at = (grid && sel && cellAt(grid, sel.level, sel.hours) ? sel : null) ?? (state.kind === 'ready' ? state.initial : null)
  const cell = grid && at ? cellAt(grid, at.level, at.hours) : null

  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      <Box ref={ref} w="100%" minW={0} h={`${height}px`} position="relative" bgImage={stale ? STALE_HATCH : undefined} data-grid-chart={state.kind}>
        {width !== null && (
          <Frame state={state} width={width} height={height} rowH={rowH} uid={uid} at={at} onPick={setSel} />
        )}
      </Box>
      {state.kind === 'ready' && cell && <Readout grid={state.grid} cell={cell} />}
      {state.kind === 'ready' && <Key uid={uid} levers={state.levers} />}
    </Box>
  )
}

/** The tapped cell in words, and its likely range as a band on a √ 0–100% scale. */
const BAR_W = 280
const Readout: React.FC<{ grid: TouchGrid; cell: GridCell }> = ({ grid, cell }) => {
  const s = (pct: number) => 2 + Math.sqrt(Math.max(0, Math.min(100, pct)) / 100) * (BAR_W - 4)
  const ticks = [1, 10, 50, 100]
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  return (
    <Box display="grid" gap={SPACING.xs} minW={0} aria-live="polite" data-grid-readout="">
      <Mono overflowWrap="anywhere">
        <b>{cellChance(cell)}</b> · {readCell(grid, cell)}
      </Mono>
      <svg width={BAR_W} height="30" viewBox={`0 0 ${BAR_W} 30`} aria-hidden="true" focusable="false" style={{ display: 'block', maxWidth: '100%', overflow: 'visible' }}>
        <line x1={s(0)} x2={s(100)} y1={8} y2={8} stroke={NEWS.muted} strokeWidth={1} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={s(t)} x2={s(t)} y1={5} y2={11} stroke={NEWS.muted} strokeWidth={1} />
            <text x={s(t)} y={26} textAnchor={t === 100 ? 'end' : 'middle'} fill={NEWS.muted} style={font}>
              {t}%
            </text>
          </g>
        ))}
        <text x={s(0)} y={26} fill={NEWS.muted} style={font}>
          √
        </text>
        {/* the likely range: a band; the forecast: a bar */}
        <rect x={s(cell.loPct)} y={3} width={Math.max(2, s(cell.hiPct) - s(cell.loPct))} height={10} fill={NEWS.ink} fillOpacity={0.3} />
        <rect x={s(cell.pct) - 1.5} y={1} width={3} height={14} fill={NEWS.ink} />
      </svg>
      <Small color={NEWS.ink2}>
        Likely range {cellBand(cell)} (90%) is the band; the bar is the forecast. Tap any cell, or use the arrow keys, to read it.
      </Small>
    </Box>
  )
}

const LeverMark: React.FC<{ kind: LeverKind; x: number; y: number }> = ({ kind, x, y }) => {
  const style = { fill: NEWS.accent, stroke: NEWS.paper, strokeWidth: 1.5, paintOrder: 'stroke' as const }
  if (kind === 'repay') return <rect x={x - 3.5} y={y - 3.5} width={7} height={7} style={style} />
  return <polygon points={`${x},${y - 4.5} ${x + 4.5},${y} ${x},${y + 4.5} ${x - 4.5},${y}`} style={style} />
}

/** The bands, what solid and halftone mean, and each lever in the rows' own words. */
const Key: React.FC<{ uid: string; levers: GridLever[] }> = ({ uid, levers }) => (
  <Box display="grid" gap={SPACING.xs} minW={0}>
    <Box display="flex" flexWrap="wrap" columnGap={SPACING.sm} rowGap={SPACING.xs} minW={0}>
      {CHANCE_BANDS.map((b, k) => (
        <Small key={b.label} display="inline-flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2}>
          <svg width="12" height="10" aria-hidden="true" focusable="false">
            <rect x={0.5} y={0.5} width={11} height={9} fill={NEWS.ink} fillOpacity={BAND_COVER[k]} stroke={NEWS.rule} strokeWidth={0.5} />
          </svg>
          {b.label}
        </Small>
      ))}
    </Box>
    <Box display="flex" flexWrap="wrap" columnGap={SPACING.md} rowGap={SPACING.xs} minW={0}>
      <Small display="inline-flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2}>
        <svg width="12" height="10" aria-hidden="true" focusable="false">
          <rect x={0.5} y={0.5} width={11} height={9} fill={NEWS.ink} fillOpacity={BAND_COVER[3]} />
        </svg>
        solid: 1 · 3 · 7 days, checked against 2024–26 outcomes (preliminary)
      </Small>
      <Small display="inline-flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2}>
        <svg width="12" height="10" aria-hidden="true" focusable="false">
          <defs>
            <pattern id={`kht-${uid}`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
              <circle cx={PITCH / 2} cy={PITCH / 2} r={dotR(BAND_COVER[3])} fill={NEWS.ink} />
            </pattern>
          </defs>
          <rect x={0.5} y={0.5} width={11} height={9} fill={`url(#kht-${uid})`} />
        </svg>
        halftone: model-only, no outcome check
      </Small>
    </Box>
    {levers.map((p) => (
      <Small key={p.level} display="flex" alignItems="center" gap={SPACING.xs} color={NEWS.ink2} overflowWrap="anywhere">
        <svg width={p.kinds.length * 11} height="10" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
          {p.kinds.map((k, i) => (
            <LeverMark key={k} kind={k} x={5 + i * 11} y={5} />
          ))}
        </svg>
        <span>
          your row → {'−'}
          {p.level}%: {p.detail.join(' · ')} within 7 days
        </span>
      </Small>
    ))}
  </Box>
)

const Frame: React.FC<{
  state: GridChartState
  width: number
  height: number
  rowH: number
  uid: string
  at: { level: number; hours: number } | null
  onPick: (s: { level: number; hours: number }) => void
}> = ({ state, width, height, rowH, uid, at, onPick }) => {
  const pw = width - M.left - M.right
  const grid = state.kind === 'ready' ? state.grid : null
  const hours = grid ? grid.hours : TIME_TICKS.map((t) => t.h)
  const levels = grid ? grid.levels : Array.from({ length: 31 }, (_, i) => i + 5)
  const ph = levels.length * rowH
  const floorY = M.top + ph
  const cols = useMemo(() => columnScale(hours, M.left, pw), [hours, pw])
  const rowY = (i: number) => M.top + i * rowH
  const font = { fontFamily: NEWS_FONT.mono, fontSize: TYPE_PX.label }
  const halo = { ...font, paintOrder: 'stroke' as const, stroke: NEWS.paper, strokeWidth: 3, strokeLinejoin: 'round' as const }
  const sign = grid?.direction === 'rise' ? '+' : '−'
  const asset = grid?.asset ?? 'the price'
  const verb = grid?.direction === 'rise' ? 'rises' : 'falls'
  const tickOf = (h: number) => TIME_TICKS.find((t) => t.h === h)
  const you = state.kind === 'ready' ? state.you : null
  const youI = you !== null ? levels.indexOf(you) : -1
  const label =
    state.kind === 'ready' ? state.summary : state.kind === 'reading' ? 'Chance by time and depth: reading' : `Chance by time and depth withheld: ${state.reason}`

  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!grid) return
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    if (py < M.top - 4 || py > floorY + 4 || px < M.left - 4 || px > M.left + pw + 4) return
    const i = Math.min(levels.length - 1, Math.max(0, Math.floor((py - M.top) / rowH)))
    const j = Math.max(0, cols.findIndex((c) => px < c.right))
    onPick({ level: levels[i], hours: hours[j === -1 ? hours.length - 1 : j] })
  }
  const key = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!grid || !at) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      onPick(stepCell(grid, at, e.key))
    }
  }

  // Levers: one bracket each in the right margin, from the reader's row to the lever's row.
  const leverX = M.left + pw + 9
  const levers = state.kind === 'ready' ? state.levers.filter((p) => levels.includes(p.level)) : []
  // The reader's row read at 1 / 3 / 7 days: 1d and 7d above the row, 3d below (no collision).
  const readings = grid && you !== null ? rowReading(grid, you) : []

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      tabIndex={grid ? 0 : undefined}
      onClick={pick}
      onKeyDown={key}
      style={{ display: 'block', overflow: 'visible', cursor: grid ? 'pointer' : undefined, outline: 'none' }}
      data-grid-svg=""
    >
      <title>{label}</title>
      <defs>
        {BAND_COVER.map((c, k) => (
          <pattern key={k} id={`ht-${uid}-${k}`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
            <circle cx={PITCH / 2} cy={PITCH / 2} r={dotR(c)} fill={NEWS.ink} />
          </pattern>
        ))}
      </defs>

      {/* captions: rows top-left, columns bottom-right */}
      <text x={M.left} y={M.top - 18} fill={NEWS.muted} style={font}>
        ↓ how far {asset} {verb} · → time from now (log)
      </text>

      {/* the cells */}
      {grid &&
        grid.cells.map((row, i) =>
          row.map((c, j) => (
            <rect
              key={`${c.level}-${c.hours}`}
              x={cols[j].left}
              y={rowY(i)}
              width={Math.max(0, cols[j].right - cols[j].left - 0.5)}
              height={Math.max(0, rowH - 0.5)}
              fill={c.checked ? NEWS.ink : `url(#ht-${uid}-${c.band})`}
              fillOpacity={c.checked ? BAND_COVER[c.band] : 1}
              data-cell={`${c.level}:${c.hours}`}
              data-band={c.band}
              data-checked={c.checked ? 'true' : 'false'}
            />
          )),
        )}
      {!grid && <rect x={M.left} y={M.top} width={pw} height={ph} fill="none" stroke={NEWS.rule} />}

      {/* y: every 5% labelled; the reader's row in the danger ink */}
      {levels.map((L, i) =>
        L % 5 === 0 && (youI < 0 || Math.abs(i - youI) > 1) ? (
          <text key={L} x={M.left - 5} y={rowY(i) + rowH / 2 + 4} textAnchor="end" fill={NEWS.muted} style={font}>
            {sign}
            {L}%
          </text>
        ) : null,
      )}

      {/* x: ticks under their columns; checked columns bold */}
      <line x1={M.left} x2={M.left + pw} y1={floorY} y2={floorY} stroke={NEWS.muted} />
      {hours.map((h, j) => {
        const t = tickOf(h)
        if (!t) return null
        const checked = h === 24 || h === 72 || h === 168
        const last = j === hours.length - 1
        return (
          <g key={h}>
            <line x1={cols[j].mid} x2={cols[j].mid} y1={floorY} y2={floorY + 4} stroke={NEWS.muted} />
            <text
              x={last ? cols[j].right : cols[j].mid}
              y={floorY + 15}
              textAnchor={last ? 'end' : j === 0 ? 'start' : 'middle'}
              fill={checked ? NEWS.ink : NEWS.muted}
              style={{ ...font, fontWeight: checked ? 700 : 400 }}
            >
              {t.label}
            </text>
          </g>
        )
      })}

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

      {/* the reader's row: outlined, labelled on the axis, read at 1 / 3 / 7 days */}
      {grid && youI >= 0 && (
        <g data-you-row={you ?? undefined}>
          <rect x={M.left - 0.5} y={rowY(youI) - 0.75} width={pw + 1} height={rowH + 1.5} fill="none" stroke={NEWS.danger} strokeWidth={1.5} />
          <text x={M.left - 5} y={rowY(youI) + rowH / 2 + 4} textAnchor="end" fill={NEWS.danger} style={{ ...halo, fontWeight: 700 }}>
            {sign}
            {you}%
          </text>
          {readings.map((r) => {
            const j = hours.indexOf(r.hours)
            const last = j === hours.length - 1
            const below = r.horizon === '3d' || youI < 2
            const y = below ? rowY(youI) + rowH + 11 : rowY(youI) - 4
            return (
              <text
                key={r.horizon}
                x={last ? cols[j].right : cols[j].mid}
                y={y}
                textAnchor={last ? 'end' : 'middle'}
                fill={NEWS.danger}
                style={{ ...halo, fontWeight: 700 }}
              >
                {r.horizon} {r.chance}
              </text>
            )
          })}
        </g>
      )}

      {/* levers: a bracket from the reader's row to the row each one moves it to */}
      {grid &&
        youI >= 0 &&
        levers.map((p) => {
          const y0 = rowY(youI) + rowH / 2
          const y1 = rowY(levels.indexOf(p.level)) + rowH / 2
          const x = leverX
          return (
            <g key={p.level} data-lever-row={p.level}>
              <line x1={x} x2={x} y1={y0} y2={y1} stroke={NEWS.accent} strokeWidth={1} />
              <line x1={M.left + pw + 1} x2={x} y1={y0} y2={y0} stroke={NEWS.accent} strokeWidth={1} />
              {p.kinds.map((kind, i) => (
                <LeverMark key={kind} kind={kind} x={x + i * 9} y={y1} />
              ))}
              <line x1={M.left + pw - 4} x2={M.left + pw + 1} y1={y1} y2={y1} stroke={NEWS.accent} strokeWidth={1} />
            </g>
          )
        })}

      {/* the read-out cell */}
      {grid && at && levels.includes(at.level) && hours.includes(at.hours) && (
        <rect
          x={cols[hours.indexOf(at.hours)].left - 1}
          y={rowY(levels.indexOf(at.level)) - 1}
          width={cols[hours.indexOf(at.hours)].right - cols[hours.indexOf(at.hours)].left + 1.5}
          height={rowH + 1.5}
          fill="none"
          stroke={NEWS.ink}
          strokeWidth={1.5}
          style={{ paintOrder: 'stroke' }}
          data-selected=""
        />
      )}
      <text x={M.left + pw} y={height - 2} textAnchor="end" fill={NEWS.muted} style={font}>
        {width >= 360 ? 'tap a cell to read it' : 'tap a cell'}
      </text>
    </svg>
  )
}
