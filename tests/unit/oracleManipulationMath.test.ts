/**
 * Pure-math unit tests for the oracle-manipulation engine. No network: every input is
 * either a literal or the frozen on-chain snapshot in fixtures/.
 */

import { describe, it, expect } from 'vitest'
import { keccak256, selector, topic } from '@/lib/oracleRegistry/manipulation/chain/keccak'
import { encodeAbi, decodeAbi, fn } from '@/lib/oracleRegistry/manipulation/chain/abi'
import { precompute, trade, tradeSplit, pendleImpactCurve, type PendleState } from '@/lib/oracleRegistry/manipulation/cost/pendle'
import { walkV3, type V3State } from '@/lib/oracleRegistry/manipulation/cost/univ3'
import { strategyCost, sampleAt, pctToX } from '@/lib/oracleRegistry/manipulation/cost/impact'
import { positionCapture, downsideEv, upsideEv, totalEv, morphoLif } from '@/lib/oracleRegistry/manipulation/ev/math'
import { deviationBand, pullSelection, divergence, clampMove } from '@/lib/oracleRegistry/manipulation/cost/freeMoves'
import { evalTree, treeFactor, readMove } from '@/lib/oracleRegistry/manipulation/tree'
import type { Exposure, ImpactCurve, PriceNode } from '@/lib/oracleRegistry/manipulation/types'
import snapshot from './fixtures/oracle-manipulation-snapshot.json'

