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
  it('always names the two memo blind spots — yield flatness is not one (owner 2026-09-26)', () => {
    const ids = uncoveredFor({ hasInstant: true }).map((u) => u.id)
    expect(ids).toEqual(expect.arrayContaining(['depth_vs_book', 'terms_page_changes']))
    expect(UNCOVERED_SIGNALS).toHaveLength(2)
    expect(UNCOVERED_SIGNALS.map((u) => u.id)).not.toContain('yield_flatness')
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

describe('depth_collapse read guards (2026-09-25)', () => {
  it('a null reading is dropped, never read as a collapse to zero', async () => {
    const { evalDepthCollapse } = await import('../../scripts/lib/alarmRules.mjs')
    expect(evalDepthCollapse([{ at: '2026-09-26T00:00Z', value: 3.8e9 }, { at: '2026-09-26T01:00Z', value: null }]).fires).toBe(false)
  })
  it('a pre-guard zero is an unread; a post-guard zero is a real drain', async () => {
    const { evalDepthCollapse } = await import('../../scripts/lib/alarmRules.mjs')
    expect(evalDepthCollapse([{ at: '2026-09-12T23:00Z', value: 3.8e9 }, { at: '2026-09-13T04:04Z', value: 0 }]).fires).toBe(false)
    const post = evalDepthCollapse([{ at: '2026-09-26T00:00Z', value: 3.8e9 }, { at: '2026-09-26T01:00Z', value: 0 }])
    expect(post.fires).toBe(true)
    expect(post.severity).toBe('alarm')
  })
})

describe('coverageFor / uncoveredFooter — the ONE blind-spot source (2026-09-25)', () => {
  it('derives coverage from venue config exactly as the checker does', async () => {
    const { coverageFor } = await import('../../scripts/lib/alarmRules.mjs')
    const ids = (cfg: object, hasInstant: boolean) => coverageFor(cfg, { hasInstant }).map((u: { id: string }) => u.id).sort()
    expect(ids({}, false)).toEqual(['depth_vs_book', 'headroom_instant_liquidity', 'terms_page_changes'])
    expect(ids({ termsUrl: 'https://x', depthMarkets: [{ enabled: true }] }, true)).toEqual([])
    expect(ids({ depthMarkets: [{ enabled: false }] }, true)).toContain('depth_vs_book')
    expect(ids({ depthCoveredByInstant: true }, true)).not.toContain('depth_vs_book')
  })

  it('names a signal once when every venue is blind to it, else lists the venues', async () => {
    const { coverageFor, uncoveredFooter } = await import('../../scripts/lib/alarmRules.mjs')
    const line = uncoveredFooter({
      sUSDS: coverageFor({ termsUrl: 'x', depthMarkets: [{ enabled: true }] }, { hasInstant: false }),
      'aave-v3-usde': coverageFor({ termsUrl: 'x', depthCoveredByInstant: true }, { hasInstant: true }),
    })
    expect(line).toBe('this alarm cannot yet see: instant-exit headroom (sUSDS)')
  })

  it('never goes silent', async () => {
    const { uncoveredFooter } = await import('../../scripts/lib/alarmRules.mjs')
    expect(uncoveredFooter({})).toMatch(/^blind spots unknown/)
    expect(uncoveredFooter({ sUSDS: [] })).toMatch(/can see every signal/)
  })

  it('no hand-kept copy of the list exists outside alarmRules.mjs', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const { join } = await import('path')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|mjs)$/.test(f) && !p.endsWith('alarmRules.mjs')) {
          const src = readFileSync(p, 'utf8')
          if (/UNCOVERED_SIGNALS\s*[:=]|UNCOVERED_FOOTER\s*=|'depth-vs-book'/.test(src)) hits.push(p)
        }
      }
    }
    for (const d of ['components', 'pages', 'lib', 'scripts']) walk(join(process.cwd(), d))
    expect(hits).toEqual([])
  })
})

