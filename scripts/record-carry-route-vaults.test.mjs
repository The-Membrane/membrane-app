import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  collectRouteVaultObservations,
  deriveRouteVaultSubjects,
  loadRouteVaultUniverse,
  persistRouteVaultObservations,
} from './record-carry-route-vaults.mjs'
import { apply } from './apply-carry-route-vault-observations-ddl.mjs'

const HASH = `0x${'ab'.repeat(32)}`
const VAULT = '0x0000000000000000000000000000000000000011'
const ASSET = '0x0000000000000000000000000000000000000022'
const AT = Date.UTC(2026, 8, 28, 18, 0, 0)
const header = { number: 26_000_000n, hash: HASH, timestamp: BigInt(AT / 1000 - 60) }
const provenance = {
  cohortId: 'aug-2026-ab-vault-routes',
  seedSourceSha256: 'a'.repeat(64),
  seedSha256: 'b'.repeat(64),
  boardSha256: 'c'.repeat(64),
  displayedRoutesSha256: 'd'.repeat(64),
}
const universe = {
  displayedRouteCount: 25,
  unresolvedRoutes: ['USDT → supply on Spark'],
  subjects: [
    { routeKey: 'AUSD → Staked USDat [USDat]', vault: VAULT },
    { routeKey: 'USDC → VaultV2 [USDC]', vault: VAULT },
  ],
}

function mockClient(change = {}) {
  const calls = []
  let headerReads = 0
  const client = {
    getChainId: async () => change.chainId ?? 1,
    getBlock: async (request) => {
      calls.push(['header', request])
      headerReads++
      return headerReads === 2 && change.endHeader ? change.endHeader : header
    },
    getCode: async (request) => {
      calls.push(['code', request])
      return change.noCodeAt === request.address ? '0x' : '0x6000'
    },
    readContract: async (request) => {
      calls.push(['contract', request])
      if (request.functionName === change.failAt) throw new Error('rpc_unavailable')
      return {
        asset: ASSET,
        decimals: 18,
        totalAssets: 10_000n,
        totalSupply: 9_000n,
        balanceOf: 1_000n,
      }[request.functionName]
    },
  }
  return { client, calls }
}

test('the exact 25 displayed August groups cover 22 mapped routes, 64 pairs, and 63 vaults', async () => {
  const { universe: actual, provenance: source } = await loadRouteVaultUniverse()
  assert.equal(actual.displayedRouteCount, 25)
  assert.equal(actual.subjects.length, 64)
  assert.equal(new Set(actual.subjects.map((row) => row.routeKey)).size, 22)
  assert.equal(new Set(actual.subjects.map((row) => row.vault)).size, 63)
  assert.deepEqual(actual.unresolvedRoutes, [
    'USDT → supply on Spark',
    'USDC → supply on Aave V3',
    'USDC → supply on Compound v3',
  ])
  assert.equal(source.cohortId, 'aug-2026-ab-vault-routes')
  assert.match(source.seedSha256, /^[0-9a-f]{64}$/)
  assert.match(source.boardSha256, /^[0-9a-f]{64}$/)
})

test('source mismatch or a newly added displayed route fails closed', () => {
  const board = {
    schemaVersion: 1,
    routes: Array.from({ length: 25 }, (_, i) => ({ route: `r${i}` })),
    sourceSha256: { 'routes_ab.json': 'a'.repeat(64) },
  }
  const seed = { schemaVersion: 1, source: { sha256: 'b'.repeat(64) }, positions: [] }
  assert.throws(() => deriveRouteVaultSubjects(board, seed), /source_shape_or_provenance/)
  seed.source.sha256 = 'a'.repeat(64)
  board.routes.push({ route: 'new' })
  assert.throws(() => deriveRouteVaultSubjects(board, seed), /source_shape_or_provenance/)
})

test('one finalized block anchors every distinct vault read and every route row', async () => {
  const { client, calls } = mockClient()
  const result = await collectRouteVaultObservations(client, universe, provenance, () => AT)
  assert.equal(result.rows.length, 2)
  assert.equal(result.vaultCount, 1)
  assert.equal(result.block, header.number.toString())
  assert.equal(result.blockHash, HASH)
  assert.equal(result.rows[0].cashRaw, '1000')
  assert.equal(result.rows[1].totalAssetsRaw, '10000')
  assert.equal(result.rows[0].asset, ASSET)
  assert.equal(result.rows[0].observedAt, new Date(AT - 60_000).toISOString())
  assert.equal(calls.filter(([kind]) => kind === 'contract').length, 6)
  for (const [kind, request] of calls) {
    if (kind !== 'header') assert.equal(request.blockNumber, header.number)
  }
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'header').map(([, r]) => r),
    [{ blockTag: 'finalized' }, { blockNumber: header.number }],
  )
})

test('wrong chain, missing code, failed read, stale clock, or changed block aborts whole batch', async () => {
  for (const change of [
    { chainId: 10 },
    { noCodeAt: VAULT },
    { noCodeAt: ASSET },
    { failAt: 'totalAssets' },
    { endHeader: { ...header, hash: `0x${'cd'.repeat(32)}` } },
  ]) {
    const { client } = mockClient(change)
    await assert.rejects(() =>
      collectRouteVaultObservations(client, universe, provenance, () => AT),
    )
  }
  const { client } = mockClient()
  await assert.rejects(
    () =>
      collectRouteVaultObservations(client, universe, provenance, () => AT + 2 * 60 * 60 * 1000),
    /not_fresh/,
  )
})

test('storage is one transaction with append-only conflict handling and exact replay assertion', async () => {
  const { client } = mockClient()
  const batch = await collectRouteVaultObservations(client, universe, provenance, () => AT)
  const calls = []
  const sql = (parts, ...values) => ({ text: parts.join('?'), values })
  sql.transaction = async (queries) => {
    calls.push(queries)
    return []
  }
  await persistRouteVaultObservations(sql, batch)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.match(calls[0][0].text, /ON CONFLICT \(route_key, vault, block\) DO NOTHING/)
  assert.match(calls[0][1].text, /exact_batch/)
  const stored = JSON.parse(calls[0][0].values[0])
  assert.equal(stored.length, 2)
  assert.equal(stored[0].route_key, universe.subjects[0].routeKey)
  assert.equal(stored[0].vault, VAULT)
  assert.equal(stored[0].cash_raw, '1000')
  assert.equal(stored[0].block_hash, HASH)
  assert.equal(stored[0].displayed_routes_sha256, provenance.displayedRoutesSha256)
  const ddl = []
  await apply((parts) => {
    ddl.push(parts.join(''))
    return Promise.resolve()
  })
  assert.equal(ddl.length, 2)
  assert.match(ddl[0], /first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp\(\)/)
  assert.match(ddl[0], /PRIMARY KEY \(route_key, vault, block\)/)
  assert.match(ddl[1], /observed_at DESC/)
})
