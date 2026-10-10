import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult, toHex } from 'viem'
import {
  BASE,
  COMET,
  CREATION_BLOCK,
  MAX_CHUNK_BLOCKS,
  ONSETS,
  Q,
  STUDY,
  TOPICS,
  decodeCandidateLog,
  discoverCandidates,
  digest,
  loadCheckpoint,
  run,
  selectHolder,
  validateCheckpoint,
} from './cusds-holder-feasibility-first5.mjs'

const A = `0x${'1'.repeat(40)}`
const B = `0x${'2'.repeat(40)}`
const H = `0x${'a'.repeat(64)}`
const TX = `0x${'b'.repeat(64)}`
const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
const log = (kind = 0, block = CREATION_BLOCK, index = 0, from = A, to = B) => ({
  address: COMET,
  topics: [TOPICS[kind], topic(from), topic(to)],
  data: toHex(123n, { size: 32 }),
  blockNumber: toHex(block),
  logIndex: toHex(index),
  blockHash: H,
  transactionHash: TX,
  removed: false,
})
const blank = () => ({
  study: STUDY,
  chainId: 1,
  comet: COMET,
  base: BASE,
  creationBlock: CREATION_BLOCK,
  onsets: [...ONSETS],
  qRaw: Q.toString(),
  status: 'partial',
  nextBlock: CREATION_BLOCK,
  chunks: [],
  probes: Object.fromEntries(ONSETS.map((b) => [b, { block: b - 1, blockHash: null, reads: [] }])),
})

test('official indexed Transfer and Supply decode, candidates dedupe and sort', () => {
  const transfer = decodeCandidateLog(log(0), CREATION_BLOCK, CREATION_BLOCK)
  const supply = decodeCandidateLog(log(1, CREATION_BLOCK, 1), CREATION_BLOCK, CREATION_BLOCK)
  assert.equal(transfer.kind, 'Transfer')
  assert.equal(supply.kind, 'Supply')
  assert.deepEqual(discoverCandidates([transfer, supply]), [A, B])
  assert.throws(() =>
    decodeCandidateLog(
      { ...log(), topics: [TOPICS[0], A, topic(B)] },
      CREATION_BLOCK,
      CREATION_BLOCK,
    ),
  )
  assert.throws(() => decodeCandidateLog(log(), CREATION_BLOCK + 1, CREATION_BLOCK + 1))
})

test('largest qualified EOA, deterministic tie break; contracts and small holders excluded', () => {
  const rows = [
    { address: B, status: 'ok', eoa: true, balanceRaw: Q.toString() },
    { address: A, status: 'ok', eoa: true, balanceRaw: Q.toString() },
    { address: `0x${'3'.repeat(40)}`, status: 'ok', eoa: false, balanceRaw: (Q * 4n).toString() },
  ]
  assert.equal(selectHolder(rows).address, A)
  assert.equal(selectHolder([{ ...rows[0], balanceRaw: (Q - 1n).toString() }]), null)
})

test('sealed checkpoint detects corruption even when valid JSON', () => {
  const payload = blank(),
    envelope = { payload, sha256: digest(payload) }
  assert.equal(validateCheckpoint(envelope).nextBlock, CREATION_BLOCK)
  payload.nextBlock++
  assert.throws(() => validateCheckpoint(envelope), /SHA mismatch/)
})

test('bounded scan stores raw log identity; rerun resumes without duplicate scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-feas-'))
  const out = join(dir, 'checkpoint.json')
  const calls = []
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      assert.equal(method, 'eth_getLogs')
      assert.equal(params[0].fromBlock, toHex(CREATION_BLOCK))
      assert.deepEqual(params[0].topics, [TOPICS])
      return [log()]
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: H }),
  }
  try {
    const one = await run({ out, client, maxNewChunks: 1, chunkBlocks: 2, checkDisk: () => {} })
    assert.equal(one.nextBlock, CREATION_BLOCK + 2)
    assert.equal(one.logCount, 1)
    assert.equal(calls.length, 2)
    const saved = loadCheckpoint(out)
    assert.equal(saved.chunks[0].logs[0].txHash, TX)
    assert.equal(saved.chunks[0].logsSha256, digest(saved.chunks[0].logs))
    assert.equal(
      (await run({ out, client, maxNewChunks: 0, checkDisk: () => {} })).nextBlock,
      CREATION_BLOCK + 2,
    )
    assert.equal(calls.length, 2)
    const corrupt = JSON.parse(readFileSync(out, 'utf8'))
    corrupt.payload.chunks[0].logs[0].amount = '999'
    writeFileSync(out, JSON.stringify(corrupt))
    assert.throws(() => loadCheckpoint(out), /SHA mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chunk and budget guards stop before RPC or sampling', async () => {
  assert.equal(MAX_CHUNK_BLOCKS, 2000)
  const client = {
    request: ({ method }) => {
      if (method === 'eth_chainId') return '0x1'
      throw new Error('should not scan')
    },
  }
  await assert.rejects(
    run({
      out: '/tmp/no-cusds-checkpoint-required.json',
      client,
      maxNewChunks: 1,
      chunkBlocks: 2001,
    }),
    /chunkBlocks/,
  )
  await assert.rejects(
    run({ out: '/tmp/no-cusds-checkpoint-required.json', client, maxNewChunks: -1 }),
    /nonnegative/,
  )
  await assert.rejects(
    run({
      out: '/tmp/no-cusds-checkpoint-required.json',
      client,
      maxNewChunks: 1,
      checkDisk: () => {
        throw new Error('floor')
      },
    }),
    /floor/,
  )
})

