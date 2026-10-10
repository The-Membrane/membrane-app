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
//   terms_page_notice  (notice)             — page text changed; exit impact unclassified
//   drawdown_fast      (alarm)              — stETH/Angle drain genre
//   net_outflow_streak — suspended: venue_flows has no certified quiet ranges
//   headroom_thin      — suspended: historical worst outflow is incomplete
//
// Condition dedupe-while-open: at most one OPEN row per (venue, kind); when a condition
// stops holding its open row is CLEARED. Previously open alarms from suspended
// flow rules are also cleared because their evidence is not verifiable. New alarms are delivered via
// scripts/lib/notify.mjs (telegram if configured, else local log + macOS
// notification) and marked notified after configured Telegram succeeds, or
// after a local channel succeeds when Telegram is not configured. Open rows
// left notified=false after delivery failure are retried on the next check.
// Terms-page edits get separate notices keyed by immutable venue_events.id.
//
// CRITICAL HONESTY: the checker also prints a per-venue `uncovered` list — the
// memo signals it CANNOT evaluate yet — so a quiet run never reads as all-clear.
//
// Env: DATABASE_URL(_UNPOOLED) from .env.local (hand-parsed; no Next injection).

import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import { readEnv, loadConfig } from './lib/venue-reads.mjs'
import {
  evalGateChange,
  termsNoticeRows,
  termsNoticeExpired,
  isLegacyTermsOnlyGateAlarm,
  legacyTermsNoticeEvidence,
  evalDrawdown,
  evalUtilization,
  evalDepthSkew,
  evalDepthCollapse,
  reconcileAlarms,
  coverageFor,
  instantExitUsd,
  curveCapacityAtCost,
  ALARM_THRESHOLDS,
} from './lib/alarmRules.mjs'
import { notify } from './lib/notify.mjs'

// The app card can be kept current without delivering a notification.
// The guarded Mac recorder uses this mode; external delivery is opt-in via
// an explicit invocation without --record-only.
const recordOnly = process.argv.length === 3 && process.argv[2] === '--record-only'
if (process.argv.length !== 2 && !recordOnly) {
  console.error('Usage: node scripts/check-venue-alarms.mjs [--record-only]')
  process.exit(2)
}

const { get } = readEnv()
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)
const SCALE = 1e18 // all four venue underlyings are 18-dec stables, valued at $1
const UNCERTIFIED_FLOW_KINDS = new Set(['net_outflow_streak', 'headroom_thin'])
const FLOW_COVERAGE_DIAGNOSTICS = Object.freeze([
  {
    id: 'net_outflow_streak',
    label: 'net outflow streak',
    memo: 'suspended: venue_flows has event rows but no certified complete daily ranges, including quiet days',
  },
  {
    id: 'headroom_thin',
    label: 'exit headroom versus worst day outflow',
    memo: 'suspended: venue_flows has no certified complete historical window; observed daily max is not a maximum outflow',
  },
])

// Resolve a snapshot row to the primary metric the drawdown rule tracks:
// instant_usd where the venue has it (already USD), else totalAssets in USD.
function metricPoint(row, metric) {
  if (metric === 'instant_usd') {
    return row.instant_usd === null || row.instant_usd === undefined
      ? null
      : Number(row.instant_usd)
  }
  const ta = row.params?.totalAssets
  return ta === undefined || ta === null ? null : Number(ta) / SCALE
}

const nowMs = Date.now()
const firing = [] // condition alarms only
const termsFiring = [] // one notice per source event
const uncoveredByVenue = {} // venue -> [{id,label,memo}]
const [termsMigration] =
  await sql`SELECT boundary_at, status FROM venue_alarm_terms_migration WHERE singleton = true`
if (!termsMigration)
  throw new Error('terms notice migration boundary missing; apply venue recorder DDL first')
const termsBoundaryMs = new Date(termsMigration.boundary_at).getTime()

