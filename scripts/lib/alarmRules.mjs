// alarmRules.mjs — the VENUE FAILURE-PATTERN ALARM rules, as PURE functions.
//
// The pattern library is docs/research/worst-carry-venues.md (§2 ranked pattern,
// §3 signal table). Each rule below matches ONE genre of past carry failure to a
// signal we can compute FROM THE RECORDER CORPUS ALONE (venue_snapshots,
// venue_flows, venue_events) — no new chain reads. All I/O (DB reads, the 24h /
// 7d windowing SQL) lives in scripts/check-venue-alarms.mjs; this module is
// pure so tests/unit/alarms.test.ts exercises the same code that runs in prod
// (same discipline as scripts/lib/newsParse.mjs).
//
// A "fire" result is { fires, severity: 'watch'|'alarm'|null, evidence }.
// evidence is the numbers that fired it (or null when it did not fire).
//
// CRITICAL HONESTY: silence is NOT all-clear. The signals we CANNOT yet see are
// enumerated in UNCOVERED_SIGNALS / uncoveredFor() and surfaced verbatim by the
// checker and the API so nobody reads a quiet dashboard as a safe venue.

const DAY_MS = 86_400_000

// --- rule: gate_change (alarm) --------------------------------------------
// Memo P2 ("the gate moves, or was never there"). Ethena's 7d→1d cooldown cut
// (recorder dated it 2026-03-18) is the canonical hit. Any cooldown change or
// >20% instant-liquidity shift the recorder witnessed in the last 24h fires.
//
// `events`: [{ kind, at }] (at = ISO string or epoch ms). Only the two
// gate-moving kinds count; the 24h window is applied here so the boundary is
// tested against the pure fn, not the SQL.
// terms_page_changed is ALARM-GRADE: a redemption/terms page edit is a
// gate-moving act in the same genre as a cooldown change (memo P2 — "the gate
// moves, or was never there"), so it rides the gate_change rule. The recorder
// seeds terms baselines silently (no event on first hash); only a SUBSEQUENT
// hash change emits terms_page_changed, and that is what fires here.
export const GATE_KINDS = new Set(['cooldown_duration_changed', 'instant_liquidity_shift', 'terms_page_changed'])

export function evalGateChange(events, nowMs = Date.now()) {
  const since = nowMs - DAY_MS
  const hits = (events ?? [])
    .filter((e) => GATE_KINDS.has(e.kind))
    .filter((e) => {
      const t = typeof e.at === 'number' ? e.at : Date.parse(e.at)
      return Number.isFinite(t) && t >= since
    })
  if (hits.length === 0) return { fires: false, severity: null, evidence: null }
  // newest first for the evidence "latest"
  const sorted = [...hits].sort((a, b) => tOf(b.at) - tOf(a.at))
  return {
    fires: true,
    severity: 'alarm',
    evidence: { count: hits.length, latest: sorted[0], events: sorted },
  }
}

// --- rule: drawdown_fast (alarm) ------------------------------------------
// stETH/Angle drain genre: the carried book's capacity fell fast. Peak-to-
// current drawdown of the primary metric over the trailing 7d of observed
// snapshots. `series`: [{ at, value }] ascending, ALREADY the metric the checker
// chose (instant_usd where the venue has it, else totalAssets in USD). Fires when
// the fall from the in-window peak to the latest reading is STRICTLY > 20%.
export function evalDrawdown(series, metric = 'value') {
  const pts = (series ?? []).filter((p) => Number.isFinite(Number(p.value)))
  if (pts.length < 2) return { fires: false, severity: null, evidence: null }
  let peak = pts[0]
  for (const p of pts) if (Number(p.value) > Number(peak.value)) peak = p
  const current = pts[pts.length - 1]
  const peakV = Number(peak.value)
  const curV = Number(current.value)
  if (peakV <= 0) return { fires: false, severity: null, evidence: null }
  const fallFrac = (peakV - curV) / peakV
  if (!(fallFrac > 0.2)) return { fires: false, severity: null, evidence: null }
  return {
    fires: true,
    severity: 'alarm',
    evidence: {
      metric,
      fromValue: peakV,
      fromDate: peak.at,
      toValue: curV,
      toDate: current.at,
      dropPct: -fallFrac * 100,
    },
  }
}

