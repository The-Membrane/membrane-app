// record-venue-liquidity.mjs — the venue withdrawal-ability recorder (owner-
// approved). One OBSERVED pass over every enabled venue in
// tools/venue-recorder.config.json:
//
//   1. Read the venue's state at the latest block (via scripts/lib/venue-reads).
//   2. Insert a venue_snapshots row (source='observed'). Skip if this venue
//      already has an observed snapshot < 10 minutes old (idempotent-ish).
//   3. Diff against the venue's previous observed snapshot → insert venue_events
//      rows for any params-field change and any instant_usd move > 20%.
//   4. Score any due, unscored predictions (made_at + horizon <= now), then
//      write one fresh 'persistence-v0' prediction (24h horizon) per venue.
//
//   node scripts/record-venue-liquidity.mjs        (from the membrane-app root)
//
// Env: RECORDER_RPC_URL (a MAINNET RPC — these are external venues, NOT anvil)
// and DATABASE_URL(_UNPOOLED), both from .env.local. tsx/node get no Next env
// injection. If RECORDER_RPC_URL is unset the script exits(1) with the fix.

import { neon } from '@neondatabase/serverless'
import { readEnv, loadConfig, makeClient, readVenueState, readDepthMarkets, primaryMetric } from './lib/venue-reads.mjs'

const { get } = readEnv()
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error(
    'RECORDER_RPC_URL is unset. Set it in .env.local to a MAINNET Ethereum RPC ' +
      '(these are external venues — Ethena/Aave on mainnet, NOT the local anvil), then re-run.',
  )
  process.exit(1)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(dbUrl)
const client = makeClient(rpcUrl)

// jsonb columns are compared field-by-field; these keys are meta, not state.
// depthMarkets is a structured sub-array whose reserves drift every block — its
// eventable summary is the top-level depth_usd / depth_skew_pct, so the array
// itself is meta (diffing it would spam param_changed rows every tick).
const META_KEYS = new Set(['kind', 'reads', 'instant_note', 'depthMarkets', 'depth_note'])

// Continuously-varying metrics drift every block (yield accrual, ordinary
// flows). Eventing every tick makes the news tracker a noise feed (Badass
// rule 9) — these only fire an event on a >20% move, like instant_usd.
// Discrete params (cooldownDuration, silo, …) still event on ANY change.
const CONTINUOUS_KEYS = new Set(['totalAssets', 'totalSupply', 'underlyingBalance', 'depth_usd', 'depth_skew_pct'])
const CONTINUOUS_SHIFT = 0.2

// Extract the value of a chosen metric from a snapshot row (numeric columns
// arrive from neon as strings).
function metricValueOf(row, metric) {
  if (metric === 'instant_usd') {
    return row.instant_usd === null || row.instant_usd === undefined ? null : Number(row.instant_usd)
  }
  const ta = row.params?.totalAssets
  return ta === undefined || ta === null ? null : Number(ta)
}

