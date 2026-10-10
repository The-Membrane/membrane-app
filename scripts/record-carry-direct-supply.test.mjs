import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  collectDirectSupplyObservations,
  collectSparkDirectSupplyObservation,
  persistDirectSupplyObservations,
  persistSparkDirectSupplyObservation,
  main,
} from './record-carry-direct-supply.mjs'
import { apply } from './apply-carry-direct-supply-observations-ddl.mjs'

const HASH = `0x${'ab'.repeat(32)}`
const SOURCE = {
  chainId: 1,
  blockNumber: 26_080_000,
  blockHash: HASH,
  blockTimestamp: '2026-09-29T01:00:00.000Z',
  ageSeconds: 60,
  finality: 'finalized',
}
const RESULT = {
  source: SOURCE,
  asset: {
    symbol: 'USDC',
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
  },
  routes: [
    {
      routeKey: 'USDC → supply on Aave V3',
      venueKind: 'aave_v3_atoken',
      destination: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
      cashRaw: '1500000000',
      totalSupplyRaw: '2500000000',
    },
    {
      routeKey: 'USDC → supply on Compound v3',
      venueKind: 'compound_v3_comet',
      destination: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
      cashRaw: '1200000000',
      totalSupplyRaw: '3200000000',
    },
  ],
}
const SPARK_RESULT = {
  source: SOURCE,
  asset: {
    symbol: 'USDT',
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
  },
  route: {
    routeKey: 'USDT → supply on Spark',
    venueKind: 'spark_lend_atoken',
    destination: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    cashRaw: '500000000',
    totalSupplyRaw: '2500000000',
  },
}

function readerOf(value) {
  return async () => value
}

test('one finalized reader result becomes exactly two immutable market rows', async () => {
  const batch = await collectDirectSupplyObservations({}, () => 1, readerOf(RESULT))
  assert.equal(batch.rows.length, 2)
  assert.deepEqual(
    batch.rows.map((row) => row.block),
    ['26080000', '26080000'],
  )
  assert.deepEqual(
    batch.rows.map((row) => row.blockHash),
    [HASH, HASH],
  )
  assert.deepEqual(
    batch.rows.map((row) => row.underlying),
    [RESULT.asset.address, RESULT.asset.address],
  )
  assert.deepEqual(
    batch.rows.map((row) => row.cashRaw),
    ['1500000000', '1200000000'],
  )
  assert.equal(batch.rows[0].destination, RESULT.routes[0].destination.toLowerCase())
  assert.equal(batch.rows[1].venueKind, 'compound_v3_comet')
})

test('market drift, duplicate route, bad raw unit and partial batch fail closed', async () => {
  const variations = [
    { ...RESULT, source: { ...SOURCE, finality: 'latest' } },
    { ...RESULT, asset: { ...RESULT.asset, address: RESULT.routes[0].destination } },
    { ...RESULT, routes: [RESULT.routes[0]] },
    { ...RESULT, routes: [RESULT.routes[0], RESULT.routes[0]] },
    {
      ...RESULT,
      routes: [{ ...RESULT.routes[0], cashRaw: '-1' }, RESULT.routes[1]],
    },
    {
      ...RESULT,
      routes: [
        { ...RESULT.routes[0], destination: RESULT.routes[1].destination },
        RESULT.routes[1],
      ],
    },
  ]
  for (const value of variations) {
    await assert.rejects(() => collectDirectSupplyObservations({}, () => 1, readerOf(value)))
  }
})

test('storage inserts both rows atomically and rejects a conflicting replay', async () => {
  const batch = await collectDirectSupplyObservations({}, () => 1, readerOf(RESULT))
  const transactions = []
  const sql = (parts, ...values) => ({ text: parts.join('?'), values })
  sql.transaction = async (queries) => {
    transactions.push(queries)
  }
  await persistDirectSupplyObservations(sql, batch)
  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].length, 2)
  assert.match(transactions[0][0].text, /ON CONFLICT \(route_key, destination, block\) DO NOTHING/)
  assert.match(transactions[0][1].text, /o\.cash_raw = r\.cash_raw/)
  assert.match(transactions[0][1].text, /exact_batch/)
  const stored = JSON.parse(transactions[0][0].values[0])
  assert.equal(stored.length, 2)
  assert.equal(stored[0].cash_raw, '1500000000')
  assert.equal(stored[1].total_supply_raw, '3200000000')
  await assert.rejects(() => persistDirectSupplyObservations(sql, { rows: stored.slice(0, 1) }))
})

