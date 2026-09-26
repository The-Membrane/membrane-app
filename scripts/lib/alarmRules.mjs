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

const HOUR_MS = 3_600_000

// --- thresholds: the ONE place every alarm number lives ---------------------
// Every eval* rule below reads its numbers from here, and the glossary
// (components/Glossary/terms.ts) builds its definitions from here, so the words
// a user reads can never drift from the numbers that fire. Percentages are
// stored as percents (20 = 20%) and divided by 100 at the comparison; x/100 is
// the same double as the old 0.x literal, so behaviour is byte-identical.
// Windows are also read by scripts/check-venue-alarms.mjs for its SQL.
export const ALARM_THRESHOLDS = Object.freeze({
  // any gate-moving event in the trailing window
  gate_change: Object.freeze({ windowHours: 24 }),
  // peak-to-current fall STRICTLY above alarmFallPct over the trailing window
  drawdown_fast: Object.freeze({ windowDays: 7, alarmFallPct: 20 }),
  // consecutive net-outflow days; cumulative outflow must be STRICTLY above minPctOfTvl
  net_outflow_streak: Object.freeze({ watchDays: 10, alarmDays: 20, minPctOfTvl: 10 }),
  // instant exit capacity / worst recorded day out, STRICTLY below the multiple
  headroom_thin: Object.freeze({ watch: 3, alarm: 1.5, windowDays: 90, poolMaxSeverity: 'watch' }),
  // lending-reserve utilization STRICTLY above
  utilization: Object.freeze({ watchPct: 90, alarmPct: 95 }),
  // exit-pool one-sidedness STRICTLY above
  depth_skew: Object.freeze({ watchPct: 80, alarmPct: 90 }),
  // exitable-depth peak-to-current fall STRICTLY above, over the trailing window
  depth_collapse: Object.freeze({ windowDays: 7, watchFallPct: 35, alarmFallPct: 50 }),
})

// --- read-value guards -----------------------------------------------------
// A missing reading is null/undefined and must be DROPPED, never coerced:
// Number(null) is 0 and would read as a collapse to zero.
export function isReadValue(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))
}

