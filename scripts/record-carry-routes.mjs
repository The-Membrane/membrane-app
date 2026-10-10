// Daily exact-leg pilot: historical wallet holder stock, same-wallet debt/holding
// overlap, all-depositor destination-vault TVL, and an independent rate spread.
// Neither wallet metric is a realized return or route-attributed TVL.
// Called by the hourly venue tick, but each successful leg is refreshed only
// after 24h. Failed/missing legs retry at the next tick. Neither goes blank
// merely because a refresh fails. Run after apply-carry-route-ddl.mjs.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'
import {
  dueCarryRouteKinds,
  HOLDER_ROUTE_KEY,
  SPREAD_ROUTE_KEY,
} from './lib/carry-route-cadence.mjs'
import { summarizeGhoHolding } from './lib/carry-route-summary.mjs'
import { collectSnapshot, normalizeSeed } from './route-cohort/collector.mjs'
import {
  loadOrAttestAaveBorrowReceipts,
  isPilotKindDue,
  isRecentPinnedBlock,
  PILOT_ROUTE,
  readDestinationVaultTvlWithWitness,
  readGhoVariableDebtToken,
  readMatchedGhoCapital,
  parsePinnedPilotManifest,
} from './route-cohort/gho-matched.mjs'
import { checkpointForRun, filterSeed } from './route-cohort/run.mjs'
import {
  loadProspectiveBorrowers,
  PROSPECTIVE_FROM_BLOCK,
  readProspectiveOverlap,
} from './route-cohort/prospective-matched.mjs'
import { runSnapshot, writeAtomicJson } from './route-rates/run-hourly.mjs'

const ROUTE = HOLDER_ROUTE_KEY
const SEED_PATH = join(ROOT, 'scripts', 'route-cohort', 'aug-2026-ab-vault-seed.json')
const HOLDING_PATH = join(ROOT, 'scripts', 'route-cohort', '.cache', 'gho-sgho-latest.json')
const MANIFEST_PATH = join(ROOT, 'scripts', 'route-cohort', 'gho-sgho-observations.json')
const ENTRANT_PATH = join(ROOT, 'data', 'research', 'venue-signals', 'carry-route-entrants')

const { get } = readEnv()
const rpcUrl =
  process.env.RECORDER_RPC_URLS ||
  process.env.RECORDER_RPC_URL ||
  get('RECORDER_RPC_URLS') ||
  get('RECORDER_RPC_URL')
const dbUrl =
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.DATABASE_URL ||
  get('DATABASE_URL_UNPOOLED') ||
  get('DATABASE_URL')
if (!rpcUrl || !dbUrl) throw new Error('Recorder RPC and database URLs are required')

const sql = neon(dbUrl)
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const latestSuccess = await sql`SELECT kind, route_key, MAX(recorded_at) AS recorded_at
  FROM carry_route_hourly
  WHERE status = 'ok'
    AND ((route_key = ${HOLDER_ROUTE_KEY} AND kind IN ('holder_stock', 'matched_capital', 'destination_tvl', 'prospective_overlap'))
      OR (route_key = ${SPREAD_ROUTE_KEY} AND kind = 'spread'))
  GROUP BY kind, route_key`
const latestDestination = await sql`SELECT data FROM carry_route_hourly
  WHERE route_key = ${ROUTE} AND kind = 'destination_tvl' AND status = 'ok'
  ORDER BY recorded_at DESC LIMIT 1`
const due = dueCarryRouteKinds(latestSuccess)
due.matched_capital = isPilotKindDue(latestSuccess, 'matched_capital')
// One migration read is due even if the older TVL-only row is <24h old.
due.destination_tvl =
  isPilotKindDue(latestSuccess, 'destination_tvl') ||
  !/^\d+$/.test(String(latestDestination[0]?.data?.vaultCashRaw ?? '')) ||
  typeof latestDestination[0]?.data?.withdrawalsPaused !== 'boolean'
due.prospective_overlap = isPilotKindDue(latestSuccess, 'prospective_overlap')
if (
  !due.holder_stock &&
  !due.spread &&
  !due.matched_capital &&
  !due.destination_tvl &&
  !due.prospective_overlap
) {
  console.log('carry route readings current; next refresh after 24h from each successful record')
  process.exit(0)
}

