import { describe, expect, it } from 'vitest'

import { GAME, computeByteAward, utcDayRange } from '@/lib/game/config'

describe('computeByteAward — Phase 3 daily BYTE cap arithmetic', () => {
  const perWin = GAME.BYTE_PER_WIN // 5_000_000n
  const cap = GAME.DAILY_BYTE_CAP // 200_000_000n

  it('awards the full per-win amount when nothing earned yet today', () => {
    expect(computeByteAward(0n, perWin, cap)).toBe(perWin)
  })

  it('awards the full per-win amount comfortably under the cap', () => {
    expect(computeByteAward(cap - perWin * 10n, perWin, cap)).toBe(perWin)
  })

  it('awards a partial amount when only a fraction of the per-win amount remains', () => {
    const earned = cap - perWin / 2n // exactly half a win's worth of headroom left
    expect(computeByteAward(earned, perWin, cap)).toBe(perWin / 2n)
  })

  it('awards exactly the per-win amount at the boundary where remaining == perWin', () => {
    const earned = cap - perWin
    expect(computeByteAward(earned, perWin, cap)).toBe(perWin)
  })

  it('awards zero the instant the cap is reached exactly', () => {
    expect(computeByteAward(cap, perWin, cap)).toBe(0n)
  })

  it('awards zero once earnings exceed the cap (never negative)', () => {
    expect(computeByteAward(cap + perWin, perWin, cap)).toBe(0n)
    expect(computeByteAward(cap * 2n, perWin, cap)).toBe(0n)
  })

  it('never returns a negative award for any earnedToday >= cap', () => {
    for (const extra of [0n, 1n, perWin, perWin * 100n]) {
      const award = computeByteAward(cap + extra, perWin, cap)
      expect(award >= 0n).toBe(true)
      expect(award).toBe(0n)
    }
  })

  it('uses the real GAME defaults when no overrides are passed', () => {
    expect(computeByteAward(0n)).toBe(GAME.BYTE_PER_WIN)
    expect(computeByteAward(GAME.DAILY_BYTE_CAP)).toBe(0n)
  })
})

describe('utcDayRange — the window the daily cap sums over', () => {
  it('start is midnight UTC and end is exactly 24h later', () => {
    const now = new Date('2026-09-01T15:42:07.123Z')
    const { start, end } = utcDayRange(now)
    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-09-02T00:00:00.000Z')
  })

  it('a moment just before midnight and just after fall in different windows', () => {
    const beforeMidnight = utcDayRange(new Date('2026-09-01T23:59:59.999Z'))
    const afterMidnight = utcDayRange(new Date('2026-09-02T00:00:00.000Z'))
    expect(beforeMidnight.start.toISOString()).not.toBe(afterMidnight.start.toISOString())
  })
})
