import { describe, expect, it } from 'vitest'

import {
  bandOf,
  effectiveLt,
  isStable,
  ltFromConfig,
  xrayMetrics,
} from '@/components/LiquidationMap/xrayLogic'
import {
  layerBands,
  sameBand,
  topAssets,
  usd2,
  type LayersDoc,
} from '@/components/LiquidationMap/liqmapLogic'

// Same synthetic cases as research test_q26_terminal.py (LT 80 %).
const r = (symbol: string, priceUsd: number, collateralUsd: number, debtUsd: number) => ({
  symbol,
  priceUsd,
  lt: 0.8,
  collateralUsd,
  debtUsd,
})

describe('xrayMetrics', () => {
  it('price position: k* distance and liquidation price', () => {
    const x = xrayMetrics([r('WETH', 2000, 20000, 0), r('USDC', 1, 0, 15000)])
    expect(x.riskType).toBe('price')
    expect(x.distance).toBeCloseTo(0.0625, 6)
    expect(x.liquidationPrice).toBeCloseTo(1875, 3)
    expect(x.band).toBe('5-10%')
  })

  it('pair loop: collateral-only distance, no price line', () => {
    const x = xrayMetrics([r('weETH', 2100, 21000, 0), r('WETH', 2000, 0, 16000)])
    expect(x.riskType).toBe('pair')
    expect(x.distanceJointPrice).toBeNull()
    expect(x.distance).toBeCloseTo(1 - 1 / 1.05, 6)
    expect(x.band).toBe('3.5-5%')
    expect(x.liquidationPrice).toBeNull()
  })

  it('stable-only, and stable collateral covering the debt, are stable', () => {
    expect(xrayMetrics([r('USDC', 1, 1000, 780)]).riskType).toBe('stable')
    const x = xrayMetrics([r('USDC', 1, 1000, 700), r('WETH', 2000, 2, 0)])
    expect(x.riskType).toBe('stable')
    expect(x.distance).toBeCloseTo(1 - 700 / 801.6, 6)
  })

  it('no debt: no health factor, no distance', () => {
    const x = xrayMetrics([r('WETH', 2000, 1000, 0)])
    expect(x.healthFactor).toBeNull()
    expect(x.distance).toBeNull()
  })
})

describe('helpers', () => {
  it('bands, stables, e-mode LT and config decode', () => {
    expect(bandOf(0.005)).toBe(0)
    expect(bandOf(0.1)).toBe(4)
    expect(bandOf(0.2)).toBeNull()
    expect(isStable('USDC')).toBe(true)
    expect(isStable('PT-sUSDE-27NOV2025')).toBe(true)
    expect(isStable('weETH')).toBe(false)
    expect(effectiveLt(8000, 3, { ltBps: 9500, bitmap: 1n << 3n })).toBe(0.95)
    expect(effectiveLt(8000, 2, { ltBps: 9500, bitmap: 1n << 3n })).toBe(0.8)
    expect(ltFromConfig(8250n << 16n)).toBe(8250)
  })

  it('formats two significant figures', () => {
    expect(usd2(3_785_200_000)).toBe('$3.8B')
    expect(usd2(26_600_000)).toBe('$27M')
    expect(usd2(940)).toBe('$940')
  })
})

