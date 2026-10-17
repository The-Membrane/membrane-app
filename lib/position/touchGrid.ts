/**
 * THE TIME × DEPTH GRID (owner, 2026-10-17: "I'm unsure if we need both chance charts since
 * they overlap but they each contain unique reads; is there a better way to combine them?").
 *
 * The two charts it replaces were two slices of one table: chance by TIME at the reader's
 * depth (touchTime.ts), and chance by DEPTH at 7 days (touch.ts). Both slices are rows and
 * columns of the same surface, so the surface is drawn once:
 *   columns  time from now, the touch-time grid's window lengths, 1 h … 7 days (log axis);
 *   rows     how far the price moves, one row per whole percent, −5% … −35% (widened to the
 *            reader's line and to where each lever moves it, up to the table's 60%);
 *   cell     the chance the line is touched by then, as an ink band.
 * The reader's row IS the old time curve; the 7-day column IS the old depth curve; the
 * levers are rows the reader's row would move to. Nothing new is modelled: every cell is
 * timeToTouch's point (the table's cell at 1, 3 and 7 days; the grid's elsewhere).
 *
 * MONOTONE BOTH WAYS. Along a row the chance never falls with time (timeToTouch holds it);
 * down a column it never rises with depth (a deeper fall touched is a shallower one touched).
 * Raw counts already obey the second; timeToTouch's time repair could break it by a count,
 * so each row is held at or under the row above. The checked cells (the table's) are
 * monotone in depth already, so the hold never moves one of them.
 *
 * Pure: no React, no I/O.
 */

import { formatBand, formatChance } from './touch'
import type { Direction, HistoryAsset, HorizonId, TouchTable } from './touchHistory'
import { TIME_AXIS, timeLabel, timeToTouch, type TimePoint, type TouchTimeGrid } from './touchTime'

/** The rows shown by default (FORECAST_VISUALS.md's depth range, deepened to −35%). */
export const GRID_DEPTH = { from: 5, to: 35 } as const

/**
 * The ink bands a cell is drawn in. A band is named by what formatChance prints, so a
 * cell's colour and its readout always agree ("<1%" is band 0, never "0%").
 */
export const CHANCE_BANDS: readonly { upTo: number; label: string }[] = [
  { upTo: 1, label: '<1%' },
  { upTo: 5, label: '1–5%' },
  { upTo: 10, label: '5–10%' },
  { upTo: 25, label: '10–25%' },
  { upTo: 50, label: '25–50%' },
  { upTo: Infinity, label: '50%+' },
]

/**
 * The band of a chance, from the figure formatChance prints for it: "<1%" → 0; a printed
 * 1–4% → 1; 5–9% → 2; 10–24% → 3; 25–49% → 4; 50% and up → 5.
 */
export function chanceBand(pct: number, n: number): number {
  const shown = formatChance((pct * n) / 100, n)
  if (shown === '<1%') return 0
  const v = Number.parseInt(shown, 10)
  const i = CHANCE_BANDS.findIndex((b) => v < b.upTo)
  return i === 0 ? 1 : i
}

export interface GridCell extends TimePoint {
  level: number
  band: number
}

export interface TouchGrid {
  asset: HistoryAsset
  direction: Direction
  /** Column hours, ascending. */
  hours: number[]
  /** Row levels, ascending (shallow first). */
  levels: number[]
  /** cells[row][col] */
  cells: GridCell[][]
}

/** Rows to show: the default depth range, widened to every level given, inside the table. */
export function gridRange(t: TouchTable, marks: readonly (number | null)[]): { from: number; to: number } {
  const xs = marks.filter((x): x is number => x !== null && Number.isFinite(x))
  return {
    from: Math.max(t.levels.min, Math.min(GRID_DEPTH.from, ...xs)),
    to: Math.min(t.levels.max, Math.max(GRID_DEPTH.to, ...xs)),
  }
}

