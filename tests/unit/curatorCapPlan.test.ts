import { describe, expect, it } from 'vitest'

import {
  calculateCuratorCapPlan,
  formatAssetDisplayUnits,
  parseAssetDisplayUnits,
  type CuratorCapPlanInput,
} from '@/lib/carry/curatorCapPlan'

const base: CuratorCapPlanInput = {
  asset: 'CDT',
  currentVenueAssets: '60000',
  currentCap: '100000',
  proposedCap: '150000',
  targetVenueAssets: '120000',
  matchingWithdrawal: '60000',
  daysUntilNeeded: '14',
  proposalState: 'not-submitted',
  timelockDays: '7',
  pendingValidInDays: '7',
}

describe('user-entered CuratorVault cap planning conditions', () => {
  it('shows a raise time gate without promoting an unsubmitted or pending cap', () => {
    const unsubmitted = calculateCuratorCapPlan(base)
    expect(unsubmitted).toMatchObject({
      capStep: 'timelocked',
      earliestCapEligibleInDays: 7,
      readyByNeededDay: true,
      needsSubmission: true,
      needsAcceptance: true,
      structuralReady: false,
      reason: 'action',
    })
    const pending = calculateCuratorCapPlan({
      ...base,
      proposalState: 'pending',
      pendingValidInDays: '0',
    })
    expect(pending).toMatchObject({
      earliestCapEligibleInDays: 0,
      needsSubmission: false,
      needsAcceptance: true,
      structuralReady: false,
    })
  })

  it('does not infer a new raise from an accepted cap; accepted cap must match current state', () => {
    expect(calculateCuratorCapPlan({ ...base, proposalState: 'accepted' })).toBeNull()
    const accepted = calculateCuratorCapPlan({
      ...base,
      currentCap: '150000',
      proposalState: 'accepted',
    })
    expect(accepted).toMatchObject({
      earliestCapEligibleInDays: 0,
      needsSubmission: false,
      needsAcceptance: false,
      structuralReady: true,
      reason: 'ready',
    })
  })

  it('permits an immediate lower only after the user marks it already set', () => {
    const lower = {
      ...base,
      currentVenueAssets: '40000',
      currentCap: '100000',
      proposedCap: '60000',
      targetVenueAssets: '50000',
      matchingWithdrawal: '10000',
    }
    expect(calculateCuratorCapPlan(lower)).toMatchObject({
      capStep: 'immediate',
      earliestCapEligibleInDays: 0,
      needsSubmission: true,
      structuralReady: false,
    })
    expect(
      calculateCuratorCapPlan({ ...lower, currentCap: '60000', proposalState: 'accepted' }),
    ).toMatchObject({ structuralReady: true })
  })

  it('shows revoked timing only if resubmitted now and still requires both actions', () => {
    expect(calculateCuratorCapPlan({ ...base, proposalState: 'revoked' })).toMatchObject({
      earliestCapEligibleInDays: 7,
      readyByNeededDay: true,
      needsSubmission: true,
      needsAcceptance: true,
      structuralReady: false,
      reason: 'action',
    })
  })

  it('shows a target above proposed cap even when current assets are already over cap', () => {
    const plan = calculateCuratorCapPlan({
      ...base,
      currentVenueAssets: '80',
      currentCap: '100',
      proposedCap: '60',
      targetVenueAssets: '90',
      matchingWithdrawal: '10',
    })
    expect(formatAssetDisplayUnits(plan?.capShortfall ?? 0n, 'CDT')).toBe('30 CDT')
    expect(plan?.structuralReady).toBe(false)
    expect(plan?.reason).toBe('cap')
  })

  it('excludes a no-op target from the addition planner, even when current assets exceed cap', () => {
    expect(
      calculateCuratorCapPlan({
        ...base,
        currentVenueAssets: '80',
        currentCap: '60',
        proposedCap: '60',
        targetVenueAssets: '80',
        matchingWithdrawal: '0',
      }),
    ).toBeNull()
  })

  it('requires exact net-zero flow, including no extra withdrawal', () => {
    const tooLittle = calculateCuratorCapPlan({ ...base, matchingWithdrawal: '59999.5' })
    expect(formatAssetDisplayUnits(tooLittle?.matchingWithdrawalShortfall ?? 0n, 'CDT')).toBe(
      '0.5 CDT',
    )
    expect(tooLittle?.reason).toBe('withdrawal')
    const tooMuch = calculateCuratorCapPlan({ ...base, matchingWithdrawal: '60001' })
    expect(formatAssetDisplayUnits(tooMuch?.excessWithdrawal ?? 0n, 'CDT')).toBe('1 CDT')
    expect(tooMuch?.reason).toBe('excess-withdrawal')
  })

  it('fails closed when the assumed wait misses the planning deadline', () => {
    expect(calculateCuratorCapPlan({ ...base, daysUntilNeeded: '6' })).toMatchObject({
      earliestCapEligibleInDays: 7,
      readyByNeededDay: false,
      structuralReady: false,
      reason: 'timing',
    })
  })

  it('keeps CDT and USDC display quantities separate and avoids token-atomic claims', () => {
    const cdt = calculateCuratorCapPlan(base)
    const usdc = calculateCuratorCapPlan({ ...base, asset: 'USDC' })
    expect(cdt?.requiredSupply).toBe(usdc?.requiredSupply)
    expect(formatAssetDisplayUnits(usdc?.requiredSupply ?? 0n, 'USDC')).toBe('60,000 USDC')
    expect(calculateCuratorCapPlan({ ...base, asset: 'GHO' as 'CDT' })).toBeNull()
  })

  it('enforces the 1–14 whole-day new-raise assumption while pending may be due today', () => {
    for (const days of ['0', '15', '3651']) {
      expect(calculateCuratorCapPlan({ ...base, timelockDays: days })).toBeNull()
      expect(
        calculateCuratorCapPlan({ ...base, proposalState: 'revoked', timelockDays: days }),
      ).toBeNull()
    }
    expect(calculateCuratorCapPlan({ ...base, timelockDays: '1' })?.earliestCapEligibleInDays).toBe(
      1,
    )
    expect(
      calculateCuratorCapPlan({ ...base, timelockDays: '14' })?.earliestCapEligibleInDays,
    ).toBe(14)
    expect(
      calculateCuratorCapPlan({ ...base, proposalState: 'pending', pendingValidInDays: '0' })
        ?.earliestCapEligibleInDays,
    ).toBe(0)
  })

  it('rejects negative, exponent, precision overflow, excessive display size and invalid state', () => {
    for (const amount of [
      '-1',
      '1e9',
      '0.0000001',
      '1000000000000.000001',
      '1000000000001',
      `${1n << 192n}`,
    ]) {
      expect(parseAssetDisplayUnits(amount)).toBeNull()
    }
    expect(parseAssetDisplayUnits('1.000001')).toBe(1_000_001n)
    expect(calculateCuratorCapPlan({ ...base, proposedCap: `${1n << 192n}` })).toBeNull()
    expect(calculateCuratorCapPlan({ ...base, matchingWithdrawal: '-1' })).toBeNull()
    expect(calculateCuratorCapPlan({ ...base, targetVenueAssets: '50000' })).toBeNull()
    expect(calculateCuratorCapPlan({ ...base, daysUntilNeeded: '1.5' })).toBeNull()
    expect(calculateCuratorCapPlan({ ...base, timelockDays: '3651' })).toBeNull()
    expect(calculateCuratorCapPlan({ ...base, proposalState: 'bad' as 'accepted' })).toBeNull()
    expect(
      calculateCuratorCapPlan({ ...base, proposedCap: '50000', proposalState: 'pending' }),
    ).toBeNull()
  })
})