describe('layered map', () => {
  const doc: LayersDoc = {
    schema: 'q26-terminal/layers-doc/1',
    kind: 'measured',
    source: 't',
    notes: [],
    chains: [
      {
        chain: 'ethereum',
        block: 1,
        readAt: 't',
        borrowers: 1,
        near: 1,
        totalUsd: { price: 0, pair: 0, stable: 0 },
        layers: {
          price: { WETH: { debtUsd: [0, 0, 0, 10, 100], n: [0, 0, 0, 1, 2] } },
          pair: { weETH: { debtUsd: [0, 50, 500, 0, 0], n: [0, 1, 3, 0, 0] } },
          stable: {},
        },
      },
      {
        chain: 'base',
        block: 1,
        readAt: 't',
        borrowers: 1,
        near: 1,
        totalUsd: { price: 0, pair: 0, stable: 0 },
        layers: {
          price: { WETH: { debtUsd: [0, 0, 5, 0, 0], n: [0, 0, 1, 0, 0] } },
          pair: {},
          stable: {},
        },
      },
    ],
  }

  it('sums layers across chains and filters', () => {
    expect(layerBands(doc).price).toEqual([0, 0, 5, 10, 100])
    expect(layerBands(doc, ['base']).price).toEqual([0, 0, 5, 0, 0])
    expect(layerBands(doc).pair).toEqual([0, 50, 500, 0, 0])
  })

  it('ranks assets and reads same-band crowding', () => {
    const t = topAssets(doc)
    expect(t[0]).toMatchObject({ asset: 'weETH', layer: 'pair', total: 550 })
    expect(t[1]).toMatchObject({ asset: 'WETH', layer: 'price', total: 115 })
    expect(sameBand(doc, 'ethereum', 'pair', 'weETH', 2)).toEqual({ debtUsd: 500, positions: 3 })
    expect(sameBand(doc, 'ethereum', 'pair', 'rsETH', 2)).toBeNull()
  })
})

describe('markets logic (ports of q26_terminal.py)', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')

  it('feed kinds', () => {
    expect(M.feedKind('ETH / USD')).toBe('market feed')
    expect(M.feedKind('Capped weETH / eETH(ETH) / USD')).toBe('exchange-rate (capped)')
    expect(M.feedKind('Capped USDT/USD')).toBe('capped peg')
    expect(M.feedKind(null)).toBe('unknown')
  })

  it('rate curve and headroom (live WETH strategy 2026-10-29)', () => {
    const p = { opt: 0.92, base: 0, s1: 0.022, s2: 0.06 }
    expect(M.utilForRate(0.0194, p)).toBeCloseTo((0.92 * 0.0194) / 0.022, 9)
    expect(M.borrowRate(0.95, p)).toBeCloseTo(0.0445, 9)
    const h = M.rateHeadroom(1000, 0.0194, p, 0.0231)
    const total = 1000 / ((0.92 * 0.0194) / 0.022)
    expect(h.utilAtTarget).toBeCloseTo(0.92 + (0.0011 * 0.08) / 0.06, 9)
    expect(h.withdrawalsToTarget!).toBeCloseTo(total - 1000 / h.utilAtTarget!, 6)
    expect(h.newBorrowsToTarget!).toBeCloseTo(h.utilAtTarget! * total - 1000, 6)
  })

  it('kink headroom from balances', () => {
    const k = M.kinkHeadroom(800, 200, 0.9)
    expect(k.utilization).toBeCloseTo(0.8, 9)
    expect(k.borrowsToKink).toBeCloseTo(100, 9)
    expect(k.withdrawalsToKink).toBeCloseTo(1000 - 800 / 0.9, 9)
    expect(M.kinkHeadroom(950, 50, 0.9).borrowsToKink).toBe(0)
  })

  it('history breaches', () => {
    const day = 86_400_000
    const bars = Array.from({ length: 20 }, (_, i) => ({ t: i * day, close: 100, low: 99 }))
    bars[10] = { t: 10 * day, close: 90, low: 85 }
    const h = M.historyBreaches(bars, 0.1, [1, 7])
    expect(h['1d']).toMatchObject({ windows: 19, breaches: 1 })
    expect(h['7d'].breaches).toBe(7)
    expect(h['1d'].worst[0].drop).toBeCloseTo(0.15, 9)
  })

  it('carry gap: rising and falling', () => {
    const legs = (borrowApr: number) => [
      { collateralUsd: 21000, debtUsd: 0, yieldApr: 0.03, supplyApr: 0, borrowApr: 0 },
      { collateralUsd: 0, debtUsd: 16000, yieldApr: 0, supplyApr: 0, borrowApr },
    ]
    expect(M.carryGap(legs(0.02), 1.05)).toMatchObject({ daysToHf1: null })
    expect(M.carryGap(legs(0.02), 1.05).carryGapPerYear).toBeCloseTo(-0.01, 9)
    const dn = M.carryGap(legs(0.05), 1.05)
    expect(dn.carryGapPerYear).toBeCloseTo(0.02, 9)
    expect(dn.daysToHf1).toBeCloseTo((Math.log(1.05) / 0.02) * 365, 6)
  })

  it('what-if: price move, repay, add collateral', () => {
    const base = [
      { ...r('WETH', 2000, 20000, 0), stable: false },
      { ...r('USDC', 1, 0, 15000), stable: true },
    ]
    expect(
      M.applyWhatIf(base, { priceMovePct: -6.25, repayUsd: 0, addCollateralUsd: 0 }, 'WETH')
        .healthFactor,
    ).toBeCloseTo(1, 9)
    expect(
      M.applyWhatIf(base, { priceMovePct: 0, repayUsd: 5000, addCollateralUsd: 0 }, 'WETH')
        .healthFactor,
    ).toBeCloseTo(1.6, 9)
    expect(
      M.applyWhatIf(base, { priceMovePct: 0, repayUsd: 0, addCollateralUsd: 5000 }, 'WETH')
        .healthFactor,
    ).toBeCloseTo(20000 / 15000, 9)
  })
})

