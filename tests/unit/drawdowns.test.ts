/**
 * drawdowns — the pure statistics behind the set-and-forget LTV sim. Every expectation is
 * worked by hand from the GRID CONVENTION in lib/position-sim/drawdowns.ts (close = price at
 * the step's END, low/high = range inside the step), and the O(n) sliding-window paths are
 * checked against brute force on seeded random walks.
 */
import { describe, expect, it } from 'vitest'

import {
  DRAWDOWN_WINDOWS,
  coverage,
  detectDropEvents,
  drawdownStats,
  drawdownTable,
  forwardDrawdowns,
  gridFromFile,
  historyReplayShape,
  indexAt,
  intrabarWicks,
  ltvBandToPriceBand,
  primaryGrid,
  quantileSorted,
  recoveryCurve,
  rollingMaxDrawdown,
  seriesDiffStats,
  sliceGrid,
  wilsonInterval,
  worstWindows,
  type PriceGrid,
  type PriceHistoryFile,
} from '@/lib/position-sim/drawdowns'
import { runStress, type StressPosition } from '@/lib/position-sim/stressGrid'

const T0 = 1_577_836_800 // 2020-01-01T00:00Z
const grid = (
  close: (number | null)[],
  low?: (number | null)[],
  high?: (number | null)[],
): PriceGrid => ({
  startTs: T0,
  stepSeconds: 3600,
  close,
  low,
  high,
})

/** Seeded random walk with intra-step lows/highs (mulberry32). */
function walk(n: number, seed: number): PriceGrid {
  let s = seed >>> 0
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const close: number[] = []
  const low: number[] = []
  const high: number[] = []
  let p = 100
  for (let i = 0; i < n; i++) {
    const open = p
    p = p * Math.exp((rnd() - 0.5) * 0.06)
    close.push(p)
    low.push(Math.min(open, p) * (1 - rnd() * 0.03))
    high.push(Math.max(open, p) * (1 + rnd() * 0.03))
  }
  return grid(close, low, high)
}

function bruteForward(g: PriceGrid, w: number): number[] {
  const n = g.close.length
  return g.close.map((c, t) => {
    if (c == null || t + w >= n) return NaN
    let m = Infinity
    for (let s = t + 1; s <= t + w; s++) m = Math.min(m, (g.low?.[s] ?? g.close[s]) as number)
    return Math.max(0, 1 - m / c)
  })
}

describe('quantileSorted', () => {
  it('interpolates linearly (type 7)', () => {
    expect(quantileSorted([0, 1, 2, 3, 4], 0.5)).toBe(2)
    expect(quantileSorted([0, 1, 2, 3, 4], 0.9)).toBeCloseTo(3.6, 12)
    expect(quantileSorted([7], 0.99)).toBe(7)
    expect(quantileSorted([], 0.5)).toBeNaN()
  })
})

describe('forwardDrawdowns', () => {
  it('is entry close → lowest later low, floored at 0, NaN past the end', () => {
    const g = grid([100, 90, 95, 80, 100])
    const d1 = forwardDrawdowns(g, 1)
    expect(d1[0]).toBeCloseTo(0.1, 12)
    expect(d1[1]).toBe(0) // 95 above 90: no drawdown
    expect(d1[2]).toBeCloseTo(1 - 80 / 95, 12)
    expect(d1[3]).toBe(0)
    expect(d1[4]).toBeNaN() // window runs past the grid
    const d2 = forwardDrawdowns(g, 2)
    expect(d2[1]).toBeCloseTo(1 - 80 / 90, 12)
    expect(d2[3]).toBeNaN()
  })

  it('reads the intra-step LOW, not the close, for the trough', () => {
    const g = grid([100, 99, 100], [100, 85, 98])
    expect(forwardDrawdowns(g, 1)[0]).toBeCloseTo(0.15, 12)
  })

  it('skips missing entries and falls back to close where a low is missing', () => {
    const g = grid([100, null, 90, 95], [null, null, null, 93])
    const d = forwardDrawdowns(g, 2)
    expect(d[0]).toBeCloseTo(0.1, 12) // step 1 has nothing; step 2's close stands in
    expect(d[1]).toBeNaN() // no entry close
  })

  it('matches brute force on random walks', () => {
    for (const seed of [1, 7, 42]) {
      const g = walk(600, seed)
      for (const w of [1, 3, 8, 24, 100]) {
        const fast = forwardDrawdowns(g, w)
        const slow = bruteForward(g, w)
        for (let i = 0; i < slow.length; i++) {
          if (Number.isNaN(slow[i])) expect(fast[i]).toBeNaN()
          else expect(fast[i]).toBeCloseTo(slow[i], 12)
        }
      }
    }
  })
})

