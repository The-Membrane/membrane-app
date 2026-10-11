import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { baseApy, headlineApy } from '@/lib/carryScan/columns'
import { stabilityFromChart } from '@/lib/carryScan/stability'
import type { LlamaLendBorrow, LlamaPool, LlamaProtocol } from '@/lib/carryScan/types'
import {
  buildUniverse,
  isCollateralRow,
  rewardShare,
  stableIndex,
  STABLES_CONFIG,
} from '@/lib/carryScan/universe'

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'carry-scan-sources.json'), 'utf8'),
) as {
  pools: LlamaPool[]
  lendBorrow: LlamaLendBorrow[]
  protocols: LlamaProtocol[]
}
const uni = buildUniverse(fx.pools, fx.lendBorrow, fx.protocols)
const pool = (id: string) => fx.pools.find((p) => p.pool === id)!
const ids = (cs: { pool: LlamaPool }[]) => cs.map((c) => c.pool.pool).sort()

describe('S1 universe', () => {
  it('counts Ethereum ∧ stablecoin pools for the week-over-week gate, other chains and non-stables excluded', () => {
    expect(uni.ethStableCount).toBe(19)
    expect(uni.trace.has('pool-other-chain')).toBe(false)
  })

  it('splits single-exposure and ilRisk=no LP pools', () => {
    expect(uni.universeSingle).toBe(14)
    expect(uni.universeLp).toBe(1)
    expect(uni.trace.get('pool-lp-il')).toBe('universe: multi-asset with IL risk')
  })

  it('the Morpho trap: a market row describes the collateral, so it never enters the supply universe', () => {
    const stables = stableIndex()
    const lb = (id: string) => fx.lendBorrow.find((r) => r.pool === id)
    // USDC is the collateral; the loan is mintedCoin = USDT.
    expect(
      isCollateralRow(
        pool('pool-morpho-collateral-usdc'),
        lb('pool-morpho-collateral-usdc'),
        stables,
      ),
    ).toBe(true)
    expect(uni.trace.get('pool-morpho-collateral-usdc')).toBe(
      'universe: market row describes collateral (loan is mintedCoin)',
    )
    expect(uni.trace.get('pool-morpho-susde-usdc-idle')).toBe(
      'universe: market row describes collateral (loan is mintedCoin)',
    )
    // A vault row (no lendBorrow join) and an Aave reserve whose mintedCoin is its own asset are not collateral rows.
    expect(isCollateralRow(pool('pool-vault-usdc'), undefined, stables)).toBe(false)
    expect(isCollateralRow(pool('pool-aave-usdc'), lb('pool-aave-usdc'), stables)).toBe(false)
  })

  it('drops non-USD pegs: every underlying must be a listed USD stable', () => {
    expect(uni.trace.get('pool-eur')).toBe('universe: an underlying is not a listed USD stable')
    const syms = STABLES_CONFIG.stables.map((s) => s.symbol)
    for (const nonUsd of ['EURC', 'EURCV', 'ZCHF', 'XAUt', 'PAXG'])
      expect(syms).not.toContain(nonUsd)
    // Addresses are unique and compared lowercase.
    const addrs = STABLES_CONFIG.stables.map((s) => s.address.toLowerCase())
    expect(new Set(addrs).size).toBe(addrs.length)
  })
})

describe('S2 filters', () => {
  it('keeps exactly the pools that pass every filter', () => {
    expect(ids(uni.single)).toEqual([
      'pool-aave-horizon-rlusd',
      'pool-aave-usdc',
      'pool-apy-ne-sum',
      'pool-apy-null-parts',
      'pool-crvusd',
      'pool-vault-usdc',
    ])
    expect(ids(uni.lp)).toEqual(['pool-lp-usdc-usdt'])
  })

  it('excludes tvlUsd = 0 and sub-$10M pools, outliers, short history and majority-reward pools', () => {
    expect(uni.trace.get('pool-zero-tvl')).toBe('filter: TVL under $10M')
    expect(uni.trace.get('pool-spark-usdc')).toBe('filter: TVL under $10M')
    expect(uni.trace.get('pool-outlier')).toBe('filter: DeFiLlama outlier')
    expect(uni.trace.get('pool-short-history')).toBe('filter: under 30 days of history')
    expect(uni.trace.get('pool-reward-heavy')).toBe('filter: more than half the APY is rewards')
  })

  it('excludes denied projects and categories outside the allow list', () => {
    expect(uni.trace.get('pool-cedefi')).toMatch(/^filter: project denied/)
    expect(uni.trace.get('pool-uncollateralized')).toBe(
      'filter: category Uncollateralized Lending not allowed',
    )
  })

  it('the apy ≠ base + reward case: headline is apy, reward share comes from apyReward only', () => {
    const p = pool('pool-apy-ne-sum') // apy 5.0, base 3.0, reward 1.0
    expect(headlineApy(p)).toBeCloseTo(0.05, 12)
    expect(rewardShare(p)).toBeCloseTo(0.2, 12)
    expect(baseApy(p)).toBeCloseTo(0.03, 12)
    // base and reward both null (fluid-lite style): the whole headline counts as base, no rewards.
    const q = pool('pool-apy-null-parts')
    expect(rewardShare(q)).toBe(0)
    expect(baseApy(q)).toBeCloseTo(0.0683, 12)
  })

  it('records the first failed gate for every pool that falls out', () => {
    const total = Object.values(uni.traceCounts).reduce((s, n) => s + n, 0)
    expect(total + uni.single.length + uni.lp.length).toBe(uni.ethStableCount)
  })
})

describe('finalist stability (90-day chart)', () => {
  const day = (i: number) => new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString()
  it('passes a calm series and fails a volatile one or a spike', () => {
    const calm = Array.from({ length: 90 }, (_, i) => ({
      timestamp: day(i),
      apy: 5 + (i % 2 ? 0.2 : -0.2),
    }))
    expect(stabilityFromChart(calm, 5.1).ok).toBe(true)
    const wild = Array.from({ length: 90 }, (_, i) => ({ timestamp: day(i), apy: i % 2 ? 8 : 3 }))
    const w = stabilityFromChart(wild, 5)
    expect(w.ok).toBe(false)
    expect(w.reason).toMatch(/σ/)
    // bUSD0 on 2026-10-10: 5.93 now against a 3.35 median.
    const flat = Array.from({ length: 90 }, (_, i) => ({ timestamp: day(i), apy: 3.35 }))
    const s = stabilityFromChart(flat, 5.93)
    expect(s.ok).toBe(false)
    expect(s.spikeRatio).toBeCloseTo(5.93 / 3.35, 9)
  })
  it('refuses to judge a series shorter than 30 points', () => {
    const short = Array.from({ length: 10 }, (_, i) => ({ timestamp: day(i), apy: 5 }))
    expect(stabilityFromChart(short, 5)).toMatchObject({ ok: false, points: 10 })
  })
})
