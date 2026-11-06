import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { evaluateM0, HOUR_MS, type HourlyPoint } from '@/lib/regime/m0'
import { M0_THRESHOLDS } from '@/lib/regime/thresholds'

// The M0 rule on synthetic hours (exact thresholds below) and on a real replay of the
// 10 Oct 2025 crash from membrane-datasets price-history (fixture copied unchanged).

// 0.0625 = 1/16, exact in binary, so "at p95" tests the ≥ without float noise.
const T = { move24hP95: 0.0625, gapBand: 0.0167 }
/** A fixed "now": 30 minutes into the hour after the hour ending at H. */
const H = Date.UTC(2026, 9, 14, 12)
const NOW = H + 30 * 60_000
const h = (k: number) => H - k * HOUR_MS

/** 48 hour ends, oldest first, ending at H, from a value function of hours-before-H. */
function series(f: (k: number) => number | null, hours = 48): HourlyPoint[] {
  return Array.from({ length: hours }, (_, i) => {
    const k = hours - 1 - i
    return { t: h(k), v: f(k) }
  })
}
const flat = (v = 2500) => series(() => v)

describe('evaluateM0 — calm', () => {
  it('is calm with full, fresh, quiet inputs', () => {
    const r = evaluateM0({ oracle: flat(), market: flat(2501), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('calm')
    expect(r.triggers).toEqual([])
    expect(r.active).toBe(false)
    expect(r.since).toBeNull()
    expect(r.holdsUntil).toBeNull()
    expect(r.lastTriggerAt).toBeNull()
    expect(r.evaluatedAt).toBe(H)
    expect(r.coverage).toEqual({ hoursObserved: 24, window: 24, required: 20 })
    expect(r.inputs).toEqual({ oracleAsOf: H, marketAsOf: H })
    expect(r.stale).toEqual([])
    expect(r.current.move24h).toEqual({ t: H, value: 0 })
    expect(r.current.gap?.t).toBe(H)
    expect(r.current.gap?.value).toBeCloseTo(2500 / 2501 - 1, 12)
    expect(r.liquidationVolume).toEqual({ counted: false, reason: 'no live source' })
  })

  it('a move just under p95 does not fire', () => {
    const p = (k: number) => (k <= 0 ? 2500 * 1.0624 : 2500)
    const r = evaluateM0({ oracle: series(p), market: series(p), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('calm')
  })
})

describe('evaluateM0 — trigger (A), the 24h move', () => {
  it('fires on a drop at or past p95, signed', () => {
    // The price is 2560 until 3h ago, then 2400: the move at H is −6.25% exactly.
    const p = (k: number) => (k <= 2 ? 2400 : 2560)
    const r = evaluateM0({ oracle: series(p), market: series(p), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('choppy')
    expect(r.active).toBe(true)
    const moves = r.triggers.filter((x) => x.kind === 'move24h')
    expect(moves.map((x) => x.t)).toEqual([h(2), h(1), h(0)])
    expect(moves[0].value).toBe(-0.0625)
    expect(moves[0].threshold).toBe(0.0625)
    expect(r.since).toBe(h(2))
    expect(r.lastTriggerAt).toBe(H)
    expect(r.holdsUntil).toBe(H + 24 * HOUR_MS)
    expect(r.current.move24h?.value).toBe(-0.0625)
  })

  it('fires on a rise too (the rule is on |move|)', () => {
    const p = (k: number) => (k === 0 ? 2500 * 1.09 : 2500)
    const r = evaluateM0({ oracle: series(p), market: series(p), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('choppy')
    expect(r.triggers).toHaveLength(1)
    expect(r.triggers[0]).toMatchObject({ t: H, kind: 'move24h' })
    expect(r.triggers[0].value).toBeCloseTo(0.09, 12)
  })
})

describe('evaluateM0 — trigger (B), the oracle gap', () => {
  it('fires when Chainlink sits outside the band against Coinbase', () => {
    const market = series((k) => (k === 0 ? 2500 / (1 - 0.019) : 2500))
    const r = evaluateM0({ oracle: flat(), market, nowMs: NOW, thresholds: T })
    expect(r.state).toBe('choppy')
    expect(r.triggers).toHaveLength(1)
    expect(r.triggers[0]).toMatchObject({ t: H, kind: 'oracleGap', threshold: 0.0167 })
    expect(r.triggers[0].value).toBeCloseTo(-0.019, 12)
    expect(r.current.gap?.value).toBeCloseTo(-0.019, 12)
  })

  it('a gap exactly at the band fires (≥)', () => {
    const market = series((k) => (k === 5 ? 2500 / 1.0167 : 2500))
    const r = evaluateM0({
      oracle: flat(),
      market,
      nowMs: NOW,
      thresholds: { ...T, gapBand: 2500 / (2500 / 1.0167) - 1 },
    })
    expect(r.triggers.map((x) => x.t)).toEqual([h(5)])
    expect(r.state).toBe('choppy')
    expect(r.active).toBe(false)
  })
})

describe('evaluateM0 — the 24h hold', () => {
  const gapAt = (ks: number[]) => series((k) => (ks.includes(k) ? 2600 : 2500))

  it('holds exactly 24h after the last trigger, then turns calm', () => {
    // A trigger 23h before H is still inside the last 24 completed hours.
    let r = evaluateM0({ oracle: flat(), market: gapAt([23]), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('choppy')
    expect(r.active).toBe(false)
    expect(r.since).toBe(h(23))
    expect(r.holdsUntil).toBe(h(23) + 24 * HOUR_MS)
    expect(r.holdsUntil).toBe(H + HOUR_MS)
    expect(NOW).toBeLessThan(r.holdsUntil as number)
    // One hour later the same trigger is 24h old: the hold has run out.
    r = evaluateM0({ oracle: flat(), market: gapAt([24]), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('calm')
    expect(r.lastTriggerAt).toBe(h(24))
    expect(r.since).toBeNull()
    expect(r.holdsUntil).toBeNull()
  })

  it('the state flips exactly at holdsUntil on the clock', () => {
    const oracle = flat()
    const market = gapAt([0])
    const until = H + 24 * HOUR_MS
    // Hours after H are absent (the as-of stamps are kept fresh so only the hold decides).
    const before = evaluateM0({
      oracle,
      market,
      nowMs: until - 1,
      thresholds: T,
      oracleAsOfMs: until - 60_000,
      marketAsOfMs: until - 60_000,
    })
    expect(before.state).toBe('choppy')
    expect(before.holdsUntil).toBe(until)
    const after = evaluateM0({
      oracle,
      market,
      nowMs: until,
      thresholds: T,
      oracleAsOfMs: until - 60_000,
      marketAsOfMs: until - 60_000,
    })
    expect(after.state).not.toBe('choppy')
  })

  it('a re-trigger extends the hold, and since stays at the first hour of the run', () => {
    const r = evaluateM0({ oracle: flat(), market: gapAt([20, 4]), nowMs: NOW, thresholds: T })
    expect(r.state).toBe('choppy')
    expect(r.since).toBe(h(20))
    expect(r.lastTriggerAt).toBe(h(4))
    expect(r.holdsUntil).toBe(h(4) + 24 * HOUR_MS)
  })

  it('a run continues across a gap of exactly 24h, and breaks at 25h', () => {
    let r = evaluateM0({ oracle: flat(), market: gapAt([30, 6]), nowMs: NOW, thresholds: T })
    expect(r.since).toBe(h(30))
    r = evaluateM0({ oracle: flat(), market: gapAt([31, 6]), nowMs: NOW, thresholds: T })
    expect(r.since).toBe(h(6))
    expect(r.sinceTruncated).toBe(false)
  })

  it('flags since as truncated when the run could reach back past the window', () => {
    const r = evaluateM0({ oracle: flat(), market: gapAt([40, 20]), nowMs: NOW, thresholds: T })
    expect(r.since).toBe(h(40))
    expect(r.sinceTruncated).toBe(true)
  })

  it('takes holdHours as a parameter', () => {
    const r = evaluateM0({
      oracle: flat(),
      market: gapAt([10]),
      nowMs: NOW,
      thresholds: T,
      holdHours: 6,
    })
    expect(r.state).toBe('calm')
    expect(r.holdHours).toBe(6)
  })
})

describe('evaluateM0 — stale', () => {
  it('an oracle round older than 2h is stale, even with a trigger', () => {
    const market = series((k) => (k === 0 ? 2600 : 2500))
    const r = evaluateM0({
      oracle: flat(),
      market,
      nowMs: NOW,
      thresholds: T,
      oracleAsOfMs: NOW - 2 * HOUR_MS - 1,
    })
    expect(r.state).toBe('stale')
    expect(r.stale).toContain('oracleOld')
    // The trigger and its hold are still reported; the UI withholds them.
    expect(r.holdsUntil).toBe(H + 24 * HOUR_MS)
  })

  it('exactly 2h old is not stale', () => {
    const r = evaluateM0({
      oracle: flat(),
      market: flat(),
      nowMs: NOW,
      thresholds: T,
      oracleAsOfMs: NOW - 2 * HOUR_MS,
    })
    expect(r.state).toBe('calm')
  })

  it('an old market candle is stale when nothing fired', () => {
    const market = series((k) => (k <= 2 ? null : 2500))
    const r = evaluateM0({ oracle: flat(), market, nowMs: NOW, thresholds: T })
    expect(r.inputs.marketAsOf).toBe(h(3))
    expect(r.stale).toEqual(['marketOld'])
    expect(r.state).toBe('stale')
  })

  it('an old or missing market does not hide an observed move trigger', () => {
    const p = (k: number) => (k <= 1 ? 2200 : 2500)
    const r = evaluateM0({ oracle: series(p), market: [], nowMs: NOW, thresholds: T })
    expect(r.stale).toEqual(['marketOld', 'lowCoverage'])
    expect(r.state).toBe('choppy')
    expect(r.inputs.marketAsOf).toBeNull()
  })

  it('fewer than 20 of the last 24 hours with both inputs is stale', () => {
    // 5 missing market hours inside the window, none at the newest hour.
    const market = series((k) => ([3, 5, 7, 9, 11].includes(k) ? null : 2500))
    const r = evaluateM0({ oracle: flat(), market, nowMs: NOW, thresholds: T })
    expect(r.coverage.hoursObserved).toBe(19)
    expect(r.stale).toEqual(['lowCoverage'])
    expect(r.state).toBe('stale')
    // 4 missing is still enough.
    const ok = evaluateM0({
      oracle: flat(),
      market: series((k) => ([3, 5, 7, 9].includes(k) ? null : 2500)),
      nowMs: NOW,
      thresholds: T,
    })
    expect(ok.coverage.hoursObserved).toBe(20)
    expect(ok.state).toBe('calm')
  })

  it('a trigger that is observed still counts when other hours are missing', () => {
    const market = series((k) => (k === 2 ? 2600 : k % 2 ? null : 2500))
    const r = evaluateM0({ oracle: flat(), market, nowMs: NOW, thresholds: T })
    expect(r.coverage.hoursObserved).toBe(12)
    expect(r.stale).toContain('lowCoverage')
    expect(r.state).toBe('choppy')
    expect(r.since).toBe(h(2))
  })

  it('no inputs at all is stale', () => {
    const r = evaluateM0({ oracle: [], market: [], nowMs: NOW, thresholds: T })
    expect(r.state).toBe('stale')
    expect(r.stale).toEqual(['oracleOld', 'marketOld', 'lowCoverage'])
    expect(r.inputs).toEqual({ oracleAsOf: null, marketAsOf: null })
    expect(r.current).toEqual({ move24h: null, gap: null })
  })
})

describe('evaluateM0 — nulls, gaps and bad points', () => {
  it('skips nulls, zeros, NaN, off-grid and not-yet-closed hours', () => {
    const oracle = flat()
    oracle[46] = { t: h(1), v: null }
    const market: HourlyPoint[] = [
      ...flat().map((p, i) => (i === 40 ? { ...p, v: 0 } : i === 41 ? { ...p, v: Number.NaN } : p)),
      // The open hour (ends after now) and an off-grid stamp: both ignored.
      { t: H + HOUR_MS, v: 1 },
      { t: H - 1234, v: 1 },
    ]
    const r = evaluateM0({ oracle, market, nowMs: NOW, thresholds: T })
    expect(r.triggers).toEqual([])
    expect(r.coverage.hoursObserved).toBe(21)
    expect(r.state).toBe('calm')
    expect(r.inputs.marketAsOf).toBe(H)
  })

  it('a missing lookback hour skips (A) for that hour only', () => {
    // The hour 24h before H is missing, so (A) at H cannot be read even though the
    // price at H is far off; (B) at H still reads.
    const oracle = series((k) => (k === 24 ? null : k === 0 ? 2000 : 2500))
    const market = series((k) => (k === 0 ? 2000 : 2500))
    const r = evaluateM0({ oracle, market, nowMs: NOW, thresholds: T })
    expect(r.triggers.filter((x) => x.t === H)).toEqual([])
    expect(r.current.move24h?.t).toBe(h(1))
  })
})

// ---------------------------------------------------------------------------------
// REAL REPLAY: 72 hours of membrane-datasets price-history around 10 Oct 2025.
// ---------------------------------------------------------------------------------

interface Fixture {
  t: number[]
  oracle: (number | null)[]
  coinbase: (number | null)[]
}
const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'eth-usd-1h-2025-10-10.json'), 'utf8'),
) as Fixture
const real = (col: (number | null)[]): HourlyPoint[] => fx.t.map((t, i) => ({ t, v: col[i] }))

describe('evaluateM0 — real replay, 10 Oct 2025', () => {
  const run = (iso: string) =>
    evaluateM0({
      oracle: real(fx.oracle),
      market: real(fx.coinbase),
      nowMs: Date.parse(iso),
      thresholds: M0_THRESHOLDS,
    })

  it('the fixture is 72 contiguous hour ends', () => {
    expect(fx.t).toHaveLength(72)
    fx.t.forEach((t, i) => i && expect(t - fx.t[i - 1]).toBe(HOUR_MS))
  })

  it('is calm in the afternoon before the crash', () => {
    expect(run('2025-10-10T18:30:00Z').state).toBe('calm')
  })

  it('turns choppy on the 24h move at 21:00Z', () => {
    const r = run('2025-10-10T21:05:00Z')
    expect(r.state).toBe('choppy')
    expect(r.active).toBe(true)
    expect(r.since).toBe(Date.parse('2025-10-10T21:00:00Z'))
    expect(r.triggers.map((x) => x.kind)).toEqual(['move24h'])
    expect(r.current.move24h?.value).toBeLessThan(-M0_THRESHOLDS.move24hP95)
    expect(r.stale).toEqual([])
  })

  it('still holds choppy late on 11 Oct, after the last trigger', () => {
    const r = run('2025-10-11T23:30:00Z')
    expect(r.state).toBe('choppy')
    expect(r.active).toBe(false)
    expect(r.since).toBe(Date.parse('2025-10-10T21:00:00Z'))
    expect(r.lastTriggerAt).toBe(Date.parse('2025-10-11T15:00:00Z'))
    expect(r.holdsUntil).toBe(Date.parse('2025-10-12T15:00:00Z'))
  })
})
