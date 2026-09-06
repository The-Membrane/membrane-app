import { describe, expect, it } from 'vitest'

// The rules are a dependency-free .mjs shared with the checker that actually runs
// (scripts/check-venue-alarms.mjs), so the code under test IS the code that runs
// in production — same discipline as newsParse.test.ts.
import {
  evalGateChange,
  evalDrawdown,
  evalOutflowStreak,
  evalHeadroom,
  evalUtilization,
  evalDepthSkew,
  evalDepthCollapse,
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

  it('treats a terms_page_changed event as alarm-grade (gate moves)', () => {
    const r = evalGateChange([{ kind: 'terms_page_changed', at: hoursAgo(2) }], NOW)
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('alarm')
    expect(r.evidence!.count).toBe(1)
  })

  it('does NOT fire for a terms_page_changed older than 24h (boundary)', () => {
    expect(evalGateChange([{ kind: 'terms_page_changed', at: hoursAgo(25) }], NOW).fires).toBe(false)
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

describe('evalUtilization (Fraxlend/Morpho — lenders cannot exit at ~100% util)', () => {
  it('watch above 90% utilization', () => {
    const r = evalUtilization(92)
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('watch')
    expect(r.evidence!.utilizationPct).toBe(92)
  })

  it('alarm above 95% utilization', () => {
    expect(evalUtilization(97).severity).toBe('alarm')
  })

  it('does NOT fire at exactly 90% (boundary strict)', () => {
    expect(evalUtilization(90).fires).toBe(false)
  })

  it('does NOT fire at exactly 95% — stays watch, not alarm', () => {
    const r = evalUtilization(95)
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('watch')
  })

  it('does not fire on a healthy reserve (44% genre)', () => {
    expect(evalUtilization(44.19).fires).toBe(false)
  })

  it('is null-safe (venue records no utilization)', () => {
    expect(evalUtilization(null).fires).toBe(false)
    expect(evalUtilization(undefined).fires).toBe(false)
  })
})

describe('evalDepthSkew (memo P4 — pool one-sidedness of the instant-exit tier)', () => {
  it('watch above 80% one-sided (stETH 78:22 genre)', () => {
    const r = evalDepthSkew(85)
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('watch')
    expect(r.evidence!.skewPct).toBe(85)
  })

  it('alarm above 90% one-sided (MIM 96% genre)', () => {
    expect(evalDepthSkew(96).severity).toBe('alarm')
  })

  it('does NOT fire at exactly 80% (boundary strict)', () => {
    expect(evalDepthSkew(80).fires).toBe(false)
  })

  it('does not fire on a balanced pool', () => {
    expect(evalDepthSkew(54.2).fires).toBe(false)
  })

  it('is null-safe (no depth reading)', () => {
    expect(evalDepthSkew(null).fires).toBe(false)
    expect(evalDepthSkew(undefined).fires).toBe(false)
  })
})

describe('evalDepthCollapse (memo P4 — exitable depth falling fast over 7d)', () => {
  const s = (at: string, value: number) => ({ at, value })

  it('watch when exitable depth falls >35% from the in-window peak', () => {
    const r = evalDepthCollapse([s('2026-09-01', 100), s('2026-09-06', 60)]) // -40%
    expect(r.fires).toBe(true)
    expect(r.severity).toBe('watch')
    expect(r.evidence!.dropPct).toBeCloseTo(-40, 5)
    expect(r.evidence!.metric).toBe('depth_usd')
  })

  it('alarm when it falls >50% (CRV/stETH drain genre)', () => {
    expect(evalDepthCollapse([s('2026-09-01', 100), s('2026-09-06', 49)]).severity).toBe('alarm')
  })

  it('does NOT fire at exactly 35% (boundary strict)', () => {
    expect(evalDepthCollapse([s('2026-09-01', 100), s('2026-09-06', 65)]).fires).toBe(false)
  })

  it('takes the peak from anywhere in the window, not just the first point', () => {
    const r = evalDepthCollapse([s('2026-09-01', 80), s('2026-09-03', 120), s('2026-09-06', 70)]) // peak 120 → -41.7%
    expect(r.fires).toBe(true)
    expect(r.evidence!.fromValue).toBe(120)
  })

  it('does not fire on a rising or flat series', () => {
    expect(evalDepthCollapse([s('2026-09-01', 50), s('2026-09-06', 100)]).fires).toBe(false)
  })

  it('needs at least two points', () => {
    expect(evalDepthCollapse([s('2026-09-06', 10)]).fires).toBe(false)
    expect(evalDepthCollapse([]).fires).toBe(false)
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

  it('drops depth_vs_book once the venue has a verified/covered depth market', () => {
    // covered (enabled depth market OR covered-by-instant) → depth_vs_book leaves the blind list
    expect(uncoveredFor({ hasInstant: false, depthCovered: true }).map((u) => u.id)).not.toContain('depth_vs_book')
    // still blind by default (no depth market, no instant depth) → depth_vs_book stays
    expect(uncoveredFor({ hasInstant: true, depthCovered: false }).map((u) => u.id)).toContain('depth_vs_book')
    expect(uncoveredFor({ hasInstant: true }).map((u) => u.id)).toContain('depth_vs_book')
  })

  it('drops terms_page_changes once the venue has a termsUrl baseline', () => {
    // termsCovered (a termsUrl the hash watcher tracks) → terms_page_changes leaves the blind list
    expect(uncoveredFor({ hasInstant: true, termsCovered: true }).map((u) => u.id)).not.toContain('terms_page_changes')
    // no termsUrl → still blind
    expect(uncoveredFor({ hasInstant: true, termsCovered: false }).map((u) => u.id)).toContain('terms_page_changes')
    expect(uncoveredFor({ hasInstant: true }).map((u) => u.id)).toContain('terms_page_changes')
  })
})
