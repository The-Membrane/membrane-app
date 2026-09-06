// check-venue-alarms.mjs — the VENUE FAILURE-PATTERN ALARM checker.
//
// Owner directive: "whenever data we pull starts to look similar to how failed
// past venues did, we need to flag, and notify." This evaluates the recorder
// corpus (venue_snapshots, venue_flows, venue_events) against the failure genres
// catalogued in docs/research/worst-carry-venues.md (§2 ranked pattern). It reads
// EXISTING DB DATA ONLY — no chain reads — so it is cheap, appended to the hourly
// recorder tick AFTER the refresh line, and non-fatal.
//
//   node scripts/check-venue-alarms.mjs        (from the membrane-app root)
//
// Rules (pure, in scripts/lib/alarmRules.mjs; tested in tests/unit/alarms.test.ts):
//   gate_change        (alarm)              — memo P2, "the gate moves"
//   drawdown_fast      (alarm)              — stETH/Angle drain genre
//   net_outflow_streak (watch 10d/alarm 20d)— Stream/sUSDe bleed genre
//   headroom_thin      (watch <3x/alarm <1.5x)— "one bad day from gating"
//
// Dedupe-while-open: at most one OPEN row per (venue, kind); when a condition
// stops holding its open row is CLEARED. New alarms are delivered via
// scripts/lib/notify.mjs (telegram if configured, else local log + macOS
// notification) and marked notified only after a channel succeeds.
//
// CRITICAL HONESTY: the checker also prints a per-venue `uncovered` list — the
// memo signals it CANNOT evaluate yet — so a quiet run never reads as all-clear.
//
// Env: DATABASE_URL(_UNPOOLED) from .env.local (hand-parsed; no Next injection).

import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'
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
} from './lib/alarmRules.mjs'
import { notify } from './lib/notify.mjs'

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)
const SCALE = 1e18 // all four venue underlyings are 18-dec stables, valued at $1

// Resolve a snapshot row to the primary metric the drawdown rule tracks:
// instant_usd where the venue has it (already USD), else totalAssets in USD.
function metricPoint(row, metric) {
  if (metric === 'instant_usd') {
    return row.instant_usd === null || row.instant_usd === undefined ? null : Number(row.instant_usd)
  }
  const ta = row.params?.totalAssets
  return ta === undefined || ta === null ? null : Number(ta) / SCALE
}

const nowMs = Date.now()
const firing = [] // {venue, kind, severity, evidence}
const uncoveredByVenue = {} // venue -> [{id,label,memo}]

