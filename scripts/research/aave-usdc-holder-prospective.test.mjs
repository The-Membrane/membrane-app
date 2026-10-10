import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { assayEndpoint } from './aave-usdc-holder-flow-pair.mjs'

import {
  append,
  compareFutureQuotes,
  issue,
  readChain,
  score,
  selectDue,
  sourceManifest,
  targets,
  verifyLedgers,
} from './aave-usdc-holder-prospective.mjs'

const hash = (digit) => `0x${digit.repeat(64)}`
const sha = (digit) => digit.repeat(64)
const holder = `0x${'1'.repeat(40)}`
const destination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const underlying = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const routeKey = 'USDC → supply on Aave V3'
const start = Date.parse('2026-10-01T12:00:00.000Z')
const root = () => mkdtempSync(join(tmpdir(), 'aave-holder-test-'))
const joined = () => ({
  study: 'aave-usdc-cash-direct-flow-join-v1',
  fromBlock: 99,
  toBlock: 100,
  slices: [
    {
      fromExclusive: 99,
      toInclusive: 100,
      toHash: hash('a'),
      sources: {
        cashSidecarSha256: sha('a'),
        cashLeftSha256: sha('b'),
        cashProjectionSha256: sha('c'),
      },
    },
  ],
  directSupplySourceFiles: [{ file: 'supply-aaveV3Usdc-100-100.json', sha256: sha('d') }],
  directWithdrawalSourceFiles: [{ file: 'aaveV3Usdc-100-100.json', sha256: sha('e') }],
})

test('V2 source manifest binds verified pre-window continuity', () => {
  const v2 = {
    ...joined(),
    study: 'aave-usdc-cash-direct-flow-join-v2',
    fromBlock: 26_095_417,
    toBlock: 26_095_674,
    slices: [{ ...joined().slices[0], fromExclusive: 26_095_417, toInclusive: 26_095_674 }],
    continuity: {
      v1ThroughBlock: 26_095_417,
      v1LastHash: hash('b'),
      verifiedV2ThroughBlock: 26_095_674,
      verifiedV2LastHash: hash('a'),
      archivePrefixSha256: sha('f'),
      archivedSlices: 65,
      windowed: false,
    },
  }
  const first = sourceManifest(v2)
  assert.equal(first.manifest.joinStudy, v2.study)
  assert.equal(first.manifest.continuity.archivedSlices, 65)
  assert.notEqual(
    first.digest,
    sourceManifest({ ...v2, continuity: { ...v2.continuity, archivedSlices: 66 } }).digest,
  )
  assert.throws(
    () => sourceManifest({ ...v2, continuity: null }),
    /aave_holder_source_manifest_invalid/,
  )
  assert.throws(
    () =>
      sourceManifest({ ...v2, continuity: { ...v2.continuity, verifiedV2LastHash: hash('c') } }),
    /aave_holder_source_manifest_invalid/,
  )
})
const baselineAssay = (source, rpcOperators) => ({
  status: 'same_holder_same_block_two_origin_assay',
  endpoint: { blockNumber: 100, blockHash: hash('a') },
  holder,
  assetsRaw: '1000000',
  balanceRaw: '2000000',
  simulation: { status: 'success' },
  noDeployedCodeAtEndpoint: true,
  source,
  rpcOperators,
})
function harness() {
  let number = 102
  let timestampMs = start - 60_000
  const clients = [0, 1].map(() => ({
    getBlock: async (args) => {
      if (args.blockNumber === 100n)
        return { number: 100n, hash: hash('a'), timestamp: BigInt((start - 300_000) / 1000) }
      return {
        number: BigInt(number),
        hash: hash(number === 102 ? 'b' : 'c'),
        timestamp: BigInt(timestampMs / 1000),
      }
    },
  }))
  const source = {
    joinedContentSha256: createHash('sha256').update(JSON.stringify(joined())).digest('hex'),
  }
  const load = () => ({
    endpoint: { blockNumber: 100, blockHash: hash('a') },
    candidates: [
      {
        holder,
        kind: 'withdraw',
        blockNumber: 100,
        blockHash: hash('a'),
        transactionHash: hash('d'),
        logIndex: 1,
      },
    ],
    source,
  })
  const setHead = (n, time) => {
    number = n
    timestampMs = time
  }
  return {
    clients,
    load,
    replay: joined,
    rpcOperators: ['ankr', 'drpc'],
    setHead,
    assay: async ({ source: supplied, rpcOperators }) => {
      assert.equal(supplied.joinedContentSha256, source.joinedContentSha256)
      assert.deepEqual(rpcOperators, ['ankr', 'drpc'])
      return baselineAssay(supplied, rpcOperators)
    },
  }
}
const futureQuote = (block, balance = '2000000', simulation = { status: 'success' }) => ({
  status: 'checked_at_finalized_block',
  source: { chainId: 1, blockNumber: block.number, blockHash: block.hash },
  routeKey,
  market: {
    kind: 'aaveV3Usdc',
    address: destination,
    assetAddress: underlying,
    assetDecimals: 6,
    identity: 'pinned_market_and_live_underlying',
  },
  owner: holder,
  position: { suppliedBalanceRaw: balance },
  request: { assetsRaw: '1000000' },
  simulation,
})