test('Spark is collected independently as one identity-checked finalized USDT row', async () => {
  let calledRoute
  const batch = await collectSparkDirectSupplyObservation(
    {},
    () => 1,
    async (_, route) => {
      calledRoute = route
      return SPARK_RESULT
    },
  )
  assert.equal(calledRoute, SPARK_RESULT.route.routeKey)
  assert.equal(batch.rows.length, 1)
  assert.deepEqual(batch.rows[0], {
    routeKey: SPARK_RESULT.route.routeKey,
    venueKind: 'spark_lend_atoken',
    destination: SPARK_RESULT.route.destination,
    underlying: SPARK_RESULT.asset.address,
    underlyingDecimals: 6,
    chainId: 1,
    block: String(SOURCE.blockNumber),
    blockHash: HASH,
    observedAt: SOURCE.blockTimestamp,
    cashRaw: SPARK_RESULT.route.cashRaw,
    totalSupplyRaw: SPARK_RESULT.route.totalSupplyRaw,
  })
  for (const corrupt of [
    { ...SPARK_RESULT, source: { ...SOURCE, finality: 'latest' } },
    { ...SPARK_RESULT, asset: { ...SPARK_RESULT.asset, symbol: 'USDC' } },
    { ...SPARK_RESULT, asset: { ...SPARK_RESULT.asset, address: RESULT.asset.address } },
    {
      ...SPARK_RESULT,
      route: { ...SPARK_RESULT.route, destination: RESULT.routes[0].destination },
    },
    { ...SPARK_RESULT, route: { ...SPARK_RESULT.route, cashRaw: '-1' } },
  ]) {
    await assert.rejects(() =>
      collectSparkDirectSupplyObservation(
        {},
        () => 1,
        async () => corrupt,
      ),
    )
  }
})

test('Spark write is its own immutable transaction and rejects cross-market rows', async () => {
  const batch = await collectSparkDirectSupplyObservation(
    {},
    () => 1,
    async () => SPARK_RESULT,
  )
  const transactions = []
  const sql = (parts, ...values) => ({ text: parts.join('?'), values })
  sql.transaction = async (queries) => transactions.push(queries)
  await persistSparkDirectSupplyObservation(sql, batch)
  assert.equal(transactions.length, 1)
  const stored = JSON.parse(transactions[0][0].values[0])
  assert.equal(stored.length, 1)
  assert.equal(stored[0].venue_kind, 'spark_lend_atoken')
  assert.equal(stored[0].underlying, SPARK_RESULT.asset.address)
  await assert.rejects(() => persistSparkDirectSupplyObservation(sql, { rows: RESULT.routes }))
  await assert.rejects(() =>
    persistSparkDirectSupplyObservation(sql, {
      rows: [{ ...batch.rows[0], underlying: RESULT.asset.address }],
    }),
  )
  await assert.rejects(() => main(['--spark', '--spark']), /usage:/)
})

test('DDL stores raw units and a database insert clock with market identity', async () => {
  const statements = []
  await apply((parts) => {
    statements.push(parts.join(''))
    return Promise.resolve()
  })
  assert.equal(statements.length, 3)
  assert.match(statements[0], /PRIMARY KEY \(route_key, destination, block\)/)
  assert.match(
    statements[0],
    /first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/,
  )
  assert.match(statements[0], /cash_raw numeric\(78,0\)/)
  assert.match(statements[0], /underlying_decimals smallint/)
  assert.match(
    statements[1],
    /DROP CONSTRAINT IF EXISTS carry_direct_supply_observations_venue_kind_check/,
  )
  assert.match(statements[1], /ADD CONSTRAINT carry_direct_supply_observations_venue_kind_check/)
  assert.match(statements[1], /spark_lend_atoken/)
})