// --- rule: net_outflow_streak (watch @10d, alarm @20d) --------------------
// Stream/sUSDe bleed genre: consecutive days of net outflow whose cumulative
// magnitude has eaten a meaningful slice of the book. `dailyNets`:
// [{ day: 'YYYY-MM-DD', net }] (net = in − out in USD; may be sparse — missing
// calendar days count as net 0 and BREAK the streak). Anchored at the newest day
// present, walking backward. Fires only if BOTH the day count AND the
// cumulative-outflow-vs-TVL condition hold.
export function evalOutflowStreak(dailyNets, tvlUsd) {
  const rows = (dailyNets ?? []).filter((d) => d && typeof d.day === 'string')
  if (rows.length === 0) return { fires: false, severity: null, streakDays: 0, cumulativeOutflowUsd: 0, evidence: null }
  const byDay = new Map(rows.map((d) => [d.day, Number(d.net)]))
  const days = rows.map((d) => d.day).sort()
  let cursor = days[days.length - 1]
  let streak = 0
  let cum = 0
  // Walk backward one CALENDAR day at a time. A gap (day absent from the map)
  // resolves to net 0, which is not < 0, so it correctly breaks the streak.
  while (true) {
    const net = byDay.has(cursor) ? byDay.get(cursor) : 0
    if (Number.isFinite(net) && net < 0) {
      streak += 1
      cum += -net
      cursor = prevDay(cursor)
    } else break
  }
  const tvl = Number(tvlUsd)
  const pctOfTvl = tvl > 0 ? cum / tvl : 0
  const cumConditionMet = pctOfTvl > 0.1
  let severity = null
  if (streak >= 20 && cumConditionMet) severity = 'alarm'
  else if (streak >= 10 && cumConditionMet) severity = 'watch'
  // streakDays / cumulativeOutflowUsd are ALWAYS returned (observable even when
  // the rule does not fire, so streak accounting is testable); evidence is
  // populated only when it fires.
  const base = { streakDays: streak, cumulativeOutflowUsd: cum }
  if (!severity) return { fires: false, severity: null, ...base, evidence: null }
  return {
    fires: true,
    severity,
    ...base,
    evidence: { streakDays: streak, cumulativeOutflowUsd: cum, tvlUsd: tvl, pctOfTvl: pctOfTvl * 100 },
  }
}

// --- rule: headroom_thin (watch <3x, alarm <1.5x) -------------------------
// "One bad day from gating." Current instant exit liquidity vs the venue's WORST
// recorded single-day outflow. Only venues that expose instant_usd can be judged
// here (the cooldown/4626 venues cannot — that gap is reported via uncoveredFor).
export function evalHeadroom(instantUsd, worstDayOutflowUsd) {
  if (instantUsd === null || instantUsd === undefined) {
    return { fires: false, severity: null, evidence: null }
  }
  const inst = Number(instantUsd)
  const worst = Number(worstDayOutflowUsd)
  if (!Number.isFinite(inst) || !Number.isFinite(worst) || worst <= 0) {
    return { fires: false, severity: null, evidence: null }
  }
  const ratio = inst / worst
  let severity = null
  if (ratio < 1.5) severity = 'alarm'
  else if (ratio < 3) severity = 'watch'
  if (!severity) return { fires: false, severity: null, evidence: null }
  return {
    fires: true,
    severity,
    evidence: { instantUsd: inst, worstDayOutflowUsd: worst, ratio },
  }
}

// --- rule: utilization (watch >90%, alarm >95%) ---------------------------
// Fraxlend/Morpho genre: a lending reserve at ~100% utilization means the
// available liquidity is lent out and LENDERS CANNOT EXIT even though the market
// is nominally solvent (CRV/Egorov near-miss: Fraxlend gated at ~100% util).
// `utilPct` is the recorded params.utilization_pct = debt/(debt+available)*100
// of the latest snapshot. Only venues that record utilization (the aToken
// reader with a configured variableDebtToken) can be judged here.
export function evalUtilization(utilPct) {
  const v = Number(utilPct)
  if (!Number.isFinite(v)) return { fires: false, severity: null, evidence: null }
  let severity = null
  if (v > 95) severity = 'alarm'
  else if (v > 90) severity = 'watch'
  if (!severity) return { fires: false, severity: null, evidence: null }
  return { fires: true, severity, evidence: { utilizationPct: v } }
}

// --- rule: depth_skew (watch >80%, alarm >90% one-sided) ------------------
// Memo P4 ("book size vs oracle-market depth mismatch") + the pool-composition
// skew genre (stETH's Curve pool drifting 50:50→78:22; MIM 96% one-sided). The
// venue's INSTANT-exit tier is a secondary-market pool; when that pool goes
// one-sided the tokens you can actually swap INTO are gone even though the
// stated $1 "capacity" is unchanged. `skewPct` is the pool's one-sidedness in
// [0,100] (100*maxSide/total), recorded per tick as params.depth_skew_pct.
// NOTE: our four venues also have PROTOCOL redemption (cooldown or instant), so
// skew is the INSTANT-tier warning, not a solvency claim — an 80% pool means the
// fast exit is thinning, not that the venue is insolvent.
export function evalDepthSkew(skewPct) {
  const v = Number(skewPct)
  if (!Number.isFinite(v)) return { fires: false, severity: null, evidence: null }
  let severity = null
  if (v > 90) severity = 'alarm'
  else if (v > 80) severity = 'watch'
  if (!severity) return { fires: false, severity: null, evidence: null }
  return { fires: true, severity, evidence: { skewPct: v } }
}

