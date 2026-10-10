import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult, parseAbi, toHex } from 'viem'
import { BASE, COMET, Q, ONSETS } from './cusds-holder-feasibility-first5.mjs'
import {
  INTERVAL,
  TRANSFER,
  decodeTransfer,
  mergeTransfers,
  digest,
  evaluate,
  loadCheckpoint,
  run,
  validateCheckpoint,
} from './cusds-threshold-crossings-first5.mjs'

const EOA = `0x${'1'.repeat(40)}`
const HASH = `0x${'a'.repeat(64)}`
const TX = `0x${'b'.repeat(64)}`
const topic = (x) => `0x${'0'.repeat(24)}${x.slice(2)}`
const onset = ONSETS[0]
const anchor = onset - INTERVAL
const raw = (from, to, amount, block = onset - 1, index = 0) => ({
  address: BASE,
  topics: [TRANSFER, topic(from), topic(to)],
  data: toHex(amount, { size: 32 }),
  blockNumber: toHex(block),
  blockHash: HASH,
  transactionHash: TX,
  logIndex: toHex(index),
  removed: false,
})
const row = (logs, cash, to = anchor + 2) => ({
  from: anchor,
  to,
  logs,
  logsSha256: digest(logs),
  reads: [anchor, anchor + 1, anchor + 2].map((block, i) => ({
    block,
    blockHash: HASH,
    cashRaw: cash[i].toString(),
  })),
})

test('deduplicates self-transfer from both indexed queries and keeps zero net flow', () => {
  const self = raw(COMET, COMET, 7n)
  const outgoing = raw(COMET, EOA, 2n, onset, 1)
  const logs = mergeTransfers([self, outgoing], [self], anchor, onset)
  assert.equal(logs.length, 2)
  assert.equal(logs[0].from, COMET)
  assert.equal(logs[0].to, COMET)
  assert.equal(logs[1].block, onset)
  assert.throws(() => decodeTransfer(raw(EOA, EOA, 2n), anchor, onset), /Unrelated/)
  assert.throws(() => decodeTransfer(raw(COMET, EOA, 1n, anchor), anchor, onset), /Out-of-interval/)
})

test('exact first end-of-block crossing is localized only after all balance deltas reconcile', () => {
  const exit = decodeTransfer(raw(COMET, EOA, 3n, anchor + 1), anchor, anchor + 2)
  const stable = row([exit], [Q + 2n, Q - 1n, Q - 1n])
  assert.equal(evaluate(stable).status, 'localized')
  assert.equal(evaluate(stable).firstCrossingBlock, anchor + 1)
  const mismatch = row([exit], [Q + 2n, Q - 2n, Q - 2n])
  assert.equal(evaluate(mismatch).status, 'not-localized')
  assert.equal(evaluate({ ...stable, reads: stable.reads.slice(0, 2) }).status, 'reads-pending')
})

test('unlogged block-end dip and recovery is a mismatch, never a silently missed first crossing', () => {
  const unlogged = row([], [Q + 2n, Q - 1n, Q + 2n])
  const result = evaluate(unlogged)
  assert.equal(result.status, 'not-localized')
  assert.equal(result.reason, 'transfer-cash-mismatch')
  assert.equal(result.mismatches.length, 2)
})

test('checkpoint seal, identity and log-versus-header hash are enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-cross-'))
  try {
    const out = join(dir, 'study.json')
    const empty = loadCheckpoint(out)
    assert.equal(validateCheckpoint({ payload: empty, sha256: digest(empty) }).intervals.length, 5)
    const entry = row(
      [decodeTransfer(raw(COMET, EOA, 3n, anchor + 1), anchor, onset)],
      [Q + 2n, Q - 1n, Q - 1n],
      onset,
    )
    empty.intervals[0] = entry
    writeFileSync(out, JSON.stringify({ payload: empty, sha256: digest(empty) }))
    assert.equal(loadCheckpoint(out).intervals[0].reads.length, 3)
    const altered = JSON.parse(readFileSync(out, 'utf8'))
    altered.payload.intervals[0].reads[1].cashRaw = '0'
    assert.throws(() => validateCheckpoint(altered), /SHA mismatch/)
    altered.sha256 = digest(altered.payload)
    altered.payload.intervals[0].reads[1].blockHash = `0x${'c'.repeat(64)}`
    altered.sha256 = digest(altered.payload)
    assert.throws(() => validateCheckpoint(altered), /disagrees with pinned/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bounded run makes two complete topic queries, pinned reads, and resumes offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-cross-'))
  const out = join(dir, 'study.json')
  const calls = []
  const transfer = raw(COMET, EOA, 3n, anchor + 1)
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getLogs') {
        assert.equal(params[0].fromBlock, toHex(anchor + 1))
        assert.equal(params[0].toBlock, toHex(onset))
        return params[0].topics[1] === null ? [] : [transfer]
      }
      if (method === 'eth_call') {
        assert.equal(params[1].blockHash, HASH)
        assert.equal(params[1].requireCanonical, true)
        const block = anchor + calls.filter((x) => x.method === 'eth_call').length - 1
        const value = block === anchor ? Q + 2n : Q - 1n
        return encodeFunctionResult({
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          result: value,
        })
      }
      throw new Error(method)
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: HASH }),
  }
  try {
    const result = await run({ out, client, maxNewIntervals: 1, maxReads: 3, checkDisk: () => {} })
    assert.equal(result.rows[0].status, 'reads-pending')
    assert.equal(result.rows[0].reads, 3)
    assert.equal(result.rows[0].requiredReads, INTERVAL + 1)
    assert.equal(result.rows[1].status, 'logs-pending')
    assert.equal(calls.filter((x) => x.method === 'eth_getLogs').length, 2)
    assert.equal(calls.filter((x) => x.method === 'eth_call').length, 3)
    const again = await run({ out, maxNewIntervals: 0, maxReads: 0, checkDisk: () => {} })
    assert.equal(again.rows[0].status, 'reads-pending')
    assert.equal(calls.filter((x) => x.method === 'eth_getLogs').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wrong chain halts before any data fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-cross-'))
  try {
    const client = {
      request: async ({ method }) => {
        assert.equal(method, 'eth_chainId')
        return '0x2'
      },
    }
    await assert.rejects(
      () => run({ out: join(dir, 'study.json'), client, maxNewIntervals: 1, checkDisk: () => {} }),
      /mainnet/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resume rejects a saved header that is no longer canonical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-cross-'))
  const out = join(dir, 'study.json')
  const client = {
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getLogs') return []
      if (method === 'eth_call')
        return encodeFunctionResult({
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          result: Q + 1n,
        })
      throw new Error(`${method}:${params}`)
    },
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: HASH }),
  }
  try {
    await run({ out, client, maxNewIntervals: 1, maxReads: 1, checkDisk: () => {} })
    client.getBlock = async ({ blockNumber }) => ({
      number: blockNumber,
      hash: blockNumber === BigInt(anchor) ? `0x${'c'.repeat(64)}` : HASH,
    })
    await assert.rejects(
      () => run({ out, client, maxReads: 1, checkDisk: () => {} }),
      /no longer canonical/,
    )
    assert.equal(loadCheckpoint(out).intervals[0].reads.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
