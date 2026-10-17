// The time × depth grid (lib/position/touchGrid.ts): the one chance chart's cell model,
// and the data-age line (lib/position/touchHistory.ts).

import { describe, expect, it } from 'vitest'

import { formatChance, touchAtLevel } from '@/lib/position/touch'
import { TOUCH_TABLE, dataAgeDays, dataAgeLine, isStale, staleOn, type HistoryAsset } from '@/lib/position/touchHistory'
import {
  CHANCE_BANDS,
  GRID_DEPTH,
  cellAt,
  cellChance,
  chanceBand,
  gridRange,
  readCell,
  rowReading,
  stepCell,
  touchGrid,
} from '@/lib/position/touchGrid'
import { TOUCH_TIME_GRID, timeToTouch } from '@/lib/position/touchTime'

const t = TOUCH_TABLE
const g = TOUCH_TIME_GRID
const ASSETS: HistoryAsset[] = ['ETH', 'BTC']
const DIRS = ['fall', 'rise'] as const

describe('chanceBand', () => {
  it('names a band by what formatChance prints', () => {
    const n = 1000
    expect(chanceBand(0, n)).toBe(0)
    expect(chanceBand(0.5, n)).toBe(0) // "<1%"
    expect(chanceBand(1, n)).toBe(1)
    expect(chanceBand(4.9, n)).toBe(2) // prints "5%"
    expect(chanceBand(9, n)).toBe(2)
    expect(chanceBand(10, n)).toBe(3)
    expect(chanceBand(24, n)).toBe(3)
    expect(chanceBand(25, n)).toBe(4)
    expect(chanceBand(50, n)).toBe(5)
    expect(chanceBand(100, n)).toBe(5)
    expect(CHANCE_BANDS).toHaveLength(6)
  })
})

describe('touchGrid', () => {
  it('covers the default rows and the grid hours, 1 h to 7 days', () => {
    const grid = touchGrid(t, g, 'ETH', 'fall', GRID_DEPTH)
    expect(grid.levels[0]).toBe(5)
    expect(grid.levels[grid.levels.length - 1]).toBe(35)
    expect(grid.hours[0]).toBe(1)
    expect(grid.hours[grid.hours.length - 1]).toBe(168)
    expect(grid.cells).toHaveLength(31)
    for (const row of grid.cells) expect(row).toHaveLength(grid.hours.length)
  })

  it('is the table exactly at 1, 3 and 7 days, and flags only those cells checked', () => {
    for (const a of ASSETS)
      for (const d of DIRS) {
        const grid = touchGrid(t, g, a, d, { from: 1, to: 60 })
        for (const row of grid.cells)
          for (const c of row) {
            expect(c.checked).toBe(c.hours === 24 || c.hours === 72 || c.hours === 168)
            if (!c.checked) continue
            const f = touchAtLevel(t, a, d, c.horizon!, c.level)!
            expect(c.pct).toBeCloseTo(f.pct, 9)
            expect(c.loPct).toBeCloseTo(f.loPct, 9)
            expect(c.hiPct).toBeCloseTo(f.hiPct, 9)
          }
      }
  })

  it('never falls with time along a row, never rises with depth down a column, band edges too', () => {
    for (const a of ASSETS)
      for (const d of DIRS) {
        const grid = touchGrid(t, g, a, d, { from: 1, to: 60 })
        grid.cells.forEach((row, i) =>
          row.forEach((c, j) => {
            for (const k of ['pct', 'loPct', 'hiPct'] as const) {
              if (j > 0) expect(c[k]).toBeGreaterThanOrEqual(row[j - 1][k] - 1e-9)
              if (i > 0) expect(c[k]).toBeLessThanOrEqual(grid.cells[i - 1][j][k] + 1e-9)
            }
            expect(c.loPct).toBeLessThanOrEqual(c.pct + 1e-9)
            expect(c.hiPct).toBeGreaterThanOrEqual(c.pct - 1e-9)
            expect(c.band).toBe(chanceBand(c.pct, c.n))
          }),
        )
      }
  })

  it("keeps a row the reader's time curve wherever that curve is already monotone in depth", () => {
    const grid = touchGrid(t, g, 'ETH', 'fall', GRID_DEPTH)
    const tt = timeToTouch(t, g, 'ETH', 'fall', 5)!
    // The first row has nothing above it: it IS the time curve.
    tt.points.forEach((p, j) => expect(grid.cells[0][j].pct).toBe(p.pct))
  })

  it('throws for a row outside the table', () => {
    expect(() => touchGrid(t, g, 'ETH', 'fall', { from: 50, to: 61 })).toThrow(/61/)
  })
})

