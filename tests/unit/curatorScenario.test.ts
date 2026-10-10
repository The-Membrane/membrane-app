import { describe, expect, it } from 'vitest'

import { calculateCuratorScenario, calculateDiscoDecisionWindow } from '@/lib/carry/curatorScenario'

const base = {
  principalGho: 10_000,
  horizonDays: 30,
  borrowApy: 0.04,
  yieldApy: 0.05,
  borrowRisePp: 0.5,
  yieldFallPp: 0.5,
  cashDrawdownPct: 25,
}

describe('curator carry and cash what-if', () => {
  it('combines both rate shocks as percentage points on the same principal', () => {
    const result = calculateCuratorScenario(base)
    expect(result?.currentSpreadPp).toBeCloseTo(1)
    expect(result?.stressedSpreadPp).toBeCloseTo(0)
    expect(result?.currentAnnualNetGho).toBeCloseTo(100)
    expect(result?.stressedAnnualNetGho).toBeCloseTo(0)
    expect(result?.changeInAnnualNetGho).toBeCloseTo(-100)
    expect(result?.currentHorizonNetGho).toBeCloseTo((100 * 30) / 365)
    expect(result?.stressedHorizonNetGho).toBeCloseTo(0)
    expect(result?.changeInHorizonNetGho).toBeCloseTo((-100 * 30) / 365)
    expect(result?.inventory).toBeNull()
  })

  it('shows an adverse spread without calling it a risk forecast', () => {
    const result = calculateCuratorScenario({ ...base, borrowApy: 0.07 })
    expect(result?.currentAnnualNetGho).toBeCloseTo(-200)
    expect(result?.stressedAnnualNetGho).toBeCloseTo(-300)
    expect(result?.combinedShockRoomPp).toBeCloseTo(-2)
    expect(result?.currentHorizonNetGho).toBeCloseTo((-200 * 30) / 365)
  })

  it('scales a fixed annualized spread over the inclusive 1–365 day planning range', () => {
    const oneDay = calculateCuratorScenario({ ...base, horizonDays: 1 })
    const fullYear = calculateCuratorScenario({ ...base, horizonDays: 365 })
    expect(oneDay?.horizonDays).toBe(1)
    expect(oneDay?.currentHorizonNetGho).toBeCloseTo(100 / 365)
    expect(fullYear?.currentHorizonNetGho).toBeCloseTo(fullYear?.currentAnnualNetGho ?? NaN)
    expect(fullYear?.stressedHorizonNetGho).toBeCloseTo(fullYear?.stressedAnnualNetGho ?? NaN)
  })

  it('keeps vault-side cash distinct from a wallet executable quote', () => {
    const result = calculateCuratorScenario({
      ...base,
      vaultCashGho: 12_000,
      vaultAssetsGho: 20_000,
      withdrawalsPaused: false,
    })
    expect(result?.inventory?.currentVaultSideGho).toBe(12_000)
    expect(result?.inventory?.stressedVaultSideGho).toBe(9_000)
    expect(result?.inventory?.currentShortfallGho).toBe(0)
    expect(result?.inventory?.stressedShortfallGho).toBe(1_000)
    expect(result?.inventory?.cashDrawdownRoomPct).toBeCloseTo(16.666666)
  })

  it('caps by vault assets and treats paused withdrawals as zero vault-side bound', () => {
    const capped = calculateCuratorScenario({
      ...base,
      vaultCashGho: 20_000,
      vaultAssetsGho: 8_000,
      withdrawalsPaused: false,
    })
    expect(capped?.inventory?.currentVaultSideGho).toBe(8_000)
    expect(capped?.inventory?.currentShortfallGho).toBe(2_000)
    expect(capped?.inventory?.cashDrawdownRoomPct).toBeNull()
    const paused = calculateCuratorScenario({
      ...base,
      vaultCashGho: 20_000,
      vaultAssetsGho: 20_000,
      withdrawalsPaused: true,
    })
    expect(paused?.inventory?.stressedVaultSideGho).toBe(0)
    expect(paused?.inventory?.cashDrawdownRoomPct).toBeNull()
    const alreadyShort = calculateCuratorScenario({
      ...base,
      vaultCashGho: 9_000,
      vaultAssetsGho: 20_000,
      withdrawalsPaused: false,
    })
    expect(alreadyShort?.inventory?.currentShortfallGho).toBe(1_000)
    expect(alreadyShort?.inventory?.cashDrawdownRoomPct).toBeNull()
  })

  it('rejects incomplete inventory and invalid or unsupported shocks', () => {
    expect(calculateCuratorScenario({ ...base, vaultCashGho: 1_000 })).toBeNull()
    expect(
      calculateCuratorScenario({
        ...base,
        vaultCashGho: -1,
        vaultAssetsGho: 10,
        withdrawalsPaused: false,
      }),
    ).toBeNull()
    expect(calculateCuratorScenario({ ...base, principalGho: 0 })).toBeNull()
    for (const horizonDays of [0, 366, 1.5, NaN, Infinity, -Infinity]) {
      expect(calculateCuratorScenario({ ...base, horizonDays })).toBeNull()
    }
    expect(calculateCuratorScenario({ ...base, borrowRisePp: -1 })).toBeNull()
    expect(calculateCuratorScenario({ ...base, yieldFallPp: 3 })).toBeNull()
    expect(calculateCuratorScenario({ ...base, yieldApy: -0.99, yieldFallPp: 2 })).toBeNull()
    expect(calculateCuratorScenario({ ...base, cashDrawdownPct: 80 })).toBeNull()
  })
})

