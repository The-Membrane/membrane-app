import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TOKEN, MIN_FREE_BYTES } from './usde-debt-mint-baseline.mjs'
import {
  append,
  assertDiskFloor,
  assertVerifiedFrontier,
  candidateOwners,
  collect,
  fetchWindow,
  parseArgs,
  readFinalizedWitness,
  sourceIdentity,
  verify,
} from './alchemy-mint-discovery.mjs'

const H = `0x${'a'.repeat(64)}`
const OWNER = `0x${'b'.repeat(40)}`
const ZERO = `0x${'0'.repeat(40)}`
const frontier = { throughBlock: 99, frontierHash: H }
const transfer = (block = 100, value = '0x01') => ({
  blockNum: `0x${block.toString(16)}`,
  hash: H,
  from: ZERO,
  to: OWNER,
  category: 'erc20',
  rawContract: { address: TOKEN, value },
})
const response = (transfers, pageKey, error) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers, pageKey }, error })
  return new Response(body, { status: 200 })
}
const segment = (fromBlock, toBlock, rows) => ({
  sourceIdentity: sourceIdentity(frontier),
  fromBlock,
  toBlock,
  finalizedHead: toBlock,
  finalizedHeadHash: H,
  fromBlockHash: H,
  fromBlockParentHash: H,
  boundaryHash: H,
  fetchedAt: '2026-09-27T12:00:00.000Z',
  pages: 1,
  pageKeyExhausted: true,
  rows,
  candidateOwners: candidateOwners(rows),
  canonicalLogClaim: false,
  borrowerCensusClaim: false,
})
const row = (block, amount = 1) => `${block}:${H}:${OWNER}:${amount}`
const witness = ({ toBlock }) =>
  Promise.resolve({
    finalizedHead: toBlock,
    finalizedHeadHash: H,
    fromBlockHash: H,
    fromBlockParentHash: H,
    boundaryHash: H,
  })
const free = () => ({ bavail: Math.ceil((MIN_FREE_BYTES + 10_000_000) / 4096), bsize: 4096 })
const withTemp = (fn) => {
  const out = mkdtempSync(join(tmpdir(), 'alchemy-discovery-test-'))
  try {
    return fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('fixed query and finite pagination exhaust the final page', async () => {
  const params = []
  const pages = [response([transfer()], 'next'), response([transfer(101, '0x02')])]
  const result = await fetchWindow({
    fromBlock: 100,
    toBlock: 101,
    url: 'https://example.invalid',
    fetchImpl: async (_url, options) => {
      params.push(JSON.parse(options.body).params[0])
      return pages.shift()
    },
  })
  assert.deepEqual(result, { rows: [row(100), row(101, 2)], pages: 2, pageKeyExhausted: true })
  assert.deepEqual(params[0], {
    fromBlock: '0x64',
    toBlock: '0x65',
    fromAddress: ZERO,
    contractAddresses: [TOKEN],
    category: ['erc20'],
    excludeZeroValue: false,
    maxCount: '0x3e8',
  })
  assert.equal(params[1].pageKey, 'next')
})

test('expired pagination, repeated keys, duplicate tuples and malformed pages fail closed', async () => {
  const run = (pages) =>
    fetchWindow({
      fromBlock: 100,
      toBlock: 101,
      url: 'https://example.invalid',
      fetchImpl: async () => pages.shift(),
    })
  await assert.rejects(
    run([response([], 'expired'), response([], undefined, { code: -32602 })]),
    /response_invalid/,
  )
  await assert.rejects(run([response([], 'again'), response([], 'again')]), /page_key_invalid/)
  await assert.rejects(
    run([response([transfer()], 'next'), response([transfer()])]),
    /duplicate_transfer/,
  )
  await assert.rejects(run([response([transfer(102)])]), /transfer_invalid/)
  await assert.rejects(run([new Response('{', { status: 200 })]), /response_invalid/)
  await assert.rejects(
    run([response([], 'a'), response([], 'b'), response([], 'c'), response([], 'd')]),
    /page_cap/,
  )
})

test('deadline prevents late abort-ignoring response from requesting another page', async () => {
  let calls = 0
  await assert.rejects(
    fetchWindow({
      fromBlock: 100,
      toBlock: 100,
      url: 'https://example.invalid',
      deadlineMs: 5,
      fetchImpl: async () => {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 15))
        return response([], 'next')
      },
    }),
    /deadline/,
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls, 1)
})

test('physical SHA tamper and exact gap/overlap are rejected offline', () =>
  withTemp((out) => {
    const first = append(out, segment(100, 5099, [row(100)]), { stat: free })
    assert.equal(verify({ out, frontier }).throughBlock, 5099)
    const gap = append(out, segment(5101, 10100, []), { stat: free })
    assert.throws(() => verify({ out, frontier }), /seal_invalid/)
    rmSync(gap)
    const overlap = append(out, segment(5099, 10098, []), { stat: free })
    assert.throws(() => verify({ out, frontier }), /seal_invalid/)
    rmSync(overlap)
    writeFileSync(first, Buffer.concat([readFileSync(first), Buffer.from(' ')]))
    assert.throws(() => verify({ out, frontier }), /seal_invalid/)
  }))

test('identity mismatch and duplicate rows are not accepted', () =>
  withTemp((out) => {
    const altered = segment(100, 5099, [])
    altered.sourceIdentity = { ...altered.sourceIdentity, token: ZERO }
    append(out, altered, { stat: free })
    assert.throws(() => verify({ out, frontier }), /seal_invalid/)
  }))

