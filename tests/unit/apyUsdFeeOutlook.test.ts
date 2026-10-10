import { describe, expect, it } from 'vitest'

import { projectApyUsdNet, type ApyUsdFeeCurve } from '@/lib/carry/apyUsdFeeOutlook'

const current: ApyUsdFeeCurve = {
  minFeeWad: '0',
  maxFeeWad: '34000000000000000',
  minDurationSeconds: 259_200,
  maxDurationSeconds: 1_728_000,
  curvatureWad: '1000000000000000000',
}

describe('ApyUSD fee outlook', () => {
  it('projects exact net amounts at the live linear-curve endpoints', () => {
    const escrow = '1000000000000000000000'
    expect(projectApyUsdNet(escrow, 259_200, current)).toEqual({
      feeRateWad: '34000000000000000',
      feeRaw: '34000000000000000000',
      netRaw: '966000000000000000000',
    })
    expect(projectApyUsdNet(escrow, 1_728_000, current)).toEqual({
      feeRateWad: '0',
      feeRaw: '0',
      netRaw: escrow,
    })
  })

  it('uses Solidity floor and ceil rounding between endpoints', () => {
    const result = projectApyUsdNet('101', 993_600, current)
    expect(result?.feeRateWad).toBe('17000000000000000')
    expect(result?.feeRaw).toBe('2')
    expect(result?.netRaw).toBe('99')
  })

  it('abstains on unsupported fractional curvature between endpoints', () => {
    const curved = { ...current, curvatureWad: '1500000000000000000' }
    expect(projectApyUsdNet('1000', 500_000, curved)).toBeNull()
    expect(projectApyUsdNet('1000', 259_200, curved)?.netRaw).toBe('966')
  })

  it('matches the archived receipt 874 preview on two independent RPC origins', () => {
    // Alchemy and Ankr agreed at Ethereum B25840065, hash 0x01fe033e...63a30a.
    const escrow = '70683130068415557255825'
    const elapsed = 1787755439 - 1787284955
    expect(projectApyUsdNet(escrow, elapsed, current)).toEqual({
      feeRateWad: '29109166666666667',
      feeRaw: '2057527013683186548981',
      netRaw: '68625603054732370706844',
    })
  })
})
