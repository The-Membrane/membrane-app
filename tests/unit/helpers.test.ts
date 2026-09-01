import { describe, it, expect } from 'vitest'
import BigNumber from 'bignumber.js'
import { num, isGreaterThanZero, shiftDigits as shiftDigitsToString } from '@/helpers/num'
import { shiftDigits as shiftDigitsToBigNumber, sum } from '@/helpers/math'
import { truncate } from '@/helpers/truncate'

/**
 * The BigNumber wrapper layer. Nearly every balance, LTV and rate in the app
 * flows through these, so a rounding or fallback bug here is silent and
 * everywhere at once.
 */

describe('num', () => {
  it('defaults to zero when called with nothing', () => {
    expect(num().toString()).toBe('0')
  })

  it('accepts strings and numbers alike', () => {
    expect(num('1.5').toString()).toBe('1.5')
    expect(num(1.5).toString()).toBe('1.5')
  })

  it('keeps precision that float arithmetic would lose', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in plain JS.
    expect(num('0.1').plus('0.2').toString()).toBe('0.3')
  })
})

describe('isGreaterThanZero', () => {
  it('is true only for positive values', () => {
    expect(isGreaterThanZero('1')).toBe(true)
    expect(isGreaterThanZero(0.0001)).toBe(true)
    expect(isGreaterThanZero('0')).toBe(false)
    expect(isGreaterThanZero(-1)).toBe(false)
  })

  it('treats missing and empty values as zero rather than throwing', () => {
    expect(isGreaterThanZero(undefined)).toBe(false)
    expect(isGreaterThanZero('')).toBe(false)
  })
})

describe('shiftDigits (helpers/num, returns a string)', () => {
  it('converts micro-denominations up to whole units', () => {
    // The chain stores 6-decimal micro units; -6 is the standard display shift.
    expect(shiftDigitsToString('1000000', -6)).toBe('1')
    expect(shiftDigitsToString('1500000', -6)).toBe('1.5')
  })

  it('converts whole units down to micro-denominations', () => {
    expect(shiftDigitsToString('1', 6)).toBe('1000000')
  })

  it('truncates rather than rounds up, so balances are never overstated', () => {
    // helpers/num sets ROUNDING_MODE: ROUND_DOWN globally.
    expect(shiftDigitsToString('1.9999999', 0)).toBe('1.999999')
  })

  it('honours an explicit decimal-place limit', () => {
    expect(shiftDigitsToString('1.23456789', 0, 2)).toBe('1.23')
  })
})

describe('shiftDigits (helpers/math, returns a BigNumber)', () => {
  it('returns a BigNumber, not a string — the two helpers share a name but not a type', () => {
    const result = shiftDigitsToBigNumber('1000000', -6)
    expect(result).toBeInstanceOf(BigNumber)
    expect(result.toString()).toBe('1')
  })

  it('falls back to zero on input BigNumber cannot parse', () => {
    // Regression guard: BigNumber returns NaN for junk rather than throwing, so
    // the function's try/catch never fired and NaN leaked into displayed
    // balances. The zero fallback is now explicit.
    expect(shiftDigitsToBigNumber('not-a-number', -6).toString()).toBe('0')
    expect(shiftDigitsToBigNumber('', -6).toString()).toBe('0')
  })

  it('defaults a missing value to zero', () => {
    expect(shiftDigitsToBigNumber(undefined, -6).toString()).toBe('0')
  })
})

describe('sum', () => {
  it('adds numeric strings without float drift', () => {
    expect(sum('0.1', '0.2').toString()).toBe('0.3')
    expect(sum('1', '2', '3').toString()).toBe('6')
  })

  it('is zero for no arguments', () => {
    expect(sum().toString()).toBe('0')
  })
})

describe('truncate', () => {
  it('shortens an EVM address to head and tail', () => {
    expect(truncate('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
  })

  it('leaves short strings alone', () => {
    expect(truncate('0x1234')).toBe('0x1234')
    expect(truncate('0x12345678')).toBe('0x12345678')
  })

  it('returns undefined for missing input rather than throwing', () => {
    expect(truncate(undefined)).toBeUndefined()
    expect(truncate('')).toBeUndefined()
  })

  it('ignores the legacy bech32 prefix argument', () => {
    expect(truncate('0x1234567890abcdef1234567890abcdef12345678', 'osmo')).toBe('0x1234...5678')
  })
})
