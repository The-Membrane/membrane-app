import { describe, expect, it } from 'vitest'

// The rules are a dependency-free .mjs shared with the checker that actually runs
// (scripts/check-venue-alarms.mjs), so the code under test IS the code that runs
// in production — same discipline as newsParse.test.ts.
import {
  evalGateChange,
  evalDrawdown,
  evalOutflowStreak,
  evalHeadroom,
  reconcileAlarms,
  uncoveredFor,
  UNCOVERED_SIGNALS,
} from '../../scripts/lib/alarmRules.mjs'

const NOW = Date.parse('2026-09-06T00:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('evalGateChange (memo P2 — the gate moves)', () => {
  it('fires alarm on a cooldown change inside the 24h window', () => {
    const r = evalGateChange([{ kind: 'cooldown_duration_changed', at: hoursAgo(23) }], NOW)
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('alarm')
    expect(r.evidence!.count).toBe(1)
  })

  it('fires on an instant_liquidity_shift too', () => {
    expect(evalGateChange([{ kind: 'instant_liquidity_shift', at: hoursAgo(1) }], NOW).fires).toBe(true)
  })

  it('does NOT fire for an event older than 24h (boundary)', () => {
    expect(evalGateChange([{ kind: 'cooldown_duration_changed', at: hoursAgo(25) }], NOW).fires).toBe(false)
  })

  it('ignores non-gate event kinds', () => {
    expect(evalGateChange([{ kind: 'param_changed', at: hoursAgo(1) }], NOW).fires).toBe(false)
  })

  it('is empty-safe', () => {
    expect(evalGateChange([], NOW).fires).toBe(false)
    expect(evalGateChange(undefined, NOW).fires).toBe(false)
  })
})

describe('evalDrawdown (stETH/Angle drain — >20% peak-to-current over 7d)', () => {
  const s = (at: string, value: number) => ({ at, value })

  it('fires when capacity falls strictly more than 20% from the in-window peak', () => {
    const r = evalDrawdown([s('2026-09-01', 100), s('2026-09-03', 100), s('2026-09-06', 74)], 'instant_usd')
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('alarm')
    expect(r.evidence!.fromValue).toBe(100)
    expect(r.evidence!.toValue).toBe(74)
    expect(r.evidence!.dropPct).toBeCloseTo(-26, 5)
  })

  it('does NOT fire at exactly a 20% fall (boundary is strict)', () => {
    expect(evalDrawdown([s('2026-09-01', 100), s('2026-09-06', 80)], 'instant_usd').fires).toBe(false)
  })

  it('fires just past 20%', () => {
    expect(evalDrawdown([s('2026-09-01', 100), s('2026-09-06', 79.9)], 'instant_usd').fires).toBe(true)
  })

  it('does not fire on a rising series (peak is the latest point)', () => {
    expect(evalDrawdown([s('2026-09-01', 50), s('2026-09-06', 100)], 'instant_usd').fires).toBe(false)
  })

  it('needs at least two points', () => {
    expect(evalDrawdown([s('2026-09-06', 10)], 'instant_usd').fires).toBe(false)
    expect(evalDrawdown([], 'instant_usd').fires).toBe(false)
  })
})

