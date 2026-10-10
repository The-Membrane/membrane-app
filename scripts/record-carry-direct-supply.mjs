// Prospective, finalized aggregate cash observations for the exact
// direct-supply markets in the displayed August Carry board. These are market
// cash proxies, not holder withdrawal quotes, outcome labels, or forecasts.
// Invoke with `node --import tsx` to load the shared TypeScript market reader.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

import directReads from '../lib/carry/directSupplyReads.ts'
import marketConstants from '../lib/carry/directSupplyMarketConstants.ts'
import { makeClient, readEnv } from './lib/venue-reads.mjs'

const { readDirectSupplyCash, readDirectSupplyCashForRoute } = directReads
const { DIRECT_SUPPLY_MARKETS } = marketConstants
const HASH = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n
const MARKETS = [
  { ...DIRECT_SUPPLY_MARKETS.aaveV3Usdc, venueKind: 'aave_v3_atoken' },
  { ...DIRECT_SUPPLY_MARKETS.compoundV3Usdc, venueKind: 'compound_v3_comet' },
]
const SPARK = { ...DIRECT_SUPPLY_MARKETS.sparkLendUsdt, venueKind: 'spark_lend_atoken' }

function raw(value) {
  if (typeof value !== 'string' || !RAW.test(value) || BigInt(value) > MAX_U256)
    throw new Error('direct_supply_invalid_raw_amount')
  return value
}

function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error('direct_supply_invalid_address')
  return value.toLowerCase()
}

/** The shared reader verifies chain, market identities, one finalized block and freshness. */
export async function collectDirectSupplyObservations(
  client,
  clock = Date.now,
  reader = readDirectSupplyCash,
) {
  const observation = await reader(client, clock)
  const source = observation?.source
  const observedAtMs = Date.parse(source?.blockTimestamp ?? '')
  if (
    source?.chainId !== 1 ||
    source?.finality !== 'finalized' ||
    !Number.isSafeInteger(source?.blockNumber) ||
    source.blockNumber <= 0 ||
    !HASH.test(String(source.blockHash).toLowerCase()) ||
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== source.blockTimestamp ||
    observation?.asset?.symbol !== 'USDC' ||
    observation?.asset?.decimals !== 6 ||
    !Array.isArray(observation?.routes) ||
    observation.routes.length !== MARKETS.length
  ) {
    throw new Error('direct_supply_invalid_source_or_batch')
  }
  const expectedUnderlying = address(MARKETS[0].underlying)
  if (address(observation.asset.address) !== expectedUnderlying) {
    throw new Error('direct_supply_underlying_mismatch')
  }
  const seen = new Set()
  const rows = observation.routes.map((route) => {
    const expected = MARKETS.find((market) => market.routeKey === route?.routeKey)
    if (
      !expected ||
      route.venueKind !== expected.venueKind ||
      address(route.destination) !== address(expected.destination) ||
      seen.has(route.routeKey)
    ) {
      throw new Error('direct_supply_market_identity_mismatch')
    }
    seen.add(route.routeKey)
    return {
      routeKey: route.routeKey,
      venueKind: route.venueKind,
      destination: address(route.destination),
      underlying: expectedUnderlying,
      underlyingDecimals: 6,
      chainId: 1,
      block: String(source.blockNumber),
      blockHash: source.blockHash.toLowerCase(),
      observedAt: source.blockTimestamp,
      cashRaw: raw(route.cashRaw),
      totalSupplyRaw: raw(route.totalSupplyRaw),
    }
  })
  if (seen.size !== MARKETS.length) throw new Error('direct_supply_partial_batch')
  return { rows, source }
}

/** Spark is collected separately so a Spark RPC failure cannot suppress USDC rows. */
export async function collectSparkDirectSupplyObservation(
  client,
  clock = Date.now,
  reader = readDirectSupplyCashForRoute,
) {
  const observation = await reader(client, SPARK.routeKey, clock)
  const source = observation?.source
  const route = observation?.route
  const observedAtMs = Date.parse(source?.blockTimestamp ?? '')
  if (
    source?.chainId !== 1 ||
    source?.finality !== 'finalized' ||
    !Number.isSafeInteger(source?.blockNumber) ||
    source.blockNumber <= 0 ||
    !HASH.test(String(source.blockHash).toLowerCase()) ||
    !Number.isFinite(observedAtMs) ||
    new Date(observedAtMs).toISOString() !== source.blockTimestamp ||
    observation?.asset?.symbol !== 'USDT' ||
    observation?.asset?.decimals !== SPARK.decimals ||
    address(observation?.asset?.address) !== address(SPARK.underlying) ||
    route?.routeKey !== SPARK.routeKey ||
    route?.venueKind !== SPARK.venueKind ||
    address(route?.destination) !== address(SPARK.destination)
  ) {
    throw new Error('direct_supply_spark_identity_or_source_mismatch')
  }
  return {
    source,
    rows: [
      {
        routeKey: SPARK.routeKey,
        venueKind: SPARK.venueKind,
        destination: address(SPARK.destination),
        underlying: address(SPARK.underlying),
        underlyingDecimals: SPARK.decimals,
        chainId: 1,
        block: String(source.blockNumber),
        blockHash: source.blockHash.toLowerCase(),
        observedAt: source.blockTimestamp,
        cashRaw: raw(route.cashRaw),
        totalSupplyRaw: raw(route.totalSupplyRaw),
      },
    ],
  }
}