describe('instantExitUsd — headroom capacity: instant_usd, else swap-out capacity within the cost cap, else raw depth (2026-09-26)', () => {
  it('prefers instant_usd when read', async () => {
    const { instantExitUsd } = await import('../../scripts/lib/alarmRules.mjs')
    expect(instantExitUsd({ instant_usd: '120.5', params: { depth_usd: 9 } })).toEqual({ usd: 120.5, source: 'instant_usd' })
  })

  it('with no instant_usd, prefers the depth-curve capacity within the cost cap (owner ask 2026-09-26)', async () => {
    const { instantExitUsd, curveCapacityAtCost, ALARM_THRESHOLDS } = await import('../../scripts/lib/alarmRules.mjs')
    const cap = ALARM_THRESHOLDS.headroom_thin.poolCostPct
    const rows = [
      { market: 'A', points: [{ costPct: 0.5, capacityUsd: 1 }, { costPct: cap, capacityUsd: 10 }] },
      { market: 'B', points: [{ costPct: 0.5, capacityUsd: 2 }, { costPct: cap, capacityUsd: 5 }] },
    ]
    const curve = curveCapacityAtCost(rows, cap)
    expect(curve).toEqual({ usd: 15, costPct: cap })
    const at = '2026-09-26T00:00:00Z'
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 99 } }, curve)).toEqual({ usd: 15, source: 'depth_curve', costCapPct: cap })
    // a real instant read still wins
    expect(instantExitUsd({ instant_usd: 7, at, params: {} }, curve)?.source).toBe('instant_usd')
    // no rows / a market with no read at the cap: no curve capacity (never a partial sum, never 0)
    expect(curveCapacityAtCost([], cap)).toBeNull()
    expect(curveCapacityAtCost([rows[0], { market: 'C', points: [{ costPct: cap, capacityUsd: null }] }], cap)).toBeNull()
    expect(curveCapacityAtCost([{ market: 'D', points: [{ costPct: 2, capacityUsd: 3 }] }], cap)).toBeNull()
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 99 } }, null)?.source).toBe('depth_usd_raw')
  })

  it('evalHeadroom records the cost cap and treats curve/raw pool capacity as pool-only', async () => {
    const { evalHeadroom, ALARM_THRESHOLDS } = await import('../../scripts/lib/alarmRules.mjs')
    const cap = ALARM_THRESHOLDS.headroom_thin.poolCostPct
    expect(evalHeadroom(140, 100, 'depth_curve', null, cap).evidence).toEqual({ instantUsd: 140, worstDayOutflowUsd: 100, windowDays: 90, ratio: 1.4, totalRatio: 1.4, source: 'depth_curve', costCapPct: cap })
    const deep = ALARM_THRESHOLDS.headroom_thin.alarm / 2
    for (const src of ['depth_curve', 'depth_usd_raw']) {
      expect(evalHeadroom(deep, 1, src, { usd: 100, delaySec: 86400 }).severity).toBe(ALARM_THRESHOLDS.headroom_thin.poolMaxSeverity)
    }
  })

  it('falls back to the RAW params.depth_usd (labelled depth_usd_raw) when there is no instant_usd and no curve', async () => {
    const { instantExitUsd } = await import('../../scripts/lib/alarmRules.mjs')
    const at = '2026-09-26T00:00:00Z'
    expect(instantExitUsd({ instant_usd: null, observed_at: at, params: { depth_usd: 3.8e9, depth_complete: true } })).toEqual({
      usd: 3.8e9,
      source: 'depth_usd_raw',
    })
    // depth_complete absent (older rows) is not a failed read
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 5 } })?.source).toBe('depth_usd_raw')
    // a post-guard zero is a real, empty pool — it counts
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 0, depth_complete: true } })).toEqual({ usd: 0, source: 'depth_usd_raw' })
  })

  it('never reads a missing or failed depth as 0', async () => {
    const { instantExitUsd } = await import('../../scripts/lib/alarmRules.mjs')
    const at = '2026-09-26T00:00:00Z'
    expect(instantExitUsd(null)).toBeNull()
    expect(instantExitUsd({ instant_usd: null, at, params: {} })).toBeNull()
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: null, depth_complete: false } })).toBeNull()
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 7, depth_complete: false } })).toBeNull()
    expect(instantExitUsd({ instant_usd: null, at, params: { depth_usd: 'x' } })).toBeNull()
    // pre-guard zero = unread (string, epoch-ms and Date timestamps)
    const pre = '2026-09-13T04:04:00Z'
    expect(instantExitUsd({ instant_usd: null, observed_at: pre, params: { depth_usd: 0 } })).toBeNull()
    expect(instantExitUsd({ instant_usd: null, observed_at: Date.parse(pre), params: { depth_usd: 0 } })).toBeNull()
    expect(instantExitUsd({ instant_usd: null, observed_at: new Date(pre), params: { depth_usd: 0 } })).toBeNull()
  })

  it('evalHeadroom records which capacity it judged', async () => {
    const { evalHeadroom } = await import('../../scripts/lib/alarmRules.mjs')
    expect(evalHeadroom(140, 100, 'depth_usd').evidence).toEqual({ instantUsd: 140, worstDayOutflowUsd: 100, windowDays: 90, ratio: 1.4, totalRatio: 1.4, source: 'depth_usd' })
    expect(evalHeadroom(140, 100).evidence).toEqual({ instantUsd: 140, worstDayOutflowUsd: 100, windowDays: 90, ratio: 1.4, totalRatio: 1.4 })
  })

  it('coverage: a venue with recorded depth is no longer headroom-blind; one with neither still is', async () => {
    const { coverageFor, instantExitUsd } = await import('../../scripts/lib/alarmRules.mjs')
    const at = '2026-09-26T00:00:00Z'
    const withDepth = coverageFor({}, { hasInstant: instantExitUsd({ instant_usd: null, at, params: { depth_usd: 1e6 } }) !== null })
    const neither = coverageFor({}, { hasInstant: instantExitUsd({ instant_usd: null, at, params: {} }) !== null })
    expect(withDepth.map((u: { id: string }) => u.id)).not.toContain('headroom_instant_liquidity')
    expect(neither.map((u: { id: string }) => u.id)).toContain('headroom_instant_liquidity')
  })
})