describe('what-if edge cases', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  const s = (
    symbol: string,
    priceUsd: number,
    collateralUsd: number,
    debtUsd: number,
    stable: boolean,
  ) => ({
    ...r(symbol, priceUsd, collateralUsd, debtUsd),
    stable,
  })

  it('a price move does not move the line: below HF 1 the liquidation price stays put', () => {
    const base = [s('WETH', 2000, 20000, 0, false), s('USDC', 1, 0, 15000, true)]
    const under = M.applyWhatIf(
      base,
      { priceMovePct: -12, repayUsd: 0, addCollateralUsd: 0 },
      'WETH',
    )
    expect(under.healthFactor!).toBeLessThan(1)
    expect(under.liquidationPrice!).toBeCloseTo(1875, 6)
  })

  it('ratio loop: a common move changes nothing, a ratio move does', () => {
    const loop = [s('weETH', 2100, 21000, 0, false), s('WETH', 2000, 0, 16000, false)]
    const common = M.applyWhatIf(
      loop,
      { priceMovePct: -10, repayUsd: 0, addCollateralUsd: 0 },
      'weETH',
    )
    expect(common.healthFactor!).toBeCloseTo(1.05, 9)
    const ratio = M.applyWhatIf(
      loop,
      { priceMovePct: -10, repayUsd: 0, addCollateralUsd: 0, ratioOnly: true },
      'weETH',
    )
    expect(ratio.healthFactor!).toBeCloseTo(0.945, 9)
  })
})

describe('carry board helpers', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('feed base, ratio yield, loop return', () => {
    expect(M.feedBase('Capped weETH / eETH(ETH) / USD')).toBe('WETH')
    expect(M.feedBase('Capped sUSDe / USDT / USD')).toBe('USDT')
    expect(M.feedBase('ETH / USD')).toBe('WETH')
    expect(M.feedBase(null)).toBeNull()
    const y = M.ratioYield(2100 * Math.exp(0.03 * (30 / 365)), 2000, 2100, 2000, 30)
    expect(y!).toBeCloseTo(0.03, 9)
    expect(M.ratioYield(0, 1, 1, 1, 30)).toBeNull()
    expect(M.loopReturn(0.03, 0.02, 5)).toBeCloseTo(0.07, 12)
  })
})