test('offline verifier rejects duplicate transfer tuples', () =>
  withTemp((out) => {
    append(out, segment(100, 5099, [row(100), row(100)]), { stat: free })
    assert.throws(() => verify({ out, frontier }), /rows_invalid/)
  }))

test('zero-value transfers stay in evidence but not in the owner candidate list', () =>
  withTemp((out) => {
    append(out, segment(100, 5099, [row(100, 0)]), { stat: free })
    assert.equal(verify({ out, frontier }).transferCount, 1)
    assert.deepEqual(candidateOwners([row(100, 0)]), [])
  }))

test('disk reserve blocks all writes before creating a directory', () =>
  withTemp((root) => {
    const out = join(root, 'sealed')
    const low = () => ({ bavail: 1, bsize: 4096 })
    assert.throws(() => assertDiskFloor(out, low), /disk_reserve_reached/)
    assert.throws(() => append(out, segment(100, 5099, []), { stat: low }), /disk_reserve_reached/)
    assert.equal(existsSync(out), false)
  }))

test('CLI pins an explicitly verified frontier and rejects a silent rebase', () => {
  const args = parseArgs(['--verify', '--frontier-block', '99', '--frontier-hash', H])
  assert.deepEqual(args.frontier, frontier)
  assertVerifiedFrontier(frontier, frontier)
  assert.throws(
    () =>
      assertVerifiedFrontier(frontier, {
        throughBlock: 99,
        frontierHash: `0x${'c'.repeat(64)}`,
      }),
    /frontier_unverified/,
  )
  assert.throws(() => parseArgs(['--verify']), /cli_invalid/)
})

test('collector seals only an exhausted fixed window and leaves failed pages unsealed', async () => {
  const out = mkdtempSync(join(tmpdir(), 'alchemy-discovery-collect-'))
  try {
    const done = await collect({
      frontier,
      throughBlock: 5099,
      maxChunks: 1,
      out,
      url: 'https://example.invalid',
      stat: free,
      readWitness: witness,
      fetchImpl: async () => response([transfer()]),
    })
    assert.equal(done.throughBlock, 5099)
    assert.equal(done.transferCount, 1)
    await assert.rejects(
      collect({
        frontier,
        throughBlock: 10099,
        maxChunks: 1,
        out,
        url: 'https://example.invalid',
        stat: free,
        readWitness: witness,
        fetchImpl: async () => response([], 'expired'),
      }),
      /page_key_invalid|page_cap|request_failed/,
    )
    assert.equal(verify({ out, frontier }).throughBlock, 5099)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('finalized head, exact boundary, and linked first block are required', async () => {
  const rpc =
    (head, boundary = 5099, parent = H) =>
    async (_url, options) => {
      const tag = JSON.parse(options.body).params[0]
      const number = tag === 'finalized' ? head : tag === '0x64' ? 100 : boundary
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: { number: `0x${number.toString(16)}`, hash: H, parentHash: parent },
        }),
        { status: 200 },
      )
    }
  await assert.rejects(
    readFinalizedWitness({
      fromBlock: 100,
      toBlock: 5099,
      expectedParentHash: H,
      url: 'https://example.invalid',
      fetchImpl: rpc(5098),
    }),
    /boundary_not_finalized/,
  )
  await assert.rejects(
    readFinalizedWitness({
      fromBlock: 100,
      toBlock: 5099,
      expectedParentHash: H,
      url: 'https://example.invalid',
      fetchImpl: rpc(5100, 5101),
    }),
    /witness_invalid/,
  )
  await assert.rejects(
    readFinalizedWitness({
      fromBlock: 100,
      toBlock: 5099,
      expectedParentHash: H,
      url: 'https://example.invalid',
      fetchImpl: rpc(5100, 5099, `0x${'c'.repeat(64)}`),
    }),
    /parent_hash_mismatch/,
  )
  assert.deepEqual(
    await readFinalizedWitness({
      fromBlock: 100,
      toBlock: 5099,
      expectedParentHash: H,
      url: 'https://example.invalid',
      fetchImpl: rpc(5100),
    }),
    {
      finalizedHead: 5100,
      finalizedHeadHash: H,
      fromBlockHash: H,
      fromBlockParentHash: H,
      boundaryHash: H,
    },
  )
})

test('offline verifier rejects a second window not linked to prior boundary', () =>
  withTemp((out) => {
    append(out, segment(100, 5099, []), { stat: free })
    const second = segment(5100, 10099, [])
    second.fromBlockParentHash = `0x${'c'.repeat(64)}`
    append(out, second, { stat: free })
    assert.throws(() => verify({ out, frontier }), /seal_invalid/)
  }))

test('exclusive lock prevents a second writer from sealing the same range', async () => {
  const out = mkdtempSync(join(tmpdir(), 'alchemy-discovery-lock-'))
  let release
  let began
  const started = new Promise((resolve) => {
    began = resolve
  })
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  try {
    const first = collect({
      frontier,
      throughBlock: 5099,
      maxChunks: 1,
      out,
      url: 'https://example.invalid',
      stat: free,
      readWitness: witness,
      fetchImpl: async () => {
        began()
        await waiting
        return response([])
      },
    })
    await started
    await assert.rejects(
      collect({
        frontier,
        throughBlock: 5099,
        maxChunks: 1,
        out,
        url: 'https://example.invalid',
        stat: free,
        readWitness: witness,
        fetchImpl: async () => response([]),
      }),
      /lock_held/,
    )
    release()
    await first
    assert.equal(verify({ out, frontier }).segmentCount, 1)
  } finally {
    release?.()
    rmSync(out, { recursive: true, force: true })
  }
})