describe('ALARM_THRESHOLDS — the one home of every alarm number', () => {
  it('holds the shipped values and is frozen', async () => {
    const { ALARM_THRESHOLDS } = await import('../../scripts/lib/alarmRules.mjs')
    expect(ALARM_THRESHOLDS).toEqual({
      gate_change: { windowHours: 24 },
      drawdown_fast: { windowDays: 7, alarmFallPct: 20 },
      net_outflow_streak: { watchDays: 10, alarmDays: 20, minPctOfTvl: 10 },
      headroom_thin: { watch: 3, alarm: 1.5, windowDays: 90, poolMaxSeverity: 'watch', poolCostPct: 1 },
      utilization: { watchPct: 90, alarmPct: 95 },
      depth_skew: { watchPct: 80, alarmPct: 90 },
      depth_collapse: { windowDays: 7, watchFallPct: 35, alarmFallPct: 50 },
    })
    expect(Object.isFrozen(ALARM_THRESHOLDS)).toBe(true)
    for (const v of Object.values(ALARM_THRESHOLDS)) expect(Object.isFrozen(v)).toBe(true)
  })

  it('no eval* rule compares against a bare numeric threshold', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(process.cwd(), 'scripts/lib/alarmRules.mjs'), 'utf8')
    // comparisons of a ratio/fraction/streak/value to a literal (the old shape: `ratio < 1.5`, `v > 95`)
    const code = src.replace(/\/\/.*$/gm, '')
    const bare = code.match(/\b(?:ratio|fallFrac|pctOfTvl|streak|v)\s*[<>]=?\s*\d/g) ?? []
    expect(bare).toEqual([])
  })
})

describe('headroom_thin: pool capacity stays at watch (owner ruling 2026-09-26)', () => {
  it('a swap pool backed by the vault redemption stays at watch; a real instant read, or a pool with nothing behind it, alarms', async () => {
    const { evalHeadroom, ALARM_THRESHOLDS } = await import('../../scripts/lib/alarmRules.mjs')
    const deep = ALARM_THRESHOLDS.headroom_thin.alarm / 2 // well under the alarm multiple
    expect(evalHeadroom(deep, 1, 'depth_usd', { usd: 100, delaySec: 86400 }).severity).toBe(ALARM_THRESHOLDS.headroom_thin.poolMaxSeverity)
    expect(evalHeadroom(deep, 1, 'depth_usd').severity).toBe('alarm')
    expect(evalHeadroom(deep, 1, 'instant_usd').severity).toBe('alarm')
    expect(evalHeadroom(deep, 1).severity).toBe('alarm')
    expect(ALARM_THRESHOLDS.headroom_thin.windowDays).toBeGreaterThan(0)
  })
})

describe('headroom_thin counts the vault redemption as capacity (owner 2026-09-26)', () => {
  it('instant redemption joins the fast exit; a cooldown redemption only the total', async () => {
    const { evalHeadroom, redemptionCapacity } = await import('../../scripts/lib/alarmRules.mjs')
    // sUSDS-like: pool 1, instant redemption 100, worst day 10 -> fast 101/10, quiet
    expect(evalHeadroom(1, 10, 'depth_usd', { usd: 100, delaySec: 0 }).fires).toBe(false)
    // sUSDe-like: pool 49, 1-day cooldown redemption 1311, worst day 70 -> fast 0.7x (alarm band) capped to watch, total ~19.4x
    const e = evalHeadroom(49, 70, 'depth_usd', { usd: 1311, delaySec: 86400 })
    expect(e.severity).toBe('watch')
    expect(e.evidence.redemptionDelaySec).toBe(86400)
    expect(e.evidence.totalRatio).toBeCloseTo((49 + 1311) / 70, 6)
    // even the total cannot cover -> alarm regardless of pool source
    expect(evalHeadroom(1, 100, 'depth_usd', { usd: 10, delaySec: 86400 }).severity).toBe('alarm')
    expect(redemptionCapacity({ params: { totalAssets: '2000000000000000000', vaultDecimals: 18, cooldownDuration: 86400 } })).toEqual({ usd: 2, delaySec: 86400 })
    expect(redemptionCapacity({ params: { totalAssets: '2000000000000000000', vaultDecimals: 18 } })).toEqual({ usd: 2, delaySec: 0 })
    expect(redemptionCapacity({ params: { underlyingBalance: '1' } })).toBeNull()
  })
})
