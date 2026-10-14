// lib/position: the ProtocolPosition → snapshot mapper, asset families, the liquidation
// line model and the reverse solve. Pure arithmetic; every fixture is built by hand.

import { describe, expect, it } from 'vitest'

import { computeMetrics } from '@/lib/positionAlerts/metrics'
import type { PositionSnapshot } from '@/lib/positionAlerts/types'
import type { CollateralLeg, DebtLeg, ProtocolPosition } from '@/lib/position-sim/types'
import { amountStep, amountStepFor, ceilTo, fmtMove, fmtUsd, stepDecimals } from '@/lib/position/format'
import {
  classifyRisk,
  heroOf,
  lineDistance,
  lineModel,
  priceDecimals,
  roundTowardRisk,
  type LineModel,
} from '@/lib/position/liquidation'
import {
  ACCRUAL_BUFFER_HOURS,
  REPAY_ROUND_USD,
  REVERSE_SOLVE_TARGETS_PCT,
  accrualFactor,
  unitStep,
  addFor,
  afterAdd,
  afterRepay,
  levelForTarget,
  repayFor,
  reverseSolve,
} from '@/lib/position/reverseSolve'
import { SPLIT_TOLERANCE, assetClassOf, checkSplit, historyAssetFor, isUsdStable, toSnapshot } from '@/lib/position/snapshot'
import { floorPct, touchAtLevel } from '@/lib/position/touch'
import { TOUCH_TABLE, type TouchTable } from '@/lib/position/touchHistory'

// ---------------------------------------------------------------- fixtures

const coll = (symbol: string, amount: number, priceUsd: number, lt: number): CollateralLeg => ({
  symbol,
  address: `0x${symbol}`,
  decimals: 18,
  amount,
  priceUsd,
  valueUsd: amount * priceUsd,
  liquidationThreshold: lt,
  maxLtv: lt - 0.03,
  liquidationBonus: 0.05,
})
const debt = (symbol: string, amount: number, priceUsd: number): DebtLeg => ({
  symbol,
  address: `0x${symbol}`,
  decimals: 6,
  amount,
  priceUsd,
  valueUsd: amount * priceUsd,
  borrowApr: 0.05,
})
function position(c: CollateralLeg[], d: DebtLeg[], over: Partial<ProtocolPosition> = {}): ProtocolPosition {
  const C = c.reduce((s, x) => s + x.valueUsd, 0)
  const D = d.reduce((s, x) => s + x.valueUsd, 0)
  const W = c.reduce((s, x) => s + x.valueUsd * x.liquidationThreshold, 0)
  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: c,
    debt: d,
    totalCollateralUsd: C,
    totalDebtUsd: D,
    ltv: C > 0 ? D / C : 0,
    liquidationLtv: C > 0 ? W / C : 0,
    healthFactor: D > 0 ? W / D : Infinity,
    provenance: { kind: 'onchain', label: 'aave v3 · public rpc', at: 1_760_000_000_000 },
    ...over,
  }
}
const snap = (p: ProtocolPosition) => toSnapshot(p).snapshot

/**
 * A synthetic table: touched/n = f(L) (the 1d row at `oneDay`·f), a band of ±2pp, so
 * targets land on known levels and the band text is predictable.
 */
function syntheticTable(f: (L: number) => number, n = 1000, oneDay = 1): TouchTable {
  const row = (k: number) => {
    const touched = Array.from({ length: 60 }, (_, i) => Math.round(n * k * f(i + 1)))
    return {
      n,
      from: '2021-03-25',
      to: '2026-10-05',
      touched,
      lo: touched.map((x) => Math.max(0, x - 20)),
      hi: touched.map((x) => Math.min(n, x + 20)),
      confidence: { label: 'medium' as const, held: 3, checks: 5, detail: [] },
    }
  }
  const dir = { '1d': row(oneDay), '3d': row(1), '7d': row(1), '14d': row(1), '30d': row(1) }
  return {
    ...TOUCH_TABLE,
    assets: {
      ETH: { feed: 'Chainlink ETH/USD', fall: dir, rise: dir },
      BTC: { feed: 'Chainlink BTC/USD', fall: dir, rise: dir },
    },
  }
}
// 7d frequency falls 1pp per level from 30% at L=1: ≤10% at L=21, ≤5% at L=26, ≤1% at L=30.
const LINEAR = syntheticTable((L) => Math.max(0, (31 - L) / 100))