describe('user-entered Disco lower-LTV planning window', () => {
  it('counts back both request boundaries and shows eligibility if requested today', () => {
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 30,
        configuredWaitDays: 7,
        executionWindowDays: 2,
      }),
    ).toEqual({
      earliestUsefulRequestInDays: 21,
      latestRequestInDays: 23,
      todayStatus: 'early',
      eligibilityStartsInDays: 7,
      eligibilityEndsInDays: 9,
    })
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 5,
        configuredWaitDays: 7,
        executionWindowDays: 2,
      }),
    ).toEqual({
      earliestUsefulRequestInDays: -4,
      latestRequestInDays: -2,
      todayStatus: 'too-late',
      eligibilityStartsInDays: 7,
      eligibilityEndsInDays: 9,
    })
  })

  it('includes today at T=W and T=W+E, with no boundary buffer', () => {
    const input = { configuredWaitDays: 7, executionWindowDays: 2 }
    expect(calculateDiscoDecisionWindow({ ...input, daysUntilNeeded: 7 })).toMatchObject({
      earliestUsefulRequestInDays: -2,
      latestRequestInDays: 0,
      todayStatus: 'in-window',
    })
    expect(calculateDiscoDecisionWindow({ ...input, daysUntilNeeded: 9 })).toMatchObject({
      earliestUsefulRequestInDays: 0,
      latestRequestInDays: 2,
      todayStatus: 'in-window',
    })
    expect(calculateDiscoDecisionWindow({ ...input, daysUntilNeeded: 8 })).toMatchObject({
      earliestUsefulRequestInDays: -1,
      latestRequestInDays: 1,
      todayStatus: 'in-window',
    })
    expect(calculateDiscoDecisionWindow({ ...input, daysUntilNeeded: 6.99 })?.todayStatus).toBe(
      'too-late',
    )
    expect(calculateDiscoDecisionWindow({ ...input, daysUntilNeeded: 9.01 })?.todayStatus).toBe(
      'early',
    )
  })

  it('requires three complete, finite, bounded user assumptions', () => {
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: NaN,
        executionWindowDays: 2,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: -1,
        configuredWaitDays: 7,
        executionWindowDays: 2,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: 3651,
        executionWindowDays: 2,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: 7,
        executionWindowDays: NaN,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 7,
        configuredWaitDays: 7,
        executionWindowDays: 0,
      }),
    ).toMatchObject({
      earliestUsefulRequestInDays: 0,
      latestRequestInDays: 0,
      todayStatus: 'in-window',
      eligibilityStartsInDays: 7,
      eligibilityEndsInDays: 7,
    })
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: 7,
        executionWindowDays: -1,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: 7,
        executionWindowDays: 3651,
      }),
    ).toBeNull()
    expect(
      calculateDiscoDecisionWindow({
        daysUntilNeeded: 10,
        configuredWaitDays: 7,
        executionWindowDays: Infinity,
      }),
    ).toBeNull()
  })
})
