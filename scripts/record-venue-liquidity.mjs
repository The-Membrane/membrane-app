// record-venue-liquidity.mjs — the venue withdrawal-ability recorder (owner-
// approved). One OBSERVED pass over every enabled venue in
// tools/venue-recorder.config.json:
//
//   1. Read the venue's state at one recent finalized, hash-checked block.
//   2. Insert a venue_snapshots row (source='observed') when Neon is healthy.
//      With Neon unavailable, seal the same finalized observation locally.
//      Skip a database row when this venue has an observed snapshot < 10 min old.
//   3. Diff against the venue's previous observed snapshot → insert venue_events
//      rows for any params-field change and any instant_usd move > 20%.
//   4. On the database path only, score due predictions and write one fresh
//      persistence-v0 prediction. Local snapshots are measured context, not
//      a replacement predictive model or a claimed flow history.
//
//   node scripts/record-venue-liquidity.mjs        (from the membrane-app root)
//
// Env: RECORDER_RPC_URL (a MAINNET RPC — these are external venues, NOT anvil)
// from .env.local; DATABASE_URL(_UNPOOLED) is optional for local fallback.
// tsx/node get no Next env injection. Missing RPC is a hard failure.

import { neon } from '@neondatabase/serverless'
import {
  appendLocalVenueSnapshot,
  acquireLocalVenueSnapshotWriter,
  clearLocalVenueSnapshotAttempt,
  markLocalVenueSnapshotAttempt,
  releaseLocalVenueSnapshotWriter,
  runDatabaseOrLocal,
} from './lib/localVenueSnapshotStore.mjs'
import {
  readEnv,
  loadConfig,
  makeClient,
  readVenueState,
  readDepthMarkets,
  primaryMetric,
} from './lib/venue-reads.mjs'

// launchd normally uses .env.local, but a process-supplied RPC can also run
// the local recorder when that file is absent.
let get = () => undefined
try {
  get = readEnv().get
} catch {
  // Missing local env file is not a reason to discard process env settings.
}
const rpcUrl = get('RECORDER_RPC_URL') || process.env.RECORDER_RPC_URL
if (!rpcUrl) {
  console.error(
    'RECORDER_RPC_URL is unset. Set it in .env.local to a MAINNET Ethereum RPC ' +
      '(these are external venues — Ethena/Aave on mainnet, NOT the local anvil), then re-run.',
  )
  process.exit(1)
}
const dbUrl =
  get('DATABASE_URL_UNPOOLED') ||
  get('DATABASE_URL') ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL
// The hourly native observation stage owns the local cash ledger. Do not
// contact Neon or mix its history into this pass when explicitly local.
const localOnly = process.argv.includes('--local')
const sql = !localOnly && dbUrl ? neon(dbUrl) : null
const client = makeClient(rpcUrl)
const MAX_FINALIZED_AGE_SECONDS = 2 * 60 * 60
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/

// A legacy latest-head observation is not a canonical comparison point. This
// also prevents a malformed/missing source seal from becoming an alertable
// instant-liquidity event after a recorder upgrade or partial write.
export function isFinalizedSource(row) {
  const params = row?.params
  return (
    params?.read_block_finalized === true &&
    params?.read_block_pinned === true &&
    BLOCK_HASH.test(params?.read_block_hash ?? '') &&
    Number.isInteger(params?.read_block_time) &&
    /^\d+$/.test(String(row.block ?? '')) &&
    /^\d+$/.test(String(params.read_block_number ?? '')) &&
    BigInt(row.block) === BigInt(params.read_block_number)
  )
}

export function finalizedSourceHasNotAdvanced(previous, nextBlock) {
  return isFinalizedSource(previous) && BigInt(previous.block) >= nextBlock
}

export async function readFinalizedVenueState(reader, venue, nowSeconds = Date.now() / 1000) {
  if ((await reader.getChainId()) !== 1) throw new Error('venue_recorder_wrong_chain')
  const source = await reader.getBlock({ blockTag: 'finalized' })
  if (
    typeof source.number !== 'bigint' ||
    !BLOCK_HASH.test(source.hash ?? '') ||
    typeof source.timestamp !== 'bigint'
  ) {
    throw new Error('venue_recorder_invalid_finalized_block')
  }
  const age = nowSeconds - Number(source.timestamp)
  if (age < -120 || age > MAX_FINALIZED_AGE_SECONDS) {
    throw new Error('venue_recorder_stale_finalized_block')
  }
  const state = await readVenueState(reader, venue, source.number)
  const depth = await readDepthMarkets(reader, venue, source.number)
  if (depth) Object.assign(state.params, depth)
  const recheck = await reader.getBlock({ blockNumber: source.number })
  if (recheck.hash !== source.hash || recheck.timestamp !== source.timestamp) {
    throw new Error('venue_recorder_block_hash_changed')
  }
  Object.assign(state.params, {
    read_block_pinned: true,
    read_block_finalized: true,
    read_block_number: source.number.toString(),
    read_block_hash: source.hash,
    read_block_time: Number(source.timestamp),
  })
  return { block: source.number, ...state, depth }
}

