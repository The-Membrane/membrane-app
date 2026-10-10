import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ROUTE, SOURCE_SHA256 } from './route-cohort/usde-susde-receipts.mjs'
import { RECEIPT_SHA256, main as matchedMain } from './route-cohort/usde-susde-matched.mjs'
import { main as spreadMain } from './route-rates/usde-exact-spread.mjs'
import {
  CADENCE_MS,
  MAX_PROMOTION_AGE_MS,
  SPREAD_KEY,
  assertCanonicalAnchor,
  assertPromotable,
  assertSameBlockPair,
  createNeonStorage,
  dueKinds,
  loadOrCollect,
  main,
  projectMatched,
} from './record-usde-carry-pilot.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
// Fixture-only statfs: production defaults to the real 1 GiB guard.
const ampleSpace = async () => ({ bavail: 2_147_483_648, bsize: 1 })
const belowFloor = async () => ({ bavail: 1_000_000, bsize: 1 })
const NOW = Date.UTC(2026, 8, 28, 18, 0)
const DAY = '2026-09-28'
const SOURCE = '/Users/EBmic/membrane-app/scripts/route-cohort/.cache/usde-aug-source-a0aee855.json'
const RECEIPTS =
  '/Users/EBmic/membrane-app/scripts/route-cohort/.cache/usde-susde-receipts-413d45d1.json'
const SEALED_MATCHED =
  '/Users/EBmic/membrane-app/scripts/route-cohort/.cache/usde-susde-matched-32adb0aa.json'
const SEALED_SPREAD =
  '/Users/EBmic/membrane-app/scripts/route-cohort/.cache/usde-susde-spread-66af12ec.json'
const matched = {
  claim: 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit',
  measurement:
    'lesser_of_current_aave_usde_variable_debt_and_susde_holding_per_august_receipt_attested_wallet',
  sourceSha256: SOURCE_SHA256,
  sourceArtifactSha256: RECEIPT_SHA256,
  borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  borrowAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  blockNumber: '26070000',
  blockHash: `0x${'ab'.repeat(32)}`,
  blockTimestamp: new Date(NOW - 60_000).toISOString(),
  capturedAt: new Date(NOW).toISOString(),
  ageSecondsAtCapture: 60,
  observedWalletCount: 25,
  completeWalletCount: 25,
  unknownWalletCount: 0,
  matchedRaw: '1000000000000000000',
  destinationVaultTotalAssetsRaw: '2000000000000000000',
  rows: [{ owner: '0xnot-for-neon', debtRaw: '1' }],
}
const spread = {
  claim: 'modeled_two_leg_spread_not_cohort_realized_return',
  currentBlockNumber: matched.blockNumber,
  currentBlockHash: matched.blockHash,
  currentBlockTimestamp: matched.blockTimestamp,
  capturedAt: new Date(NOW).toISOString(),
  borrowApy: 0.05,
  yieldApy: 0.06,
  spread: 0.01,
  documentSha256: 'internal-only',
}
const ANCHOR_BLOCK = {
  number: BigInt(matched.blockNumber),
  hash: matched.blockHash,
  timestamp: BigInt(Math.floor(Date.parse(matched.blockTimestamp) / 1000)),
}
const anchorClient = {
  getChainId: async () => 1,
  getBlock: async () => ANCHOR_BLOCK,
}

test('a daily pair requires the exact block number, hash, and timestamp', () => {
  assert.equal(assertSameBlockPair(matched, spread).blockNumber, matched.blockNumber)
  for (const change of [
    { currentBlockNumber: '26070001' },
    { currentBlockHash: `0x${'cd'.repeat(32)}` },
    { currentBlockTimestamp: new Date(NOW - 50_000).toISOString() },
  ]) {
    assert.throws(
      () => assertSameBlockPair(matched, { ...spread, ...change }),
      /usde_recorder_daily_pair_block_mismatch/,
    )
  }
})

