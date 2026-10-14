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
  REPAY_ROUND_USD,
  REVERSE_SOLVE_TARGETS_PCT,
  addFor,
  afterAdd,
  afterRepay,
  levelForTarget,
  repayFor,
  reverseSolve,
} from '@/lib/position/reverseSolve'
import { assetClassOf, historyAssetFor, isUsdStable, toSnapshot } from '@/lib/position/snapshot'
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

/** A synthetic table: touched/n = f(L) per horizon, so targets land on known levels. */
function syntheticTable(f: (L: number) => number, n = 1000): TouchTable {
  const row = { n, from: '2020-01-01', to: '2026-01-01', touched: Array.from({ length: 60 }, (_, i) => Math.round(n * f(i + 1))) }
  const dir = { '1d': row, '3d': row, '7d': row, '14d': row, '30d': row }
  return {
    ...TOUCH_TABLE,
    assets: {
      ETH: { feed: 'Chainlink ETH/USD', oracleGradeFrom: '', fall: dir, rise: dir },
      BTC: { feed: 'Chainlink BTC/USD', oracleGradeFrom: '', fall: dir, rise: dir },
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

describe('toSnapshot', () => {
  it('maps legs one to one with the oracle price and threshold', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 20_000, 1)])
    const m = toSnapshot(p)
    expect(m.thresholdsScaled).toBe(false)
    expect(m.snapshot.collateral).toEqual([{ symbol: 'WETH', amount: 10, oraclePriceUsd: 4000, liquidationThreshold: 0.83 }])
    expect(m.snapshot.debt).toEqual([{ symbol: 'USDC', amount: 20_000, priceUsd: 1 }])
    expect(m.snapshot.ts).toBe(1_760_000_000)
    expect(m.snapshot.venue).toBe('Aave V3')
    expect(computeMetrics(m.snapshot).healthFactor).toBeCloseTo(p.healthFactor, 12)
  })

  it('scales thresholds to the protocol aggregate when e-mode raises them', () => {
    // wstETH reserve LT 0.81, but the account sits in the ETH e-mode category at 0.95.
    const p = position([coll('wstETH', 10, 4800, 0.81)], [debt('USDC', 30_000, 1)], { liquidationLtv: 0.95 })
    const m = toSnapshot(p)
    expect(m.thresholdsScaled).toBe(true)
    expect(m.thresholdScale).toBeCloseTo(0.95 / 0.81, 12)
    expect(m.snapshot.collateral[0].liquidationThreshold).toBeCloseTo(0.95, 12)
  })

  it('ignores bps truncation noise in the aggregate', () => {
    const p = position([coll('WETH', 3, 4000, 0.83), coll('USDC', 5000, 1, 0.78)], [debt('USDT', 6000, 1)])
    const m = toSnapshot({ ...p, liquidationLtv: Math.floor(p.liquidationLtv * 1e4) / 1e4 })
    expect(m.thresholdsScaled).toBe(false)
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
      expect(b.kind).toBe('dominant')
      return b.kind === 'dominant' ? b.reason : ''
    })
    expect(reasons).toEqual([
      'ETH and BTC legs move separately.',
      'Collateral and debt both move with ETH.',
      'Every leg is a USD stablecoin.',
      'No price history for LINK yet.',
    ])
    for (const r of reasons) expect(r.split(/\s+/).length).toBeLessThanOrEqual(8)
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
    const base: LineModel = { direction: 'fall', symbol: 'WETH', priceNow: 4000, W: 33_200, Wm: 33_200, D: 28_000, Dm: 0, moving: ['WETH'], held: ['USDC'] }
    for (const L of [0.17, 0.3, 0.45]) {
      expect(lineDistance(afterRepay(base, repayFor(base, L, false), false))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(base, addFor(base, L, true), true))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(base, addFor(base, L, false), false))).toBeCloseTo(L, 12)
    }
    const rise: LineModel = { direction: 'rise', symbol: 'WETH', priceNow: 4000, W: 7800, Wm: 0, D: 6000, Dm: 6000, moving: ['WETH'], held: ['USDC'] }
    for (const L of [0.35, 0.5]) {
      expect(lineDistance(afterRepay(rise, repayFor(rise, L, true), true))).toBeCloseTo(L, 12)
      expect(lineDistance(afterAdd(rise, addFor(rise, L, false), false))).toBeCloseTo(L, 12)
    }
    // The brief's two formulas, for collateral moving together and stable debt.
    const L = 0.3
    expect(repayFor(base, L, false)).toBeCloseTo(28_000 - (1 - L) * 33_200, 9)
    expect(addFor(base, L, true)).toBeCloseTo(28_000 / (1 - L) - 33_200, 9)
  })

  it('writes repay and add rows from the live position, amounts rounded up', () => {
    // WETH 10 @ $4,000, LT 0.83; USDC debt $28,000 → line 15.66% away.
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)])
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const rows = reverseSolve(s, m, LINEAR, 'ETH')
    expect(rows.map((r) => r.text)).toEqual([
      // 0.21·33,200 − 5,200 = 1,772 → $1,780 → D 26,220 → 21.02% → L 21 → 10%
      'Repay $1,780 → line at −21% → 7d: 10%',
      'Repay $3,440 → line at −26% → 7d: 5%',
      'Repay $4,760 → line at −30% → 7d: 1%',
      // (0.21·33,200 − 5,200)/0.79 = 2,243.04 weighted → /(0.83·4000) = 0.6756 → 0.68 WETH
      'Add 0.68 WETH → line at −21% → 7d: 10%',
      'Add 1.40 WETH → line at −26% → 7d: 5%',
      'Add 2.05 WETH → line at −30% → 7d: 1%',
    ])
    for (const r of rows) {
      expect(r.newDistancePct).toBeGreaterThanOrEqual(r.level)
      expect(r.history.pct).toBeLessThanOrEqual(r.targetPct + 1e-9)
      if (r.kind === 'repay') expect(r.amount % REPAY_ROUND_USD).toBe(0)
    }
  })

  it('skips targets already met and repays that would clear the debt', () => {
    const far = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 10_000, 1)]) // 69.9% away
    const s = snap(far)
    expect(reverseSolve(s, lineModel(s, classifyRisk(s))!, LINEAR, 'ETH')).toEqual([])
    // Past the line, debt split over two legs: every repay of the larger leg (USDC $1,900)
    // would need more than the leg holds (≥ $2,120), so only top-ups remain.
    const tiny = position([coll('WETH', 1, 4000, 0.5)], [debt('USDC', 1900, 1), debt('USDT', 1800, 1)])
    const t2 = snap(tiny)
    const rows = reverseSolve(t2, lineModel(t2, classifyRisk(t2))!, LINEAR, 'ETH')
    expect(rows.filter((r) => r.kind === 'repay')).toEqual([])
    expect(rows.length).toBeGreaterThan(0)
  })

  it('a rise risk repays the volatile debt and tops up the stable collateral', () => {
    const p = position([coll('USDC', 10_000, 1, 0.78)], [debt('WETH', 1.7, 4000)]) // 14.7% rise
    const s = snap(p)
    const m = lineModel(s, classifyRisk(s))!
    const rows = reverseSolve(s, m, LINEAR, 'ETH')
    expect(rows[0].text).toMatch(/^Repay \$[\d,]+ → line at \+21% → 7d: 10%$/)
    const add = rows.find((r) => r.kind === 'add')!
    expect(add.symbol).toBe('USDC')
    expect(add.amount % 10).toBe(0)
    expect(add.text).toMatch(/^Add [\d,]+ USDC → line at \+\d+% → 7d: \d+%$/)
  })

  it('on the real table: every row meets its target and names a 7d history frequency', () => {
    const p = position([coll('WETH', 10, 4000, 0.83)], [debt('USDC', 28_000, 1)])
    const s = snap(p)
    const rows = reverseSolve(s, lineModel(s, classifyRisk(s))!, TOUCH_TABLE, 'ETH')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const L = levelForTarget(TOUCH_TABLE, 'ETH', 'fall', '7d', r.targetPct)!
      expect(r.level).toBe(L)
      expect(r.newDistancePct).toBeGreaterThanOrEqual(L)
      expect(r.history).toEqual(touchAtLevel(TOUCH_TABLE, 'ETH', 'fall', '7d', r.newDistancePct))
      expect(REVERSE_SOLVE_TARGETS_PCT).toContain(r.targetPct as 10 | 5 | 1)
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