describe('rollingMaxDrawdown', () => {
  it('measures running-close peak to later low inside the window', () => {
    const g = grid([100, 120, 90, 130, 100])
    const r = rollingMaxDrawdown(g, 4)
    expect(r[3]).toBeNaN()
    expect(r[4]).toBeCloseTo(0.25, 12) // 120 → 90; the later 130 → 100 is 23.1%
  })

  it('a step low is judged against the peak BEFORE its own close', () => {
    // step 1 dips to 95 then closes at 130: the dip is 5% off the 100 open, not 27% off 130.
    const g = grid([100, 130], [100, 95])
    expect(rollingMaxDrawdown(g, 1)[1]).toBeCloseTo(0.05, 12)
  })

  it('bounds the forward drawdown of its first step and shares its maximum', () => {
    const g = walk(800, 9)
    for (const w of [8, 24, 168]) {
      const fwd = forwardDrawdowns(g, w)
      const rol = rollingMaxDrawdown(g, w)
      let maxF = 0
      let maxR = 0
      for (let t = 0; t + w < 800; t++) {
        expect(rol[t + w]).toBeGreaterThanOrEqual(fwd[t] - 1e-12)
        maxF = Math.max(maxF, fwd[t])
      }
      for (let t = w; t < 800; t++) maxR = Math.max(maxR, rol[t])
      expect(maxR).toBeGreaterThanOrEqual(maxF - 1e-12)
    }
  })
})

describe('drawdownStats / drawdownTable', () => {
  it('reports quantiles, effective sample size and where the max sits', () => {
    const s = drawdownStats([0.1, NaN, 0.3, 0.2, 0], 2, { startTs: T0, stepSeconds: 3600 })
    expect(s.n).toBe(4)
    expect(s.effectiveN).toBe(2)
    expect(s.max).toBe(0.3)
    expect(s.maxIndex).toBe(2)
    expect(s.maxTs).toBe(T0 + 2 * 3600)
    expect(s.p50).toBeCloseTo(0.15, 12)
  })

  it('covers the owner windows in order and slices by index', () => {
    const g = walk(2000, 3)
    const rows = drawdownTable(g)
    expect(rows.map((r) => r.label)).toEqual(DRAWDOWN_WINDOWS.map((w) => w.label))
    for (const r of rows) {
      expect(r.p50).toBeLessThanOrEqual(r.p90)
      expect(r.p90).toBeLessThanOrEqual(r.p99)
      expect(r.p99).toBeLessThanOrEqual(r.max)
    }
    // A longer window sees a deeper typical drawdown.
    expect(rows[rows.length - 1].p50).toBeGreaterThan(rows[0].p50)
    const sub = drawdownTable(g, { fromIndex: 1000, windows: [{ label: '8h', hours: 8 }] })[0]
    expect(sub.n).toBe(1000 - 8)
    expect(sub.maxTs).toBeGreaterThanOrEqual(T0 + 1000 * 3600)
    expect(drawdownTable(g, { mode: 'rolling' })[0].mode).toBe('rolling')
  })

  it('sliceGrid re-bases the timestamp', () => {
    const g = grid([1, 2, 3, 4], [1, 2, 3, 4])
    const s = sliceGrid(g, 1, 2)
    expect(s.startTs).toBe(T0 + 3600)
    expect(s.close).toEqual([2, 3])
    expect(s.low).toEqual([2, 3])
  })
})

describe('worstWindows', () => {
  it('returns non-overlapping crashes, deepest first, with their trough', () => {
    const close = new Array(100).fill(100)
    close[20] = 70 // 30% at step 20
    close[21] = 75
    close[70] = 80 // 20% at step 70
    const ww = worstWindows(grid(close), 5, 3)
    expect(ww.length).toBe(2)
    expect(ww[0].drop).toBeCloseTo(0.3, 12)
    expect(ww[0].troughIndex).toBe(20)
    expect(ww[0].troughPrice).toBe(70)
    expect(ww[1].drop).toBeCloseTo(0.2, 12)
    expect(ww[1].troughTs).toBe(T0 + 70 * 3600)
  })
})