describe('cross-venue borrow board', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('comet APR and ranking', () => {
    expect(M.cometApr(1_000_000_000n)).toBeCloseTo(0.031536, 9)
    const r = M.rankQuotes([
      { asset: 'USDT', venue: 'Compound', borrowApr: 0.091, availableUsd: 1, utilization: 0.91 },
      { asset: 'USDT', venue: 'Aave', borrowApr: 0.053, availableUsd: 1, utilization: 0.93 },
      { asset: 'WETH', venue: 'Aave', borrowApr: 0.019, availableUsd: 1, utilization: 0.8 },
    ])
    const usdt = r.find((x) => x.asset === 'USDT')!
    expect(usdt.quotes[0].venue).toBe('Aave')
    expect(usdt.quotes[1].spread).toBeCloseTo(0.038, 9)
  })
})

describe('crash replay: Aave vs Membrane rules', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  const bar = (p: number, low = p) => ({ t: 0, open: p, high: p, low, close: p })

  it('a wick through the line liquidates on Aave but not under the 1 h average + timer', () => {
    const bars = [bar(100), bar(100, 89), bar(100), bar(100)] // one-hour wick to 89, line 90
    const r = M.replayCrash(bars, 90)
    expect(r.aave).toEqual({ liquidated: true, hour: 1 })
    expect(r.membrane.outcome).toBe('survived')
    expect(r.membrane.timerStartHour).toBeNull()
  })

  it('a deep average below line/1.04 is immediate', () => {
    const r = M.replayCrash([bar(100), bar(86)], 90)
    expect(r.membrane).toMatchObject({ outcome: 'immediate', hour: 1 })
  })

  it('timer starts at the line and liquidates on a re-dip in hours 8-16', () => {
    const bars = [bar(89.5), ...Array.from({ length: 7 }, () => bar(95)), bar(89.5)]
    const r = M.replayCrash(bars, 90)
    expect(r.membrane).toMatchObject({ outcome: 'timer', hour: 8, timerStartHour: 0 })
  })

  it('recovery before hour 8 and no re-dip in 8-16: survives; a stale timer lapses at 16 h', () => {
    const bars = [bar(89.5), ...Array.from({ length: 20 }, () => bar(95)), bar(89.5)]
    const r = M.replayCrash(bars, 90)
    expect(r.membrane.outcome).toBe('survived')
    expect(r.membrane.timerStartHour).toBe(0)
  })
})

describe('Morpho filtering', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('drops spam markets and converts APY to APR', () => {
    const keep = M.usableMorpho([
      {
        loan: 'USDC',
        collateral: 'PAXG',
        lltv: 0.915,
        borrowApy: 2979.96,
        liquidityUsd: 0,
        utilization: 1,
      },
      {
        loan: 'USDC',
        collateral: 'cbBTC',
        lltv: 0.86,
        borrowApy: 0.0502,
        liquidityUsd: 34e6,
        utilization: 0.9,
      },
      {
        loan: 'USDC',
        collateral: 'tiny',
        lltv: 0.86,
        borrowApy: 0.05,
        liquidityUsd: 2e5,
        utilization: 0.5,
      },
      {
        loan: 'USDC',
        collateral: null,
        lltv: 0,
        borrowApy: 0.01,
        liquidityUsd: 5e6,
        utilization: 0.1,
      },
    ])
    expect(keep.map((m) => m.collateral)).toEqual(['cbBTC'])
    expect(M.apyToApr(0.0502)).toBeCloseTo(Math.log(1.0502), 12)
  })
})

describe('rules check', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('passes, fails and cannot-judge', () => {
    const r = M.checkRules(M.DEFAULT_RULES, {
      healthFactor: 1.05,
      distance: 0.099,
      past7d: { windows: 2851, breaches: 463 },
    })
    expect(r.map((x) => x.pass)).toEqual([false, true, false])
    const loop = M.checkRules(M.DEFAULT_RULES, { healthFactor: 1.2, distance: 0.03, past7d: null })
    expect(loop.map((x) => x.pass)).toEqual([true, false, null])
    expect(M.checkRules(M.DEFAULT_RULES, { healthFactor: null, distance: null })[0].pass).toBe(true)
  })
})