test('issue binds exact owner, Q, B/hash, source digest and three future targets', async () => {
  const dir = root()
  const h = harness()
  const result = await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  assert.equal(result.status, 'issued')
  const saved = verifyLedgers(dir).issues[0]
  assert.equal(saved.holder, holder)
  assert.equal(saved.qRaw, '1000000')
  assert.equal(saved.baseline.blockHash, hash('a'))
  assert.equal(saved.baseline.sourceDigest, sourceManifest(joined()).digest)
  assert.deepEqual(
    saved.targets.map((row) => row.horizonHours),
    [1, 4, 24],
  )
  assert.equal(saved.keyControlVerified, false)
  assert.equal(saved.forecast, false)
  assert.equal(
    (await issue({ ...h, root: dir, nowMs: start, clock: () => start })).status,
    'already_issued',
  )
})

test('issuer rejects a sub-Q assay without writing an issue', async () => {
  const dir = root()
  const h = harness()
  await assert.rejects(
    () =>
      issue({
        ...h,
        root: dir,
        nowMs: start,
        clock: () => start,
        assay: async (args) => ({
          ...baselineAssay(args.source, args.rpcOperators),
          assetsRaw: '500000',
          balanceRaw: '500000',
        }),
      }),
    /aave_holder_baseline_assay_invalid/,
  )
  assert.equal(verifyLedgers(dir).issues.length, 0)
})

test('issue passes production assay source, operator and candidate contract', async () => {
  const dir = root()
  const h = harness()
  const clients = h.clients.map((client) => ({
    ...client,
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_getCode')
      assert.equal(params[1].blockHash, hash('a'))
      return '0x'
    },
    readContract: async ({ blockHash }) => {
      assert.equal(blockHash, hash('a'))
      return 2_000_000n
    },
  }))
  const result = await issue({
    ...h,
    clients,
    root: dir,
    nowMs: start,
    clock: () => start,
    assay: (args) =>
      assayEndpoint({
        ...args,
        quoteReader: async (_client, request, _now, historical) => {
          assert.equal(request.owner, holder)
          assert.equal(historical.blockHash, hash('a'))
          return futureQuote({ number: 100, hash: hash('a') })
        },
      }),
  })
  assert.equal(result.status, 'issued')
  assert.deepEqual(verifyLedgers(dir).issues[0].rpcOperators, ['ankr', 'drpc'])
})

test('same holder and Q at a future finalized block records callable outcome', async () => {
  const dir = root()
  const h = harness()
  await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  const at = start + 3_600_000 + 60_000
  h.setHead(110, at)
  let calls = 0
  const result = await score({
    clients: h.clients,
    rpcOperators: h.rpcOperators,
    root: dir,
    nowMs: at,
    clock: () => at,
    quoteReader: async (_client, request, _now, historical) => {
      calls++
      assert.equal(request.owner, holder)
      assert.equal(request.assetsRaw, '1000000')
      assert.equal(historical.blockNumber, 110n)
      assert.equal(historical.blockHash, hash('c'))
      return futureQuote({ number: 110, hash: hash('c') })
    },
  })
  assert.equal(result.outcome, 'simulated_callable')
  assert.equal(calls, 2)
  const saved = verifyLedgers(dir).scores[0]
  assert.equal(saved.issueSha256, readChain('issues', dir)[0].sha256)
  assert.equal(saved.forecast, false)
})

test('balance below frozen Q remains a measured failure', async () => {
  for (const simulation of [
    { status: 'not_holder_exit', reason: 'requested_amount_exceeds_holder_supply' },
    { status: 'evm_revert', reason: 'unknown_execution_constraint' },
  ]) {
    const dir = root()
    const h = harness()
    await issue({ ...h, root: dir, nowMs: start, clock: () => start })
    const at = start + 3_600_000 + 60_000
    h.setHead(110, at)
    const result = await score({
      clients: h.clients,
      rpcOperators: h.rpcOperators,
      root: dir,
      nowMs: at,
      clock: () => at,
      quoteReader: async () => futureQuote({ number: 110, hash: hash('c') }, '500000', simulation),
    })
    assert.equal(result.outcome, 'balance_below_q')
    assert.equal(verifyLedgers(dir).scores[0].outcome, 'balance_below_q')
  }
})