for (const venue of loadConfig().filter((v) => v.enabled)) {
  const v = venue.name
  console.log(`\n[${v}] ${venue.kind}`)

  // Latest observed snapshot: decides hasInstant + current TVL.
  const [latest] = await sql`
    SELECT instant_usd, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed'
    ORDER BY observed_at DESC LIMIT 1`
  const hasInstant = !!latest && latest.instant_usd !== null && latest.instant_usd !== undefined
  const currentTvlUsd = latest
    ? hasInstant
      ? Number(latest.instant_usd)
      : latest.params?.totalAssets !== undefined && latest.params?.totalAssets !== null
        ? Number(latest.params.totalAssets) / SCALE
        : 0
    : 0

  // --- gate_change: gate-moving events in the last 24h ---------------------
  const gateEvents = await sql`
    SELECT kind, observed_at AS at, prev, next, note FROM venue_events
    WHERE venue = ${v}
      AND kind IN ('cooldown_duration_changed', 'instant_liquidity_shift', 'terms_page_changed')
      AND observed_at > now() - interval '24 hours'
    ORDER BY observed_at DESC`
  const gate = evalGateChange(
    gateEvents.map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString(), prev: e.prev, next: e.next, note: e.note })),
    nowMs,
  )
  if (gate.fires) {
    firing.push({ venue: v, kind: 'gate_change', severity: gate.severity, evidence: gate.evidence })
    console.log(`  FIRE gate_change (${gate.severity}) — ${gate.evidence.count} event(s) in 24h`)
  }

  // --- drawdown_fast: peak-to-current fall > 20% over trailing 7d ----------
  const metric = hasInstant ? 'instant_usd' : 'total_assets'
  const snaps = await sql`
    SELECT observed_at AS at, instant_usd, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed' AND observed_at > now() - interval '7 days'
    ORDER BY observed_at ASC`
  const series = snaps
    .map((r) => ({ at: new Date(r.at).toISOString(), value: metricPoint(r, metric) }))
    .filter((p) => p.value !== null)
  const draw = evalDrawdown(series, metric)
  if (draw.fires) {
    firing.push({ venue: v, kind: 'drawdown_fast', severity: draw.severity, evidence: draw.evidence })
    console.log(`  FIRE drawdown_fast (${draw.severity}) — ${metric} ${draw.evidence.dropPct.toFixed(1)}% (${series.length} obs)`)
  }

  // --- net_outflow_streak: consecutive negative-net days vs TVL ------------
  const dailyRows = await sql`
    SELECT to_char(date_trunc('day', block_time), 'YYYY-MM-DD') AS day,
           SUM(CASE WHEN direction = 'in' THEN assets_raw ELSE -assets_raw END) AS net_raw
    FROM venue_flows WHERE venue = ${v}
    GROUP BY 1 ORDER BY 1 ASC`
  const dailyNets = dailyRows.map((r) => ({ day: r.day, net: Number(r.net_raw) / SCALE }))
  const streak = evalOutflowStreak(dailyNets, currentTvlUsd)
  if (streak.fires) {
    firing.push({ venue: v, kind: 'net_outflow_streak', severity: streak.severity, evidence: streak.evidence })
    console.log(
      `  FIRE net_outflow_streak (${streak.severity}) — ${streak.evidence.streakDays}d, $${streak.evidence.cumulativeOutflowUsd.toLocaleString()} = ${streak.evidence.pctOfTvl.toFixed(1)}% of TVL`,
    )
  }

  // --- headroom_thin: instant liquidity vs worst 1-day outflow -------------
  if (hasInstant) {
    const [worst] = await sql`
      SELECT MAX(day_out) AS worst_out FROM (
        SELECT date_trunc('day', block_time) AS d,
               SUM(CASE WHEN direction = 'out' THEN assets_raw ELSE 0 END) AS day_out
        FROM venue_flows WHERE venue = ${v} GROUP BY 1
      ) t`
    const worstDayOutflowUsd = worst && worst.worst_out !== null ? Number(worst.worst_out) / SCALE : 0
    const hr = evalHeadroom(Number(latest.instant_usd), worstDayOutflowUsd)
    if (hr.fires) {
      firing.push({ venue: v, kind: 'headroom_thin', severity: hr.severity, evidence: hr.evidence })
      console.log(`  FIRE headroom_thin (${hr.severity}) — ${hr.evidence.ratio.toFixed(2)}x`)
    }
  }

  // --- utilization: lending reserve utilization (Fraxlend/Morpho genre) -----
  // Uses the latest snapshot's recorded params.utilization_pct (venues with a
  // configured variableDebtToken; null-safe for the others).
  const util = evalUtilization(latest?.params?.utilization_pct)
  if (util.fires) {
    firing.push({ venue: v, kind: 'utilization', severity: util.severity, evidence: util.evidence })
    console.log(`  FIRE utilization (${util.severity}) — ${util.evidence.utilizationPct.toFixed(1)}% utilized`)
  }

  // --- depth_skew: pool one-sidedness of the instant-exit tier (memo P4) ----
  // Uses the latest snapshot's recorded depth_skew_pct (worst enabled market).
  const depthSkew = evalDepthSkew(latest?.params?.depth_skew_pct)
  if (depthSkew.fires) {
    firing.push({ venue: v, kind: 'depth_skew', severity: depthSkew.severity, evidence: depthSkew.evidence })
    console.log(`  FIRE depth_skew (${depthSkew.severity}) — ${depthSkew.evidence.skewPct.toFixed(1)}% one-sided`)
  }

  // --- depth_collapse: exitable depth (depth_usd) falling >35%/>50% over 7d --
  const depthSnaps = await sql`
    SELECT observed_at AS at, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed' AND observed_at > now() - interval '7 days'
    ORDER BY observed_at ASC`
  const depthSeries = depthSnaps
    .map((r) => ({ at: new Date(r.at).toISOString(), value: r.params?.depth_usd }))
    .filter((p) => p.value !== undefined && p.value !== null)
  const depthCollapse = evalDepthCollapse(depthSeries)
  if (depthCollapse.fires) {
    firing.push({ venue: v, kind: 'depth_collapse', severity: depthCollapse.severity, evidence: depthCollapse.evidence })
    console.log(`  FIRE depth_collapse (${depthCollapse.severity}) — depth_usd ${depthCollapse.evidence.dropPct.toFixed(1)}% (${depthSeries.length} obs)`)
  }

  // --- coverage honesty: what this venue is BLIND to -----------------------
  // depth_vs_book leaves the uncovered list only when the venue has >=1 enabled,
  // on-chain-verified depth market OR its instant_usd read IS the depth (aave).
  const depthCovered =
    (venue.depthMarkets ?? []).some((m) => m.enabled) || venue.depthCoveredByInstant === true
  // terms_page_changes leaves the blind list once the venue has a termsUrl the
  // hash watcher tracks (baseline seeded on the first tick before this checker).
  const termsCovered = !!venue.termsUrl
  const uncovered = uncoveredFor({ hasInstant, depthCovered, termsCovered })
  uncoveredByVenue[v] = uncovered
  console.log(`  uncovered (cannot evaluate): ${uncovered.map((u) => u.id).join(', ')}`)
}