/** A replay must match every immutable field; otherwise the transaction rolls back. */
export async function persistDirectSupplyObservations(sql, batch) {
  return persistBatch(sql, batch, MARKETS)
}

export async function persistSparkDirectSupplyObservation(sql, batch) {
  return persistBatch(sql, batch, [SPARK])
}

async function persistBatch(sql, batch, expectedMarkets) {
  if (!Array.isArray(batch?.rows) || batch.rows.length !== expectedMarkets.length)
    throw new Error('direct_supply_partial_batch')
  const seen = new Set()
  for (const row of batch.rows) {
    const expected = expectedMarkets.find((market) => market.routeKey === row?.routeKey)
    if (
      !expected ||
      seen.has(row.routeKey) ||
      row.venueKind !== expected.venueKind ||
      address(row.destination) !== address(expected.destination) ||
      address(row.underlying) !== address(expected.underlying) ||
      row.underlyingDecimals !== expected.decimals ||
      row.chainId !== 1 ||
      !/^[1-9][0-9]*$/.test(row.block) ||
      !HASH.test(row.blockHash) ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      new Date(row.observedAt).toISOString() !== row.observedAt
    ) {
      throw new Error('direct_supply_market_identity_mismatch')
    }
    raw(row.cashRaw)
    raw(row.totalSupplyRaw)
    seen.add(row.routeKey)
  }
  const payload = JSON.stringify(
    batch.rows.map((row) => ({
      route_key: row.routeKey,
      venue_kind: row.venueKind,
      destination: row.destination,
      underlying: row.underlying,
      underlying_decimals: row.underlyingDecimals,
      chain_id: row.chainId,
      block: row.block,
      block_hash: row.blockHash,
      observed_at: row.observedAt,
      cash_raw: row.cashRaw,
      total_supply_raw: row.totalSupplyRaw,
    })),
  )
  await sql.transaction([
    sql`INSERT INTO carry_direct_supply_observations
      (route_key, venue_kind, destination, underlying, underlying_decimals,
       chain_id, block, block_hash, observed_at, cash_raw, total_supply_raw)
      SELECT route_key, venue_kind, destination, underlying, underlying_decimals,
        chain_id, block, block_hash, observed_at, cash_raw, total_supply_raw
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        route_key text, venue_kind text, destination text, underlying text,
        underlying_decimals smallint, chain_id smallint, block bigint,
        block_hash text, observed_at timestamptz, cash_raw numeric,
        total_supply_raw numeric)
      ON CONFLICT (route_key, destination, block) DO NOTHING`,
    sql`SELECT 1 / CASE WHEN (
      SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        route_key text, venue_kind text, destination text, underlying text,
        underlying_decimals smallint, chain_id smallint, block bigint,
        block_hash text, observed_at timestamptz, cash_raw numeric,
        total_supply_raw numeric)
      JOIN carry_direct_supply_observations o USING (route_key, destination, block)
      WHERE o.venue_kind = r.venue_kind AND o.underlying = r.underlying
        AND o.underlying_decimals = r.underlying_decimals AND o.chain_id = r.chain_id
        AND o.block_hash = r.block_hash AND o.observed_at = r.observed_at
        AND o.cash_raw = r.cash_raw AND o.total_supply_raw = r.total_supply_raw
    ) = ${expectedMarkets.length} THEN 1 ELSE 0 END AS exact_batch`,
  ])
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length > 2 ||
    new Set(argv).size !== argv.length ||
    argv.some((arg) => arg !== '--dry-run' && arg !== '--spark')
  )
    throw new Error(
      'usage: node --import tsx scripts/record-carry-direct-supply.mjs [--spark] [--dry-run]',
    )
  const dryRun = argv.includes('--dry-run')
  const spark = argv.includes('--spark')
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
  if (!rpcUrl || (!dryRun && !dbUrl)) throw new Error('recorder_rpc_and_database_url_required')
  const batch = spark
    ? await collectSparkDirectSupplyObservation(makeClient(rpcUrl))
    : await collectDirectSupplyObservations(makeClient(rpcUrl))
  if (!dryRun) {
    if (spark) await persistSparkDirectSupplyObservation(neon(dbUrl), batch)
    else await persistDirectSupplyObservations(neon(dbUrl), batch)
  }
  process.stdout.write(
    JSON.stringify({
      status: dryRun ? 'read_only_complete' : 'recorded',
      block: batch.source.blockNumber,
      blockHash: batch.source.blockHash,
      observedAt: batch.source.blockTimestamp,
      marketCount: batch.rows.length,
      routes: batch.rows.map((row) => ({
        routeKey: row.routeKey,
        destination: row.destination,
        cashRaw: row.cashRaw,
        totalSupplyRaw: row.totalSupplyRaw,
      })),
    }) + '\n',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Provider and database exceptions can include credential-bearing URLs.
    process.stderr.write('Carry direct-supply observation failed closed.\n')
    process.exitCode = 1
  })
}
