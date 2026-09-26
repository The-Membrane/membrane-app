import { describe, expect, it } from 'vitest'

// The stats are a dependency-free .mjs shared with the renderer that actually
// runs (scripts/make-share-card.mjs --template turnover), so the code under test
// IS the code that draws the card — same discipline as alarms.test.ts.
import {
  sig2,
  fmtUsd,
  computeTurnover,
  barWidths,
  vaultTicks,
  exitSemantics,
} from '../../scripts/lib/turnoverStats.mjs'

const day = (d: string, usd: number) => ({ d, usd })

describe('sig2 / fmtUsd (BRAND_CHARTS §4.5 — two significant figures)', () => {
  it('rounds to two significant figures across magnitudes', () => {
    expect(sig2(33_512_345_678)).toBe(34_000_000_000)
    expect(sig2(4.732)).toBe(4.7)
    expect(sig2(0.0713)).toBe(0.071)
    expect(sig2(0)).toBe(0)
  })

  it('never renders a third significant digit in a headline number', () => {
    expect(fmtUsd(33_512_345_678)).toBe('$34B')
    expect(fmtUsd(4_712_000_000)).toBe('$4.7B')
    expect(fmtUsd(832_700_000)).toBe('$830M')
    expect(fmtUsd(-1_700_000_000)).toBe('-$1.7B')
  })

  it('degrades to an em dash rather than NaN', () => {
    expect(fmtUsd(Number.NaN)).toBe('—')
    expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('computeTurnover', () => {
  const dailyOut = [day('2026-07-12', 100), day('2026-07-13', 833), day('2026-07-14', 67)]
  const dailyIn = [day('2026-07-12', 400), day('2026-07-13', 300), day('2026-07-14', 100)]

  it('sums gross both ways and nets them', () => {
    const t = computeTurnover({ dailyOut, dailyIn, tvl: 200, windowDays: 90 })
    expect(t.grossOut).toBe(1000)
    expect(t.grossIn).toBe(800)
    expect(t.net).toBe(-200) // out-dominant venue nets negative
    expect(t.gross).toBe(1800)
  })

  it('derives the turnover multiple and days-per-vault-turn', () => {
    const t = computeTurnover({ dailyOut, dailyIn, tvl: 200, windowDays: 90 })
    expect(t.turnoverMultiple).toBe(5) // 1000 gross out / 200 held
    expect(t.daysPerVaultTurn).toBe(18) // 90d / 5 turns
  })

  it('finds the worst single out-day with its date', () => {
    const t = computeTurnover({ dailyOut, dailyIn, tvl: 200, windowDays: 90 })
    expect(t.worstOutDay).toEqual({ d: '2026-07-13', usd: 833 })
  })

  it('reports the sliver TVL actually shows, as a share of all capital moved', () => {
    const t = computeTurnover({ dailyOut, dailyIn, tvl: 200, windowDays: 90 })
    expect(t.netShareOfGross).toBeCloseTo(200 / 1800, 10)
  })

  it('counts distinct active days across both directions', () => {
    const t = computeTurnover({ dailyOut, dailyIn, tvl: 200, windowDays: 90 })
    expect(t.activeDays).toBe(3)
  })

  it('returns null — never NaN or Infinity — when TVL is missing or zero', () => {
    for (const tvl of [null, 0, undefined, Number.NaN]) {
      const t = computeTurnover({ dailyOut, dailyIn, tvl: tvl as number, windowDays: 90 })
      expect(t.tvl).toBeNull()
      expect(t.turnoverMultiple).toBeNull()
      expect(t.daysPerVaultTurn).toBeNull()
    }
  })

  it('survives an empty corpus without throwing', () => {
    const t = computeTurnover({ dailyOut: [], dailyIn: [], tvl: 100, windowDays: 90 })
    expect(t.grossOut).toBe(0)
    expect(t.worstOutDay).toBeNull()
    expect(t.turnoverMultiple).toBe(0)
    expect(t.daysPerVaultTurn).toBeNull() // 0 turns => no finite turn time
    expect(t.netShareOfGross).toBeNull()
  })

  it('handles an in-dominant venue (net positive)', () => {
    const t = computeTurnover({
      dailyOut: [day('2026-01-01', 10)],
      dailyIn: [day('2026-01-01', 90)],
      tvl: 100,
      windowDays: 30,
    })
    expect(t.net).toBe(80)
  })
})

describe('barWidths (true relative scale — the contrast is the argument)', () => {
  it('gives the longest bar the full width and scales the rest to it', () => {
    const w = barWidths({ grossIn: 31.8, grossOut: 33.5, net: -1.7, tvl: 4.7 }, 1000)
    expect(w.outPx).toBe(1000)
    expect(w.inPx).toBeCloseTo(949.25, 1)
    expect(w.netPx).toBeCloseTo(50.75, 1)
    expect(w.tvlPx).toBeCloseTo(140.3, 1)
  })

  it('includes TVL in the peak so a quiet venue cannot run off the card', () => {
    // sUSDe over 90d: the vault ($1.39B) is bigger than gross outflow ($1.08B).
    const w = barWidths({ grossIn: 0.683, grossOut: 1.077, net: -0.395, tvl: 1.387 }, 1064)
    expect(w.tvlPx).toBe(1064)
    for (const px of [w.inPx, w.outPx, w.netPx, w.tvlPx]) expect(px).toBeLessThanOrEqual(1064)
  })

  it('ignores a missing TVL rather than scaling to NaN', () => {
    const w = barWidths({ grossIn: 800, grossOut: 1000, net: -200, tvl: null }, 1000)
    expect(w.outPx).toBe(1000)
    expect(w.tvlPx).toBe(0)
  })

  it('does NOT floor the net sliver to a visible minimum', () => {
    const w = barWidths({ grossIn: 1000, grossOut: 1000.5, net: -0.5 }, 800)
    expect(w.netPx).toBeCloseTo(0.3998, 4) // sub-pixel, and left sub-pixel
  })

  it('returns zeros rather than NaN on a degenerate input', () => {
    expect(barWidths({ grossIn: 0, grossOut: 0, net: 0, tvl: 0 }, 900)).toEqual({
      inPx: 0,
      outPx: 0,
      netPx: 0,
      tvlPx: 0,
      scale: 0,
    })
  })
})

describe('vaultTicks (one notch per whole vault that walked out)', () => {
  it('emits a fractional position per completed vault-turn, all strictly inside the bar', () => {
    const ticks = vaultTicks(1000, 200)
    expect(ticks).toHaveLength(4) // 5th tick would sit at the bar end
    expect(ticks[0]).toBeCloseTo(0.2, 10)
    expect(Math.max(...ticks)).toBeLessThan(1)
  })

  it('caps runaway tick counts', () => {
    expect(vaultTicks(1e9, 1).length).toBe(40)
    expect(vaultTicks(1e9, 1, 6).length).toBe(6)
  })

  it('is empty when there is no vault or no flow', () => {
    expect(vaultTicks(0, 200)).toEqual([])
    expect(vaultTicks(1000, 0)).toEqual([])
  })
})

describe('exitSemantics (HONESTY — "served" is a claim, not a label)', () => {
  it('calls a no-cooldown venue served', () => {
    const s = exitSemantics(0)
    expect(s.gated).toBe(false)
    expect(s.verb).toBe('served')
    expect(s.note).toMatch(/no cooldown/)
  })

  it('refuses "served" on a cooldown venue and says why', () => {
    const s = exitSemantics(86_400)
    expect(s.gated).toBe(true)
    expect(s.verb).toBe('queued')
    expect(s.note).toMatch(/INITIATION, not a settled exit/)
    expect(s.note).not.toMatch(/served|served on demand/)
  })

  it('treats an unknown cooldown as ungated (sUSDS has no cooldown method)', () => {
    expect(exitSemantics(null as unknown as number).gated).toBe(false)
    expect(exitSemantics(undefined as unknown as number).verb).toBe('served')
  })
})
