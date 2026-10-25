// components/PositionV0/curveLayout.ts — the curve's marks never stack: the reader's ring,
// each lever group, each label and each moved point's dot keep clear of one another,
// including when points coincide. Also the two helpers that feed it (forecastMarks.ts).

import { describe, expect, it } from 'vitest'

import { MARK, inside, layoutCurveMarks, overlaps, type CurveLayout, type LayoutInput, type LeverKind, type Rect } from '@/components/PositionV0/curveLayout'
import { chanceCells, curveMarks } from '@/components/PositionV0/forecastMarks'
import { buildPositionView } from '@/components/PositionV0/viewModel'
import type { CollateralLeg, DebtLeg, ProtocolPosition } from '@/lib/position-sim/types'
import { formatBand, formatChance } from '@/lib/position/touch'
import { HORIZON_IDS, TOUCH_TABLE } from '@/lib/position/touchHistory'

/** The phone plot: a 358px column less the chart's margins (34 left, 10 right; 18 top, 40 bottom of 170). */
const PHONE: Rect = { x: 34, y: 18, w: 314, h: 112 }
const METRICS = { charW: 6.6, lineH: 12 }

/** Every footprint the layout drew, named, so a failure says which two collide. */
function footprints(l: CurveLayout): { name: string; r: Rect }[] {
  const out: { name: string; r: Rect }[] = []
  if (l.you) out.push({ name: 'ring', r: l.you.ring }, { name: 'your label', r: l.you.label.box })
  for (const p of l.levers) {
    out.push({ name: `group ${p.id}`, r: p.box }, { name: `label ${p.id}`, r: p.label.box })
    if (p.dot) out.push({ name: `dot ${p.id}`, r: { x: p.point.x - MARK.dotR, y: p.point.y - MARK.dotR, w: MARK.dotR * 2, h: MARK.dotR * 2 } })
  }
  return out
}

function expectClear(input: LayoutInput, l: CurveLayout) {
  const fp = [...(input.obstacles ?? []).map((r, i) => ({ name: `obstacle ${i}`, r })), ...footprints(l)]
  for (let i = 0; i < fp.length; i++) {
    for (let j = i + 1; j < fp.length; j++) {
      if (overlaps(fp[i].r, fp[j].r)) throw new Error(`${fp[i].name} overlaps ${fp[j].name}`)
    }
  }
  if (l.you) expect(inside(l.you.label.box, input.bounds)).toBe(true)
  for (const p of l.levers) {
    expect(inside(p.label.box, input.bounds)).toBe(true)
    // Markers of one group sit side by side, never on each other.
    for (let i = 1; i < p.markers.length; i++) expect(p.markers[i].x - p.markers[i - 1].x).toBeGreaterThanOrEqual(MARK.lever)
    if (p.moved) {
      // A moved group stays in the plot, leaves its point in view and leads back to it.
      expect(inside(p.box, input.bounds)).toBe(true)
      expect(p.point.x >= p.box.x && p.point.x <= p.box.x + p.box.w && p.point.y >= p.box.y && p.point.y <= p.box.y + p.box.h).toBe(false)
      expect(p.leader).not.toBeNull()
      expect(p.leader!.x2).toBe(p.point.x)
      expect(p.leader!.y2).toBe(p.point.y)
    } else {
      expect(p.leader).toBeNull()
      expect(p.box.x + p.box.w / 2).toBeCloseTo(p.point.x, 9)
      expect(p.box.y + p.box.h / 2).toBeCloseTo(p.point.y, 9)
    }
  }
}

const lever = (id: string, x: number, y: number, kinds: LeverKind[], label = '→ 5%') => ({ id, x, y, kinds, label })

