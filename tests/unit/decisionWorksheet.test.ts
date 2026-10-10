import { describe, expect, it } from 'vitest'

import {
  calculateRateWorksheet,
  MAX_WORKSHEET_APY,
  MAX_WORKSHEET_SIZE_GHO,
  MIN_WORKSHEET_YIELD_APY,
  vaultSideRedeemCeiling,
} from '@/lib/carry/decisionWorksheet'

const rates = { sizeGho: 10_000, borrowApy: 0.04, yieldApy: 0.05 }

describe('sGHO vault-side redemption bound', () => {
  it('takes the lower of cash and totalAssets without losing fractional GHO', () => {
    expect(
      vaultSideRedeemCeiling({
        vaultCashGho: 120.9,
        totalAssetsGho: 100.8,
        withdrawalsPaused: false,
      }),
    ).toBe(100.8)
    expect(
      vaultSideRedeemCeiling({
        vaultCashGho: 80.9,
        totalAssetsGho: 100.8,
        withdrawalsPaused: false,
      }),
    ).toBe(80.9)
    expect(
      vaultSideRedeemCeiling({ vaultCashGho: 0.9, totalAssetsGho: 10, withdrawalsPaused: false }),
    ).toBe(0.9)
  })

  it('returns zero while paused and rejects incomplete values', () => {
    expect(
      vaultSideRedeemCeiling({ vaultCashGho: 120, totalAssetsGho: 100, withdrawalsPaused: true }),
    ).toBe(0)
    expect(
      vaultSideRedeemCeiling({ vaultCashGho: NaN, totalAssetsGho: 100, withdrawalsPaused: false }),
    ).toBeNull()
    expect(
      vaultSideRedeemCeiling({ vaultCashGho: 120, totalAssetsGho: -1, withdrawalsPaused: false }),
    ).toBeNull()
  })
})

describe('equal-principal rate worksheet', () => {
  it('illustrates a positive spread and a percentage-point borrow shock', () => {
    const result = calculateRateWorksheet({ ...rates, borrowShockPp: 1 })
    expect(result?.currentAnnualNetGho).toBeCloseTo(100)
    expect(result?.shockedAnnualNetGho).toBeCloseTo(0)
    expect(result?.currentSpreadPp).toBeCloseTo(1)
    expect(result?.shockedSpreadPp).toBeCloseTo(0)
    expect(result?.breakEvenBorrowApy).toBe(0.05)
    expect(result?.breakEvenHeadroomPp).toBeCloseTo(1)
  })

  it('allows an already-negative spread and shows further loss after a two-point shock', () => {
    const result = calculateRateWorksheet({ ...rates, borrowApy: 0.06, borrowShockPp: 2 })
    expect(result?.currentAnnualNetGho).toBeCloseTo(-100)
    expect(result?.shockedAnnualNetGho).toBeCloseTo(-300)
    expect(result?.breakEvenHeadroomPp).toBeCloseTo(-1)
  })

  it('includes a bounded negative effective yield when the share price falls', () => {
    const result = calculateRateWorksheet({ ...rates, yieldApy: -0.02, borrowShockPp: 1 })
    expect(result?.currentAnnualNetGho).toBeCloseTo(-600)
    expect(result?.shockedAnnualNetGho).toBeCloseTo(-700)
    expect(result?.breakEvenBorrowApy).toBe(-0.02)
    expect(result?.breakEvenHeadroomPp).toBeCloseTo(-6)
  })

  it('shows a one-point borrow shock crossing a small positive spread below zero', () => {
    const result = calculateRateWorksheet({ ...rates, yieldApy: 0.045, borrowShockPp: 1 })
    expect(result?.currentAnnualNetGho).toBeCloseTo(50)
    expect(result?.shockedAnnualNetGho).toBeCloseTo(-50)
    expect(result?.currentSpreadPp).toBeCloseTo(0.5)
    expect(result?.shockedSpreadPp).toBeCloseTo(-0.5)
  })

  it('defaults to no shock and does not use freshness metadata in its arithmetic', () => {
    const reading = { ...rates, stale: true, observedAt: '2026-08-01T00:00:00Z' }
    const result = calculateRateWorksheet(reading)
    expect(result).toEqual(calculateRateWorksheet(rates))
    expect(result?.currentAnnualNetGho).toBeCloseTo(result?.shockedAnnualNetGho ?? NaN)
  })

  it('returns null for an incomplete size rather than inventing an annual return', () => {
    expect(calculateRateWorksheet({ ...rates, sizeGho: 0 })).toBeNull()
  })

  it.each([NaN, Infinity, -Infinity, -1, MAX_WORKSHEET_SIZE_GHO + 1])(
    'rejects invalid principal %s',
    (sizeGho) => {
      expect(calculateRateWorksheet({ ...rates, sizeGho })).toBeNull()
    },
  )

  it.each([NaN, Infinity, -Infinity, MAX_WORKSHEET_APY + 0.01])(
    'rejects nonfinite or excessive borrow and yield APY %s',
    (apy) => {
      expect(calculateRateWorksheet({ ...rates, borrowApy: apy })).toBeNull()
      expect(calculateRateWorksheet({ ...rates, yieldApy: apy })).toBeNull()
    },
  )

  it('rejects negative borrowing APY and yields below the effective-rate floor', () => {
    expect(calculateRateWorksheet({ ...rates, borrowApy: -0.01 })).toBeNull()
    expect(calculateRateWorksheet({ ...rates, yieldApy: -1 })).toBeNull()
    expect(
      calculateRateWorksheet({ ...rates, yieldApy: MIN_WORKSHEET_YIELD_APY + 0.0001 }),
    ).not.toBeNull()
  })

  it.each([NaN, Infinity, -1, 0.5, 3])('rejects unsupported borrow shock %s pp', (shock) => {
    expect(calculateRateWorksheet({ ...rates, borrowShockPp: shock })).toBeNull()
  })
})