describe('safe borrow size', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('curve, target distance and debt change', () => {
    const day = 86_400_000
    const bars = Array.from({ length: 40 }, (_, i) => ({ t: i * day, close: 100, low: 99 }))
    bars[20] = { t: 20 * day, close: 80, low: 75 }
    const curve = M.breachCurve(bars, [0.01, 0.1, 0.3])
    expect(curve[0].share).toBeGreaterThan(curve[1].share)
    expect(curve[2].share).toBe(0)
    expect(M.distanceForShare(curve, 0)).toBe(0.3)
    // 10 WETH @2000, LT 0.8 = 16000 cLT; 15000 USDC debt (d = 6.25 %). For d = 25 %: debt = 12000.
    const pos = [
      { ...r('WETH', 2000, 20000, 0), stable: false },
      { ...r('USDC', 1, 0, 15000), stable: true },
    ]
    expect(M.debtChangeForDistance(pos, 0.25)!).toBeCloseTo(-3000, 3)
    expect(M.debtChangeForDistance(pos, 0.0)!).toBeCloseTo(1000, 3)
  })
})

describe('peg monitor', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('uses the deepest pool and ignores empty ones', () => {
    expect(M.sqrtToPrice(2n ** 96n)).toBe(1)
    const g = M.pegGap(
      [
        { fee: 100, liquidity: 0, lstInBase: 1.0076 },
        { fee: 500, liquidity: 2.25e24, lstInBase: 1.10617 },
        { fee: 3000, liquidity: 2.4e14, lstInBase: 1.097 },
      ],
      1.10677,
    )
    expect(g!.fee).toBe(500)
    expect(g!.gapPct).toBeCloseTo(1.10617 / 1.10677 - 1, 12)
    expect(M.pegGap([{ fee: 100, liquidity: 0, lstInBase: 1 }], 1.08)).toBeNull()
  })
})

describe('spread history stats', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('median, negatives, range', () => {
    expect(M.spreadStats([])).toBeNull()
    expect(M.spreadStats([0.003, -0.01, 0.004, 0.002, -0.001])).toEqual({
      weeks: 5,
      median: 0.002,
      negativeWeeks: 2,
      min: -0.01,
      max: 0.004,
    })
  })
})

describe('competitor vaults', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('filters small and absurd vaults, prefers V2, sorts by size', () => {
    const v = M.usableVaults([
      { name: 'A', asset: 'USDC', netApy: 0.05, tvlUsd: 1e8, version: 'V1' },
      { name: 'A', asset: 'USDC', netApy: 0.051, tvlUsd: 9e7, version: 'V2' },
      { name: 'B', asset: 'USDT', netApy: 0.04, tvlUsd: 2e8, version: 'V2' },
      { name: 'C', asset: 'USDC', netApy: 0.07, tvlUsd: 5e6, version: 'V2' },
      { name: 'D', asset: 'USDC', netApy: 30, tvlUsd: 5e8, version: 'V1' },
    ])
    expect(v.map((x) => `${x.name}:${x.version}`)).toEqual(['B:V2', 'A:V2'])
  })
})

describe('greedy unwind split', async () => {
  const M = await import('@/components/LiquidationMap/marketsLogic')
  it('fills the deeper venue first and splits when the first saturates', async () => {
    // venue A: constant product with reserves 100/100; venue B: 1000/1000
    const cp = (r: number) => async (x: number) => (r * x) / (r + x)
    const small = await M.greedySplit([cp(100), cp(1000)], 1, 10)
    expect(small.shares[1]).toBeGreaterThan(0.8)
    const big = await M.greedySplit([cp(100), cp(1000)], 400, 40)
    expect(big.shares[0]).toBeGreaterThan(0)
    expect(big.out).toBeGreaterThan(await cp(1000)(400)) // splitting beats one venue
  })
})
