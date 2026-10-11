import { describe, expect, it } from 'vitest'
import {
  buildMorphoV2IdleConditionalEntitlementBand,
  MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION,
  type MorphoV2IdleConditionalEntitlementBand,
  type MorphoV2IdleConditionalEntitlementBandInput,
} from '@/lib/carry/morphoV2IdleConditionalEntitlementBand'

const MAX = (1n << 256n) - 1n
const input = (
  probe: bigint,
  quote: bigint,
  shares: bigint,
  supply?: bigint,
): MorphoV2IdleConditionalEntitlementBandInput => ({
  recordedProbeSharesRaw: probe.toString(),
  recordedQuoteAssetsRaw: quote.toString(),
  requestedSharesRaw: shares.toString(),
  ...(supply === undefined ? {} : { historicalTotalSupplySharesRaw: supply.toString() }),
})

function bounded(value: unknown) {
  const result = buildMorphoV2IdleConditionalEntitlementBand(value)
  expect(result?.status).toBe('bounded')
  if (!result || result.status !== 'bounded') throw new Error('expected_conditional_band')
  return result
}

function censored(value: unknown) {
  const result = buildMorphoV2IdleConditionalEntitlementBand(value)
  expect(result?.status).toBe('arithmetic_domain_censored')
  if (!result || result.status !== 'arithmetic_domain_censored') throw new Error('expected_domain_censor')
  return result
}

// Independent rational-rate observations: actual floor(S * numerator / denominator).
// Neither witness uses the implementation's lower/upper integer-bound expressions.
function observedFloor(shares: bigint, numerator: bigint, denominator: bigint) {
  return shares * numerator / denominator
}

function rateIsConsistent(probe: bigint, quote: bigint, numerator: bigint, denominator: bigint) {
  return probe * numerator >= quote * denominator && probe * numerator < (quote + 1n) * denominator
}