describe('keccak256 / abi', () => {
  it('keccak matches known vectors', () => {
    expect(keccak256('', 'utf8')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(selector('transfer(address,uint256)')).toBe('0xa9059cbb')
    expect(topic('AnswerUpdated(int256,uint256,uint256)')).toBe('0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f')
  })
  it('abi round-trips static and dynamic params', () => {
    const types = 'address,uint256,bool,bytes'
    const v = ['0x000000000000000000000000000000000000dead', 123n, true, '0xabcd']
    const out = decodeAbi(types, encodeAbi(types, v)) as [string, bigint, boolean, string]
    expect(out[0]).toBe('0x000000000000000000000000000000000000dead')
    expect(out[1]).toBe(123n)
    expect(out[2]).toBe(true)
    expect(out[3]).toBe('0xabcd')
  })
  it('abi round-trips a nested tuple array', () => {
    const t = '(address,uint256)[]'
    const v = [['0x0000000000000000000000000000000000000001', 10n], ['0x0000000000000000000000000000000000000002', 20n]]
    const [out] = decodeAbi(t, encodeAbi(t, [v])) as [[string, bigint][]]
    expect(out).toHaveLength(2)
    expect(out[1][1]).toBe(20n)
  })
  it('fn builds calldata with the right selector', () => {
    const f = fn('balanceOf(address)', 'uint256')
    expect(f.encode(['0x0000000000000000000000000000000000000001']).slice(0, 10)).toBe('0x70a08231')
  })
})

describe('Pendle AMM', () => {
  const state = snapshot.pendlePtReusd.state as unknown as PendleState

  it('PT spot from readState matches the snapshot', () => {
    expect(1 / precompute(state).e0).toBeCloseTo(snapshot.pendlePtReusd.ptSpot, 6)
  })

  it('splitting a trade is cheaper than one lump (MarketMathCore prices at one point)', () => {
    const pre = precompute(state)
    const size = state.totalPt * 0.3
    const lump = trade(state, pre, -size)
    const split = tradeSplit(state, -size, 32)
    // Selling: more asset out of the pool is better for the attacker.
    expect(split.netAsset).toBeGreaterThan(lump.netAsset)
  })

  it('down-move cost and premium rise monotonically with the move', () => {
    const c = pendleImpactCurve(state, 'down', 1)
    expect(c.samples.length).toBeGreaterThan(2)
    for (let i = 1; i < c.samples.length; i++) {
      expect(c.samples[i].qUsd).toBeGreaterThan(c.samples[i - 1].qUsd)
      expect(c.samples[i].jUsd).toBeGreaterThanOrEqual(c.samples[i - 1].jUsd)
    }
  })

  it('cannot push past the 96% proportion cap', () => {
    const c = pendleImpactCurve(state, 'up', 1)
    expect(c.maxX).toBeLessThan(0.1) // a few percent, not unbounded
  })
})

describe('Uniswap v3 tick-walk', () => {
  // Reconstruct the frozen pool state (bigint fields were serialised as strings).
  const raw = snapshot.univ3UsdcWeth.state
  const state: V3State = {
    sqrtPriceX96: BigInt(raw.sqrtPriceX96),
    tick: raw.tick,
    liquidity: BigInt(raw.liquidity),
    fee: raw.fee,
    tickSpacing: raw.tickSpacing,
    decimals0: raw.decimals0,
    decimals1: raw.decimals1,
    ticks: raw.ticks.map((t) => ({ tick: t.tick, liquidityNet: BigInt(t.liquidityNet) })),
  }

  it('walking to a target reaches exactly that log move', () => {
    const { samples } = walkV3(state, 'up', [0.001, 0.01, 0.05])
    expect(samples.map((s) => s.x)).toEqual([0.001, 0.01, 0.05])
    // input grows with the move; premium is a small fraction of it
    for (const s of samples) expect(s.j).toBeLessThan(s.q)
    expect(samples[2].q).toBeGreaterThan(samples[0].q)
  })

  it('deeper moves cost strictly more in both directions', () => {
    const up = walkV3(state, 'up', [0.01, 0.1])
    const dn = walkV3(state, 'down', [0.01, 0.1])
    expect(up.samples[1].q).toBeGreaterThan(up.samples[0].q)
    expect(dn.samples[1].q).toBeGreaterThan(dn.samples[0].q)
  })
})

describe('impact → strategy cost (regimes)', () => {
  const curve: ImpactCurve = {
    direction: 'down',
    feeRate: 0.0005,
    mechanism: 'trade',
    liquidity: 'full',
    maxX: 1,
    samples: [
      { x: 0.01, qUsd: 1_000_000, jUsd: 2_000 },
      { x: 0.05, qUsd: 5_000_000, jUsd: 40_000 },
    ],
  }

  it('atomic cost is the round-trip fee only', () => {
    expect(strategyCost(curve, 0.01, 0, 'atomic')).toBeCloseTo(2 * 0.0005 * 1_000_000, 6)
  })
  it('a hold is impossible atomically', () => {
    expect(strategyCost(curve, 0.01, 900, 'atomic')).toBeNull()
  })
  it('passive cost ignores the hold length', () => {
    expect(strategyCost(curve, 0.01, 900, 'passive')).toBe(strategyCost(curve, 0.01, 60, 'passive'))
  })
  it('competitive cost grows with the hold (re-push each block)', () => {
    const short = strategyCost(curve, 0.05, 12, 'competitive')!
    const long = strategyCost(curve, 0.05, 120, 'competitive')!
    expect(long).toBeGreaterThan(short)
  })
  it('a donation costs its premium in every regime', () => {
    const don: ImpactCurve = { ...curve, mechanism: 'donation', samples: [{ x: 0.01, qUsd: 1e6, jUsd: 1e6 }] }
    expect(strategyCost(don, 0.01, 0, 'atomic')).toBe(1e6)
    expect(strategyCost(don, 0.01, 900, 'passive')).toBe(1e6)
  })
  it('sampleAt interpolates and refuses beyond reach', () => {
    expect(sampleAt(curve, 0.03)!.qUsd).toBeGreaterThan(1_000_000)
    expect(sampleAt(curve, 2)).toBeNull()
    expect(pctToX(1, 'up')).toBeCloseTo(Math.log(1.01), 9)
  })
})

describe('EV math', () => {
  const base: Exposure = {
    protocol: 'morpho-blue',
    id: 'm',
    label: 'm',
    role: 'collateral',
    tree: { op: 'leaf', leafId: 'x', read: { mode: 'feed' }, value: 1 },
    borrowLtv: 0.86,
    liqLtv: 0.86,
    lif: morphoLif(0.86),
    closeFactor: 1,
    borrowableUsd: 100e6,
    borrowableHiUsd: 100e6,
    liquidityKey: 'm',
    collateralRoomUsd: Infinity,
    positions: null,
    aggregate: { collateralUsd: 50e6, debtUsd: 40e6 },
  }

  it('morphoLif matches the Blue formula', () => {
    expect(morphoLif(0.86)).toBeCloseTo(Math.min(1.15, 1 / (0.3 * 0.86 + 0.7)), 9)
    expect(morphoLif(0.3)).toBe(1.15) // capped
  })

  it('upside pays only when r clears 1/borrowLtv', () => {
    expect(upsideEv(base, 1 / 0.86 - 0.001)).toBe(0)
    expect(upsideEv(base, 1.3)).toBeGreaterThan(0)
  })

  it('a healthy position captures nothing; an underwater one yields the bonus', () => {
    const p = { collateralUsd: 100, debtUsd: 80 } // hf at r=1 = 100*0.86/80 = 1.075
    expect(positionCapture({ ...base }, p, 1)).toBe(0)
    const cap = positionCapture({ ...base }, p, 0.9) // hf = 0.9675 < 1
    expect(cap).toBeGreaterThan(0)
  })

  it('downside EV_pt is withheld without positions but EV_hi uses the aggregate bound', () => {
    expect(downsideEv(base, 0.9, 'pt')).toBe(0)
    expect(downsideEv(base, 0.9, 'hi')).toBeGreaterThan(0)
  })

  it('shared liquidity caps total upside across a key', () => {
    const a = { ...base, id: 'a', liquidityKey: 'shared', borrowableUsd: 100e6 }
    const b = { ...base, id: 'b', liquidityKey: 'shared', borrowableUsd: 100e6 }
    const ev = totalEv([a, b], [1.3, 1.3], 'hi')
    // Both draw on one 100e6 pool, so the sum cannot exceed one pool's worth of profit.
    expect(ev.upsideUsd).toBeLessThanOrEqual(upsideEv(a, 1.3) + 1)
  })
})

describe('free moves', () => {
  it('deviation band is symmetric and sized by the threshold', () => {
    const fm = deviationBand(2, 'feed')!
    expect(fm.x).toBeCloseTo(Math.log(1.02), 9)
    expect(fm.directions).toEqual(['up', 'down'])
  })
  it('pull selection grows with staleness and volatility', () => {
    const a = pullSelection(60, 0.6, 'pyth')!
    const b = pullSelection(600, 0.6, 'pyth')!
    expect(b.x).toBeGreaterThan(a.x)
  })
  it('divergence points the right way', () => {
    expect(divergence(1.02, 1.0, 'oracle')!.directions).toEqual(['up'])
    expect(divergence(0.98, 1.0, 'oracle')!.directions).toEqual(['down'])
  })
  it('a clamp is free only at the bound', () => {
    expect(clampMove(1.0, 0.9, 1.1, 'f').move).toBeNull() // mid-range: headroom only
    expect(clampMove(0.9, 0.9, 1.1, 'f').move).not.toBeNull() // pinned at min
  })
})

describe('oracle tree', () => {
  const tree: PriceNode = {
    op: 'min',
    value: 0.97,
    of: [
      { op: 'leaf', leafId: 'pendle', read: { mode: 'twap', windowSec: 900 }, value: 0.97 },
      { op: 'leaf', leafId: 'lin', read: { mode: 'rate' }, value: 0.982 },
    ],
  }
  it('a TWAP reader sees only the held share of the window', () => {
    expect(readMove({ mode: 'twap', windowSec: 900 }, 0.02, 450)).toBeCloseTo(0.01, 9)
    expect(readMove({ mode: 'twap', windowSec: 900 }, 0.02, 900)).toBeCloseTo(0.02, 9)
    expect(readMove({ mode: 'spot' }, 0.02, 0)).toBe(0.02)
  })
  it('min node passes the move through the binding branch only', () => {
    const f = treeFactor(tree, 'pendle', (r) => Math.exp(-readMove(r, 0.01, 900)))
    expect(f).toBeCloseTo(Math.exp(-0.01), 6) // pendle binds at 0.97
    const g = treeFactor(tree, 'lin', (r) => Math.exp(-readMove(r, 0.01, 900)))
    expect(g).toBe(1) // moving the non-binding branch does nothing
  })
  it('evalTree on a product applies exponents', () => {
    const prod: PriceNode = {
      op: 'product',
      value: 2,
      factors: [
        { node: { op: 'leaf', leafId: 'a', read: { mode: 'feed' }, value: 4 }, exp: 1 },
        { node: { op: 'leaf', leafId: 'b', read: { mode: 'feed' }, value: 2 }, exp: -1 },
      ],
    }
    expect(evalTree(prod, (l) => (l.leafId === 'a' ? 1.1 : 1))).toBeCloseTo(2 * 1.1, 9)
    expect(evalTree(prod, (l) => (l.leafId === 'b' ? 1.1 : 1))).toBeCloseTo(2 / 1.1, 9)
  })
})