test('cached pair still needs a canonical chain-1 hash and fresh timestamp', async () => {
  const anchor = {
    blockNumber: matched.blockNumber,
    blockHash: matched.blockHash,
    blockTimestamp: matched.blockTimestamp,
  }
  assert.equal(await assertCanonicalAnchor(anchorClient, anchor, NOW), true)
  await assert.rejects(
    () =>
      assertCanonicalAnchor(
        {
          ...anchorClient,
          getBlock: async () => ({ ...ANCHOR_BLOCK, hash: `0x${'cd'.repeat(32)}` }),
        },
        anchor,
        NOW,
      ),
    /usde_recorder_daily_pair_block_changed/,
  )
  await assert.rejects(
    () => assertCanonicalAnchor(anchorClient, anchor, NOW + MAX_PROMOTION_AGE_MS),
    /usde_recorder_daily_pair_block_changed/,
  )
  await assert.rejects(
    () =>
      assertCanonicalAnchor(
        {
          ...anchorClient,
          getBlock: async ({ blockTag }) =>
            blockTag === 'finalized'
              ? { ...ANCHOR_BLOCK, number: ANCHOR_BLOCK.number - 1n }
              : ANCHOR_BLOCK,
        },
        anchor,
        NOW,
      ),
    /usde_recorder_daily_pair_block_changed/,
  )
})

test('Neon storage promotes all due rows in one transaction with in-transaction exact-key guards', async () => {
  const batches = []
  const sql = (strings, ...values) => ({ strings, values })
  sql.transaction = async (queries) => batches.push(queries)
  const storage = createNeonStorage(sql)
  const latestQuery = await storage.latestSuccess(NOW)
  assert.match(latestQuery.strings.join('?'), /observed_at <= .*::timestamptz/)
  assert.ok(latestQuery.values.includes(new Date(NOW).toISOString()))
  await storage.storePair([
    {
      routeKey: ROUTE,
      kind: 'matched_capital',
      block: '42',
      observedAt: matched.blockTimestamp,
      data: {},
    },
    {
      routeKey: SPREAD_KEY,
      kind: 'spread',
      block: '42',
      observedAt: matched.blockTimestamp,
      data: {},
    },
  ])
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 4)
  for (const guard of [batches[0][1], batches[0][3]]) {
    const query = guard.strings.join('?')
    assert.match(query, /SELECT 1 \/ CASE/)
    assert.match(query, /EXISTS/)
    assert.match(query, /status = 'ok'/)
    assert.match(query, /observed_at = .*::timestamptz/)
    assert.match(query, /data = .*::jsonb/)
    assert.match(query, /THEN 1 ELSE 0 END/)
  }
})