const client = makeClient(rpcUrl)

async function store({ routeKey, kind, block, observedAt, status, data }) {
  if (!routeKey || !block || !observedAt) return
  await sql`INSERT INTO carry_route_hourly
    (route_key, kind, block, observed_at, status, data)
    VALUES (${routeKey}, ${kind}, ${block}, ${observedAt}, ${status}, ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (route_key, kind, block) DO UPDATE
      SET status = EXCLUDED.status, data = EXCLUDED.data, recorded_at = now()
      WHERE (carry_route_hourly.status <> 'ok' AND EXCLUDED.status = 'ok')
         OR (
           carry_route_hourly.kind = 'destination_tvl'
           AND carry_route_hourly.status = 'ok'
           AND EXCLUDED.status = 'ok'
           AND (NOT (carry_route_hourly.data ? 'vaultCashRaw')
             OR jsonb_typeof(carry_route_hourly.data->'withdrawalsPaused') IS DISTINCT FROM 'boolean')
           AND (EXCLUDED.data ? 'vaultCashRaw')
           AND jsonb_typeof(EXCLUDED.data->'withdrawalsPaused') = 'boolean'
         )`
}

let failures = 0
let holding = null
// Prospective discovery is a separate event-observed sample. The hourly tick
// runs its bounded scanner and offline verifier before this daily reader; never
// widen the observed cohort into a borrower census or route-attributed TVL.
if (due.prospective_overlap && existsSync(ENTRANT_PATH)) {
  try {
    const seed = filterSeed(await readJson(SEED_PATH), PILOT_ROUTE)
    const observations = parsePinnedPilotManifest(
      await readFile(MANIFEST_PATH, 'utf8'),
      seed,
      normalizeSeed(seed).seedHash,
    )
    const cohort = loadProspectiveBorrowers({
      out: ENTRANT_PATH,
      fromBlock: PROSPECTIVE_FROM_BLOCK,
      excludedOwners: observations.map((row) => row.borrower),
    })
    const result = await readProspectiveOverlap(client, cohort)
    if (result.status === 'none_observed') {
      console.log('prospective GHO overlap: no non-August borrower observed in sealed coverage')
    } else if (result.status === 'source_stale') {
      failures++
      console.error('prospective GHO overlap unavailable: sealed discovery frontier is stale')
    } else if (result.status === 'over_capacity') {
      failures++
      console.error('prospective GHO overlap unavailable: candidate read bound exceeded')
    } else {
      await store({
        routeKey: ROUTE,
        kind: 'prospective_overlap',
        block: result.block,
        observedAt: result.observedAt,
        status: result.status,
        data: result.data,
      })
      console.log(
        `prospective GHO overlap ${result.status}: ${result.data.matchedGho ?? 'unknown'} GHO across ${result.data.candidateWalletCount} event-observed borrowers`,
      )
      if (result.status !== 'ok') failures++
    }
  } catch {
    failures++
    console.error('prospective GHO overlap unavailable: sealed source or pinned read failed')
  }
}
if (due.holder_stock || due.matched_capital) {
  try {
    const seed = filterSeed(await readJson(SEED_PATH), ROUTE)
    let prior = null
    try {
      prior = await readJson(HOLDING_PATH)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    holding = await collectSnapshot(client, seed, {
      snapshot: checkpointForRun(prior),
      onProgress: (progress) => writeAtomicJson(HOLDING_PATH, progress),
    })
    if (due.holder_stock) {
      const { status, data } = summarizeGhoHolding(holding)
      await store({
        routeKey: ROUTE,
        kind: 'holder_stock',
        block: holding.blockNumber,
        observedAt: holding.asOf,
        status,
        data,
      })
      console.log(
        `holder stock ${status}: ${data.holderCount} seeded wallets, ${data.holderStockGho ?? 'unknown'} GHO`,
      )
      if (status !== 'ok') failures++
    }
  } catch (error) {
    failures++
    console.error('holder stock unavailable: RPC, seed, or storage read failed')
  }
}

// The raw August rows do not contain a market address. Only all 20 matching
// Aave Pool Borrow receipts may promote this cohort to an exact-market metric.
if (due.matched_capital && holding) {
  try {
    if (!isRecentPinnedBlock(Date.parse(holding.asOf) / 1000)) {
      throw new Error('pilot_finalized_block_stale')
    }
    const seed = filterSeed(await readJson(SEED_PATH), PILOT_ROUTE)
    const observations = parsePinnedPilotManifest(
      await readFile(MANIFEST_PATH, 'utf8'),
      seed,
      holding.seedHash,
    )
    const attestation = await loadOrAttestAaveBorrowReceipts(
      client,
      observations,
      holding.seedHash,
      join(ROOT, 'scripts', 'route-cohort', '.cache'),
    )
    const block = BigInt(holding.blockNumber)
    const debtToken = await readGhoVariableDebtToken(client, block)
    const { status, data } = await readMatchedGhoCapital(client, holding, debtToken, attestation)
    await store({
      routeKey: ROUTE,
      kind: 'matched_capital',
      block: holding.blockNumber,
      observedAt: holding.asOf,
      status,
      data,
    })
    console.log(`matched debt-and-holding overlap ${status}: ${data.matchedGho ?? 'unknown'} GHO`)
    if (status !== 'ok') failures++
  } catch {
    failures++
    await store({
      routeKey: ROUTE,
      kind: 'matched_capital',
      block: holding.blockNumber,
      observedAt: holding.asOf,
      status: 'unavailable',
      data: {
        measurement: 'lesser_of_current_aave_gho_debt_and_sgho_holding_per_august_observed_wallet',
        reason: 'source_receipt_identity_or_pinned_read_unavailable',
      },
    })
    console.error(
      'matched capital unavailable: August source, Aave receipt identity, or pinned debt read failed',
    )
  }
}

if (due.destination_tvl) {
  try {
    if ((await client.getChainId()) !== 1) throw new Error('mainnet_required')
    const block = holding
      ? {
          number: BigInt(holding.blockNumber),
          hash: holding.blockHash,
          timestamp: BigInt(Math.floor(Date.parse(holding.asOf) / 1000)),
        }
      : await client.getBlock({ blockTag: 'finalized' })
    if (!block?.number || !block?.hash || !block?.timestamp)
      throw new Error('finalized_block_unavailable')
    if (!isRecentPinnedBlock(block.timestamp)) throw new Error('pilot_finalized_block_stale')
    // Do not mix vault cash/pause/totalAssets across fallback RPC hosts at the
    // same height. Each candidate must agree with the saved finalized header
    // before and after the complete set of reads.
    const candidates = String(rpcUrl)
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)
    const data = await readDestinationVaultTvlWithWitness(
      candidates.map((url) => makeClient(url)),
      block,
    )
    await store({
      routeKey: ROUTE,
      kind: 'destination_tvl',
      block: block.number.toString(),
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      status: 'ok',
      data: { ...data, blockHash: block.hash },
    })
    console.log(`sGHO destination TVL/cash ok: ${data.totalAssetsGho}/${data.vaultCashGho} GHO`)
  } catch {
    failures++
    console.error('sGHO destination-vault TVL unavailable: finalized vault read failed')
  }
}

if (due.spread) {
  try {
    const rate = await runSnapshot({ client })
    const measurement = rate.measurement
    const status = measurement.status === 'priced' ? 'ok' : 'unavailable'
    await store({
      routeKey: measurement.key,
      kind: 'spread',
      block: measurement.blockNumber,
      observedAt: measurement.asOf == null ? null : new Date(measurement.asOf * 1000).toISOString(),
      status,
      data: { ...measurement, freshness: rate.freshness },
    })
    console.log(`exact-leg spread ${status}: ${measurement.spread ?? 'unknown'} APY fraction`)
    if (status !== 'ok') failures++
  } catch (error) {
    failures++
    console.error('exact-leg spread unavailable: RPC or storage read failed')
  }
}

if (failures) process.exitCode = 2