describe('conditional Morpho V2 idle quote-rate intervals', () => {
  it('contains consistent rational floor outcomes and attains both endpoints', () => {
    for (let probe = 1n; probe <= 7n; probe += 1n) {
      for (let quote = 0n; quote <= 5n; quote += 1n) {
        for (let shares = 1n; shares <= 12n; shares += 1n) {
          const result = bounded(input(probe, quote, shares))
          const lower = BigInt(result.lowerAssetsRaw)
          const upper = BigInt(result.upperAssetsRaw)
          // The closed lower-rate endpoint is admitted and gives the lower outcome.
          expect(rateIsConsistent(probe, quote, quote, probe)).toBe(true)
          expect(observedFloor(shares, quote, probe)).toBe(lower)
          // This rational rate lies strictly below the open upper-rate endpoint.
          // k > shares places its outcome within less than 1/probe of that endpoint,
          // attaining the highest feasible integer even when the endpoint is integral.
          const k = shares + 1n
          const topNumerator = (quote + 1n) * k - 1n
          const topDenominator = probe * k
          expect(rateIsConsistent(probe, quote, topNumerator, topDenominator)).toBe(true)
          expect(observedFloor(shares, topNumerator, topDenominator)).toBe(upper)
          for (let fraction = 0n; fraction < 10n; fraction += 1n) {
            const numerator = quote * 10n + fraction
            const denominator = probe * 10n
            expect(rateIsConsistent(probe, quote, numerator, denominator)).toBe(true)
            const outcome = observedFloor(shares, numerator, denominator)
            expect(outcome >= lower && outcome <= upper).toBe(true)
          }
        }
      }
    }
  })

  it('excludes the open upper-rate endpoint rather than rounding it into the interval', () => {
    const result = bounded(input(3n, 1n, 6n))
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual(['2', '3'])
    expect(rateIsConsistent(3n, 1n, 2n, 3n)).toBe(false)
    expect(observedFloor(6n, 2n, 3n)).toBe(4n)
  })

  it.each([
    [1n, 0n], [3n, 2n], [352805058661206444n, 714413n], [MAX, MAX],
  ])('preserves the same recorded stock as a singleton (%s, %s)', (probe, quote) => {
    const result = bounded(input(probe, quote, probe))
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual([quote.toString(), quote.toString()])
  })

  it('preserves zero requested stock without an upper-bound underflow', () => {
    const result = bounded(input(7n, MAX, 0n, 0n))
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual(['0', '0'])
    expect(result.extrapolatesBeyondHistoricalSupply).toBe(false)
  })

  it('preserves a zero recorded quote with a nonzero conditional upper outcome', () => {
    const result = bounded(input(3n, 0n, 10n))
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual(['0', '3'])
    expect(result.recordedQuoteAssetsRaw).toBe('0')
  })

  it('flags historical supply extrapolation without rejecting or clamping the band', () => {
    const withoutSupply = bounded(input(3n, 2n, 10n))
    const withSupply = bounded(input(3n, 2n, 10n, 4n))
    const zeroSupply = bounded(input(3n, 2n, 10n, 0n))
    expect([withSupply.lowerAssetsRaw, withSupply.upperAssetsRaw]).toEqual(['6', '9'])
    expect([withSupply.lowerAssetsRaw, withSupply.upperAssetsRaw]).toEqual([
      withoutSupply.lowerAssetsRaw, withoutSupply.upperAssetsRaw,
    ])
    expect(withoutSupply.extrapolatesBeyondHistoricalSupply).toBeNull()
    expect(withSupply.extrapolatesBeyondHistoricalSupply).toBe(true)
    expect(zeroSupply.extrapolatesBeyondHistoricalSupply).toBe(true)
    expect(bounded(input(3n, 2n, 10n, 10n)).extrapolatesBeyondHistoricalSupply).toBe(false)
    expect(bounded(input(3n, 2n, 10n, 11n)).extrapolatesBeyondHistoricalSupply).toBe(false)
  })

  it('treats explicitly unknown historical supply as unknown', () => {
    const result = bounded({ ...input(2n, 3n, 1n), historicalTotalSupplySharesRaw: null })
    expect(result.historicalTotalSupplySharesRaw).toBeNull()
    expect(result.extrapolatesBeyondHistoricalSupply).toBeNull()
  })

  it('retains exact 512-bit intermediate products when both results remain uint256', () => {
    const result = bounded(input(MAX, MAX, MAX))
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual([MAX.toString(), MAX.toString()])
    expect(MAX * MAX > MAX).toBe(true)
  })

  it('retains an explicit domain censor when both bounds exceed uint256', () => {
    const result = censored(input(1n, MAX, 2n))
    expect(result.arithmeticDomainCensor).toBe('conditional_bound_exceeds_uint256')
    expect(result.lowerAssetsRaw).toBeNull()
    expect(result.upperAssetsRaw).toBeNull()
    expect(result.lowerExceedsUint256).toBe(true)
    expect(result.upperExceedsUint256).toBe(true)
  })

  it('censors an overflowing upper bound even when the lower bound is exactly uint256 max', () => {
    const result = censored(input(MAX - 1n, MAX - 1n, MAX, MAX - 1n))
    expect(result.lowerExceedsUint256).toBe(false)
    expect(result.upperExceedsUint256).toBe(true)
    expect([result.lowerAssetsRaw, result.upperAssetsRaw]).toEqual([null, null])
    expect(result.extrapolatesBeyondHistoricalSupply).toBe(true)
  })

  it.each([
    '', '00', '01', '-1', '+1', ' 1', '1 ', '1\n', '1.0', '1e3', '0x1',
    '1'.repeat(79), (MAX + 1n).toString(), 1, 1n, NaN, null, undefined, {}, [],
  ])('rejects noncanonical or out-of-range scalar %s in every position', bad => {
    const valid = input(1n, 0n, 0n)
    for (const field of [
      'recordedProbeSharesRaw', 'recordedQuoteAssetsRaw', 'requestedSharesRaw',
    ] as const) {
      expect(buildMorphoV2IdleConditionalEntitlementBand({ ...valid, [field]: bad })).toBeNull()
    }
    if (bad !== null) {
      expect(buildMorphoV2IdleConditionalEntitlementBand({ ...valid, historicalTotalSupplySharesRaw: bad })).toBeNull()
    }
  })

  it('rejects zero probe stock, missing fields and nonclosed input shapes', () => {
    expect(buildMorphoV2IdleConditionalEntitlementBand(input(0n, 0n, 0n))).toBeNull()
    for (const field of ['recordedProbeSharesRaw', 'recordedQuoteAssetsRaw', 'requestedSharesRaw'] as const) {
      const value: Partial<MorphoV2IdleConditionalEntitlementBandInput> = input(1n, 0n, 0n)
      delete value[field]
      expect(buildMorphoV2IdleConditionalEntitlementBand(value)).toBeNull()
    }
    for (const value of [null, undefined, [], '1', 1, new Date(0), { ...input(1n, 0n, 0n), approved: true }]) {
      expect(buildMorphoV2IdleConditionalEntitlementBand(value)).toBeNull()
    }
    expect(buildMorphoV2IdleConditionalEntitlementBand({ ...input(1n, 0n, 0n), [Symbol('hidden')]: '1' })).toBeNull()
  })

  it('rejects accessors and failed reflection without invoking scalar getters or coercion', () => {
    let getterReads = 0
    const accessor = Object.defineProperty(input(1n, 0n, 0n), 'recordedQuoteAssetsRaw', {
      enumerable: true,
      get() { getterReads += 1; throw new Error('unit_only_getter') },
    })
    expect(buildMorphoV2IdleConditionalEntitlementBand(accessor)).toBeNull()
    expect(getterReads).toBe(0)
    const hostile = new Proxy({}, { ownKeys() { throw new Error('unit_only_reflection') } })
    expect(buildMorphoV2IdleConditionalEntitlementBand(hostile)).toBeNull()
    let coercions = 0
    const fakeScalar = { toString() { coercions += 1; return '1' } }
    expect(buildMorphoV2IdleConditionalEntitlementBand({ ...input(1n, 0n, 0n), requestedSharesRaw: fakeScalar })).toBeNull()
    expect(coercions).toBe(0)
  })

  it('accepts a closed null-prototype data record', () => {
    const value = Object.assign(Object.create(null), input(3n, 1n, 6n))
    expect(bounded(value).upperAssetsRaw).toBe('3')
  })

  it('labels immutable conditional results without minting native authority or confidence', () => {
    const results: MorphoV2IdleConditionalEntitlementBand[] = [
      bounded(input(3n, 1n, 6n)), censored(input(1n, MAX, 2n)),
    ]
    for (const result of results) {
      expect(result.kind).toBe('conditional_recorded_quote_rate_interval')
      expect(result.assumption).toBe(MORPHO_V2_IDLE_CONDITIONAL_ENTITLEMENT_ASSUMPTION)
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.claims)).toBe(true)
      expect(Object.values(result.claims).every(value => value === false)).toBe(true)
      expect('receipt' in result).toBe(false)
      expect('approved' in result).toBe(false)
    }
  })
})