function reader(document, count) {
  return async (argv) => {
    const out = argv[argv.indexOf('--out') + 1]
    if (argv[0] === '--run') {
      count.runs++
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`)
      await writeFile(out, bytes, { flag: 'wx' })
      return { outputSha256: sha256(bytes) }
    }
    count.verifies++
    const expected = argv[argv.indexOf('--out-sha256') + 1]
    assert.equal(sha256(await readFile(out)), expected)
    return { status: 'verified' }
  }
}

test('cadence is per successful kind, not per attempted or failed refresh', () => {
  assert.deepEqual(dueKinds([], NOW), {
    matched_capital: true,
    destination_tvl: true,
    spread: true,
  })
  const recent = new Date(NOW - CADENCE_MS + 1000).toISOString()
  const old = new Date(NOW - CADENCE_MS).toISOString()
  assert.deepEqual(
    dueKinds(
      [
        { route_key: ROUTE, kind: 'matched_capital', observed_at: recent },
        { route_key: ROUTE, kind: 'destination_tvl', observed_at: old },
        { route_key: SPREAD_KEY, kind: 'spread', observed_at: recent },
      ],
      NOW,
    ),
    { matched_capital: false, destination_tvl: true, spread: false },
  )
})

test('a future-dated successful row cannot suppress a due UTC-day refresh', () => {
  const future = new Date(NOW + CADENCE_MS * 3).toISOString()
  const old = new Date(NOW - CADENCE_MS).toISOString()
  assert.deepEqual(
    dueKinds(
      [
        { route_key: ROUTE, kind: 'matched_capital', observed_at: future },
        { route_key: ROUTE, kind: 'matched_capital', observed_at: old },
        { route_key: ROUTE, kind: 'destination_tvl', observed_at: future },
        { route_key: SPREAD_KEY, kind: 'spread', observed_at: future },
      ],
      NOW,
    ),
    { matched_capital: true, destination_tvl: true, spread: true },
  )
})

test('late database recovery cannot reset 24h cadence from an old source block', () => {
  const sourceAt = new Date(Date.UTC(2026, 8, 27, 0, 5)).toISOString()
  const recordedLate = new Date(Date.UTC(2026, 8, 27, 23, 55)).toISOString()
  const nextDay = Date.UTC(2026, 8, 28, 0, 6)
  assert.equal(
    dueKinds(
      [
        {
          route_key: ROUTE,
          kind: 'matched_capital',
          observed_at: sourceAt,
          recorded_at: recordedLate,
        },
      ],
      nextDay,
    ).matched_capital,
    true,
  )
  assert.throws(
    () =>
      assertPromotable(
        { ...matched, capturedAt: sourceAt, blockTimestamp: sourceAt },
        'matched',
        '2026-09-27',
        Date.UTC(2026, 8, 27, 23, 55),
      ),
    /usde_recorder_artifact_not_fresh_for_store/,
  )
  assert.equal(assertPromotable(matched, 'matched', DAY, NOW + MAX_PROMOTION_AGE_MS - 60_000), true)
})

test('matched projection has only complete aggregate and separate all-depositor TVL', () => {
  const { matched: capital, destination } = projectMatched(matched, 'a'.repeat(64), 'b'.repeat(64))
  assert.equal(capital.matchedUsde, '1')
  assert.equal(destination.totalAssetsUsde, '2')
  assert.equal(destination.claim, 'all_depositor_vault_assets_not_route_tvl')
  assert.ok(!JSON.stringify([capital, destination]).includes('0xnot-for-neon'))
  assert.ok(!('rows' in capital) && !('rows' in destination))
  assert.equal(capital.blockNumber, matched.blockNumber)
  assert.equal(destination.blockNumber, matched.blockNumber)
  assert.equal(capital.blockTimestamp, matched.blockTimestamp)
  assert.equal(destination.blockTimestamp, matched.blockTimestamp)
  assert.throws(
    () => projectMatched({ ...matched, unknownWalletCount: 1 }, 'a'.repeat(64), 'b'.repeat(64)),
    /usde_recorder_matched_incomplete/,
  )
})

test('local manifest reuses a sealed reading and rejects an orphan or altered artifact', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-cache-'))
  const counts = { runs: 0, verifies: 0 }
  const verify = async (path, hash) => {
    counts.verifies++
    assert.equal(sha256(await readFile(path)), hash)
  }
  const run = async (path) => {
    counts.runs++
    const bytes = Buffer.from(`${JSON.stringify(spread)}\n`)
    await writeFile(path, bytes, { flag: 'wx' })
    return { outputSha256: sha256(bytes) }
  }
  try {
    const options = {
      kind: 'spread',
      day: DAY,
      cacheDir: folder,
      run,
      verify,
      statfsFn: ampleSpace,
    }
    assert.equal((await loadOrCollect(options)).reused, false)
    assert.equal((await loadOrCollect(options)).reused, true)
    assert.equal(counts.runs, 1)
    await writeFile(join(folder, 'spread-2026-09-28.json'), '{"changed":true}\n')
    await assert.rejects(() => loadOrCollect(options), /usde_recorder_artifact_hash_mismatch/)
    await writeFile(join(folder, 'matched-2026-09-28.json'), '{}\n')
    await assert.rejects(
      () => loadOrCollect({ ...options, kind: 'matched' }),
      /usde_recorder_orphan_artifact/,
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('known physical bootstrap creates a manifest without requery', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-bootstrap-'))
  try {
    const sourcePath = join(folder, 'sealed.json')
    const bytes = Buffer.from(`${JSON.stringify(spread)}\n`)
    await writeFile(sourcePath, bytes)
    let runs = 0
    const result = await loadOrCollect({
      kind: 'spread',
      day: DAY,
      cacheDir: join(folder, 'cache'),
      bootstrap: { day: DAY, path: sourcePath, sha256: sha256(bytes) },
      run: async () => {
        runs++
        throw new Error('must not requery')
      },
      verify: async (path, hash) => assert.equal(sha256(await readFile(path)), hash),
      statfsFn: ampleSpace,
    })
    assert.equal(result.reused, true)
    assert.equal(runs, 0)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('the production writer floor remains fail-closed under a low-space statfs result', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-disk-floor-'))
  try {
    const sourcePath = join(folder, 'sealed.json')
    const bytes = Buffer.from(`${JSON.stringify(spread)}\n`)
    await writeFile(sourcePath, bytes)
    await assert.rejects(
      () =>
        loadOrCollect({
          kind: 'spread',
          day: DAY,
          cacheDir: join(folder, 'cache'),
          bootstrap: { day: DAY, path: sourcePath, sha256: sha256(bytes) },
          run: async () => {
            throw new Error('must not requery')
          },
          verify: async () => {
            throw new Error('must not verify unmanifested output')
          },
          statfsFn: belowFloor,
        }),
      /usde_recorder_disk_reserve_reached/,
    )
    assert.equal(existsSync(join(folder, 'cache', `spread-${DAY}.manifest.json`)), false)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('a cached due spread cannot RPC-read or promote below the run-level disk floor', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-cached-disk-floor-'))
  const counts = { runs: 0, verifies: 0 }
  let diskStats = ampleSpace
  let rpcCalls = 0
  let storeCalls = 0
  const recent = new Date(NOW - 60_000).toISOString()
  const dependencies = {
    clock: () => NOW,
    statfsFn: (path) => diskStats(path),
    env: { get: () => 'https://redacted.invalid' },
    client: {
      getChainId: async () => {
        rpcCalls++
        return 1
      },
      getBlock: async () => {
        rpcCalls++
        return ANCHOR_BLOCK
      },
    },
    storage: {
      latestSuccess: async () => [
        { route_key: ROUTE, kind: 'matched_capital', observed_at: recent },
        { route_key: ROUTE, kind: 'destination_tvl', observed_at: recent },
      ],
      storePair: async () => {
        storeCalls++
        throw new Error('temporary Neon failure')
      },
    },
    cohortOutputDir: join(folder, 'cohort'),
    rateOutputDir: join(folder, 'rates'),
    bootstrapMatched: null,
    bootstrapSpread: null,
    spreadReader: reader(spread, counts),
  }
  try {
    const first = await main(['--run'], dependencies)
    assert.deepEqual(first.failed, ['spread'])
    assert.ok(existsSync(join(folder, 'rates', `spread-${DAY}.manifest.json`)))
    assert.equal(counts.runs, 1)
    const priorRpcCalls = rpcCalls
    const priorStoreCalls = storeCalls
    diskStats = belowFloor
    await assert.rejects(() => main(['--run'], dependencies), /usde_recorder_disk_reserve_reached/)
    assert.equal(rpcCalls, priorRpcCalls)
    assert.equal(storeCalls, priorStoreCalls)
    assert.equal(counts.runs, 1)
    assert.equal(counts.verifies, 1)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('a transient offline-verify failure retries from the sealed manifest, without requery', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-retry-'))
  let runs = 0
  let checks = 0
  try {
    const options = {
      kind: 'spread',
      day: DAY,
      cacheDir: folder,
      run: async (path) => {
        runs++
        const bytes = Buffer.from(`${JSON.stringify(spread)}\n`)
        await writeFile(path, bytes, { flag: 'wx' })
        return { outputSha256: sha256(bytes) }
      },
      verify: async () => {
        if (checks++ === 0) throw new Error('temporary verifier failure')
      },
      statfsFn: ampleSpace,
    }
    await assert.rejects(() => loadOrCollect(options), /temporary verifier failure/)
    assert.ok(existsSync(join(folder, `spread-${DAY}.manifest.json`)))
    assert.equal((await loadOrCollect(options)).reused, true)
    assert.equal(runs, 1)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('verified cache from a different capture day cannot be promoted', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-record-wrong-day-'))
  try {
    await assert.rejects(
      () =>
        loadOrCollect({
          kind: 'spread',
          day: DAY,
          cacheDir: folder,
          run: async (path) => {
            const bytes = Buffer.from(
              `${JSON.stringify({ ...spread, capturedAt: '2026-09-27T23:59:00.000Z' })}\n`,
            )
            await writeFile(path, bytes, { flag: 'wx' })
            return { outputSha256: sha256(bytes) }
          },
          verify: async (path, hash) => assert.equal(sha256(await readFile(path)), hash),
          statfsFn: ampleSpace,
        }),
      /usde_recorder_cache_capture_day_mismatch/,
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test(
  'a failed capital-pair transaction leaves the independent spread promoted and retries from the seal',
  {
    skip: !existsSync(SOURCE) || !existsSync(RECEIPTS),
  },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-main-'))
    const latest = []
    const stored = []
    const matchedCount = { runs: 0, verifies: 0 }
    const spreadCount = { runs: 0, verifies: 0 }
    let failPairOnce = true
    let canonicalHash = matched.blockHash
    const storage = {
      latestSuccess: async () => latest,
      storePair: async (rows) => {
        if (failPairOnce) {
          failPairOnce = false
          throw new Error('database down')
        }
        stored.push(...rows)
        latest.push(
          ...rows.map((row) => ({
            route_key: row.routeKey,
            kind: row.kind,
            observed_at: row.observedAt,
          })),
        )
      },
    }
    const deps = {
      clock: () => NOW,
      statfsFn: ampleSpace,
      env: { get: () => 'https://redacted.invalid' },
      client: {
        ...anchorClient,
        getBlock: async () => ({ ...ANCHOR_BLOCK, hash: canonicalHash }),
      },
      storage,
      sourcePath: SOURCE,
      receiptPath: RECEIPTS,
      cohortOutputDir: join(folder, 'cohort'),
      rateOutputDir: join(folder, 'rates'),
      bootstrapMatched: null,
      bootstrapSpread: null,
      matchedReader: reader(matched, matchedCount),
      spreadReader: reader(spread, spreadCount),
    }
    try {
      const first = await main(['--run'], deps)
      assert.deepEqual(first.failed, ['matched_capital', 'destination_tvl'])
      assert.deepEqual(first.stored, ['spread'])
      assert.equal(matchedCount.runs, 1)
      assert.equal(spreadCount.runs, 1)
      assert.equal(stored.length, 1)
      assert.ok(!JSON.stringify(stored).includes('0xnot-for-neon'))
      canonicalHash = `0x${'cd'.repeat(32)}`
      const divergent = await main(['--run'], deps)
      assert.deepEqual(divergent.stored, [])
      assert.deepEqual(divergent.failed, ['matched_capital', 'destination_tvl'])
      assert.equal(stored.length, 1)
      canonicalHash = matched.blockHash
      const second = await main(['--run'], deps)
      assert.deepEqual(second.stored, ['matched_capital', 'destination_tvl'])
      assert.deepEqual(second.reused, ['matched'])
      assert.equal(matchedCount.runs, 1)
      assert.equal(spreadCount.runs, 1)
      assert.equal(stored.length, 3)
      assert.deepEqual((await main(['--run'], deps)).stored, [])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'a failed rate read does not roll back capital, and rate resumes at a newer finalized head',
  { skip: !existsSync(SOURCE) || !existsSync(RECEIPTS) },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-retry-anchor-'))
    const stored = []
    let finalizedCalls = 0
    let spreadFails = true
    const spreadCount = { runs: 0, verifies: 0 }
    const nextBlock = {
      ...ANCHOR_BLOCK,
      number: ANCHOR_BLOCK.number + 1n,
      hash: `0x${'cd'.repeat(32)}`,
    }
    const latest = []
    const dependencies = {
      clock: () => NOW,
      statfsFn: ampleSpace,
      env: { get: () => 'https://redacted.invalid' },
      client: {
        getChainId: async () => 1,
        getBlock: async ({ blockTag, blockNumber }) => {
          if (blockTag === 'finalized') {
            finalizedCalls++
            return finalizedCalls <= 2 ? ANCHOR_BLOCK : nextBlock
          }
          return blockNumber === ANCHOR_BLOCK.number ? ANCHOR_BLOCK : nextBlock
        },
      },
      storage: {
        latestSuccess: async () => latest,
        storePair: async (rows) => {
          stored.push(...rows)
          latest.push(
            ...rows.map((row) => ({
              route_key: row.routeKey,
              kind: row.kind,
              observed_at: row.observedAt,
            })),
          )
        },
      },
      sourcePath: SOURCE,
      receiptPath: RECEIPTS,
      cohortOutputDir: join(folder, 'cohort'),
      rateOutputDir: join(folder, 'rates'),
      bootstrapMatched: null,
      bootstrapSpread: null,
      matchedReader: reader(matched, { runs: 0, verifies: 0 }),
      spreadReader: async (argv, options) => {
        if (argv[0] === '--run' && spreadFails) {
          spreadFails = false
          throw new Error('temporary RPC failure')
        }
        if (argv[0] === '--run' && !spreadFails)
          assert.deepEqual(options.anchor, {
            blockNumber: nextBlock.number.toString(),
            blockHash: nextBlock.hash,
            blockTimestamp: matched.blockTimestamp,
          })
        return reader(
          {
            ...spread,
            currentBlockNumber: nextBlock.number.toString(),
            currentBlockHash: nextBlock.hash,
          },
          spreadCount,
        )(argv)
      },
    }
    try {
      const first = await main(['--run'], dependencies)
      assert.deepEqual(first.stored, ['matched_capital', 'destination_tvl'])
      assert.deepEqual(first.failed, ['spread'])
      const second = await main(['--run'], dependencies)
      assert.deepEqual(second.stored, ['spread'])
      assert.deepEqual(second.failed, [])
      assert.equal(finalizedCalls, 4)
      assert.equal(stored.length, 3)
      assert.notEqual(stored[0].block, stored[2].block)
      assert.equal(spreadCount.runs, 1)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'failed capital transaction before midnight leaves no orphan capital row; next UTC day seals a new pair',
  { skip: !existsSync(SOURCE) || !existsSync(RECEIPTS) },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-midnight-'))
    let nowMs = Date.UTC(2026, 8, 28, 23, 58)
    let failOnce = true
    const stored = []
    const latest = []
    const reading = () => {
      const blockNumber = nowMs < Date.UTC(2026, 8, 29) ? '26071000' : '26071020'
      const blockHash = `0x${(blockNumber === '26071000' ? 'ab' : 'cd').repeat(32)}`
      const blockTimestamp = new Date(nowMs - 60_000).toISOString()
      return {
        blockNumber,
        blockHash,
        blockTimestamp,
        capturedAt: new Date(nowMs).toISOString(),
      }
    }
    const dependencies = {
      clock: () => nowMs,
      statfsFn: ampleSpace,
      env: { get: () => 'https://redacted.invalid' },
      client: {
        getChainId: async () => 1,
        getBlock: async () => ({
          number: BigInt(reading().blockNumber),
          hash: reading().blockHash,
          timestamp: BigInt(Math.floor(Date.parse(reading().blockTimestamp) / 1000)),
        }),
      },
      storage: {
        latestSuccess: async () => latest,
        storePair: async (rows) => {
          if (failOnce) {
            failOnce = false
            throw new Error('Neon unavailable')
          }
          stored.push(...rows)
          latest.push(
            ...rows.map((row) => ({
              route_key: row.routeKey,
              kind: row.kind,
              observed_at: row.observedAt,
            })),
          )
        },
      },
      sourcePath: SOURCE,
      receiptPath: RECEIPTS,
      cohortOutputDir: join(folder, 'cohort'),
      rateOutputDir: join(folder, 'rates'),
      bootstrapMatched: null,
      bootstrapSpread: null,
      matchedReader: (argv) => reader({ ...matched, ...reading() }, { runs: 0, verifies: 0 })(argv),
      spreadReader: (argv) => {
        const current = reading()
        return reader(
          {
            ...spread,
            currentBlockNumber: current.blockNumber,
            currentBlockHash: current.blockHash,
            currentBlockTimestamp: current.blockTimestamp,
            capturedAt: current.capturedAt,
          },
          { runs: 0, verifies: 0 },
        )(argv)
      },
    }
    try {
      const first = await main(['--run'], dependencies)
      assert.deepEqual(first.stored, ['spread'])
      assert.deepEqual(first.failed, ['matched_capital', 'destination_tvl'])
      assert.equal(stored.length, 1)
      nowMs = Date.UTC(2026, 8, 29, 0, 2)
      const next = await main(['--run'], dependencies)
      assert.equal(next.day, '2026-09-29')
      assert.deepEqual(next.stored, ['matched_capital', 'destination_tvl'])
      assert.ok(stored.slice(1).every((row) => row.block === '26071020'))
      assert.ok(existsSync(join(folder, 'cohort', 'matched-2026-09-28.json')))
      assert.ok(existsSync(join(folder, 'cohort', 'matched-2026-09-29.json')))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'bad cached capital source blocks only its atomic pair, not the independent spread',
  {
    skip: !existsSync(SOURCE) || !existsSync(RECEIPTS),
  },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-bad-source-'))
    try {
      const badSource = join(folder, 'bad-source.json')
      await writeFile(badSource, Buffer.concat([await readFile(SOURCE), Buffer.from(' ')]))
      const stored = []
      const result = await main(['--run'], {
        clock: () => NOW,
        statfsFn: ampleSpace,
        env: { get: () => 'https://redacted.invalid' },
        client: anchorClient,
        storage: { latestSuccess: async () => [], storePair: async (rows) => stored.push(...rows) },
        sourcePath: badSource,
        receiptPath: RECEIPTS,
        cohortOutputDir: join(folder, 'cohort'),
        rateOutputDir: join(folder, 'rates'),
        bootstrapMatched: null,
        bootstrapSpread: null,
        spreadReader: reader(spread, { runs: 0, verifies: 0 }),
      })
      assert.deepEqual(result.failed, ['matched_capital', 'destination_tvl'])
      assert.deepEqual(result.stored, ['spread'])
      assert.equal(stored.length, 1)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'cached spread retries independently after capital failure and refuses a changed canonical hash',
  { skip: !existsSync(SOURCE) || !existsSync(RECEIPTS) },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-spread-retry-'))
    const badSource = join(folder, 'bad-source.json')
    await writeFile(badSource, Buffer.concat([await readFile(SOURCE), Buffer.from(' ')]))
    const spreadCount = { runs: 0, verifies: 0 }
    const stored = []
    let failStore = true
    let canonicalHash = matched.blockHash
    const deps = {
      clock: () => NOW,
      statfsFn: ampleSpace,
      env: { get: () => 'https://redacted.invalid' },
      client: {
        ...anchorClient,
        getBlock: async () => ({ ...ANCHOR_BLOCK, hash: canonicalHash }),
      },
      storage: {
        latestSuccess: async () => [],
        storePair: async (rows) => {
          if (failStore) {
            failStore = false
            throw new Error('Neon temporarily unavailable')
          }
          stored.push(...rows)
        },
      },
      sourcePath: badSource,
      receiptPath: RECEIPTS,
      cohortOutputDir: join(folder, 'cohort'),
      rateOutputDir: join(folder, 'rates'),
      bootstrapMatched: null,
      bootstrapSpread: null,
      spreadReader: reader(spread, spreadCount),
    }
    try {
      const first = await main(['--run'], deps)
      assert.deepEqual(first.failed, ['matched_capital', 'destination_tvl', 'spread'])
      assert.deepEqual(first.stored, [])
      assert.equal(spreadCount.runs, 1)
      canonicalHash = `0x${'cd'.repeat(32)}`
      const changed = await main(['--run'], deps)
      assert.deepEqual(changed.failed, ['matched_capital', 'destination_tvl', 'spread'])
      assert.deepEqual(changed.reused, ['spread'])
      assert.equal(stored.length, 0)
      canonicalHash = matched.blockHash
      const resumed = await main(['--run'], deps)
      assert.deepEqual(resumed.failed, ['matched_capital', 'destination_tvl'])
      assert.deepEqual(resumed.stored, ['spread'])
      assert.deepEqual(resumed.reused, ['spread'])
      assert.equal(spreadCount.runs, 1)
      assert.equal(spreadCount.verifies, 3)
      assert.equal(stored.length, 1)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'a single due capital kind refreshes both rows from one verified artifact, without re-reading rate',
  { skip: !existsSync(SOURCE) || !existsSync(RECEIPTS) },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-capital-pair-'))
    const stored = []
    const rateCount = { runs: 0, verifies: 0 }
    const recent = new Date(NOW - 60_000).toISOString()
    const old = new Date(NOW - CADENCE_MS).toISOString()
    try {
      const result = await main(['--run'], {
        clock: () => NOW,
        statfsFn: ampleSpace,
        env: { get: () => 'https://redacted.invalid' },
        client: anchorClient,
        storage: {
          latestSuccess: async () => [
            { route_key: ROUTE, kind: 'matched_capital', observed_at: recent },
            { route_key: ROUTE, kind: 'destination_tvl', observed_at: old },
            { route_key: SPREAD_KEY, kind: 'spread', observed_at: recent },
          ],
          storePair: async (rows) => stored.push(rows),
        },
        sourcePath: SOURCE,
        receiptPath: RECEIPTS,
        cohortOutputDir: join(folder, 'cohort'),
        rateOutputDir: join(folder, 'rates'),
        bootstrapMatched: null,
        bootstrapSpread: null,
        matchedReader: reader(matched, { runs: 0, verifies: 0 }),
        spreadReader: reader(spread, rateCount),
      })
      assert.deepEqual(result.due, {
        matched_capital: false,
        destination_tvl: true,
        spread: false,
      })
      assert.deepEqual(result.stored, ['matched_capital', 'destination_tvl'])
      assert.equal(stored.length, 1)
      assert.deepEqual(
        stored[0].map((row) => row.kind),
        ['matched_capital', 'destination_tvl'],
      )
      assert.equal(stored[0][0].block, stored[0][1].block)
      assert.equal(rateCount.runs, 0)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

test(
  'legacy physical Sep 27 seals remain immutable but do not become a same-block pair',
  { skip: ![SOURCE, RECEIPTS, SEALED_MATCHED, SEALED_SPREAD].every(existsSync) },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-record-physical-'))
    const stored = []
    try {
      const result = await main(['--run'], {
        clock: () => Date.UTC(2026, 8, 27, 18, 0),
        statfsFn: ampleSpace,
        env: { get: () => 'https://redacted.invalid' },
        client: {
          getChainId: () => {
            throw new Error('must not use RPC')
          },
        },
        storage: { latestSuccess: async () => [], storePair: async (rows) => stored.push(...rows) },
        sourcePath: SOURCE,
        receiptPath: RECEIPTS,
        cohortOutputDir: join(folder, 'cohort'),
        rateOutputDir: join(folder, 'rates'),
        bootstrapMatched: {
          day: '2026-09-27',
          path: SEALED_MATCHED,
          sha256: '32adb0aae6817a12e9c452ecb5bb5ce6349d607941a02e02cfa77e4de2b481eb',
        },
        bootstrapSpread: {
          day: '2026-09-27',
          path: SEALED_SPREAD,
          sha256: '66af12ec3d0c09c71530890ebfc0540ec69fb375e862934088755ae8d5ec20a8',
        },
        matchedReader: matchedMain,
        spreadReader: spreadMain,
      })
      assert.deepEqual(result.failed, ['matched_capital', 'destination_tvl', 'spread'])
      assert.deepEqual(result.reused, ['matched', 'spread'])
      assert.deepEqual(result.stored, [])
      assert.equal(stored.length, 0)
      assert.ok(!stored.some((row) => 'rows' in row.data))
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)