describe('curve marks: coincident points', () => {
  it('a repay and a top-up on the same point: two markers side by side, on the point', () => {
    const input: LayoutInput = { bounds: PHONE, you: null, levers: [lever('22', 200, 80, ['add', 'repay'])], ...METRICS }
    const l = layoutCurveMarks(input)
    expectClear(input, l)
    const [p] = l.levers
    expect(p.moved).toBe(false)
    expect(p.markers.map((m) => m.kind)).toEqual(['repay', 'add']) // LEVER_KINDS order, whatever the input order
    expect(p.markers[0].x).toBeLessThan(200)
    expect(p.markers[1].x).toBeGreaterThan(200)
  })

  it('a lever point exactly on the ring moves off it; the ring stays put', () => {
    const input: LayoutInput = {
      bounds: PHONE,
      you: { x: 150, y: 70, label: 'your line −21% · 6%' },
      levers: [lever('21', 150, 70, ['repay', 'add'])],
      ...METRICS,
    }
    const l = layoutCurveMarks(input)
    expectClear(input, l)
    expect(l.you).toMatchObject({ x: 150, y: 70 })
    expect(l.levers[0].moved).toBe(true)
    // The point is under the ring, so it keeps no dot of its own; the leader still reaches it.
    expect(l.levers[0].dot).toBe(false)
  })

  it('two lever points on the same pixel: the second moves, each keeps its own label', () => {
    const input: LayoutInput = {
      bounds: PHONE,
      you: null,
      levers: [lever('34', 260, 110, ['repay']), lever('35', 260, 110, ['add'], '→ <1%')],
      ...METRICS,
    }
    const l = layoutCurveMarks(input)
    expectClear(input, l)
    expect(l.levers.map((p) => p.moved)).toEqual([false, true])
    expect(l.levers[1].dot).toBe(false) // the first group covers the shared point
  })

  it('the screenshot case: a lever one level from the line, a few px off the ring', () => {
    // Aave WETH/USDC at 7d: line −21% (5.6%), repay and add both reach −22% (5.0%). At 390px
    // over −5 … −35% the two points are 10.5px apart and 2px apart in height.
    const input: LayoutInput = {
      bounds: PHONE,
      you: { x: 210.0, y: 76.1, label: 'your line −21% · 6%' },
      levers: [lever('22', 220.5, 78.4, ['repay', 'add']), lever('35', 348, 120.6, ['repay', 'add'], '→ <1%')],
      ...METRICS,
    }
    const l = layoutCurveMarks(input)
    expectClear(input, l)
    expect(l.levers[0].moved).toBe(true)
    expect(l.levers[0].dot).toBe(true)
  })

  it('points within a few px of each other and of the ring, with the drop to the axis as an obstacle', () => {
    const drop = { x: 99, y: 68, w: 2, h: 62 }
    const input: LayoutInput = {
      bounds: PHONE,
      you: { x: 100, y: 60, label: 'your line −9% · 28%' },
      levers: [
        lever('10', 102, 61, ['repay', 'add'], '→ 10%'),
        lever('11', 104, 62, ['repay', 'add'], '→ 9%'),
        lever('12', 105, 64, ['repay'], '→ 8%'),
        lever('13', 107, 65, ['add'], '→ 7%'),
      ],
      obstacles: [drop],
      ...METRICS,
    }
    const l = layoutCurveMarks(input)
    expectClear(input, l)
    expect(l.levers.every((p) => p.moved)).toBe(true)
  })

  it('is deterministic', () => {
    const input: LayoutInput = {
      bounds: PHONE,
      you: { x: 150, y: 70, label: 'your line −21% · 6%' },
      levers: [lever('21', 151, 71, ['repay', 'add']), lever('22', 152, 72, ['repay', 'add'])],
      ...METRICS,
    }
    expect(layoutCurveMarks(input)).toEqual(layoutCurveMarks(input))
  })
})

describe('curve marks: a sweep of crowded phone and desktop charts', () => {
  // mulberry32: a fixed seed, so a failure reproduces.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const KINDS: LeverKind[][] = [['repay'], ['add'], ['repay', 'add']]

  it('never overlaps, for 2,000 seeded layouts of a ring and up to six lever points', () => {
    const r = rng(20261016)
    for (let k = 0; k < 2000; k++) {
      const bounds = k % 2 === 0 ? PHONE : { x: 34, y: 18, w: 868, h: 202 }
      // The curve falls to the right: the ring first, the levers further along and lower.
      const yx = bounds.x + r() * bounds.w * 0.7
      const yy = bounds.y + r() * bounds.h * 0.8
      const n = 1 + Math.floor(r() * 6)
      const spread = r() < 0.5 ? 4 : 40 // half the cases crowd every point within a few px
      let x = yx
      let y = yy
      const levers = Array.from({ length: n }, (_, i) => {
        x = Math.min(bounds.x + bounds.w, x + r() * spread)
        y = Math.min(bounds.y + bounds.h, y + r() * spread * 0.5)
        return lever(String(i), x, y, KINDS[Math.floor(r() * 3)], r() < 0.3 ? '→ <1%' : '→ 10%')
      })
      const label = `your line −${Math.floor(5 + r() * 50)}% · ${Math.ceil(r() * 60)}%`
      const input: LayoutInput = { bounds, you: r() < 0.9 ? { x: yx, y: yy, label } : null, levers, ...METRICS }
      expectClear(input, layoutCurveMarks(input))
    }
  })
})

// ---------------------------------------------------------------- the helpers that feed it