for (const venue of loadConfig().filter((v) => v.enabled)) {
  const v = venue.name
  console.log(`\n[${v}] ${venue.kind}`)

  // Latest observed snapshot: decides hasInstant (drawdown metric + TVL) and
  // the instant exit capacity (headroom + coverage).
  const [latest] = await sql`
    SELECT observed_at, instant_usd, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed'
    ORDER BY observed_at DESC LIMIT 1`
  const hasInstant = !!latest && latest.instant_usd !== null && latest.instant_usd !== undefined
  // Swap-out capacity within headroom_thin.poolCostPct cost, from the venue's
  // latest depth-curve pass (scripts/record-depth-curves.mjs; one row per
  // market, all at one block). A missing table/row leaves it null.
  let curveRows = []
  try {
    curveRows = await sql`
      SELECT market, points FROM venue_depth_curves
      WHERE venue = ${v}
        AND block = (SELECT MAX(block) FROM venue_depth_curves WHERE venue = ${v})`
  } catch {
    curveRows = []
  }
  const curveCap = curveCapacityAtCost(curveRows, ALARM_THRESHOLDS.headroom_thin.poolCostPct)
  // instant_usd, else the curve capacity within the cost cap, else the raw
  // swap-into reserve (source 'depth_usd_raw', labelled fallback); null when none.
  const exit = instantExitUsd(latest, curveCap)

  // --- gate and terms events: independent signals in the same window -------
  const gateEvents = await sql`
    SELECT id, kind, observed_at AS at, prev, next, note,
      observed_at > (SELECT boundary_at FROM venue_alarm_terms_migration WHERE singleton = true)
        AS terms_eligible
    FROM venue_events
    WHERE venue = ${v}
      AND kind IN ('cooldown_duration_changed', 'instant_liquidity_shift', 'terms_page_changed')
      AND observed_at > now() - make_interval(hours => ${Math.max(ALARM_THRESHOLDS.gate_change.windowHours, ALARM_THRESHOLDS.terms_page_notice.windowHours)})
    ORDER BY observed_at DESC`
  const events = gateEvents.map((e) => ({
    id: e.id,
    kind: e.kind,
    at: new Date(e.at).toISOString(),
    prev: e.prev,
    next: e.next,
    note: e.note,
    termsEligible: e.terms_eligible,
  }))
  const gate = evalGateChange(events, nowMs)
  if (gate.fires) {
    firing.push({ venue: v, kind: 'gate_change', severity: gate.severity, evidence: gate.evidence })
    console.log(
      `  FIRE gate_change (${gate.severity}) — ${gate.evidence.count} event(s) in ${ALARM_THRESHOLDS.gate_change.windowHours}h`,
    )
  }
  // Bind the exact configured URL captured in this source event. Current
  // config could point to a different page by the time the notice is issued.
  const terms = termsNoticeRows(
    events.filter((e) => e.termsEligible),
    v,
    nowMs,
  )
  termsFiring.push(...terms)
  if (terms.length > 0) {
    console.log(
      `  NOTICE terms_page_notice — ${terms.length} distinct page edit(s) in ${ALARM_THRESHOLDS.terms_page_notice.windowHours}h; exit impact unclassified`,
    )
  }

  // --- drawdown_fast: peak-to-current fall > 20% over trailing 7d ----------
  const metric = hasInstant ? 'instant_usd' : 'total_assets'
  const snaps = await sql`
    SELECT observed_at AS at, instant_usd, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed'
      AND observed_at > now() - make_interval(days => ${ALARM_THRESHOLDS.drawdown_fast.windowDays})
    ORDER BY observed_at ASC`
  const series = snaps
    .map((r) => ({ at: new Date(r.at).toISOString(), value: metricPoint(r, metric) }))
    .filter((p) => p.value !== null)
  const draw = evalDrawdown(series, metric)
  if (draw.fires) {
    firing.push({
      venue: v,
      kind: 'drawdown_fast',
      severity: draw.severity,
      evidence: draw.evidence,
    })
    console.log(
      `  FIRE drawdown_fast (${draw.severity}) — ${metric} ${draw.evidence.dropPct.toFixed(1)}% (${series.length} obs)`,
    )
  }

  // Flow rules require an audited ledger of complete block/time ranges. The
  // current venue_flows table stores only observed events and advances from
  // max(event block)+1, so missing rows cannot prove a quiet day and the
  // largest recorded day cannot be called the historical maximum. Suspend
  // both rules until a coverage-certified source is connected.
  console.log('  SUSPENDED net_outflow_streak, headroom_thin — flow coverage uncertified')

  // --- utilization: lending reserve utilization (Fraxlend/Morpho genre) -----
  // Uses the latest snapshot's recorded params.utilization_pct (venues with a
  // configured variableDebtToken; null-safe for the others).
  const util = evalUtilization(latest?.params?.utilization_pct)
  if (util.fires) {
    firing.push({ venue: v, kind: 'utilization', severity: util.severity, evidence: util.evidence })
    console.log(
      `  FIRE utilization (${util.severity}) — ${util.evidence.utilizationPct.toFixed(1)}% utilized`,
    )
  }

  // --- depth_skew: pool one-sidedness of the instant-exit tier (memo P4) ----
  // Uses the latest snapshot's recorded depth_skew_pct (worst enabled market).
  const depthSkew = evalDepthSkew(latest?.params?.depth_skew_pct)
  if (depthSkew.fires) {
    firing.push({
      venue: v,
      kind: 'depth_skew',
      severity: depthSkew.severity,
      evidence: depthSkew.evidence,
    })
    console.log(
      `  FIRE depth_skew (${depthSkew.severity}) — ${depthSkew.evidence.skewPct.toFixed(1)}% one-sided`,
    )
  }

  // --- depth_collapse: exitable depth (depth_usd) falling >35%/>50% over 7d --
  const depthSnaps = await sql`
    SELECT observed_at AS at, params FROM venue_snapshots
    WHERE venue = ${v} AND source = 'observed'
      AND observed_at > now() - make_interval(days => ${ALARM_THRESHOLDS.depth_collapse.windowDays})
    ORDER BY observed_at ASC`
  const depthSeries = depthSnaps
    .map((r) => ({ at: new Date(r.at).toISOString(), value: r.params?.depth_usd }))
    .filter((p) => p.value !== undefined && p.value !== null)
  const depthCollapse = evalDepthCollapse(depthSeries)
  if (depthCollapse.fires) {
    firing.push({
      venue: v,
      kind: 'depth_collapse',
      severity: depthCollapse.severity,
      evidence: depthCollapse.evidence,
    })
    console.log(
      `  FIRE depth_collapse (${depthCollapse.severity}) — depth_usd ${depthCollapse.evidence.dropPct.toFixed(1)}% (${depthSeries.length} obs)`,
    )
  }

  // --- coverage honesty: what this venue is BLIND to -----------------------
  // Blind spots from the ONE shared definition (alarmRules.mjs coverageFor).
  const uncovered = [
    ...coverageFor(venue, { hasInstant: exit !== null }),
    ...FLOW_COVERAGE_DIAGNOSTICS,
  ]
  uncoveredByVenue[v] = uncovered
  console.log(`  uncovered (cannot evaluate): ${uncovered.map((u) => u.id).join(', ')}`)
}

