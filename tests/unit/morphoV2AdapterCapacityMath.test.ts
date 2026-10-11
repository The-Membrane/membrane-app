import { describe, it, expect } from 'vitest'
import pin from '@/data/research/venue-signals/morpho-v2-adapter-capacity-pilot-2026-10-07T15-32.export.json'
import {
  morphoV2AdapterCapacityMath,
  type MorphoV2AdapterMathInput,
} from '@/lib/carry/morphoV2AdapterCapacityMath'
const MAX = (1n << 256n) - 1n
function actual(): MorphoV2AdapterMathInput {
  const p = pin.current,
    g = p.prongs
  return {
    market: g.market.map(BigInt),
    at: BigInt(Date.parse(p.source.blockTime) / 1000),
    borrowRate: BigInt(g.borrowRateRaw),
    internalShares: BigInt(g.internalSharesRaw),
    actualShares: BigInt(g.actualSharesRaw),
    blueCash: BigInt(g.blueCashRaw),
    allowance: BigInt(g.allowanceRaw),
    idleCash: BigInt(g.idleCashRaw),
    allocations: g.allocationsRaw.map(BigInt),
    enrolled: true,
  }
}
function small(): MorphoV2AdapterMathInput {
  return {
    market: [10000000n, 10000000000000n, 4000000n, 4000000000000n, 1n, 0n],
    at: 100n,
    borrowRate: 0n,
    internalShares: 5000000000000n,
    actualShares: 5000000000000n,
    blueCash: 6000000n,
    allowance: MAX,
    idleCash: 0n,
    allocations: [1n, 1n, 5000000n],
    enrolled: true,
  }
}
describe('reviewed Morpho configured adapter native math', () => {
  it('reproduces the independently captured actual pilot pullability', () => {
    const m = morphoV2AdapterCapacityMath(actual())
    expect(m.conditionalAllocationQualifiedPullableRaw).toBe('1024558')
    expect(m.interestRaw).toBe(pin.current.prongs.interestRaw)
    expect(m.feeSharesRaw).toBe('0')
  })
  it('enforces every quantity-dependent cap, not just positive prewithdraw allocation', () => {
    expect(morphoV2AdapterCapacityMath(small()).conditionalAllocationQualifiedPullableRaw).toBe('1')
    const v = small()
    v.allocations = [5000000n, 5000000n, 5000000n]
    expect(morphoV2AdapterCapacityMath(v).conditionalAllocationQualifiedPullableRaw).toBe('5000000')
  })
  it('does not promote donated actual shares into internal entitlement', () => {
    const v = actual(),
      before = morphoV2AdapterCapacityMath(v)
    v.actualShares += 1000000n
    expect(morphoV2AdapterCapacityMath(v)).toEqual(before)
    v.internalShares = v.actualShares + 1n
    expect(() => morphoV2AdapterCapacityMath(v)).toThrow('internal_vs_actual_shares')
  })
  it('respects cash, allowance, enrollment and zero allocation gates while retaining idle cash', () => {
    const v = small()
    v.allocations = [5000000n, 5000000n, 5000000n]
    v.blueCash = 10n
    v.allowance = 7n
    expect(morphoV2AdapterCapacityMath(v).conditionalAllocationQualifiedPullableRaw).toBe('7')
    v.allocations = [0n, ...v.allocations.slice(1)]
    v.idleCash = 9n
    expect(morphoV2AdapterCapacityMath(v).conditionalProtocolCapacityRaw).toBe('9')
    v.enrolled = false
    expect(morphoV2AdapterCapacityMath(v).conditionalProtocolCapacityRaw).toBe('9')
  })
  it('ports fee accrual and native bounds before clipping', () => {
    const v = small()
    v.allocations = [5000000n, 5000000n, 5000000n]
    v.market = [10000000n, 10000000000000n, 4000000n, 4000000000000n, 1n, 100000000000000000n]
    v.borrowRate = 100000000000000n
    const m = morphoV2AdapterCapacityMath(v)
    expect(BigInt(m.interestRaw)).toBeGreaterThan(0n)
    expect(BigInt(m.feeSharesRaw)).toBeGreaterThan(0n)
    v.borrowRate = MAX
    expect(() => morphoV2AdapterCapacityMath(v)).toThrow()
  })
  it('rejects uint128, signed allocation and idle-plus-capacity overflow', () => {
    let v = actual()
    v.market = [1n << 128n, ...v.market.slice(1)]
    expect(() => morphoV2AdapterCapacityMath(v)).toThrow()
    v = small()
    v.allocations = [1n << 255n, ...v.allocations.slice(1)]
    expect(() => morphoV2AdapterCapacityMath(v)).toThrow()
    v = actual()
    v.idleCash = MAX
    expect(() => morphoV2AdapterCapacityMath(v)).toThrow()
    expect(() => morphoV2AdapterCapacityMath({ ...actual(), market: [1n] })).toThrow(
      'market_length',
    )
  })
  it('bounded small brute-force confirms the greatest safe quantity', () => {
    for (let supply = 1n; supply < 12n; supply++)
      for (let cap = 1n; cap < 5n; cap++) {
        const v: MorphoV2AdapterMathInput = {
          market: [supply, supply * 1000000n, 0n, 0n, 1n, 0n],
          at: 1n,
          borrowRate: 0n,
          internalShares: supply * 1000000n,
          actualShares: supply * 1000000n,
          blueCash: supply,
          allowance: MAX,
          idleCash: 0n,
          allocations: [cap, cap, supply],
          enrolled: true,
        }
        let best = 0n
        for (let x = 1n; x <= supply; x++) {
          const n = x * (v.market[1] + 1000000n),
            d = supply + 1n,
            burn = n / d + (n % d ? 1n : 0n)
          const remaining =
              ((v.internalShares - burn) * (supply - x + 1n)) / (v.market[1] - burn + 1000000n),
            change = remaining - supply
          if (v.allocations.every((a) => a + change >= 0n)) best = x
        }
        expect(
          BigInt(morphoV2AdapterCapacityMath(v).conditionalAllocationQualifiedPullableRaw),
        ).toBe(best)
      }
  })
})