// ---------------------------------------------------------------- families

describe('asset families', () => {
  it('maps the ETH and BTC families and the stables', () => {
    for (const s of ['ETH', 'WETH', 'wstETH', 'stETH', 'weETH', 'rETH', 'cbETH', 'osETH', 'ezETH', 'rsETH']) {
      expect(historyAssetFor(s)).toBe('ETH')
    }
    for (const s of ['WBTC', 'cbBTC', 'tBTC', 'LBTC']) expect(historyAssetFor(s)).toBe('BTC')
    for (const s of ['USDC', 'USDT', 'DAI', 'GHO', 'USDS', 'sUSDe', 'USDe']) {
      expect(historyAssetFor(s)).toBeNull()
      expect(isUsdStable(s)).toBe(true)
    }
  })
  it('is case-insensitive and never guesses an unknown symbol', () => {
    expect(historyAssetFor('wsteth')).toBe('ETH')
    expect(assetClassOf('LINK')).toBe('other')
    expect(assetClassOf('PT-sUSDE-27NOV2025')).toBe('other')
    expect(assetClassOf('EURC')).toBe('other')
  })
})

// ---------------------------------------------------------------- snapshot

describe('toSnapshot and the threshold split', () => {
  it('maps legs one to one with the oracle price and threshold, and checks they split', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 20_000, 1)])
    const m = toSnapshot(p)
    expect(m.split.ok).toBe(true)
    expect(m.split.legsHealthFactor).toBeCloseTo(p.healthFactor, 12)
    expect(m.snapshot.collateral).toEqual([{ symbol: 'WETH', amount: 10, oraclePriceUsd: 4000, liquidationThreshold: 0.83 }])
    expect(m.snapshot.debt).toEqual([{ symbol: 'USDC', amount: 20_000, priceUsd: 1 }])
    expect(m.snapshot.ts).toBe(1_760_000_000)
    expect(m.snapshot.venue).toBe('Aave V3')
    expect(computeMetrics(m.snapshot).healthFactor).toBeCloseTo(p.healthFactor, 12)
  })

  it('never rescales: legs at reserve thresholds against an e-mode aggregate do not split', () => {
    // wstETH reserve LT 0.81, but the account sits in an e-mode category at 0.95.
    const p = position([coll('wstETH', 10, 4800, 0.81)], [debt('USDC', 30_000, 1)], { liquidationLtv: 0.95, healthFactor: (48_000 * 0.95) / 30_000 })
    const m = toSnapshot(p)
    expect(m.split.ok).toBe(false)
    expect(m.split.reason).toMatch(/protocol threshold/)
    expect(m.snapshot.collateral[0].liquidationThreshold).toBe(0.81)
  })

  it('reserve LT 0 with an e-mode aggregate (the 0x902f… shape) does not split', () => {
    const p = position([coll('PT-srUSDe', 1000, 1, 0)], [debt('USDC', 800, 1)], { liquidationLtv: 0.92, healthFactor: 1.15 })
    expect(checkSplit(p)).toMatchObject({ ok: false, reason: 'the legs carry no threshold the protocol applies' })
  })

  it('the reviewer’s mixed e-mode case (tETH at reserve 0.001 + WETH, true HF 1.30) is refused, not drawn', () => {
    const aggW = 4 * 2600 * 0.75 + 4 * 2500 * 0.83
    const p = position([coll('tETH', 4, 2600, 0.001), coll('WETH', 4, 2500, 0.83)], [debt('USDC', aggW / 1.3, 1)], {
      liquidationLtv: aggW / (4 * 2600 + 4 * 2500),
      healthFactor: 1.3,
    })
    expect(checkSplit(p).ok).toBe(false)
  })

  it('with exact per-asset e-mode thresholds from the adapter, partial e-mode splits', () => {
    // weETH in e-mode at 0.90 (reserve 0.80) beside USDC at 0.78: the adapter now sends 0.90.
    const p = position([coll('weETH', 10, 2600, 0.9), coll('USDC', 20_000, 1, 0.78)], [debt('USDT', (26_000 * 0.9 + 20_000 * 0.78) / 1.25, 1)])
    expect(checkSplit(p).ok).toBe(true)
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    // The true line: x = (W − D) / Wm with the e-mode threshold on the moving leg.
    const W = 26_000 * 0.9 + 20_000 * 0.78
    expect(lineDistance(m)).toBeCloseTo((W - W / 1.25) / (26_000 * 0.9), 12)
  })

  it('ignores bps truncation noise in the aggregate', () => {
    const p = position([coll('WETH', 3, 4000, 0.83), coll('USDC', 5000, 1, 0.78)], [debt('USDT', 6000, 1)])
    expect(checkSplit({ ...p, liquidationLtv: Math.floor(p.liquidationLtv * 1e4) / 1e4 }).ok).toBe(true)
  })

  it('a health factor the legs cannot reproduce within 0.5% does not split', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 20_000, 1)])
    expect(checkSplit({ ...p, healthFactor: p.healthFactor * 1.006 }).ok).toBe(false)
    expect(checkSplit({ ...p, healthFactor: p.healthFactor * 1.004 }).ok).toBe(true)
    expect(SPLIT_TOLERANCE).toBe(0.005)
  })

  it('drops zero-amount legs', () => {
    const p = position([coll('WETH', 0, 4000, 0.83), coll('WBTC', 1, 100_000, 0.78)], [debt('USDC', 0, 1)])
    const s = snap(p)
    expect(s.collateral.map((c) => c.symbol)).toEqual(['WBTC'])
    expect(s.debt).toEqual([])
  })
})