// --- reconcile against currently-open alarms (dedupe-while-open + clear) ----
const open =
  await sql`SELECT id, venue, kind, evidence, fired_at, source_event_id, notified FROM venue_alarms WHERE cleared_at IS NULL`
const legacyTermsOnly = open.filter(isLegacyTermsOnlyGateAlarm)
const retaggedLegacyIds = new Set()
for (const row of legacyTermsOnly) {
  if (row.notified) continue
  const evidence = legacyTermsNoticeEvidence(row)
  // A legacy checker may have written an aggregate after the migration
  // boundary. Its source edit gets a distinct event-keyed notice below; clear
  // the old gate row so it cannot block a real gate alarm's unique slot.
  if (new Date(evidence.firstObservedAt).getTime() >= termsBoundaryMs) continue
  if (termsNoticeExpired({ evidence }, nowMs)) continue
  const [retagged] = await sql`
    UPDATE venue_alarms SET kind = 'terms_page_notice', severity = 'notice',
      evidence = ${JSON.stringify(evidence)}::jsonb
    WHERE id = ${row.id} AND kind = 'gate_change' AND cleared_at IS NULL AND notified = false
    RETURNING id`
  if (retagged) {
    retaggedLegacyIds.add(row.id)
    console.log(
      `  MIGRATED ${row.venue}/terms_page_notice — pending legacy terms-only notice retained`,
    )
  }
}
const { toInsert, toClear: noLongerFiring } = reconcileAlarms(
  firing,
  open.filter((row) => row.kind !== 'terms_page_notice' && !isLegacyTermsOnlyGateAlarm(row)),
)
const expiredTerms = open.filter(
  (row) => row.kind === 'terms_page_notice' && termsNoticeExpired(row, nowMs),
)
const toClear = [
  ...noLongerFiring,
  ...legacyTermsOnly.filter((row) => !retaggedLegacyIds.has(row.id)),
  ...expiredTerms,
]

