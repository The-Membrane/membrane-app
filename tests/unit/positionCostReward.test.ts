import { describe, expect, it, vi } from 'vitest'

import {
  anchorForRead,
  buildCostReward,
  costRewardReadKey,
  rateContributions,
  readRateAnchor,
  RATE_ANCHOR_DEADLINE_MS,
} from '@/lib/position/costReward'
import { RATE_HISTORY, type RateHistoryTable } from '@/lib/position/rateHistory'
import type { ProtocolPosition } from '@/lib/position-sim/types'

// Synthetic accounting cases stay in tests, never the product history file.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const NOW = Date.parse('2026-10-17T02:00:00Z')
const CLOCK = { nowMs: NOW, observedAtMs: NOW - 12_000, anchorState: 'ready' as const }
function position(): ProtocolPosition {
  return {
    protocol: 'aave-v3',
    usdValuationBasis: 'source-oracle',
    chainId: 1,
    venueAddress: POOL,
    label: 'Aave V3',
    collateral: [
      {
        symbol: 'USDC',
        address: USDC,
        decimals: 6,
        amount: 2000,
        priceUsd: 0.98,
        valueUsd: 1960,
        liquidationThreshold: 0.8,
        maxLtv: 0.75,
        liquidationBonus: 0.05,
        supplyApr: 0.03,
        supplyAprSource: 'measured liquidity rate',
        supplyAprFeeBasis: 'protocol-fee-net',
      },
    ],
    debt: [
      {
        symbol: 'USDT',
        address: USDT,
        decimals: 6,
        amount: 1000,
        priceUsd: 1.01,
        valueUsd: 1010,
        borrowApr: 0.05,
        borrowRateBasis: 'variable',
      },
    ],
    totalCollateralUsd: 1960,
    totalDebtUsd: 1010,
    ltv: 1010 / 1960,
    liquidationLtv: 0.8,
    healthFactor: (1960 * 0.8) / 1010,
    provenance: { kind: 'onchain', label: 'accounting test', at: NOW, block: 100 },
  }
}

function history(): RateHistoryTable {
  return {
    ...RATE_HISTORY,
    series: RATE_HISTORY.series.map((series) => ({
      ...series,
      points: series.points.slice(-3).map((point) => ({
        ...point,
        quality: 'observed' as const,
        apr: series.side === 'borrow' ? 0.04 : 0.02,
        missingReason: null,
      })),
    })),
  }
}