test('no B-state requests: with no fully scanned pre-B range, holder reads remain untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-preb-'))
  const out = join(dir, 'checkpoint.json')
  const methods = []
  const client = {
    request: async ({ method }) => {
      methods.push(method)
      if (method === 'eth_chainId') return '0x1'
      return []
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: H }),
  }
  try {
    await run({ out, client, maxNewChunks: 1, maxCandidates: 2, checkDisk: () => {} })
    assert.deepEqual(methods, ['eth_chainId', 'eth_getLogs'])
    assert.equal(loadCheckpoint(out).probes[ONSETS[0]].blockHash, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function firstAnchorCovered() {
  const payload = blank()
  let from = CREATION_BLOCK
  while (from < ONSETS[0]) {
    const to = Math.min(from + MAX_CHUNK_BLOCKS - 1, ONSETS[0] - 1)
    const logs = from === CREATION_BLOCK ? [decodeCandidateLog(log(), from, to)] : []
    payload.chunks.push({ from, to, fromHash: H, toHash: H, logs, logsSha256: digest(logs) })
    from = to + 1
  }
  payload.nextBlock = from
  return payload
}

test('stage gate stops before next onset until first holder cohort is resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-stage-'))
  const out = join(dir, 'checkpoint.json')
  const payload = firstAnchorCovered()
  writeFileSync(out, JSON.stringify({ payload, sha256: digest(payload) }))
  const methods = []
  const client = {
    request: async ({ method }) => {
      methods.push(method)
      if (method === 'eth_chainId') return '0x1'
      throw new Error('should not scan past first anchor')
    },
  }
  try {
    const result = await run({ out, client, maxNewChunks: 1, checkDisk: () => {} })
    assert.equal(result.nextBlock, ONSETS[0])
    assert.deepEqual(methods, ['eth_chainId'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B−1 state calls use EIP-1898 hash; failed reads retry without duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-pinned-'))
  const out = join(dir, 'checkpoint.json')
  const payload = firstAnchorCovered()
  writeFileSync(out, JSON.stringify({ payload, sha256: digest(payload) }))
  const calls = []
  let bad = true
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_call')
        return bad
          ? '0x'
          : encodeFunctionResult({
              abi: [
                {
                  type: 'function',
                  name: 'balanceOf',
                  stateMutability: 'view',
                  inputs: [{ type: 'address', name: 'owner' }],
                  outputs: [{ type: 'uint256' }],
                },
              ],
              functionName: 'balanceOf',
              result: Q,
            })
      if (method === 'eth_getCode') return '0x'
      throw new Error(`unexpected ${method}`)
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: H }),
  }
  try {
    const failed = await run({ out, client, maxCandidates: 2, checkDisk: () => {} })
    assert.equal(failed.rows[0].status, 'read-failure')
    assert.equal(loadCheckpoint(out).probes[ONSETS[0]].reads.length, 2)
    bad = false
    const retried = await run({ out, client, maxCandidates: 2, checkDisk: () => {} })
    assert.equal(retried.rows[0].status, 'holder')
    const reads = loadCheckpoint(out).probes[ONSETS[0]].reads
    assert.equal(reads.length, 2)
    assert.ok(reads.every((r) => r.attempts === 2 && r.lastError))
    assert.ok(
      calls
        .filter((c) => c.method === 'eth_call')
        .every(
          (c) =>
            JSON.stringify(c.params[1]) ===
            JSON.stringify({ blockHash: H, requireCanonical: true }),
        ),
    )
    assert.ok(
      calls
        .filter((c) => c.method === 'eth_getCode')
        .every(
          (c) =>
            JSON.stringify(c.params[1]) ===
            JSON.stringify({ blockHash: H, requireCanonical: true }),
        ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('complete status with unresolved reads is rejected; non-mainnet rejects before scan', async () => {
  const payload = blank()
  payload.status = 'complete'
  assert.throws(() => validateCheckpoint({ payload, sha256: digest(payload) }), /claims complete/)
  await assert.rejects(
    run({
      out: '/tmp/cusds-test-invalid-chain-v2.json',
      client: { request: async () => '0x89' },
      maxNewChunks: 1,
    }),
    /chainId/,
  )
})