// --- rule: depth_collapse (watch >35%, alarm >50% drop over 7d) -----------
// Memo P4, the DETERIORATION edge: CRV's $27M on-chain depth vs a $168M book,
// stETH's Curve pool draining $4.6B→$621M. An absolute depth/book ratio would
// fire always and mean nothing here (protocol redemption is the real backstop),
// so the honest signal is the depth market COLLAPSING fast. `series` is
// [{ at, value }] ascending of the EXITABLE depth (params.depth_usd = the
// swap-INTO side's reserve) over the trailing 7d of observed snapshots. Fires on
// peak-to-current fall > 35% (watch) / > 50% (alarm).
export function evalDepthCollapse(series) {
  const pts = (series ?? []).filter((p) => Number.isFinite(Number(p.value)))
  if (pts.length < 2) return { fires: false, severity: null, evidence: null }
  let peak = pts[0]
  for (const p of pts) if (Number(p.value) > Number(peak.value)) peak = p
  const current = pts[pts.length - 1]
  const peakV = Number(peak.value)
  const curV = Number(current.value)
  if (peakV <= 0) return { fires: false, severity: null, evidence: null }
  const fallFrac = (peakV - curV) / peakV
  let severity = null
  if (fallFrac > 0.5) severity = 'alarm'
  else if (fallFrac > 0.35) severity = 'watch'
  if (!severity) return { fires: false, severity: null, evidence: null }
  return {
    fires: true,
    severity,
    evidence: {
      metric: 'depth_usd',
      fromValue: peakV,
      fromDate: peak.at,
      toValue: curV,
      toDate: current.at,
      dropPct: -fallFrac * 100,
    },
  }
}

// --- dedupe-while-open reconciliation (pure) ------------------------------
// Given the set of rules FIRING now and the set of alarms currently OPEN
// (cleared_at IS NULL), decide what to INSERT (a new firing with no open row)
// and what to CLEAR (an open row whose condition no longer holds). A firing that
// already has an open row is left untouched — that is the dedupe-while-open rule
// (and severity is never mutated on an open row; the only permitted UPDATEs are
// cleared_at and notified).
export function reconcileAlarms(firing, open) {
  const key = (x) => `${x.venue} ${x.kind}`
  const openKeys = new Set((open ?? []).map(key))
  const firingKeys = new Set((firing ?? []).map(key))
  const toInsert = (firing ?? []).filter((f) => !openKeys.has(key(f)))
  const toClear = (open ?? []).filter((o) => !firingKeys.has(key(o)))
  return { toInsert, toClear }
}

// --- coverage honesty ------------------------------------------------------
// Memo signals the alarm system CANNOT evaluate from the corpus as it stands.
// Surfaced (never as alarms) so a quiet board never reads as all-clear.
export const UNCOVERED_SIGNALS = [
  { id: 'depth_vs_book', label: 'depth-vs-book', memo: 'P4 — needs the oracle-market depth extension' },
  { id: 'yield_flatness', label: 'yield flatness', memo: 'P7 — we do not record APY' },
  { id: 'terms_page_changes', label: 'terms changes', memo: 'needs the terms-page hash watcher' },
]

// Per-venue uncovered list: the always-blind memo signals, plus instant-exit
// headroom for venues that expose no instant_usd read (the cooldown/4626 ones).
//
// `depthCovered` (true) drops 'depth_vs_book' from the blind list — the venue now
// has >=1 enabled, on-chain-verified depth market OR its instant_usd read already
// IS the depth (aave: covered-by-instant). A venue with NO verified depth market
// keeps depth_vs_book listed: silence there is still a blind spot, not all-clear.
// `termsCovered` (true) drops 'terms_page_changes' — the venue has a termsUrl
// the hash watcher (scripts/watch-venue-terms.mjs) tracks, so a redemption/terms
// edit now surfaces as a terms_page_changed event (alarm-grade via gate_change).
// A venue with NO termsUrl keeps terms_page_changes listed: still a blind spot.
export function uncoveredFor({ hasInstant, depthCovered, termsCovered } = {}) {
  let list = [...UNCOVERED_SIGNALS]
  if (depthCovered) list = list.filter((u) => u.id !== 'depth_vs_book')
  if (termsCovered) list = list.filter((u) => u.id !== 'terms_page_changes')
  if (!hasInstant) {
    list.push({
      id: 'headroom_instant_liquidity',
      label: 'instant-exit headroom',
      memo: 'no instant_usd read for this venue kind',
    })
  }
  return list
}

// --- helpers ---------------------------------------------------------------
function tOf(at) {
  return typeof at === 'number' ? at : Date.parse(at)
}

// Previous calendar day for a 'YYYY-MM-DD' string, in UTC.
function prevDay(isoDay) {
  const d = new Date(`${isoDay}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