test('RPC failure stays pending before deadline and censors after deadline', async () => {
  const dir = root()
  const h = harness()
  await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  const at = start + 3_600_000 + 60_000
  h.setHead(110, at)
  const missing = await score({
    clients: h.clients,
    rpcOperators: h.rpcOperators,
    root: dir,
    nowMs: at,
    clock: () => at,
    quoteReader: async () => {
      throw Error('rpc gone')
    },
  })
  assert.equal(missing.status, 'source_unavailable')
  assert.equal(readChain('scores', dir).length, 0)
  assert.equal(readChain('attempts', dir).length, 1)
  const expired = start + 3 * 3_600_000 + 1
  const censored = await score({
    clients: h.clients,
    rpcOperators: h.rpcOperators,
    root: dir,
    nowMs: expired,
    clock: () => expired,
  })
  assert.equal(censored.status, 'censored')
  assert.equal(censored.reason, 'source_unavailable')
  assert.equal(verifyLedgers(dir).scores.length, 1)
})

test('dual-origin disagreement cannot become a score', () => {
  const reference = { routeKey, holder, qRaw: '1000000', destination, underlying }
  const block = { number: 110, hash: hash('c') }
  assert.throws(
    () =>
      compareFutureQuotes(
        futureQuote(block),
        futureQuote(block, '2000000', {
          status: 'evm_revert',
          reason: 'unknown_execution_constraint',
        }),
        reference,
        block,
      ),
    /aave_holder_future_quote_origin_disagreement/,
  )
  assert.throws(
    () =>
      compareFutureQuotes(futureQuote(block), futureQuote(block), reference, {
        number: 110,
        hash: hash('f'),
      }),
    /aave_holder_future_quote_identity_invalid/,
  )
  assert.throws(
    () =>
      compareFutureQuotes(
        { ...futureQuote(block), owner: undefined },
        futureQuote(block),
        reference,
        block,
      ),
    /aave_holder_future_quote_identity_invalid/,
  )
  assert.throws(
    () =>
      compareFutureQuotes(
        futureQuote(block),
        { ...futureQuote(block), owner: `0x${'2'.repeat(40)}` },
        reference,
        block,
      ),
    /aave_holder_future_quote_identity_invalid/,
  )
})

test('SHA reseal without a matching source digest cannot pass semantic replay', async () => {
  const dir = root()
  const h = harness()
  await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  const path = join(dir, 'issues', '00000001.json')
  const row = JSON.parse(readFileSync(path, 'utf8'))
  row.baseline.sourceDigest = sha('f')
  const { sha256: _seal, ...body } = row
  const { createHash } = await import('node:crypto')
  row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify(row)}\n`)
  assert.throws(() => verifyLedgers(dir), /aave_holder_issue_invalid/)
})

test('resealed issue cannot lower the frozen Q below the selection rule', async () => {
  const dir = root()
  const h = harness()
  await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  const path = join(dir, 'issues', '00000001.json')
  const row = JSON.parse(readFileSync(path, 'utf8'))
  row.qRaw = '500000'
  row.issueKey = createHash('sha256')
    .update(
      JSON.stringify([
        row.study,
        row.routeKey,
        row.holder,
        row.qRaw,
        row.baseline.blockNumber,
        row.baseline.blockHash,
        row.baseline.sourceDigest,
      ]),
    )
    .digest('hex')
  const { sha256: _seal, ...body } = row
  row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, `${JSON.stringify(row)}\n`)
  assert.throws(() => verifyLedgers(dir), /aave_holder_issue_invalid/)
})

test('known crash temp is ignored, unknown files fail, and open windows score first', async () => {
  const dir = root()
  const h = harness()
  await issue({ ...h, root: dir, nowMs: start, clock: () => start })
  const attempts = join(dir, 'attempts')
  mkdirSync(attempts, { recursive: true })
  writeFileSync(join(attempts, '.aave-holder-11111111-1111-4111-8111-111111111111.tmp'), 'leftover')
  assert.equal(verifyLedgers(dir).issues.length, 1)
  writeFileSync(join(attempts, 'unknown.tmp'), 'bad')
  assert.throws(() => verifyLedgers(dir), /aave_holder_ledger_filename/)
  assert.deepEqual(
    targets('2026-10-01T12:00:00.000Z').map((row) => row.horizonHours),
    [1, 4, 24],
  )
  const issueRow = readChain('issues', dir)[0]
  assert.equal(selectDue([issueRow], [], start + 3_600_000)?.target.horizonHours, 1)
})