// jsonb columns are compared field-by-field; these keys are meta, not state.
// depthMarkets is a structured sub-array whose reserves drift every block — its
// eventable summary is the top-level depth_usd / depth_skew_pct, so the array
// itself is meta (diffing it would spam param_changed rows every tick).
const META_KEYS = new Set([
  'kind',
  'reads',
  'instant_note',
  'depthMarkets',
  'depth_note',
  'depth_complete',
  'read_block_pinned',
  'read_block_finalized',
  'read_block_number',
  'read_block_hash',
  'read_block_time',
  'utilization_note',
  'variableDebtToken',
])

// Continuously-varying metrics drift every block (yield accrual, ordinary
// flows). Eventing every tick makes the news tracker a noise feed (Badass
// rule 9) — these only fire an event on a >20% move, like instant_usd.
// Discrete params (cooldownDuration, silo, …) still event on ANY change.
const CONTINUOUS_KEYS = new Set([
  'totalAssets',
  'totalSupply',
  'underlyingBalance',
  'depth_usd',
  'depth_skew_pct',
  'variableDebt',
  'utilization_pct',
])
const CONTINUOUS_SHIFT = 0.2

// Extract the value of a chosen metric from a snapshot row (numeric columns
// arrive from neon as strings).
function metricValueOf(row, metric) {
  if (metric === 'instant_usd') {
    return row.instant_usd === null || row.instant_usd === undefined
      ? null
      : Number(row.instant_usd)
  }
  const ta = row.params?.totalAssets
  return ta === undefined || ta === null ? null : Number(ta)
}

function saveLocalObservation(venue, state, observedAtUtc, localAttemptToken = undefined) {
  const { status, record } = appendLocalVenueSnapshot(
    {
      venue: venue.name,
      chain: venue.chain ?? 'ethereum',
      source: {
        block: state.block.toString(),
        hash: state.params.read_block_hash,
        timestamp: state.params.read_block_time,
        finalized: true,
        pinned: true,
      },
      observedAtUtc,
      params: state.params,
      instantUsd: state.instantUsd,
      coolingUsd: state.coolingUsd,
      strandedUsd: state.strandedUsd,
    },
    { localAttemptToken },
  )
  console.log(
    `  local ${status} seq=${record.sequence} block=${record.source.block} comparison=${record.comparison.status}`,
  )
  if (localOnly && status === 'recorded')
    clearLocalVenueSnapshotAttempt(venue.name, localAttemptToken)
  else if (localOnly && status !== 'recorded') {
    markLocalVenueSnapshotAttempt({
      identity: {
        venue: venue.name,
        chain: venue.chain ?? 'ethereum',
        kind: venue.kind,
        address: venue.address,
        underlying: venue.underlying,
        decimals: venue.decimals,
      },
      attemptedAtUtc: new Date().toISOString(),
      status: 'capture_failed',
      token: localAttemptToken,
    })
  }
  return status
}

let databaseAvailable = sql !== null
if (databaseAvailable) {
  try {
    await sql`SELECT 1 AS recorder_health`
  } catch {
    databaseAvailable = false
    console.log('venue database unavailable; finalized observations will use the local ledger')
  }
} else {
  console.log(
    localOnly
      ? 'local-only venue pass; finalized observations will use the local ledger'
      : 'venue database URL absent; finalized observations will use the local ledger',
  )
}

const failedVenues = []