describe('detectDropEvents', () => {
  const flat = (n: number, p = 100) => new Array(n).fill(p)

  it('a 12% dip that closes back within 4% inside 8h is a wick', () => {
    const close = [...flat(30), 89, 92, 95, 97, ...flat(20, 97)]
    const low = [...flat(30), 88, 90, 94, 96, ...flat(20, 97)]
    const [e, ...rest] = detectDropEvents(grid(close, low), { drop: 0.1 })
    expect(rest).toEqual([])
    expect(e.index).toBe(30)
    expect(e.refPrice).toBe(100)
    expect(e.troughPrice).toBe(88)
    expect(e.maxDrop).toBeCloseTo(0.12, 12)
    expect(e.recovered).toBe(true)
    expect(e.recoveredIndex).toBe(33) // first close >= 96
    expect(e.stepsToRecover).toBe(4)
    expect(e.kind).toBe('wick')
  })

  it('a fall that stays down is sustained, and one crash is ONE event (de-clustered)', () => {
    const close = [...flat(30), ...flat(40, 89)]
    const ev = detectDropEvents(grid(close), { drop: 0.1 })
    expect(ev.length).toBe(1)
    expect(ev[0].kind).toBe('sustained')
    expect(ev[0].recoveredIndex).toBeNull()
    // A fresh 10% leg off the new level is a new event.
    const twoLegs = [...flat(30), ...flat(40, 89), ...flat(30, 79)]
    const ev2 = detectDropEvents(grid(twoLegs), { drop: 0.1 })
    expect(ev2.map((e) => [e.index, e.refPrice])).toEqual([
      [30, 100],
      [70, 89],
    ])
  })

  it('counts recovery only inside the window (8 steps from the event step)', () => {
    const at = (k: number) => [...flat(30), ...flat(k, 89), ...flat(20, 96)]
    expect(detectDropEvents(grid(at(7)), { drop: 0.1 })[0].recovered).toBe(true) // close 96 at step 37
    expect(detectDropEvents(grid(at(8)), { drop: 0.1 })[0].recovered).toBe(false) // step 38: too late
    expect(detectDropEvents(grid(at(8)), { drop: 0.1, windowSteps: 9 })[0].recovered).toBe(true)
  })

  it("'high' counts a later touch but never the event step's own high", () => {
    const close = [...flat(30), 89, 90, ...flat(20, 90)]
    const high = [...flat(30), 99, 96.5, ...flat(20, 90)]
    const g = grid(close, undefined, high)
    expect(detectDropEvents(g, { drop: 0.1 })[0].recovered).toBe(false)
    const e = detectDropEvents(g, { drop: 0.1, recoverOn: 'high' })[0]
    expect(e.recoveredIndex).toBe(31)
  })

  it('drops an event whose window would run past the grid', () => {
    expect(detectDropEvents(grid([...flat(30), 89, 89]), { drop: 0.1 })).toEqual([])
  })

  it('the band defaults to the 4% engine constant', () => {
    const close = [...flat(30), 89, 95.9, 95.9, 95.9, 95.9, 95.9, 95.9, 95.9, 95.9]
    expect(detectDropEvents(grid(close), { drop: 0.1 })[0].recovered).toBe(false)
    expect(detectDropEvents(grid(close), { drop: 0.1, band: 0.05 })[0].recovered).toBe(true)
  })
})

describe('recoveryCurve / wilsonInterval / ltvBandToPriceBand', () => {
  it('turns events into P(recover | drop) with a Wilson interval', () => {
    const flat = (n: number, p = 100) => new Array(n).fill(p)
    // Two 12% dips: one recovers, one does not.
    const close = [...flat(30), 88, 97, ...flat(30, 97), 85, ...flat(20, 85)]
    const rows = recoveryCurve(grid(close), [0.1, 0.5])
    expect(rows[0].events).toBe(2)
    expect(rows[0].recovered).toBe(1)
    expect(rows[0].p).toBe(0.5)
    expect(rows[0].medianStepsToRecover).toBe(2)
    const [lo, hi] = wilsonInterval(1, 2)
    expect(rows[0].ciLow).toBe(lo)
    expect(rows[0].ciHigh).toBe(hi)
    expect(rows[1].events).toBe(0)
    expect(rows[1].p).toBeNaN()
  })

  it('wilson matches the textbook values', () => {
    const [a, b] = wilsonInterval(5, 10)
    expect(a).toBeCloseTo(0.2366, 4)
    expect(b).toBeCloseTo(0.7634, 4)
    expect(wilsonInterval(0, 10)[0]).toBeCloseTo(0, 12)
    expect(wilsonInterval(0, 10)[1]).toBeCloseTo(0.2775, 4)
    expect(wilsonInterval(0, 0)[0]).toBeNaN()
  })

  it('an LTV band b is a b/(1+b) price band', () => {
    expect(ltvBandToPriceBand(0.04)).toBeCloseTo(0.0384615, 6)
  })
})