for (const venue of loadConfig().filter((v) => v.enabled)) {
  console.log(`\n[${venue.name}] ${venue.kind}`)

  // 2a. Idempotent-ish: skip if a fresh observed snapshot already exists.
  const [fresh] = await sql`
    SELECT id FROM venue_snapshots
    WHERE venue = ${venue.name} AND source = 'observed'
      AND observed_at > now() - interval '10 minutes'
    ORDER BY observed_at DESC LIMIT 1`
  if (fresh) {
    console.log('  skip — an observed snapshot < 10 min old already exists')
    continue
  }

  // 1. Read latest state (+ depth-market extension, memo P4, when configured).
  const block = await client.getBlockNumber()
  const { params, instantUsd, coolingUsd, strandedUsd } = await readVenueState(client, venue)
  const depth = await readDepthMarkets(client, venue)
  if (depth) {
    Object.assign(params, depth)
    console.log(`  depth_usd=${depth.depth_usd} (exitable) depth_skew_pct=${depth.depth_skew_pct?.toFixed(1) ?? 'null'}%`)
  }
  console.log(`  block ${block} — instant_usd=${instantUsd ?? 'null'} params=${JSON.stringify(params)}`)

  // 3a. Fetch the previous observed snapshot BEFORE inserting the new one.
  const [prev] = await sql`
    SELECT id, instant_usd, params FROM venue_snapshots
    WHERE venue = ${venue.name} AND source = 'observed'
    ORDER BY observed_at DESC LIMIT 1`

  // 2. Insert the snapshot.
  const [snap] = await sql`
    INSERT INTO venue_snapshots (venue, chain, block, instant_usd, cooling_usd, stranded_usd, params, source)
    VALUES (${venue.name}, ${venue.chain ?? 'ethereum'}, ${block.toString()},
            ${instantUsd}, ${coolingUsd}, ${strandedUsd}, ${JSON.stringify(params)}::jsonb, 'observed')
    RETURNING id`
  const snapshotId = snap.id

  // 3b. Diff → venue_events (news tracker: state changes, not headlines).
  if (prev) {
    const keys = new Set([...Object.keys(prev.params ?? {}), ...Object.keys(params)])
    for (const k of keys) {
      if (META_KEYS.has(k)) continue
      const a = prev.params?.[k]
      const b = params?.[k]
      if (JSON.stringify(a) === JSON.stringify(b)) continue
      // A missing side means the READ failed on one pass, not that the venue
      // changed anything — eventing absence↔presence flapped fake
      // param_changed rows (silo/vaultDecimals) into the public log.
      if (a === undefined || a === null || b === undefined || b === null) continue
      if (CONTINUOUS_KEYS.has(k)) {
        const na = Number(a)
        const nb = Number(b)
        if (!Number.isFinite(na) || !Number.isFinite(nb) || na === 0) continue
        if (Math.abs(nb - na) / Math.abs(na) <= CONTINUOUS_SHIFT) continue
      }
      const kind = k === 'cooldownDuration' ? 'cooldown_duration_changed' : 'param_changed'
      await sql`
        INSERT INTO venue_events (venue, kind, prev, next, note, snapshot_id)
        VALUES (${venue.name}, ${kind}, ${JSON.stringify({ [k]: a })}::jsonb,
                ${JSON.stringify({ [k]: b })}::jsonb, ${`${k}: ${a} -> ${b}`}, ${snapshotId})`
      console.log(`  event ${kind} (${k}: ${a} -> ${b})`)
    }
    // instant_usd move > 20%
    const pa = prev.instant_usd === null ? null : Number(prev.instant_usd)
    const pb = instantUsd
    if (pa !== null && pb !== null && pa !== 0 && Math.abs(pb - pa) / Math.abs(pa) > 0.2) {
      const pct = ((pb - pa) / Math.abs(pa)) * 100
      await sql`
        INSERT INTO venue_events (venue, kind, prev, next, note, snapshot_id)
        VALUES (${venue.name}, 'instant_liquidity_shift', ${JSON.stringify({ instant_usd: pa })}::jsonb,
                ${JSON.stringify({ instant_usd: pb })}::jsonb, ${`instant_usd ${pct.toFixed(1)}%`}, ${snapshotId})`
      console.log(`  event instant_liquidity_shift (${pct.toFixed(1)}%)`)
    }
  }

  // 4a. Score due, unscored predictions. Exactly one UPDATE per row, per the
  // schema comment (realized/scored_at/hit set once, from a REALIZED outcome).
  const due = await sql`
    SELECT id, metric, band_low, band_high FROM venue_predictions
    WHERE venue = ${venue.name} AND scored_at IS NULL
      AND made_at + (horizon_hours || ' hours')::interval <= now()`
  for (const pred of due) {
    const realized = metricValueOf({ instant_usd: instantUsd, params }, pred.metric)
    if (realized === null) {
      console.log(`  prediction ${pred.id} due but metric '${pred.metric}' unreadable — left unscored`)
      continue
    }
    const hit = realized >= Number(pred.band_low) && realized <= Number(pred.band_high)
    await sql`
      UPDATE venue_predictions
      SET realized = ${realized}, scored_at = now(), hit = ${hit}
      WHERE id = ${pred.id} AND scored_at IS NULL`
    console.log(`  scored prediction ${pred.id}: realized=${realized} hit=${hit}`)
  }

  // 4b. Write a fresh persistence-v0 prediction for the primary metric.
  const primary = primaryMetric({ instant_usd: instantUsd, params })
  if (!primary) {
    console.log('  no primary metric available — no prediction written')
    continue
  }
  // Band spread = max abs consecutive %-move over this venue's observed history
  // of the SAME metric (floor 5%); ±25% when < 3 snapshots of history.
  const hist = await sql`
    SELECT instant_usd, params FROM venue_snapshots
    WHERE venue = ${venue.name} AND source = 'observed'
    ORDER BY observed_at ASC`
  const series = hist.map((r) => metricValueOf(r, primary.metric)).filter((v) => v !== null && v !== 0)
  let spread
  if (series.length < 3) {
    spread = 0.25
  } else {
    let maxMove = 0
    for (let i = 1; i < series.length; i++) {
      maxMove = Math.max(maxMove, Math.abs(series[i] - series[i - 1]) / Math.abs(series[i - 1]))
    }
    spread = Math.max(0.05, maxMove)
  }
  const bandLow = primary.value * (1 - spread)
  const bandHigh = primary.value * (1 + spread)
  await sql`
    INSERT INTO venue_predictions (venue, metric, horizon_hours, band_low, band_high, model)
    VALUES (${venue.name}, ${primary.metric}, 24, ${bandLow}, ${bandHigh}, 'persistence-v0')`
  console.log(
    `  prediction persistence-v0: ${primary.metric}=${primary.value} band=[${bandLow.toFixed(2)}, ${bandHigh.toFixed(2)}] (±${(spread * 100).toFixed(1)}%, ${series.length} obs)`,
  )
}

console.log('\nrecorder pass complete')