for (const venue of loadConfig().filter((v) => v.enabled)) {
  console.log(`\n[${venue.name}] ${venue.kind}`)

  const attemptAtUtc = new Date().toISOString()
  const attemptIdentity = {
    venue: venue.name,
    chain: venue.chain ?? 'ethereum',
    kind: venue.kind,
    address: venue.address,
    underlying: venue.underlying,
    decimals: venue.decimals,
  }
  let writerToken
  if (localOnly) {
    try {
      writerToken = acquireLocalVenueSnapshotWriter(attemptIdentity)
    } catch (error) {
      console.error(`  local writer unavailable: ${error.message}`)
      failedVenues.push(venue.name)
      continue
    }
  }
  try {
    if (localOnly) {
      markLocalVenueSnapshotAttempt({
        identity: attemptIdentity,
        attemptedAtUtc: attemptAtUtc,
        status: 'capture_in_progress',
        token: writerToken,
      })
    }

    // 2a. Idempotent-ish: skip if a fresh observed snapshot already exists.
    if (databaseAvailable) {
      try {
        const [fresh] = await sql`
        SELECT id FROM venue_snapshots
        WHERE venue = ${venue.name} AND source = 'observed'
          AND observed_at > now() - interval '10 minutes'
        ORDER BY observed_at DESC LIMIT 1`
        if (fresh) {
          console.log('  skip — an observed snapshot < 10 min old already exists')
          continue
        }
      } catch {
        databaseAvailable = false
        console.log('  venue database read failed; switching this pass to the local ledger')
      }
    }

    // 1. Read one recent finalized block and verify its hash before any write.
    let state
    try {
      state = await readFinalizedVenueState(client, venue)
    } catch {
      console.error('  finalized venue read failed; no observation recorded')
      if (localOnly) {
        markLocalVenueSnapshotAttempt({
          identity: attemptIdentity,
          attemptedAtUtc: attemptAtUtc,
          status: 'capture_failed',
          token: writerToken,
        })
      }
      failedVenues.push(venue.name)
      continue
    }
    const observedAtUtc = new Date().toISOString()
    const { block, params, instantUsd, coolingUsd, strandedUsd, depth } = state
    if (depth) {
      console.log(
        `  depth_usd=${depth.depth_usd} (exitable) depth_skew_pct=${depth.depth_skew_pct?.toFixed(1) ?? 'null'}%`,
      )
    }
    console.log(
      `  block ${block} — instant_usd=${instantUsd ?? 'null'} params=${JSON.stringify(params)}`,
    )

    if (!databaseAvailable) {
      try {
        saveLocalObservation(venue, state, observedAtUtc, writerToken)
      } catch {
        console.error('  local finalized observation could not be sealed')
        if (localOnly) {
          markLocalVenueSnapshotAttempt({
            identity: attemptIdentity,
            attemptedAtUtc: new Date().toISOString(),
            status: 'capture_failed',
            token: writerToken,
          })
        }
        failedVenues.push(venue.name)
      }
      continue
    }

    try {
      const result = await runDatabaseOrLocal(
        async () => {
          // 3a. Fetch the previous observed snapshot BEFORE inserting the new one.
          const [prev] = await sql`
    SELECT id, block, instant_usd, params FROM venue_snapshots
    WHERE venue = ${venue.name} AND source = 'observed'
    ORDER BY observed_at DESC LIMIT 1`
          if (prev && finalizedSourceHasNotAdvanced(prev, block)) {
            console.log('  skip — finalized source block has not advanced')
            return
          }

          // 2. Insert the snapshot.
          const [snap] = await sql`
    INSERT INTO venue_snapshots (venue, chain, block, instant_usd, cooling_usd, stranded_usd, params, source)
    VALUES (${venue.name}, ${venue.chain ?? 'ethereum'}, ${block.toString()},
            ${instantUsd}, ${coolingUsd}, ${strandedUsd}, ${JSON.stringify(params)}::jsonb, 'observed')
    RETURNING id`
          const snapshotId = snap.id

          // 3b. Diff → venue_events (news tracker: state changes, not headlines).
          if (prev && isFinalizedSource(prev)) {
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
          } else if (prev) {
            console.log('  previous observation lacks a finalized block seal — no change event')
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
              console.log(
                `  prediction ${pred.id} due but metric '${pred.metric}' unreadable — left unscored`,
              )
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
            return
          }
          // Band spread = max abs consecutive %-move over this venue's observed history
          // of the SAME metric (floor 5%); ±25% when < 3 snapshots of history.
          const hist = await sql`
    SELECT instant_usd, params FROM venue_snapshots
    WHERE venue = ${venue.name} AND source = 'observed'
    ORDER BY observed_at ASC`
          const series = hist
            .map((r) => metricValueOf(r, primary.metric))
            .filter((v) => v !== null && v !== 0)
          let spread
          if (series.length < 3) {
            spread = 0.25
          } else {
            let maxMove = 0
            for (let i = 1; i < series.length; i++) {
              maxMove = Math.max(
                maxMove,
                Math.abs(series[i] - series[i - 1]) / Math.abs(series[i - 1]),
              )
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
        },
        async () => {
          saveLocalObservation(venue, state, observedAtUtc, writerToken)
        },
      )
      if (result.sink === 'local') {
        databaseAvailable = false
        console.log('  venue database write failed; switched this pass to the local ledger')
      }
    } catch {
      console.error('  local finalized observation could not be sealed')
      if (localOnly) {
        markLocalVenueSnapshotAttempt({
          identity: attemptIdentity,
          attemptedAtUtc: new Date().toISOString(),
          status: 'capture_failed',
          token: writerToken,
        })
      }
      failedVenues.push(venue.name)
    }
  } finally {
    if (localOnly) releaseLocalVenueSnapshotWriter(venue.name, writerToken)
  }
}

console.log(`\nrecorder pass complete; failed venues=${failedVenues.length}`)
if (failedVenues.length) process.exitCode = 1