describe('measured cost and reward accounting', () => {
  it('uses underlying quantities and observed prices, with fee-net supply rates exactly once', () => {
    const model = buildCostReward(position(), history(), CLOCK)
    expect(model.current.state).toBe('fresh')
    expect(model.current.costUsdPerYear).toBeCloseTo(50.5)
    expect(model.current.incomeUsdPerYear).toBeCloseTo(58.8)
    expect(model.current.spreadUsdPerYear).toBeCloseTo(8.3)
    expect(model.history[0].costUsdPerYear).toBeCloseTo(40.4)
    expect(model.history[0].incomeUsdPerYear).toBeCloseTo(39.2)
    expect(model.history[0].costUsdPerYear).not.toBe(40) // no assumed dollar peg
    expect(model.history).toHaveLength(3) // no extra live-to-history extrapolation
  })

  it('does not hide a missing rate or return a partial sum as a whole-position spread', () => {
    const p = position()
    p.debt.push({
      ...p.debt[0],
      address: '0x1111111111111111111111111111111111111111',
      borrowApr: null,
    })
    const model = buildCostReward(p, history(), CLOCK)
    expect(model.current.costUsdPerYear).toBeNull()
    expect(model.current.incomeUsdPerYear).toBeCloseTo(58.8)
    expect(model.current.spreadUsdPerYear).toBeNull()
    expect(model.debtCoverage.pricedLegs).toBe(1)
    expect(model.debtCoverage.legs).toBe(2)
    expect(model.history.every((point) => point.costUsdPerYear === null)).toBe(true)
  })

  it('never maps a reserve variable history onto fixed, mixed or unknown debt', () => {
    for (const basis of ['fixed', 'mixed', 'unknown', undefined] as const) {
      const p = position()
      p.debt[0].borrowRateBasis = basis
      const model = buildCostReward(p, history(), CLOCK)
      expect(model.current.costUsdPerYear).toBeCloseTo(50.5)
      expect(model.history.every((point) => point.costUsdPerYear === null)).toBe(true)
    }
  })

  it('requires chain, protocol and actual resolved venue identity, not an asset symbol', () => {
    for (const mutation of [
      { chainId: 10 },
      { chainId: undefined },
      { venueAddress: undefined },
      { venueAddress: '0x1111111111111111111111111111111111111111' },
      { protocol: 'spark' as const },
    ]) {
      const legs = rateContributions({ ...position(), ...mutation }, history())
      expect(legs.every((leg) => leg.history === null)).toBe(true)
    }
    const p = position()
    p.debt[0].address = USDC
    p.debt[0].symbol = 'OTHER' // identity still exact despite an irrelevant display label
    expect(rateContributions(p, history())[0].history?.identity.tokenAddress.toLowerCase()).toBe(
      USDC.toLowerCase(),
    )
  })

  it('preserves gaps and regime boundaries instead of forward-filling or inventing zero', () => {
    const table = history()
    const debt = table.series.find(
      (s) => s.identity.tokenAddress.toLowerCase() === USDT.toLowerCase() && s.side === 'borrow',
    )!
    debt.points[1] = {
      ...debt.points[1],
      apr: null,
      quality: 'regime-change',
      missingReason: 'Curve parameters changed',
    }
    const model = buildCostReward(position(), table, CLOCK)
    expect(model.history.map((point) => point.costUsdPerYear)).toEqual([40.4, null, 40.4])
    expect(model.history[1].missing.join(' ')).toContain('Curve parameters changed')
    expect(model.history[1].incomeUsdPerYear).toBeCloseTo(39.2)
  })

  it('keeps negative venue income negative rather than clamping it at a fee-split boundary', () => {
    const p = position()
    p.collateral[0].supplyApr = -0.02
    const model = buildCostReward(p, history(), CLOCK)
    expect(model.current.incomeUsdPerYear).toBeCloseTo(-39.2)
    expect(model.current.spreadUsdPerYear).toBeCloseTo(-89.7)
  })

  it('withholds unknown native wrapper income and never counts the holding twice', () => {
    const p = position()
    p.collateral[0].address = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'
    p.collateral[0].symbol = 'wstETH'
    p.collateral[0].supplyApr = 0
    const model = buildCostReward(p, history(), CLOCK)
    expect(model.contributions.filter((leg) => leg.side === 'income')).toHaveLength(2)
    expect(model.incomeCoverage.totalValueUsd).toBe(1960)
    expect(model.current.incomeUsdPerYear).toBeNull()
    expect(model.current.spreadUsdPerYear).toBeNull()
    expect(model.contributions.find((leg) => leg.component === 'native')?.missingReason).toContain(
      'unavailable',
    )
  })

  it('withholds unknown fee bases, missing dollar prices and malformed quantities', () => {
    const p = position()
    p.collateral[0].supplyAprFeeBasis = 'unknown'
    expect(buildCostReward(p, history(), CLOCK).current.incomeUsdPerYear).toBeNull()
    p.debt[0].priceUsd = Number.NaN
    let model = buildCostReward(p, history(), CLOCK)
    expect(model.current.costUsdPerYear).toBeNull()
    expect(model.debtCoverage.totalValueUsd).toBeNull()
    p.debt[0].amount = Number.NaN
    model = buildCostReward(p, history(), CLOCK)
    expect(model.current.costUsdPerYear).toBeNull()
    expect(model.noDebt).toBe(false)
  })

  it('never labels an assumed stablecoin peg as a measured dollar valuation', () => {
    const p = position()
    p.usdValuationBasis = 'assumed-peg'
    const model = buildCostReward(p, history(), CLOCK)
    expect(model.current.costUsdPerYear).toBeNull()
    expect(model.current.incomeUsdPerYear).toBeNull()
    expect(model.current.spreadUsdPerYear).toBeNull()
    expect(model.debtCoverage.totalValueUsd).toBeNull()
    expect(
      model.history.every(
        (point) => point.costUsdPerYear === null && point.incomeUsdPerYear === null,
      ),
    ).toBe(true)
  })

  it('separates no-debt, no-income and unsupported supplied positions', () => {
    const p = position()
    p.debt = []
    expect(buildCostReward(p, history(), CLOCK)).toMatchObject({
      noDebt: true,
      current: { costUsdPerYear: null, spreadUsdPerYear: null },
    })
    p.collateral = []
    expect(buildCostReward(p, history(), CLOCK).current.incomeUsdPerYear).toBeNull()
    p.supplied = [
      { symbol: 'USDT', address: USDT, decimals: 6, amount: 10, priceUsd: 1, valueUsd: 10 },
    ]
    const supplied = buildCostReward(p, history(), CLOCK)
    expect(supplied.contributions[0].assignment).toBe('supplied')
    expect(supplied.current.incomeUsdPerYear).toBeNull()
  })

  it('uses the block observation clock and preserves dated history when the current read is stale', () => {
    const p = position()
    p.provenance.at = NOW // fetching today cannot refresh an old block
    const stale = buildCostReward(p, history(), { ...CLOCK, observedAtMs: NOW - 16 * 60_000 })
    expect(stale.current.state).toBe('stale')
    expect(stale.current.costUsdPerYear).toBeNull()
    expect(stale.history[0].costUsdPerYear).toBeCloseTo(40.4)
    expect(
      buildCostReward(p, history(), { ...CLOCK, observedAtMs: NOW + 61_000 }).current.state,
    ).toBe('stale')
    expect(
      buildCostReward(p, history(), { ...CLOCK, observedAtMs: null, anchorState: 'error' }).current
        .state,
    ).toBe('unavailable')
    expect(
      buildCostReward(p, history(), { ...CLOCK, observedAtMs: null, anchorState: 'loading' })
        .current.state,
    ).toBe('loading')
  })

  it('preserves independent sides when their historical observations are more than a minute apart', () => {
    const table = history()
    table.series.find(
      (s) => s.side === 'borrow' && s.identity.tokenAddress.toLowerCase() === USDT.toLowerCase(),
    )!.points[0].observedAt! -= 61
    const model = buildCostReward(position(), table, CLOCK)
    expect(model.history[0].costUsdPerYear).toBeCloseTo(40.4)
    expect(model.history[0].incomeUsdPerYear).toBeCloseTo(39.2)
    expect(model.history[0].costObservedAtMs).not.toBe(model.history[0].incomeObservedAtMs)
  })

  it('does not aggregate several debt legs whose historical observations are more than a minute apart', () => {
    const table = history(),
      p = position()
    p.debt.push({ ...p.debt[0], symbol: 'USDC', address: USDC })
    table.series.find(
      (s) => s.side === 'borrow' && s.identity.tokenAddress.toLowerCase() === USDT.toLowerCase(),
    )!.points[0].observedAt! -= 61
    const model = buildCostReward(p, table, CLOCK)
    expect(model.history[0].costUsdPerYear).toBeNull()
    expect(model.history[0].incomeUsdPerYear).toBeCloseTo(39.2)
  })
})

