import { describe, expect, it } from 'vitest'

import {
  apyUsdOpenReceiptBlockExpiresAt,
  isApyUsdOpenReceiptBlockFreshAt,
} from '@/lib/carry/apyUsdOpenReceiptFreshness'

describe('ApyUSD open receipt check freshness', () => {
  const blockSeconds = 1_791_057_239
  const blockMs = blockSeconds * 1000

  it('expires the dated check at the 45-minute boundary', () => {
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, blockMs)).toBe(true)
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, blockMs + 45 * 60_000)).toBe(true)
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, blockMs + 45 * 60_000 + 1)).toBe(false)
    expect(apyUsdOpenReceiptBlockExpiresAt(blockSeconds)).toBe(blockMs + 45 * 60_000)
  })

  it('rejects an implausibly future block and malformed clocks', () => {
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, blockMs - 120_000)).toBe(true)
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, blockMs - 120_001)).toBe(false)
    expect(isApyUsdOpenReceiptBlockFreshAt(-1, blockMs)).toBe(false)
    expect(isApyUsdOpenReceiptBlockFreshAt(Number.NaN, blockMs)).toBe(false)
    expect(isApyUsdOpenReceiptBlockFreshAt(blockSeconds, Number.NaN)).toBe(false)
  })
})