// ---------------------------------------------------------------- classification

describe('classifyRisk', () => {
  const c = (sym: string) => coll(sym, 1, 1000, 0.8)
  const d = (sym: string) => debt(sym, 100, 1)
  it('volatile collateral, stable debt → a fall of that family', () => {
    expect(classifyRisk(snap(position([c('WETH'), c('wstETH')], [d('USDC')])))).toEqual({ kind: 'history', asset: 'ETH', direction: 'fall' })
    expect(classifyRisk(snap(position([c('WBTC'), c('USDC')], [d('USDT')])))).toEqual({ kind: 'history', asset: 'BTC', direction: 'fall' })
  })
  it('stable collateral, volatile debt → a RISE of that family', () => {
    expect(classifyRisk(snap(position([c('USDC')], [d('WETH')])))).toEqual({ kind: 'history', asset: 'ETH', direction: 'rise' })
  })
  it('ignores dust legs when classifying, and does not name them', () => {
    // 279 WETH next to a 0.00003 WBTC remnant and 0.0004 USDT of collateral (a real read).
    const p = position([coll('WETH', 278.8, 2499.2, 0.83), coll('WBTC', 0.00003, 83_000, 0.78), coll('USDT', 0.0004, 1, 0.78)], [debt('USDT', 534_443, 0.9987)])
    const s = snap(p)
    const b = classifyRisk(s)
    expect(b).toEqual({ kind: 'history', asset: 'ETH', direction: 'fall' })
    const m = lineModel(s, b)!
    expect(m.moving).toEqual(['WETH'])
    expect(m.held).toEqual(['USDT'])
    // Dust still counts in the sums.
    expect(m.W).toBeCloseTo(278.8 * 2499.2 * 0.83 + 0.00003 * 83_000 * 0.78 + 0.0004 * 0.78, 9)
    // A real second family above the dust share still splits it.
    const mixed = position([coll('WETH', 278.8, 2499.2, 0.83), coll('WBTC', 1, 83_000, 0.78)], [debt('USDT', 534_443, 0.9987)])
    expect(classifyRisk(snap(mixed)).kind).toBe('dominant')
  })

  it('mixed or unknown → the dominant leg, with a reason of at most 8 words', () => {
    const cases = [
      position([c('WETH'), c('WBTC')], [d('USDC')]),
      position([c('wstETH')], [d('WETH')]),
      position([c('USDC')], [d('USDT')]),
      position([c('LINK')], [d('USDC')]),
    ]
    const reasons = cases.map((p) => {
      const b = classifyRisk(snap(p))
      return b.kind === 'dominant' || b.kind === 'ratio' ? `${b.kind}: ${b.reason}` : b.kind
    })
    expect(reasons).toEqual([
      'dominant: ETH and BTC legs move separately.',
      'ratio: The line moves with the wstETH/ETH ratio, not the ETH price.',
      'dominant: Every leg is a USD stablecoin.',
      'dominant: No price history for LINK yet.',
    ])
  })

  it('same family on both sides and nothing else is a RATIO line, not a USD one', () => {
    const s = snap(position([coll('wstETH', 100, 3000, 0.955)], [debt('WETH', 100, 2500)]))
    const b = classifyRisk(s)
    expect(b).toMatchObject({ kind: 'ratio', asset: 'ETH', base: 'wstETH', quote: 'WETH' })
    const m = lineModel(s, b)!
    expect(m.unit).toEqual({ kind: 'ratio', base: 'wstETH', quote: 'WETH' })
    expect(m.priceNow).toBeCloseTo(1.2, 12)
    const h = heroOf(m)
    expect(h.kind).toBe('line')
    if (h.kind !== 'line') return
    const x = 1 - 250_000 / (300_000 * 0.955)
    expect(h.distance).toBeCloseTo(x, 12)
    expect(h.priceLine).toBeCloseTo(1.2 * (1 - x), 12)
    expect(h.priceShown).toBeGreaterThanOrEqual(h.priceLine) // toward now
    expect(h.unit.kind).toBe('ratio')
  })

  it('same family on both sides with stables beside it: the net exposure sets the direction', () => {
    // wstETH collateral against WETH and USDC debt: ETH falling hurts (collateral > ETH debt).
    const fall = snap(position([coll('wstETH', 10, 3000, 0.95)], [debt('WETH', 4, 2500), debt('USDC', 10_000, 1)]))
    expect(classifyRisk(fall)).toEqual({ kind: 'history', asset: 'ETH', direction: 'fall' })
    const m = lineModel(fall, classifyRisk(fall))!
    const W = 30_000 * 0.95
    expect(lineDistance(m)).toBeCloseTo((W - 20_000) / (W - 10_000), 12)
    // USDC collateral against a large WETH and a small wstETH... debt: an ETH rise hurts.
    const rise = snap(position([coll('USDC', 30_000, 1, 0.78), coll('WETH', 1, 2500, 0.83)], [debt('WETH', 6, 2500)]))
    expect(classifyRisk(rise)).toEqual({ kind: 'history', asset: 'ETH', direction: 'rise' })
  })
})