describe('read-bound source observation receipts', () => {
  it('turns a busy observation read into an unavailable state at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const pending = readRateAnchor('busy', 100, () => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(RATE_ANCHOR_DEADLINE_MS)
      expect(await pending).toEqual({ readKey: 'busy', observedAtMs: null, state: 'error' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('validates the returned pinned block and never uses fetch time as observation time', async () => {
    expect(
      await readRateAnchor('a', 100, async () => ({ number: 100n, timestamp: 1234n })),
    ).toEqual({ readKey: 'a', state: 'ready', observedAtMs: 1_234_000 })
    expect(
      (await readRateAnchor('a', 100, async () => ({ number: 101n, timestamp: 1234n }))).state,
    ).toBe('error')
    expect(
      (
        await readRateAnchor('a', undefined, async () => {
          throw new Error('must not read')
        })
      ).state,
    ).toBe('error')
    expect(
      (
        await readRateAnchor('a', 100, async () => {
          throw new Error('RPC unavailable')
        })
      ).state,
    ).toBe('error')
  })

  it('rejects a delayed receipt after address, selection or retry changes', async () => {
    const p = position()
    const oldKey = costRewardReadKey('address-A#1', p)
    const newKey = costRewardReadKey('address-B#1', p)
    let finish!: (value: { number: bigint; timestamp: bigint }) => void
    const pending = readRateAnchor(
      oldKey,
      100,
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    finish({ number: 100n, timestamp: 1234n })
    const receipt = await pending
    expect(anchorForRead(newKey, receipt)).toBeNull()
    expect(anchorForRead(costRewardReadKey('address-A#2', p), receipt)).toBeNull()
    expect(anchorForRead(oldKey, receipt)).toBe(receipt)
  })
})