let cleared = 0
for (const o of toClear) {
  const res = await sql`
    UPDATE venue_alarms SET cleared_at = now()
    WHERE id = ${o.id} AND kind = ${o.kind} AND cleared_at IS NULL RETURNING id`
  if (res.length > 0) {
    cleared++
    const reason = legacyTermsOnly.some((row) => row.id === o.id)
      ? 'legacy terms-only gate alarm; page text change is a notice'
      : o.kind === 'terms_page_notice'
        ? '24h elapsed since this source edit was first observed'
        : UNCERTIFIED_FLOW_KINDS.has(o.kind)
          ? 'flow coverage uncertified; prior alarm evidence cannot be verified'
          : 'condition no longer holds'
    console.log(`  CLEARED ${o.venue}/${o.kind} — ${reason}`)
  }
}

const inserted = []
for (const f of toInsert) {
  const [row] = await sql`
    INSERT INTO venue_alarms (venue, kind, severity, evidence)
    VALUES (${f.venue}, ${f.kind}, ${f.severity}, ${JSON.stringify(f.evidence)}::jsonb)
    ON CONFLICT (venue, kind) WHERE cleared_at IS NULL AND kind <> 'terms_page_notice' DO NOTHING
    RETURNING id, venue, kind, severity, evidence`
  if (row) inserted.push(row)
}
for (const f of termsFiring) {
  const [row] = await sql`
    INSERT INTO venue_alarms (venue, kind, severity, evidence, source_event_id)
    VALUES (${f.venue}, ${f.kind}, ${f.severity}, ${JSON.stringify(f.evidence)}::jsonb, ${f.sourceEventId}::uuid)
    ON CONFLICT (source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
    RETURNING id, venue, kind, severity, evidence`
  if (row) inserted.push(row)
}

if (recordOnly) {
  console.log(
    JSON.stringify({
      status: 'record_only',
      firing: firing.length + termsFiring.length,
      newlyOpened: inserted.length,
      cleared,
      externalDelivery: false,
    }),
  )
  process.exit(0)
}

// --- deliver open, unnotified alarms (including failed earlier attempts) ----
// The partial unique index dedupes the open row; notified=true suppresses
// repeat delivery on later checks. Only deliver conditions still firing in
// this check, so a row cleared above cannot be retried as a stale alert.
const pending = await sql`
  SELECT id, venue, kind, severity, evidence FROM venue_alarms
  WHERE cleared_at IS NULL AND notified = false AND kind <> 'terms_page_notice'`
const deliverable = pending.filter((row) =>
  firing.some((f) => f.venue === row.venue && f.kind === row.kind),
)
if (deliverable.length > 0) {
  const { ok, channels, telegram } = await notify(deliverable)
  const requiredDelivered = telegram.configured ? telegram.delivered : ok
  if (requiredDelivered) {
    for (const row of deliverable) {
      await sql`
        UPDATE venue_alarms SET notified = true
        WHERE id = ${row.id} AND cleared_at IS NULL AND notified = false`
    }
    console.log(`\nnotified ${deliverable.length} alarm(s) via: ${channels.join(', ')}`)
  } else {
    console.log(
      `\nWARNING: ${deliverable.length} open alarm(s) lacked required notification delivery (channels: ${channels.join(', ') || 'none'}) — left notified=false for retry`,
    )
  }
} else {
  console.log('\nno open, unnotified alarms to deliver')
}

// One atomic bounded claim per process. SKIP LOCKED and claim_token prevent
// concurrent checkers from normally sending the same terms notice. A crashed
// process leaves a lease that expires; remote success followed by local crash
// can still duplicate on retry (no cross-system exactly-once transaction).
const termsClaimToken = randomUUID()
const claimedTerms = await sql`
  WITH candidate AS (
    SELECT id FROM venue_alarms
    WHERE kind = 'terms_page_notice' AND cleared_at IS NULL AND notified = false
      AND (delivery_claim_until IS NULL OR delivery_claim_until < now())
    ORDER BY fired_at, id LIMIT 5 FOR UPDATE SKIP LOCKED
  )
  UPDATE venue_alarms a SET delivery_claim_token = ${termsClaimToken}::uuid,
    delivery_claim_until = now() + interval '10 minutes'
  FROM candidate WHERE a.id = candidate.id
  RETURNING a.id, a.venue, a.kind, a.severity, a.evidence`