const coll = (symbol: string, amount: number, priceUsd: number, lt: number): CollateralLeg => ({
  symbol, address: `0x${symbol}`, decimals: 18, amount, priceUsd, valueUsd: amount * priceUsd,
  liquidationThreshold: lt, maxLtv: lt - 0.03, liquidationBonus: 0.05,
})
const debt = (symbol: string, amount: number, priceUsd: number): DebtLeg => ({
  symbol, address: `0x${symbol}`, decimals: 6, amount, priceUsd, valueUsd: amount * priceUsd, borrowApr: 0.05,
})
function aave(c: CollateralLeg[], d: DebtLeg[]): ProtocolPosition {
  const C = c.reduce((s, x) => s + x.valueUsd, 0)
  const D = d.reduce((s, x) => s + x.valueUsd, 0)
  const W = c.reduce((s, x) => s + x.valueUsd * x.liquidationThreshold, 0)
  return {
    protocol: 'aave-v3', label: 'Aave V3', collateral: c, debt: d, totalCollateralUsd: C, totalDebtUsd: D,
    ltv: D / C, liquidationLtv: W / C, healthFactor: W / D, provenance: { kind: 'onchain', label: 'x', at: 1 },
  }
}

describe('curveMarks: one point per lever level', () => {
  it('a repay and a top-up that reach one level share a point, named in the rows’ words', () => {
    const v = buildPositionView(aave([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)]), TOUCH_TABLE)
    for (const h of HORIZON_IDS) {
      const hf = v.forecast!.byHorizon[h]
      const { you, levers } = curveMarks(v.forecast!, hf)
      expect(you?.label).toMatch(/^your line −\d+% · (<1|\d+)%$/)
      // Every row has its point, and no level is drawn twice.
      expect(new Set(levers.map((p) => p.level)).size).toBe(levers.length)
      expect(levers.reduce((a, p) => a + p.detail.length, 0)).toBe(hf.actions.length)
      for (const a of hf.actions) {
        const p = levers.find((q) => q.level === a.newDistancePct)!
        expect(p.kinds).toContain(a.kind)
        expect(p.label).toBe(`→ ${formatChance(a.history.touched, a.history.n)}`)
        expect(p.detail).toContain(a.short)
        expect(a.short).toMatch(/^If you (repay|add) [\d.,]+ (USDC|WETH) → (<1|\d+)%$/)
      }
      for (const p of levers) expect(p.kinds).toEqual((['repay', 'add'] as const).filter((k) => p.kinds.includes(k)))
    }
    // At 7d this position has both levers at each target level.
    expect(curveMarks(v.forecast!, v.forecast!.byHorizon['7d']).levers.some((p) => p.kinds.length === 2)).toBe(true)
  })
})

describe('chanceCells: the strip says what the figure says', () => {
  it('inks the printed chance and spans the printed band, for every cell of the table', () => {
    const num = (s: string) => (s === '<1%' ? 0 : Number(s.replace('%', '')))
    for (const asset of ['ETH', 'BTC'] as const) {
      for (const d of ['fall', 'rise'] as const) {
        for (const h of HORIZON_IDS) {
          const row = TOUCH_TABLE.assets[asset][d][h]
          row.touched.forEach((touched, i) => {
            const f = { touched, lo: row.lo[i], hi: row.hi[i], n: row.n }
            const c = chanceCells(f)
            expect(c.inked).toBe(num(formatChance(touched, row.n)))
            const band = formatBand(f.lo, f.hi, f.n)
            const m = band.match(/^up to (\d+)%$/) ?? band.match(/^(\d+)(?:–(\d+))?%$/)!
            const [lo, hi] = band.startsWith('up to') ? [0, Number(m[1])] : [Number(m[1]), Number(m[2] ?? m[1])]
            expect(c.bandFrom).toBe(Math.min(c.inked, lo))
            expect(c.bandTo).toBe(Math.max(c.inked, hi))
            expect(c.bandFrom).toBeLessThanOrEqual(c.inked)
            expect(c.inked).toBeLessThanOrEqual(c.bandTo)
            expect(c.bandTo).toBeLessThanOrEqual(100)
          })
        }
      }
    }
  })
  it('"<1%" inks no cell; the likely range still shows', () => {
    expect(chanceCells({ touched: 1, lo: 0, hi: 40, n: 2009 })).toEqual({ inked: 0, bandFrom: 0, bandTo: 2 })
    expect(chanceCells({ touched: 488, lo: 400, hi: 560, n: 2009 })).toEqual({ inked: 25, bandFrom: 19, bandTo: 28 })
  })
})