// Before the depth reader stored null on a failed read (readDepthMarkets'
// `complete` guard, first live snapshot 2026-09-25T04:29:56Z), a failed read was
// stored as depth_usd = 0. All four pre-guard zero rows (2026-09-06 sUSDS,
// 2026-09-13 sUSDe/sUSDS/scrvUSD) recorded every reserve read as failed, so a
// pre-guard zero is an UNREAD, not a drain. After the guard a zero can only come
// from successful reads of an empty pool, and it counts. Mirrored in TS as
// components/Radar/alertLogic.ts DEPTH_GUARD_LIVE -- keep in lockstep.
export const DEPTH_GUARD_LIVE = '2026-09-25T04:29:56Z'
export function isUnreadDepthZero(value, at) {
  if (value === null || value === undefined || Number(value) !== 0) return false
  const t = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(t) && t < Date.parse(DEPTH_GUARD_LIVE)
}

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
  const since = nowMs - ALARM_THRESHOLDS.gate_change.windowHours * HOUR_MS
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
  const pts = (series ?? []).filter((p) => isReadValue(p.value))
  if (pts.length < 2) return { fires: false, severity: null, evidence: null }
  let peak = pts[0]
  for (const p of pts) if (Number(p.value) > Number(peak.value)) peak = p
  const current = pts[pts.length - 1]
  const peakV = Number(peak.value)
  const curV = Number(current.value)
  if (peakV <= 0) return { fires: false, severity: null, evidence: null }
  const fallFrac = (peakV - curV) / peakV
  if (!(fallFrac > ALARM_THRESHOLDS.drawdown_fast.alarmFallPct / 100)) return { fires: false, severity: null, evidence: null }
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
  const T = ALARM_THRESHOLDS.net_outflow_streak
  const cumConditionMet = pctOfTvl > T.minPctOfTvl / 100
  let severity = null
  if (streak >= T.alarmDays && cumConditionMet) severity = 'alarm'
  else if (streak >= T.watchDays && cumConditionMet) severity = 'watch'
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
// "One bad day from gating." Current instant exit capacity vs the venue's WORST
// recorded single-day outflow. The capacity is instantExitUsd(latest snapshot):
// instant_usd where the venue reads it, else the recorded instant swap-out depth
// (params.depth_usd). `source` ('instant_usd' | 'depth_usd'), when given, is
// recorded in the evidence so the alarm sentence names which capacity it used.
// Venues with neither read cannot be judged — that gap is reported via
// uncoveredFor.
export function evalHeadroom(instantUsd, worstDayOutflowUsd, source, redemption = null) {
  if (instantUsd === null || instantUsd === undefined) {
    return { fires: false, severity: null, evidence: null }
  }
  const inst = Number(instantUsd)
  const worst = Number(worstDayOutflowUsd)
  if (!Number.isFinite(inst) || !Number.isFinite(worst) || worst <= 0) {
    return { fires: false, severity: null, evidence: null }
  }
  // Owner ruling 2026-09-26: the venue's own redemption IS exit capacity, even
  // when it is delayed. A redemption with no cooldown adds to the fast exit; a
  // cooldown redemption counts only toward the total. The alarm judges the fast
  // exit, and escalates to 'alarm' whenever even the total cannot cover the day.
  const red = redemption && Number.isFinite(Number(redemption.usd)) && Number(redemption.usd) > 0 ? redemption : null
  const redUsd = red ? Number(red.usd) : 0
  const redDelay = red ? Number(red.delaySec) || 0 : 0
  const fast = inst + (red && redDelay === 0 ? redUsd : 0)
  const total = inst + redUsd
  const ratio = fast / worst
  const totalRatio = total / worst
  let severity = null
  if (ratio < ALARM_THRESHOLDS.headroom_thin.alarm) severity = 'alarm'
  else if (ratio < ALARM_THRESHOLDS.headroom_thin.watch) severity = 'watch'
  if (!severity) return { fires: false, severity: null, evidence: null }
  // A swap pool is not the venue's own exit, so pool-only headroom is capped at
  // poolMaxSeverity ('watch') — unless the total (pool + redemption) cannot
  // cover the worst day either.
  const poolOnly = source === 'depth_usd' && !(red && redDelay === 0)
  if (poolOnly && severity === 'alarm' && totalRatio >= ALARM_THRESHOLDS.headroom_thin.alarm) {
    severity = ALARM_THRESHOLDS.headroom_thin.poolMaxSeverity
  }
  const evidence = { instantUsd: fast, worstDayOutflowUsd: worst, windowDays: ALARM_THRESHOLDS.headroom_thin.windowDays, ratio, totalRatio }
  if (source) evidence.source = source
  if (red) {
    evidence.redemptionUsd = redUsd
    evidence.redemptionDelaySec = redDelay
  }
  return { fires: true, severity, evidence }
}

// The venue's OWN redemption capacity from ONE snapshot row: an ERC-4626 vault
// can always redeem its totalAssets (counted at face value), after
// params.cooldownDuration seconds (0 or absent = instant). null for venues with
// no vault redemption (a lending market's exit is its instant liquidity).
export function redemptionCapacity(snapshot) {
  const p = snapshot?.params ?? {}
  const raw = p.totalAssets
  const dec = Number(p.vaultDecimals)
  if (raw === undefined || raw === null || !Number.isFinite(dec)) return null
  const usd = Number(raw) / 10 ** dec
  if (!Number.isFinite(usd) || usd <= 0) return null
  const delaySec = Number(p.cooldownDuration ?? 0)
  return { usd, delaySec: Number.isFinite(delaySec) && delaySec > 0 ? delaySec : 0 }
}