for (const row of claimedTerms) {
  try {
    const { ok, channels, telegram } = await notify([row])
    const requiredDelivered = telegram.configured ? telegram.delivered : ok
    if (requiredDelivered) {
      await sql`
        UPDATE venue_alarms SET notified = true, delivery_claim_token = NULL,
          delivery_claim_until = NULL
        WHERE id = ${row.id} AND delivery_claim_token = ${termsClaimToken}::uuid
          AND cleared_at IS NULL AND notified = false`
      console.log(`  notified terms notice ${row.id} via: ${channels.join(', ')}`)
    } else {
      await sql`
        UPDATE venue_alarms SET delivery_claim_token = NULL, delivery_claim_until = NULL
        WHERE id = ${row.id} AND delivery_claim_token = ${termsClaimToken}::uuid
          AND notified = false`
      console.log(`  WARNING: terms notice ${row.id} lacked required notification; retry available`)
    }
  } catch {
    await sql`
      UPDATE venue_alarms SET delivery_claim_token = NULL, delivery_claim_until = NULL
      WHERE id = ${row.id} AND delivery_claim_token = ${termsClaimToken}::uuid
        AND notified = false`
    console.log(`  WARNING: terms notice ${row.id} delivery failed; retry available`)
  }
}

// --- honest summary --------------------------------------------------------
console.log('\n=== alarm check summary ===')
console.log(
  `firing now: ${firing.length + termsFiring.length}  ·  newly opened: ${inserted.length}  ·  cleared: ${cleared}`,
)
for (const f of [...firing, ...termsFiring])
  console.log(`  ${f.severity.toUpperCase()} ${f.venue}/${f.kind}`)
console.log('\nUNCOVERED signals (reported, never silent — silence is NOT all-clear):')
for (const [v, list] of Object.entries(uncoveredByVenue)) {
  console.log(`  ${v}: ${list.map((u) => `${u.id} (${u.memo})`).join('; ')}`)
}
console.log('\nalarm check complete')

// --- TELEGRAM ADDRESS ALERTS (MOAT step 7) ----------------------------------
// Drain /start//stop commands (poll mode only — Telegram forbids getUpdates while
// a webhook is set), then send one message per new (subscription, alarm, moment)
// to chats watching an address that holds the venue. Ships dark while the bot env
// is unset. Non-fatal, and the two halves fail independently: a poll failure
// never blocks sending.
let tg = null
try {
  const bot = await import('./lib/telegramBot.mjs')
  const tgConfig = bot.botConfig(get)
  if (!tgConfig.enabled) {
    console.log(
      'telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — skipped',
    )
  } else {
    const { require: tsxRequire } = await import('tsx/cjs/api')
    const logic = tsxRequire('../components/Radar/telegramLogic.ts', import.meta.url)
    tg = { bot, config: tgConfig, logic, venues: loadConfig() }
  }
} catch (e) {
  console.log(`telegram alerts: setup failed (non-fatal) — ${e?.message ?? e}`)
}
if (tg && tg.config.webhookSecret) {
  console.log('telegram alerts: webhook mode — command polling skipped')
} else if (tg) {
  try {
    const footerFor = tg.bot.scriptFooterFor(sql, tg.venues)
    const { handled } = await tg.bot.pollOnce({
      sql,
      logic: tg.logic,
      footerFor,
      config: tg.config,
    })
    console.log(`telegram alerts: answered ${handled} command(s)`)
  } catch (e) {
    console.log(`telegram alerts: poll failed (non-fatal) — ${e?.message ?? e}`)
  }
}
if (tg) {
  try {
    await tg.bot.sendAddressAlerts(sql, {
      logic: tg.logic,
      coverage: tg.bot.scriptCoverage(sql, tg.venues),
      config: tg.config,
    })
  } catch (e) {
    console.log(`telegram alerts: send failed (non-fatal) — ${e?.message ?? e}`)
  }
}
