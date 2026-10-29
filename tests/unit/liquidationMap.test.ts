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
