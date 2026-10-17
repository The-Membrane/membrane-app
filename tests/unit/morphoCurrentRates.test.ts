import { describe, expect, it } from 'vitest'

import { SECONDS_PER_YEAR, WAD } from '@/lib/netApy/fixedPoint'
import { MORPHO_ADAPTIVE_CURVE_IRM } from '@/lib/netApy/venues'
import {
  qualifyMorphoCurrentRates,
  type MorphoCurrentRateInput,
} from '@/lib/position/morphoCurrentRates'

const NOW = 1_792_000_000n
const ZERO = '0x0000000000000000000000000000000000000000'
/** Frozen source-call fixture: full utilization, 30 days, 10% initial target, bounded at 200% target. */
function input(): MorphoCurrentRateInput {
  return {
    irm: MORPHO_ADAPTIVE_CURVE_IRM,
    storedMarket: [
      1_000_000_000n,
      1_000_000_000_000n,
      1_000_000_000n,
      1_000_000_000_000n,
      NOW - 30n * 86_400n,
      WAD / 10n,
    ],
    blockTimestamp: NOW,
    averageRatePerSecond: 116_091_157_612n,
    rateAtTarget: 3_170_979_198n,
  }
}

describe('qualified present-time Morpho rates', () => {
  it('keeps the source interval average distinct from the adapted endpoint and deducts the fee once', () => {
    const source = input(),
      qualified = qualifyMorphoCurrentRates(source)
    const annualizedAverage = Number(source.averageRatePerSecond! * SECONDS_PER_YEAR) / Number(WAD)
    expect(annualizedAverage).toBeCloseTo(3.661050745, 8)
    // At full use the bounded endpoint is 4 × 200%/year. The average is below that endpoint.
    expect(qualified.borrowApr).toBeCloseTo(8, 8)
    expect(qualified.supplyApr).toBeCloseTo(7.2, 8)
    expect(qualified.borrowApr).not.toBe(annualizedAverage)
    expect(qualified.replayToleranceWad).toBe(0)
    expect(qualified.reason).toBeNull()
  })

  it('rejects a one-integer source replay mismatch rather than fitting or relaxing tolerance', () => {
    const source = input()
    source.averageRatePerSecond! += 1n
    expect(qualifyMorphoCurrentRates(source)).toMatchObject({
      borrowApr: null,
      supplyApr: null,
      reason: 'Source average rate failed exact replay',
    })
  })

  it('does not inherit the known model for another IRM address', () => {
    expect(
      qualifyMorphoCurrentRates({ ...input(), irm: '0x1111111111111111111111111111111111111111' })
        .borrowApr,
    ).toBeNull()
  })

  it('requires verified time, target state, fee domain and uint128 arithmetic', () => {
    for (const source of [
      { ...input(), blockTimestamp: null },
      { ...input(), blockTimestamp: NOW - 31n * 86_400n },
      { ...input(), rateAtTarget: null },
      { ...input(), rateAtTarget: -1n },
      { ...input(), rateAtTarget: 1n },
      { ...input(), averageRatePerSecond: null },
      { ...input(), storedMarket: [1n, 1n, 2n, 1n, NOW, 0n] },
      { ...input(), storedMarket: [1n, 1n, 1n, 1n, NOW, WAD + 1n] },
      { ...input(), storedMarket: [1n << 128n, 1n, 1n, 1n, NOW, 0n] },
    ])
      expect(qualifyMorphoCurrentRates(source)).toMatchObject({ borrowApr: null, supplyApr: null })
    const max = (1n << 128n) - 1n
    expect(
      qualifyMorphoCurrentRates({
        ...input(),
        storedMarket: [max, max, max, max, NOW - 30n * 86_400n, WAD / 10n],
      }).borrowApr,
    ).toBeNull()
  })

  it('qualifies zero-IRM interest only with valid market state and timestamp', () => {
    const zero = { ...input(), irm: ZERO, rateAtTarget: null, averageRatePerSecond: 0n }
    expect(qualifyMorphoCurrentRates(zero)).toMatchObject({
      borrowApr: 0,
      supplyApr: 0,
      reason: null,
    })
    expect(qualifyMorphoCurrentRates({ ...zero, blockTimestamp: null }).supplyApr).toBeNull()
  })

  it('retains zero supply/debt and virtual-share-safe state without inventing income', () => {
    const initialRate = (WAD * 4n) / 100n / SECONDS_PER_YEAR
    const source = {
      ...input(),
      storedMarket: [0n, 0n, 0n, 0n, NOW, 0n],
      rateAtTarget: 0n,
      averageRatePerSecond: initialRate / 4n,
    }
    expect(qualifyMorphoCurrentRates(source).supplyApr).toBe(0)
  })
})