describe('intrabarWicks', () => {
  it('flags a step that dips below both ends by at least minDepth', () => {
    const g = grid([100, 99, 99], [100, 90, 98])
    const w = intrabarWicks(g, 0.05)
    expect(w).toHaveLength(1)
    expect(w[0].index).toBe(1)
    expect(w[0].depth).toBeCloseTo(1 - 90 / 99, 12)
  })
})

describe('seriesDiffStats', () => {
  it('compares only steps both series observe, in bps of b', () => {
    const s = seriesDiffStats([101, 99, null, 100], [100, 100, 100, null], {
      startTs: T0,
      stepSeconds: 3600,
    })
    expect(s.n).toBe(2)
    expect(s.meanBps).toBeCloseTo(0, 9)
    expect(s.medianAbsBps).toBeCloseTo(100, 9)
    expect(s.maxIndex).toBe(0)
    expect(s.maxTs).toBe(T0)
    const r = seriesDiffStats(
      [101, 99],
      [100, 100],
      { startTs: T0, stepSeconds: 3600 },
      { fromIndex: 1 },
    )
    expect(r.n).toBe(1)
    expect(r.meanBps).toBeCloseTo(-100, 9)
  })
})

describe('file helpers', () => {
  const file: PriceHistoryFile = {
    asset: 'ETH/USD',
    startTs: T0,
    stepSeconds: 3600,
    count: 4,
    columns: {
      oracle: [null, null, 300, 310],
      oracleLow: [null, null, 295, 300],
      oracleHigh: [null, null, 305, 312],
      coinbase: [280, 290, 301, 311],
      coinbaseLow: [270, 285, 296, 299],
      coinbaseHigh: [282, 292, 306, 313],
    },
    primary: {
      segments: [
        { source: 'coinbase', fromIndex: 0, toIndex: 1 },
        { source: 'oracle', fromIndex: 2, toIndex: 3 },
      ],
    },
  }

  it('primaryGrid stitches the named sources by segment', () => {
    const p = primaryGrid(file)
    expect(p.close).toEqual([280, 290, 300, 310])
    expect(p.low).toEqual([270, 285, 295, 300])
    expect(p.high).toEqual([282, 292, 305, 312])
    expect(p.segments).toHaveLength(2)
  })

  it('gridFromFile / coverage / indexAt', () => {
    const o = gridFromFile(file, 'oracle')
    expect(coverage(o)).toEqual({ fromIndex: 2, toIndex: 3 })
    expect(indexAt(o, T0 + 2 * 3600 + 59)).toBe(2)
    expect(() => gridFromFile(file, 'binance')).toThrow(/no 'binance' column/)
    const bad = {
      ...file,
      primary: { segments: [{ source: 'binance' as const, fromIndex: 0, toIndex: 1 }] },
    }
    expect(() => primaryGrid(bad)).toThrow(/missing 'binance'/)
  })
})

describe('historyReplayShape → runStress', () => {
  const position: StressPosition = {
    collateralUsd: 100_000,
    debtUsd: 61_300, // LTV 0.613 against a 0.80 line
    line: 0.8,
    membraneClass: 'delayed',
    tradeShape: 'levered_long',
    debtMinimumUsd: 2000,
  }

  it('builds entry-relative ratios (closes, or lows) and returns null without an entry', () => {
    const g = grid([200, 180, null, 150], [200, 170, null, 140])
    const s = historyReplayShape(g, 0, 3, { id: 't' })
    expect(s).toEqual({ kind: 'replay', id: 't', stepSeconds: 3600, ratios: [1, 0.9, null, 0.75] })
    const lows = historyReplayShape(g, 0, 3, { id: 't', use: 'low' })
    expect(lows && lows.kind === 'replay' ? lows.ratios : null).toEqual([1, 0.85, null, 0.7])
    expect(historyReplayShape(g, 2, 3, { id: 'x' })).toBeNull()
    expect(historyReplayShape(g, 3, 3, { id: 'x' })).toBeNull()
  })

  it('a measured crash replays through the stress engine', () => {
    const crash = grid([100, 90, 80, 70, 70, 70])
    const shallow = grid([100, 98, 96, 95, 97, 99])
    const hit = runStress(position, { price: historyReplayShape(crash, 0, 5, { id: 'crash' })! })
    const miss = runStress(position, { price: historyReplayShape(shallow, 0, 5, { id: 'dip' })! })
    // 0.613 / 0.70 = 0.876, past the 0.80 × 1.04 = 0.832 break band: an immediate sale.
    expect(hit.outcome).toBe('sold')
    expect(miss.outcome).toBe('no_breach')
  })
})
