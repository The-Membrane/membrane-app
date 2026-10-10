import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult } from 'viem'
import { BASE, COMET, ONSETS, Q, digest } from './cusds-holder-feasibility-first5.mjs'
import {
  DEFAULT_SOURCE,
  LEAD_BLOCKS,
  SOURCE_SHA256,
  freezeSource,
  loadAsOfCheckpoint,
  rowSummary,
  run,
  validateAsOfCheckpoint,
} from './cusds-asof-holder-first5.mjs'

const HASH = `0x${'a'.repeat(64)}`
const abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'owner' }],
    outputs: [{ type: 'uint256' }],
  },
]
const withTemp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'cusds-asof-'))
  try {
    await fn(join(dir, 'asof.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('pinned complete source reconstructs the five A cohorts without old probe choices', () => {
  const source = freezeSource()
  assert.equal(source.fileSha256, SOURCE_SHA256)
  assert.equal(source.rows.length, 5)
  assert.deepEqual(
    source.rows.map((row) => row.asofBlock),
    ONSETS.map((b) => b - LEAD_BLOCKS),
  )
  assert.deepEqual(
    source.rows.map((row) => row.candidates.length),
    [387, 401, 436, 471, 496],
  )
  const wrong = JSON.parse(readFileSync(DEFAULT_SOURCE, 'utf8'))
  wrong.payload.probes[ONSETS[0]].reads = []
  // A changed B-1 probe changes file bytes and cannot silently define this cohort.
  assert.notEqual(digest(wrong), SOURCE_SHA256)
})

test('bounded run pins A balance/code, never calls B, and redacts provider failures', async () => {
  await withTemp(async (out) => {
    const calls = []
    const client = {
      getBlock: async ({ blockNumber }) => {
        calls.push({ method: 'getBlock', blockNumber: Number(blockNumber) })
        return { number: blockNumber, hash: HASH }
      },
      request: async ({ method, params }) => {
        calls.push({ method, params })
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_call')
          return encodeFunctionResult({ abi, functionName: 'balanceOf', result: Q })
        if (method === 'eth_getCode') throw new Error('https://secret.example/key rpc token')
        throw new Error(`Unexpected ${method}`)
      },
    }
    const first = await run({ out, client, maxCandidates: 1, checkDisk: () => {} })
    assert.equal(first.processed, 1)
    assert.equal(first.rows[0].status, 'pending')
    assert.equal(first.rows[0].readFailures, 1)
    assert.equal(calls.find((x) => x.method === 'getBlock').blockNumber, ONSETS[0] - LEAD_BLOCKS)
    assert.ok(
      calls
        .filter((x) => ['eth_call', 'eth_getCode'].includes(x.method))
        .every((x) => x.params[1].blockHash === HASH && x.params[1].requireCanonical),
    )
    assert.ok(!calls.some((x) => x.blockNumber === ONSETS[0] || x.blockNumber === ONSETS[0] - 1))
    const bytes = readFileSync(out, 'utf8')
    assert.doesNotMatch(bytes, /secret\.example|rpc token/)
    assert.match(bytes, /pinned-balance-or-code-read-failed/)
    assert.equal(loadAsOfCheckpoint(out, freezeSource()).rows[0].reads.length, 1)
  })
})

test('frozen five-row checkpoint keeps failures and denominator; tampering fails offline', async () => {
  await withTemp(async (out) => {
    const source = freezeSource()
    const rows = source.rows.map(({ onset, asofBlock, candidates }) => ({
      onset,
      asofBlock,
      candidateCount: candidates.length,
      candidateSha256: digest(candidates),
      blockHash: HASH,
      reads: candidates.map((address) => ({ address, status: 'ok', balanceRaw: '0', eoa: true })),
    }))
    rows[0].reads[0] = { ...rows[0].reads[0], balanceRaw: (Q + 1n).toString() }
    rows[0].reads[1] = { ...rows[0].reads[1], balanceRaw: (Q + 1n).toString() }
    rows[1].reads[0] = {
      address: rows[1].reads[0].address,
      status: 'error',
      reason: 'pinned-balance-or-code-read-failed',
    }
    const payload = {
      study: 'cusds-asof-holder-first5-preoutcome-v1',
      chainId: 1,
      comet: COMET,
      base: BASE,
      qRaw: Q.toString(),
      leadBlocks: LEAD_BLOCKS,
      sourceFileSha256: source.fileSha256,
      sourcePayloadSha256: source.payloadSha256,
      sourceLogCount: source.logCount,
      onsets: [...ONSETS],
      phase: 'frozen',
      rows,
      frozenSha256: digest(rows),
    }
    const sealed = { payload, sha256: digest(payload) }
    writeFileSync(out, JSON.stringify(sealed))
    const loaded = loadAsOfCheckpoint(out, source)
    assert.equal(loaded.phase, 'frozen')
    assert.equal(
      rowSummary(rows[0]).holder.address,
      [rows[0].reads[0].address, rows[0].reads[1].address].sort()[0],
    )
    assert.equal(rowSummary(rows[1]).status, 'read-failure')
    assert.equal(rowSummary(rows[2]).status, 'no-qualifying-eoa')
    assert.equal(rows.map(rowSummary).length, 5)
    rows[2].reads[0].balanceRaw = Q.toString()
    assert.throws(() => validateAsOfCheckpoint(sealed, source), /SHA mismatch/)
  })
})

test('resource and chain guards reject before any A read', async () => {
  await withTemp(async (out) => {
    await assert.rejects(run({ out, maxCandidates: 501 }), /0\.\.500/)
    await assert.rejects(
      run({ out, maxCandidates: 1, client: { request: async () => '0x89' } }),
      /chainId/,
    )
    assert.equal((await run({ out, maxCandidates: 0 })).processed, 0)
  })
})