// ---------------------------------------------------------------- the line

describe('line distance and hero', () => {
  it('collateral moving together: d = 1 − D / Σ(C·LT·P), matching computeMetrics', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 20_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const d = lineDistance(m)
    expect(d).toBeCloseTo(1 - 20_000 / (10 * 4000 * 0.83), 12)
    const h = heroOf(m)
    expect(h.kind).toBe('line')
    if (h.kind !== 'line') return
    expect(h.priceLine).toBeCloseTo(computeMetrics(s).dominant!.liquidationPriceUsd!, 8)
    expect(h.priceLine).toBeCloseTo(2409.6386, 3)
    expect(h.priceShown).toBe(2410) // rounded UP toward now for a fall
    expect(h.distancePct).toBe(39) // 39.76% floored
    expect(h.symbol).toBe('WETH')
  })

  it('two ETH legs move together; the hero quotes the larger', () => {
    const p = position([coll('WETH', 2, 4000, 0.83), coll('wstETH', 5, 4800, 0.81)], [debt('USDC', 20_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    expect(m.symbol).toBe('wstETH')
    expect(m.moving).toEqual(['WETH', 'wstETH'])
    expect(m.held).toEqual(['USDC'])
    const W = 2 * 4000 * 0.83 + 5 * 4800 * 0.81
    expect(lineDistance(m)).toBeCloseTo(1 - 20_000 / W, 12)
  })

  it('a stable collateral leg is held while the ETH leg moves', () => {
    const p = position([coll('WETH', 5, 4000, 0.83), coll('USDC', 10_000, 1, 0.78)], [debt('USDT', 15_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const Wm = 5 * 4000 * 0.83
    const W = Wm + 10_000 * 0.78
    expect(lineDistance(m)).toBeCloseTo((W - 15_000) / Wm, 12)
    // Same answer as computeMetrics' dominant leg (the WETH leg is the larger one).
    const h = heroOf(m)
    expect(h.kind === 'line' && h.priceLine).toBeCloseTo(computeMetrics(s).dominant!.liquidationPriceUsd!, 8)
  })

  it('a volatile debt is a rise risk: price rounds DOWN toward now', () => {
    const p = position([coll('USDC', 10_000, 1, 0.78)], [debt('WETH', 1.5, 4000)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    expect(m.direction).toBe('rise')
    expect(lineDistance(m)).toBeCloseTo(7800 / 6000 - 1, 12)
    const h = heroOf(m)
    expect(h.kind).toBe('line')
    if (h.kind !== 'line') return
    expect(h.priceLine).toBeCloseTo(5200, 6)
    expect(h.priceShown).toBe(5200)
    expect(h.distancePct).toBe(30)
    expect(h.symbol).toBe('WETH')
  })

  it('dominant-leg model equals computeMetrics for a mixed position', () => {
    const p = position([coll('WETH', 3, 4000, 0.83), coll('WBTC', 0.2, 100_000, 0.78)], [debt('USDC', 18_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    expect(m.symbol).toBe('WBTC')
    expect(m.held).toEqual(['WETH', 'USDC'])
    const h = heroOf(m)
    const cm = computeMetrics(s).dominant!
    expect(h.kind === 'line' && h.priceLine).toBeCloseTo(cm.liquidationPriceUsd!, 6)
    expect(h.kind === 'line' && h.distance).toBeCloseTo(cm.distance!, 12)
  })

  it('no debt: no line', () => {
    const s = snap(position([coll('WETH', 1, 4000, 0.83)], []))
    expect(heroOf(lineModel(s, classifyRisk(s)))).toEqual({ kind: 'no-debt' })
    expect(lineDistance(lineModel(s, classifyRisk(s))!)).toBe(Infinity)
  })

  it('already past the line', () => {
    const s = snap(position([coll('WETH', 1, 4000, 0.83)], [debt('USDC', 3400, 1)]))
    const h = heroOf(lineModel(s, classifyRisk(s)))
    expect(h.kind).toBe('past')
    if (h.kind === 'past') expect(h.healthFactor).toBeCloseTo(3320 / 3400, 12)
  })

  it('other legs alone cover the debt: no price of the dominant leg reaches the line', () => {
    const s = snap(position([coll('WETH', 3, 4000, 0.83), coll('WBTC', 0.1, 100_000, 0.78)], [debt('USDC', 5000, 1)]))
    // WETH (12k) is the dominant leg; WBTC alone weighs 7.8k > 5k debt.
    expect(heroOf(lineModel(s, classifyRisk(s))).kind).toBe('unreachable')
    expect(computeMetrics(s).dominant!.liquidationPriceUsd).toBeNull()
  })

  it('a line under 1% away floors to 0', () => {
    const s = snap(position([coll('WETH', 1, 4000, 0.8)], [debt('USDC', 3180, 1)]))
    const h = heroOf(lineModel(s, classifyRisk(s)))
    expect(h.kind === 'line' && h.distancePct).toBe(0)
  })

  it('rounds toward risk at four significant figures', () => {
    expect(priceDecimals(2409.6)).toBe(0)
    expect(priceDecimals(61_234)).toBe(0)
    expect(priceDecimals(181.3)).toBe(1)
    expect(priceDecimals(1.0712)).toBe(3)
    expect(roundTowardRisk(1.0712, 'fall')).toBe(1.072)
    expect(roundTowardRisk(1.0718, 'rise')).toBe(1.071)
    expect(roundTowardRisk(2410, 'fall')).toBe(2410) // exact stays exact
    expect(roundTowardRisk(5199.99, 'rise')).toBe(5199)
  })
})

// ---------------------------------------------------------------- reverse solve

describe('reverse solve', () => {
  it('finds the smallest level at or below each target', () => {
    expect(levelForTarget(LINEAR, 'ETH', 'fall', '7d', 10)).toBe(21)
    expect(levelForTarget(LINEAR, 'ETH', 'fall', '7d', 5)).toBe(26)
    expect(levelForTarget(LINEAR, 'ETH', 'fall', '7d', 1)).toBe(30)
    expect(levelForTarget(syntheticTable(() => 0.5), 'ETH', 'fall', '7d', 10)).toBeNull()
  })

  it('closed forms land exactly on the level', () => {
    const base: LineModel = { unit: { kind: 'usd' }, direction: 'fall', symbol: 'WETH', priceNow: 4000, W: 33_200, Wm: 33_200, D: 28_000, Dm: 0, moving: ['WETH'], held: ['USDC'] }
    for (const L of [0.17, 0.3, 0.45]) {
      expect(lineDistance(afterRepay(base, repayFor(base, L, false), false))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(base, addFor(base, L, true), true))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(base, addFor(base, L, false), false))).toBeCloseTo(L, 12)
    }
    const rise: LineModel = { unit: { kind: 'usd' }, direction: 'rise', symbol: 'WETH', priceNow: 4000, W: 7800, Wm: 0, D: 6000, Dm: 6000, moving: ['WETH'], held: ['USDC'] }
    for (const L of [0.35, 0.5]) {
      expect(lineDistance(afterRepay(rise, repayFor(rise, L, true), true))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(rise, addFor(rise, L, false), false))).toBeCloseTo(L, 12)
    }
    // The brief's two formulas, for collateral moving together and stable debt.
    const L = 0.3
    expect(repayFor(base, L, false)).toBeCloseTo(28_000 - (1 - L) * 33_200, 9)
    expect(addFor(base, L, true)).toBeCloseTo(28_000 / (1 - L) - 33_200, 9)
  })

  it('writes repay and add rows from the live position, amounts rounded up (no accrual)', () => {
    // WETH 10 @ $4,000, LT 0.83; USDC debt $28,000 → line 15.66% away. APR 0: no buffer.
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const { rows, reason } = reverseSolve(s, m, LINEAR, 'ETH', '7d', 0)
    expect(reason).toBe('ok')
    expect(rows.map((r) => r.text)).toEqual([
      // 0.21·33,200 − 5,200 = 1,772 → 1,780 USDC → D 26,220 → 21.02% → L 21 → 10% (8–12%)
      'Repay $1,780 · line −21% · 10% (8–12%)',
      'Repay $3,440 · line −26% · 5% (3–7%)',
      'Repay $4,760 · line −30% · 1% (up to 3%)',
      // (0.21·33,200 − 5,200)/0.79 = 2,243.04 weighted → /(0.83·4000) = 0.6756 → 0.68 WETH
      'Add 0.68 WETH · line −21% · 10% (8–12%)',
      'Add 1.40 WETH · line −26% · 5% (3–7%)',
      'Add 2.05 WETH · line −30% · 1% (up to 3%)',
    ])
    expect(rows.map((r) => r.short)).toEqual([
      'Repay $1,780 → 10%',
      'Repay $3,440 → 5%',
      'Repay $4,760 → 1%',
      'Add 0.68 WETH → 10%',
      'Add 1.40 WETH → 5%',
      'Add 2.05 WETH → 1%',
    ])
    expect(rows.every((r) => r.horizon === '7d')).toBe(true)
    for (const r of rows) {
      expect(r.newDistancePct).toBeGreaterThanOrEqual(r.level)
      expect(r.history.pct).toBeLessThanOrEqual(r.targetPct + 1e-9)
      if (r.kind === 'repay') expect(r.amount % REPAY_ROUND_USD).toBe(0)
    }
  })

  it('every row still holds after the accrual buffer, and one step less does not', () => {
    const p = position([coll('WETH', 6.2557, 2499.2, 0.83)], [debt('USDC', 10_601.12, 0.999892)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const apr = 0.044
    const g = accrualFactor(apr)
    expect(g).toBeCloseTo(1 + 0.044 * (ACCRUAL_BUFFER_HOURS / 8760), 15)
    const accrued = (mm: LineModel): LineModel => ({ ...mm, D: mm.D * g, Dm: mm.Dm * g })
    const { rows } = reverseSolve(s, m, TOUCH_TABLE, 'ETH', '7d', apr)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const L = r.level / 100
      const step = unitStep(r.symbol, r.kind === 'repay' ? 0.999892 : 2499.2)
      const apply = (units: number) =>
        r.kind === 'repay' ? afterRepay(m, units * 0.999892, false) : afterAdd(m, units * 2499.2 * 0.83, true)
      expect(lineDistance(accrued(apply(r.amount)))).toBeGreaterThanOrEqual(L - 1e-12)
      expect(lineDistance(accrued(apply(r.amount - step)))).toBeLessThan(L)
      // The promised line is reached at read time too: Y ≥ L*.
      expect(r.newDistancePct).toBeGreaterThanOrEqual(r.level)
    }
  })

  it('the reviewer’s case: a $0.9999 stable no longer lands a hair short of the line', () => {
    // Repaying $460 worth of a $0.999892 token reached 21.9997% and floored to −21%.
    const p = position([coll('WETH', 6.2557, 2499.2, 0.83)], [debt('USDC', 10_601.12, 0.999892)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const { rows } = reverseSolve(s, m, TOUCH_TABLE, 'ETH', '7d', 0)
    const r = rows.find((x) => x.kind === 'repay' && x.level === 22)!
    expect(r.amount % 10).toBe(0) // whole tens of tokens
    expect(r.amountUsd).toBeCloseTo(r.amount * 0.999892, 9)
    expect(r.newDistancePct).toBe(22)
  })

  it('says why there are no rows: met, beyond the table, no debt', () => {
    const far = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 10_000, 1)]) // 69.9% away
    const s = snap(far)
    expect(reverseSolve(s, lineModel(s, classifyRisk(s))!, LINEAR, 'ETH')).toMatchObject({ rows: [], reason: 'met', met: [10, 5, 1] })
    // A table where nothing within 60% gets under 1%: rows for 10/5 only, then once past them…
    const flat = syntheticTable((L) => Math.max(0.02, (31 - L) / 100))
    const near = snap(position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)]))
    const sv = reverseSolve(near, lineModel(near, classifyRisk(near))!, flat, 'ETH', '7d', 0)
    expect(sv.beyond).toEqual([1])
    expect(sv.rows.length).toBeGreaterThan(0)
    const past26 = snap(position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 24_000, 1)])) // 27.7%
    expect(reverseSolve(past26, lineModel(past26, classifyRisk(past26))!, flat, 'ETH', '7d', 0)).toMatchObject({
      rows: [],
      reason: 'beyond',
      met: [10, 5],
      beyond: [1],
    })
    const none = snap(position([coll('WETH', 1, 4000, 0.83)], []))
    expect(reverseSolve(none, lineModel(none, classifyRisk(none))!, LINEAR, 'ETH').reason).toBe('no-debt')
  })

  it('skips repays that would clear the leg; top-ups remain', () => {
    // Past the line, debt split over two legs: every repay of the larger leg (USDC $1,900)
    // would need more than the leg holds (≥ $2,120), so only top-ups remain.
    const tiny = position([coll('WETH', 1, 4000, 0.5)], [debt('USDC', 1900, 1), debt('USDT', 1800, 1)])
    const t2 = snap(tiny)
    const { rows } = reverseSolve(t2, lineModel(t2, classifyRisk(t2))!, LINEAR, 'ETH', '7d', 0)
    expect(rows.filter((r) => r.kind === 'repay')).toEqual([])
    expect(rows.length).toBeGreaterThan(0)
  })

  it('a rise risk repays the volatile debt in its own units and tops up the stable collateral', () => {
    const p = position([coll('USDC', 10_000, 1, 0.78)], [debt('WETH', 1.7, 4000)]) // 14.7% rise
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const { rows } = reverseSolve(s, m, LINEAR, 'ETH', '7d', 0)
    expect(rows[0].text).toMatch(/^Repay [\d.]+ WETH · line \+21% · 10% \(8–12%\)$/)
    expect(Math.round(rows[0].amount * 100) % 1).toBe(0) // 0.01 WETH steps
    const add = rows.find((r) => r.kind === 'add')!
    expect(add.symbol).toBe('USDC')
    expect(add.amount % 10).toBe(0)
    expect(add.text).toMatch(/^Add [\d,]+ USDC · line \+\d+% · \d+% \(\d+–\d+%\)$/)
  })

  it('a stable priced a hair under $1 still steps by 10 tokens', () => {
    expect(unitStep('USDC', 0.9999)).toBe(10)
    expect(unitStep('WETH', 2499)).toBe(0.01)
    expect(unitStep('WBTC', 83_000)).toBe(0.0001)
  })

  it('solves on the selected horizon', () => {
    // The 1d row is half the others: ≤ 10% from L = 11, ≤ 5% from L = 21, ≤ 1% from L = 29.
    const T = syntheticTable((L) => Math.max(0, (31 - L) / 100), 1000, 0.5)
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)]) // 15.66% away
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const day = reverseSolve(s, m, T, 'ETH', '1d', 0).rows
    const week = reverseSolve(s, m, T, 'ETH', '7d', 0).rows
    expect(day.every((r) => r.horizon === '1d')).toBe(true)
    // 10% at 1d is already met at 15%; 5% needs −21%, 1% needs −29%.
    expect(day.filter((r) => r.kind === 'repay').map((r) => r.level)).toEqual([21, 29])
    expect(week.filter((r) => r.kind === 'repay').map((r) => r.level)).toEqual([21, 26, 30])
    for (const r of day) expect(r.history).toEqual(touchAtLevel(T, 'ETH', 'fall', '1d', r.newDistancePct))
  })

  it('on the real table: every row meets its target and quotes the forecast with its band', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)])
    const s = snap(p)
    const { rows } = reverseSolve(s, lineModel(s, classifyRisk(s))!, TOUCH_TABLE, 'ETH')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const L = levelForTarget(TOUCH_TABLE, 'ETH', 'fall', '7d', r.targetPct)!
      expect(r.level).toBe(L)
      expect(r.newDistancePct).toBeGreaterThanOrEqual(L)
      expect(r.history).toEqual(touchAtLevel(TOUCH_TABLE, 'ETH', 'fall', '7d', r.newDistancePct))
      expect(REVERSE_SOLVE_TARGETS_PCT).toContain(r.targetPct as 10 | 5 | 1)
      expect(r.text).not.toMatch(/\b0%/)
    }
  })
})

describe('format helpers', () => {
  it('steps are worth at least $10, families quote 0.01 ETH and 0.0001 BTC', () => {
    expect(amountStep(4000)).toBe(0.01)
    expect(amountStep(110_000)).toBe(0.0001)
    expect(amountStep(83_000)).toBe(0.001)
    expect(amountStep(1)).toBe(10)
    expect(amountStepFor('BTC', 83_000)).toBe(0.0001)
    expect(amountStepFor('ETH', 2499)).toBe(0.01)
    expect(amountStepFor(null, 20)).toBe(1)
    expect(stepDecimals(0.01)).toBe(2)
    expect(stepDecimals(10)).toBe(0)
    expect(ceilTo(0.6756, 0.01)).toBe(0.68)
    expect(ceilTo(0.68, 0.01)).toBe(0.68)
    expect(ceilTo(1772, 10)).toBe(1780)
    expect(fmtUsd(1940)).toBe('$1,940')
    expect(fmtMove(34, 'fall')).toBe('−34%')
    expect(fmtMove(12, 'rise')).toBe('+12%')
    expect(floorPct(0.3)).toBe(30)
  })
})

// Satisfy the type import (used only in fixtures above).
export type _S = PositionSnapshot
