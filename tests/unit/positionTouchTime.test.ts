// The time-to-touch curve (lib/position/touchTime.ts) and its grid
// (lib/position/touchTime.generated.json, scripts/position/build-touch-time.mjs).

import { describe, expect, it } from 'vitest'

import { HORIZON_IDS, TOUCH_TABLE, type HistoryAsset } from '@/lib/position/touchHistory'
import { formatChance, touchAtLevel } from '@/lib/position/touch'
import {
  CHECKED_HORIZON,
  TIME_AXIS,
  TOUCH_TIME_GRID,
  assertTouchTimeGrid,
  readingLine,
  timeLabel,
  timeToTouch,
  type TouchTimeGrid,
} from '@/lib/position/touchTime'

const t = TOUCH_TABLE
const g = TOUCH_TIME_GRID
const ASSETS: HistoryAsset[] = ['ETH', 'BTC']
const DIRS = ['fall', 'rise'] as const

describe('touch time grid', () => {
  it('passes its structural check and is built from the same datasets commit as the table', () => {
    expect(() => assertTouchTimeGrid(g)).not.toThrow()
    expect(g.source.commit).toBe(t.source.commit)
    expect(g.levels).toEqual(t.levels)
  })

  it('reproduces the table counts exactly at 1, 3 and 7 days (same rows, same outcome)', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const [h, id] of Object.entries(CHECKED_HORIZON)) {
          const cell = g.assets[a][d][h]
          const row = t.assets[a][d][id]
          expect(cell.n).toBe(row.n)
          expect(cell.touched).toEqual(row.touched)
        }
  })

  it('spans 1 hour to 7 days', () => {
    expect(g.hours[0]).toBe(TIME_AXIS.fromHours)
    expect(g.hours[g.hours.length - 1]).toBe(TIME_AXIS.toHours)
  })
})

describe('timeToTouch', () => {
  it('is monotone non-decreasing in t, band included, at every level, asset and direction', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (let L = t.levels.min; L <= t.levels.max; L++) {
          const tt = timeToTouch(t, g, a, d, L)
          expect(tt).not.toBeNull()
          const pts = tt!.points
          for (let j = 1; j < pts.length; j++) {
            expect(pts[j].pct).toBeGreaterThanOrEqual(pts[j - 1].pct)
            expect(pts[j].loPct).toBeGreaterThanOrEqual(pts[j - 1].loPct)
            expect(pts[j].hiPct).toBeGreaterThanOrEqual(pts[j - 1].hiPct)
          }
          for (const p of pts) {
            expect(p.loPct).toBeLessThanOrEqual(p.pct)
            expect(p.hiPct).toBeGreaterThanOrEqual(p.pct)
          }
        }
  })

  it('matches the quoted 1/3/7-day figures exactly at those points', () => {
    for (const a of ASSETS)
      for (const d of DIRS)
        for (const L of [1, 5, 14, 20, 35, 60]) {
          const tt = timeToTouch(t, g, a, d, L)!
          for (const [h, id] of Object.entries(CHECKED_HORIZON)) {
            const p = tt.points.find((q) => q.hours === Number(h))!
            const f = touchAtLevel(t, a, d, id as (typeof HORIZON_IDS)[number], L)!
            expect(p.checked).toBe(true)
            expect(p.horizon).toBe(id)
            expect(p.pct).toBe(f.pct)
            expect(p.loPct).toBe(f.loPct)
            expect(p.hiPct).toBe(f.hiPct)
            expect(formatChance((p.pct * p.n) / 100, p.n)).toBe(formatChance(f.touched, f.n))
          }
        }
  })

  it('flags every other point model-only, with no confidence', () => {
    const tt = timeToTouch(t, g, 'ETH', 'fall', 14)!
    const model = tt.points.filter((p) => !p.checked)
    expect(model.length).toBe(g.hours.length - 3)
    for (const p of model) {
      expect(p.horizon).toBeNull()
      expect(p.confidence).toBeNull()
    }
  })

  it('gives null outside the table', () => {
    expect(timeToTouch(t, g, 'ETH', 'fall', 0)).toBeNull()
    expect(timeToTouch(t, g, 'ETH', 'fall', 61)).toBeNull()
    expect(timeToTouch(t, g, 'ETH', 'fall', 2.5)).toBeNull()
  })

  it('reads low early and most of the 7-day chance late for a mid-distance ETH line', () => {
    const tt = timeToTouch(t, g, 'ETH', 'fall', 14)!
    const at = (h: number) => tt.points.find((p) => p.hours === h)!.pct
    expect(at(12)).toBeLessThan(1)
    expect(at(168) - at(48)).toBeGreaterThan(at(48))
    expect(tt.readings.map((r) => r.hours)).toEqual([12, 48, 168])
    expect(tt.readings[2].chance).toBe(formatChance(touchAtLevel(t, 'ETH', 'fall', '7d', 14)!.touched, t.assets.ETH.fall['7d'].n))
    expect(readingLine(tt)).toMatch(/^Under 1% by 12 h · \d+% by day 2 · \d+% by day 7$/)
  })

  it('holds a model-only point that strays above the next checked point', () => {
    // A hand-built grid whose 18 h count exceeds the table's 1-day count.
    const bent: TouchTimeGrid = JSON.parse(JSON.stringify(g))
    const c = bent.assets.ETH.fall['18']
    c.touched[9] = t.assets.ETH.fall['1d'].touched[9] + 50
    c.hi[9] = c.touched[9] + 10
    const tt = timeToTouch(t, bent, 'ETH', 'fall', 10)!
    const p18 = tt.points.find((p) => p.hours === 18)!
    const p24 = tt.points.find((p) => p.hours === 24)!
    expect(p18.pct).toBe(p24.pct)
    expect(p18.hiPct).toBeLessThanOrEqual(p24.hiPct)
  })
})

describe('timeLabel', () => {
  it('reads hours under a day and days from one day', () => {
    expect(timeLabel(1)).toBe('1 h')
    expect(timeLabel(12)).toBe('12 h')
    expect(timeLabel(24)).toBe('day 1')
    expect(timeLabel(48)).toBe('day 2')
    expect(timeLabel(36)).toBe('36 h')
  })
})