// --- reconcile against currently-open alarms (dedupe-while-open + clear) ----
const open = await sql`SELECT id, venue, kind FROM venue_alarms WHERE cleared_at IS NULL`
const { toInsert, toClear } = reconcileAlarms(firing, open)

const inserted = []
for (const f of toInsert) {
  const [row] = await sql`
    INSERT INTO venue_alarms (venue, kind, severity, evidence)
    VALUES (${f.venue}, ${f.kind}, ${f.severity}, ${JSON.stringify(f.evidence)}::jsonb)
    ON CONFLICT (venue, kind) WHERE cleared_at IS NULL DO NOTHING
    RETURNING id, venue, kind, severity, evidence`
  if (row) inserted.push(row)
}

let cleared = 0
for (const o of toClear) {
  const res = await sql`
    UPDATE venue_alarms SET cleared_at = now()
    WHERE id = ${o.id} AND cleared_at IS NULL RETURNING id`
  if (res.length > 0) {
    cleared++
    console.log(`  CLEARED ${o.venue}/${o.kind} — condition no longer holds`)
  }
}

// --- notify newly-opened alarms; mark notified only after a channel wins ----
if (inserted.length > 0) {
  const { ok, channels } = await notify(inserted)
  if (ok) {
    for (const row of inserted) {
      await sql`UPDATE venue_alarms SET notified = true WHERE id = ${row.id} AND notified = false`
    }
    console.log(`\nnotified ${inserted.length} new alarm(s) via: ${channels.join(', ')}`)
  } else {
    console.log(`\nWARNING: ${inserted.length} new alarm(s) opened but NO channel delivered — left notified=false for retry`)
  }
} else {
  console.log('\nno new alarms to notify')
}

// --- honest summary --------------------------------------------------------
console.log('\n=== alarm check summary ===')
console.log(`firing now: ${firing.length}  ·  newly opened: ${inserted.length}  ·  cleared: ${cleared}`)
for (const f of firing) console.log(`  ${f.severity.toUpperCase()} ${f.venue}/${f.kind}`)
console.log('\nUNCOVERED signals (reported, never silent — silence is NOT all-clear):')
for (const [v, list] of Object.entries(uncoveredByVenue)) {
  console.log(`  ${v}: ${list.map((u) => `${u.id} (${u.memo})`).join('; ')}`)
}
console.log('\nalarm check complete')
