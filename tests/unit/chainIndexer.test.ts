import { describe, expect, it } from 'vitest'

import { shortWallet, dayIndexToUtcDateString } from '@/lib/game/chainIndexer'

describe('shortWallet', () => {
  it('formats as 0x1234…abcd', () => {
    expect(shortWallet('0x1234567890abcdefABCDEF1234567890abcdef12')).toBe('0x1234…ef12')
  })

  it('is stable for a real checksummed address', () => {
    expect(shortWallet('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('0xf39F…2266')
  })
})

describe('dayIndexToUtcDateString', () => {
  it('converts PocketGP.today() day-index 0 to the epoch date', () => {
    expect(dayIndexToUtcDateString(0)).toBe('1970-01-01')
  })

  it('converts a real recent day index to a UTC YYYY-MM-DD string', () => {
    // 2026-01-01T00:00:00Z / 86400s per day
    const day = Math.floor(Date.UTC(2026, 0, 1) / 86_400_000)
    expect(dayIndexToUtcDateString(day)).toBe('2026-01-01')
  })
})