// The instant exit capacity of ONE snapshot row ({ instant_usd, params,
// observed_at|at }), for headroom and for coverage. instant_usd where the venue
// reads it; else the recorded instant swap-out depth params.depth_usd (the
// exitable side of its verified depth markets / PSM buffer) when it is a finite
// read, the reader did not flag it incomplete (params.depth_complete === false),
// and it is not a pre-guard unread zero (isUnreadDepthZero). Otherwise null —
// a missing read is never 0.
export function instantExitUsd(snapshot) {
  if (!snapshot) return null
  if (isReadValue(snapshot.instant_usd)) {
    return { usd: Number(snapshot.instant_usd), source: 'instant_usd' }
  }
  const p = snapshot.params ?? {}
  const at = snapshot.observed_at ?? snapshot.at
  if (
    isReadValue(p.depth_usd) &&
    p.depth_complete !== false &&
    !isUnreadDepthZero(p.depth_usd, at instanceof Date ? at.getTime() : at)
  ) {
    return { usd: Number(p.depth_usd), source: 'depth_usd' }
  }
  return null
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
  if (v > ALARM_THRESHOLDS.utilization.alarmPct) severity = 'alarm'
  else if (v > ALARM_THRESHOLDS.utilization.watchPct) severity = 'watch'
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
  if (v > ALARM_THRESHOLDS.depth_skew.alarmPct) severity = 'alarm'
  else if (v > ALARM_THRESHOLDS.depth_skew.watchPct) severity = 'watch'
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
  const pts = (series ?? []).filter((p) => isReadValue(p.value) && !isUnreadDepthZero(p.value, p.at))
  if (pts.length < 2) return { fires: false, severity: null, evidence: null }
  let peak = pts[0]
  for (const p of pts) if (Number(p.value) > Number(peak.value)) peak = p
  const current = pts[pts.length - 1]
  const peakV = Number(peak.value)
  const curV = Number(current.value)
  if (peakV <= 0) return { fires: false, severity: null, evidence: null }
  const fallFrac = (peakV - curV) / peakV
  let severity = null
  if (fallFrac > ALARM_THRESHOLDS.depth_collapse.alarmFallPct / 100) severity = 'alarm'
  else if (fallFrac > ALARM_THRESHOLDS.depth_collapse.watchFallPct / 100) severity = 'watch'
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
  { id: 'terms_page_changes', label: 'terms changes', memo: 'needs the terms-page hash watcher' },
]

// Yield flatness (memo P7) is deliberately NOT listed: owner 2026-09-26 — it is
// not an exit-risk signal we would ever alert a borrower on.

// Blind when a venue records neither instant_usd nor a usable depth_usd
// (instantExitUsd(latest) === null).
export const HEADROOM_BLIND_SIGNAL = Object.freeze({
  id: 'headroom_instant_liquidity',
  label: 'instant-exit headroom',
  memo: 'no instant_usd or instant swap-out depth (depth_usd) read for this venue',
})

// Per-venue uncovered list: the always-blind memo signals, plus instant-exit
// headroom for venues with no instant exit capacity read (hasInstant false).
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
  if (!hasInstant) list.push({ ...HEADROOM_BLIND_SIGNAL })
  return list
}

// ONE place that turns a venue's config + latest snapshot into its blind-spot
// list. Every surface (checker, /api/venues/alarms, /api/venues/[venue]/summary,
// the venue log, per-address alerts) calls THIS -- there are no copies to drift.
//   cfg        -- the venue's tools/venue-recorder.config.json entry
//   hasInstant -- instantExitUsd(latest observed snapshot) !== null: an
//                 instant_usd read, or a usable instant swap-out depth
export function coverageFor(cfg, { hasInstant } = {}) {
  const depthCovered =
    (cfg?.depthMarkets ?? []).some((m) => m.enabled) || cfg?.depthCoveredByInstant === true
  const termsCovered = !!cfg?.termsUrl
  return uncoveredFor({ hasInstant: !!hasInstant, depthCovered, termsCovered })
}

// One footer line from { venue: signals[] }. A signal blind at EVERY listed venue
// is named once; a signal blind at some venues names them. Empty input or no
// blind spots still says so explicitly -- the footer is never silently absent.
export function uncoveredFooter(byVenue) {
  const venues = Object.keys(byVenue ?? {}).sort()
  if (venues.length === 0) return 'blind spots unknown: no venue coverage recorded'
  const where = new Map() // label -> venues blind to it
  for (const v of venues) {
    for (const s of byVenue[v] ?? []) {
      if (!where.has(s.label)) where.set(s.label, [])
      where.get(s.label).push(v)
    }
  }
  if (where.size === 0) return 'this alarm can see every signal it tracks at these venues'
  const parts = [...where.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, vs]) => (vs.length === venues.length ? label : `${label} (${vs.join(', ')})`))
  return `this alarm cannot yet see: ${parts.join(', ')}`
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