describe('evalOutflowStreak (Stream/sUSDe bleed)', () => {
  // dense descending-magnitude helper: build N consecutive negative-net days
  const negDays = (startISO: string, nets: number[]) => {
    const out: { day: string; net: number }[] = []
    const d = new Date(`${startISO}T00:00:00.000Z`)
    for (const net of nets) {
      out.push({ day: d.toISOString().slice(0, 10), net })
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return out
  }

  it('watch at a 10-day streak when cumulative outflow > 10% of TVL', () => {
    const days = negDays('2026-08-28', Array(10).fill(-2)) // 10 days, $20 out
    const r = evalOutflowStreak(days, 100) // TVL 100 → 20% > 10%
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('watch')
    expect(r.evidence!.streakDays).toBe(10)
    expect(r.evidence!.cumulativeOutflowUsd).toBeCloseTo(20, 5)
    expect(r.evidence!.pctOfTvl).toBeCloseTo(20, 5)
  })

  it('does NOT fire at 10 days if cumulative outflow is <= 10% of TVL', () => {
    const days = negDays('2026-08-28', Array(10).fill(-2)) // $20 out
    expect(evalOutflowStreak(days, 300).fires).toBe(false) // 20/300 = 6.7%
  })

  it('escalates to alarm at a 20-day streak', () => {
    const days = negDays('2026-08-18', Array(20).fill(-2)) // 20 days, $40 out
    const r = evalOutflowStreak(days, 100)
    expect(r.severity).toBe('alarm')
    expect(r.evidence!.streakDays).toBe(20)
  })

  it('a gap (missing calendar day = net 0) BREAKS the streak', () => {
    // 15 negative days, but a one-day hole 3 days back from the newest.
    const days = negDays('2026-08-20', Array(15).fill(-2))
    // remove the day two-from-last to punch a hole near the anchor end
    const anchorIdx = days.length - 1
    const holeDay = days[anchorIdx - 2].day
    const withHole = days.filter((d) => d.day !== holeDay)
    const r = evalOutflowStreak(withHole, 100)
    // walking back from the newest: 2 neg days, then the hole (net 0) breaks it.
    expect(r.streakDays).toBe(2)
    // streak of 2 < 10 → does not fire
    expect(r.fires).toBe(false)
  })

  it('a positive net day breaks the streak too', () => {
    const days = [
      ...negDays('2026-08-28', [-2, -2, -2]),
      { day: '2026-08-31', net: +5 },
      ...negDays('2026-09-01', Array(5).fill(-2)),
    ]
    // anchor = 2026-09-05, 5 neg days back to 2026-09-01, then +5 breaks.
    const r = evalOutflowStreak(days, 1000)
    expect(r.streakDays).toBe(5)
  })

  it('is empty-safe', () => {
    expect(evalOutflowStreak([], 100).fires).toBe(false)
    expect(evalOutflowStreak(undefined, 100).fires).toBe(false)
  })
})

describe('evalHeadroom (one bad day from gating)', () => {
  it('watch below 3x', () => {
    const r = evalHeadroom(250, 100) // 2.5x
    expect(r.severity).toBe('watch')
    expect(r.evidence!.ratio).toBeCloseTo(2.5, 5)
  })

  it('alarm below 1.5x', () => {
    expect(evalHeadroom(140, 100).severity).toBe('alarm') // 1.4x
  })

  it('does not fire at exactly 3x (boundary strict)', () => {
    expect(evalHeadroom(300, 100).fires).toBe(false)
  })

  it('does not fire with no worst-day data', () => {
    expect(evalHeadroom(100, 0).fires).toBe(false)
    expect(evalHeadroom(null, 100).fires).toBe(false)
  })
})

describe('reconcileAlarms (dedupe-while-open + cleared_at transition)', () => {
  const fire = (venue: string, kind: string, severity = 'alarm') => ({ venue, kind, severity, evidence: {} })
  const open = (id: string, venue: string, kind: string) => ({ id, venue, kind })

  it('inserts a firing that has no open row', () => {
    const { toInsert, toClear } = reconcileAlarms([fire('sUSDe', 'net_outflow_streak')], [])
    expect(toInsert).toHaveLength(1)
    expect(toClear).toHaveLength(0)
  })

  it('does NOT insert a firing that is already open (dedupe-while-open)', () => {
    const { toInsert } = reconcileAlarms(
      [fire('sUSDe', 'net_outflow_streak')],
      [open('a1', 'sUSDe', 'net_outflow_streak')],
    )
    expect(toInsert).toHaveLength(0)
  })

  it('clears an open alarm whose condition no longer fires', () => {
    const { toClear } = reconcileAlarms([], [open('a1', 'sUSDe', 'net_outflow_streak')])
    expect(toClear).toHaveLength(1)
    expect(toClear[0].id).toBe('a1')
  })

  it('keeps venue+kind independent (one clears, one stays, one opens)', () => {
    const firing = [fire('sUSDe', 'gate_change'), fire('aave', 'headroom_thin')]
    const opened = [open('a1', 'sUSDe', 'gate_change'), open('a2', 'scrvUSD', 'drawdown_fast')]
    const { toInsert, toClear } = reconcileAlarms(firing, opened)
    // aave/headroom_thin is new → insert; sUSDe/gate_change already open → skip;
    // scrvUSD/drawdown_fast no longer firing → clear.
    expect(toInsert.map((x: { venue: string; kind: string }) => `${x.venue}/${x.kind}`)).toEqual(['aave/headroom_thin'])
    expect(toClear.map((x: { id: string }) => x.id)).toEqual(['a2'])
  })
})

describe('uncoveredFor (silence is not all-clear)', () => {
  it('always names the three memo blind spots', () => {
    const ids = uncoveredFor({ hasInstant: true }).map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining(['depth_vs_book', 'yield_flatness', 'terms_page_changes']))
    expect(UNCOVERED_SIGNALS).toHaveLength(3)
  })

  it('adds instant-exit headroom when the venue exposes no instant_usd', () => {
    const ids = uncoveredFor({ hasInstant: false }).map((u) => u.id)
    expect(ids).toContain('headroom_instant_liquidity')
    expect(uncoveredFor({ hasInstant: true }).map((u) => u.id)).not.toContain('headroom_instant_liquidity')
  })
})