/** The grid over `range` (whole levels). Throws when a row has no table cells. */
export function touchGrid(
  t: TouchTable,
  g: TouchTimeGrid,
  asset: HistoryAsset,
  direction: Direction,
  range: { from: number; to: number },
): TouchGrid {
  const levels: number[] = []
  for (let L = range.from; L <= range.to; L++) levels.push(L)
  const cells: GridCell[][] = []
  for (const L of levels) {
    const tt = timeToTouch(t, g, asset, direction, L)
    if (!tt) throw new Error(`touchGrid: no row at ${L}%`)
    const above = cells[cells.length - 1]
    cells.push(
      tt.points.map((p, j) => {
        const q = { ...p }
        if (above) {
          // Held at or under the row above, point and band edges alike.
          q.pct = Math.min(q.pct, above[j].pct)
          q.loPct = Math.min(q.loPct, above[j].loPct)
          q.hiPct = Math.min(q.hiPct, above[j].hiPct)
          q.loPct = Math.min(q.loPct, q.pct)
          q.hiPct = Math.max(q.hiPct, q.pct)
        }
        return { ...q, level: L, band: chanceBand(q.pct, q.n) }
      }),
    )
  }
  const hours = cells[0]?.map((c) => c.hours) ?? []
  return { asset, direction, hours, levels, cells }
}

/** The cell at a row level and column hours, or null outside the grid. */
export function cellAt(grid: TouchGrid, level: number, hours: number): GridCell | null {
  const i = grid.levels.indexOf(level)
  const j = grid.hours.indexOf(hours)
  return i < 0 || j < 0 ? null : grid.cells[i][j]
}

/** "within 7 days" for a checked column; "by 12 h" / "by day 2" elsewhere. */
export function cellWhen(c: Pick<GridCell, 'hours' | 'horizon'>): string {
  const d = c.hours / 24
  if (c.hours === TIME_AXIS.toHours || (Number.isInteger(d) && d >= 1)) return d === 1 ? 'within 1 day' : `within ${d} days`
  return `within ${timeLabel(c.hours).replace(' h', ' hours').replace(/^1 hours$/, '1 hour')}`
}

/** Counts behind a cell's point and band (formatChance and formatBand take counts). */
const counts = (c: GridCell) => ({ touched: (c.pct * c.n) / 100, lo: (c.loPct * c.n) / 100, hi: (c.hiPct * c.n) / 100 })

/** "3%", the cell as the page prints it. */
export const cellChance = (c: GridCell): string => formatChance(counts(c).touched, c.n)
/** "1–6%", the cell's likely range as the page prints it. */
export const cellBand = (c: GridCell): string => {
  const k = counts(c)
  return formatBand(k.lo, k.hi, c.n)
}

/**
 * The readout of one cell, the words a tap prints: "ETH falls 18% within 2 days: 3%
 * (likely 2–5%) · model-only". A checked cell says what checks it.
 */
export function readCell(grid: Pick<TouchGrid, 'asset' | 'direction'>, c: GridCell): string {
  const verb = grid.direction === 'fall' ? 'falls' : 'rises'
  const mark = c.checked ? 'checked against 2024–26 outcomes (preliminary)' : 'model-only, no outcome check'
  return `${grid.asset} ${verb} ${c.level}% ${cellWhen(c)}: ${cellChance(c)} (likely ${cellBand(c)}) · ${mark}`
}

/** The reader's row read at the checked columns: "1d <1% · 3d 3% · 7d 14%". */
export function rowReading(grid: TouchGrid, level: number): { horizon: HorizonId; chance: string; hours: number }[] {
  const i = grid.levels.indexOf(level)
  if (i < 0) return []
  return grid.cells[i].filter((c) => c.checked && c.horizon).map((c) => ({ horizon: c.horizon as HorizonId, chance: cellChance(c), hours: c.hours }))
}

/** Move a selection by one cell, clamped to the grid (arrow keys). */
export function stepCell(
  grid: Pick<TouchGrid, 'levels' | 'hours'>,
  at: { level: number; hours: number },
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight',
): { level: number; hours: number } {
  const i = Math.max(0, grid.levels.indexOf(at.level))
  const j = Math.max(0, grid.hours.indexOf(at.hours))
  const di = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
  const dj = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
  const ni = Math.min(grid.levels.length - 1, Math.max(0, i + di))
  const nj = Math.min(grid.hours.length - 1, Math.max(0, j + dj))
  return { level: grid.levels[ni], hours: grid.hours[nj] }
}