describe('gridRange', () => {
  it('widens the default rows to the reader and the levers, inside the table', () => {
    expect(gridRange(t, [])).toEqual(GRID_DEPTH)
    expect(gridRange(t, [21, null])).toEqual(GRID_DEPTH)
    expect(gridRange(t, [3, 42])).toEqual({ from: 3, to: 42 })
    expect(gridRange(t, [80])).toEqual({ from: 5, to: t.levels.max })
  })
})

describe('cells read out', () => {
  const grid = touchGrid(t, g, 'ETH', 'fall', GRID_DEPTH)

  it('prints the figure the page prints and says checked or model-only', () => {
    const c = cellAt(grid, 20, 168)!
    const f = touchAtLevel(t, 'ETH', 'fall', '7d', 20)!
    expect(cellChance(c)).toBe(formatChance(f.touched, f.n))
    expect(readCell(grid, c)).toMatch(/^ETH falls 20% within 7 days: .+ \(likely .+\) · checked against 2024–26 outcomes/)
    const m = cellAt(grid, 20, 12)!
    expect(readCell(grid, m)).toMatch(/within 12 hours: .+ · model-only, no outcome check$/)
    expect(readCell(grid, cellAt(grid, 10, 1)!)).toMatch(/within 1 hour:/)
    expect(readCell(grid, cellAt(grid, 10, 36)!)).toMatch(/within 36 hours:/)
    expect(cellAt(grid, 4, 168)).toBeNull()
    expect(cellAt(grid, 20, 5)).toBeNull()
  })

  it("reads the reader's row at 1, 3 and 7 days", () => {
    const r = rowReading(grid, 20)
    expect(r.map((x) => x.horizon)).toEqual(['1d', '3d', '7d'])
    expect(r[2].chance).toBe(cellChance(cellAt(grid, 20, 168)!))
    expect(rowReading(grid, 99)).toEqual([])
  })

  it('steps a selection one cell at a time, clamped to the grid', () => {
    expect(stepCell(grid, { level: 20, hours: 168 }, 'ArrowRight')).toEqual({ level: 20, hours: 168 })
    expect(stepCell(grid, { level: 20, hours: 168 }, 'ArrowLeft')).toEqual({ level: 20, hours: 144 })
    expect(stepCell(grid, { level: 5, hours: 1 }, 'ArrowUp')).toEqual({ level: 5, hours: 1 })
    expect(stepCell(grid, { level: 5, hours: 1 }, 'ArrowDown')).toEqual({ level: 6, hours: 1 })
  })
})

describe('data age', () => {
  const end = Date.parse(t.period.dataEnd)
  const day = 86_400_000

  it('counts whole days since the last observed hour and dates STALE one span after it', () => {
    expect(dataAgeDays(t, end + 11 * day + 5)).toBe(11)
    expect(dataAgeDays(t, end - day)).toBe(0)
    expect(staleOn(t)).toBe(new Date(end + 30 * day).toISOString().slice(0, 10))
  })

  it('agrees with isStale at the boundary', () => {
    expect(isStale(t, end + 30 * day)).toBe(false)
    expect(isStale(t, end + 30 * day + 1)).toBe(true)
    expect(dataAgeLine(t, end + 30 * day)).toMatch(/· 30 days old · STALE from /)
    expect(dataAgeLine(t, end + 45 * day)).toMatch(/· 45 days old · STALE since /)
    expect(dataAgeLine(t, end + day)).toMatch(/^History through \d{4}-\d{2}-\d{2} · 1 day old/)
  })
})
