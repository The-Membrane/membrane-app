import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  baselineSize,
  collectTransfers,
  FACTORY_SHA,
  firstEoa,
  guardDisk,
  MANIFEST_SHA,
  probeAnchor,
  replayTransfers,
  run,
  selectAnchors,
  verifyCheckpoint,
  verifySeal,
} from './morpho-v2-full-cohort-baseline.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const H = `0x${'a'.repeat(64)}`
const V = `0x${'b'.repeat(40)}`
const E = `0x${'c'.repeat(40)}`
const Z = `0x${'0'.repeat(40)}`
const anchor = {
  index: 0,
  proposalIndex: 1,
  vault: V,
  anchorBlock: 12,
  anchorBlockHash: H,
  creationBlock: 10,
  preBlock: 11,
}
const seal = (value) => ({
  ...value,
  checkpointSha256: sha(JSON.stringify(value)),
})

test('selection retains chronological repeated-vault anchors', () => {
  const manifest = {
    study: 'morpho-v2-full-cohort-manifest-v1',
    status: 'complete',
    chainId: 1,
    factorySha256: FACTORY_SHA,
    summary: { anchors: 304 },
    rows: Array.from({ length: 304 }, (_, index) => ({
      proposalIndex: index,
      vault: V,
      anchorBlock: 12 + index,
      anchorBlockHash: H,
      anchorTxHash: H,
    })),
  }
  const factory = {
    study: 'morpho-v2-factory-create-v1',
    status: 'complete',
    events: [{ vault: V, block: 10 }],
  }
  const selected = selectAnchors(manifest, factory)
  assert.equal(selected.length, 304)
  assert.equal(selected[1].preBlock, 12)
  manifest.rows[2].proposalIndex = 1
  assert.throws(() => selectAnchors(manifest, factory), /identity or chronology/)
})

test('holder ranking and floor-sized q preserve zero as censored', () => {
  const logs = [
    { block: 10, blockHash: H, logIndex: 1, txHash: H, from: Z, to: V, value: '10' },
    { block: 11, blockHash: H, logIndex: 1, txHash: H, from: V, to: E, value: '6' },
  ]
  assert.deepEqual(replayTransfers(logs)[0], [E, 6n])
  assert.equal(baselineSize(999n, 99999n), 0n)
  assert.equal(baselineSize(2000n, 19n), 1n)
  assert.throws(() => replayTransfers([...logs, logs[1]]), /unordered/)
})

test('bounded EOA code batches preserve first-largest-holder selection', async () => {
  const holders = Array.from({ length: 11 }, (_, index) => [
    `0x${index.toString(16).padStart(40, '0')}`,
    BigInt(100 - index),
  ])
  const seen = []
  const selected = await firstEoa(
    holders,
    async (address) => {
      seen.push(address)
      return address === holders[9][0] ? '0x' : '0x6000'
    },
    4,
  )
  assert.deepEqual(selected, holders[9])
  assert.equal(seen.length, 11)
  await assert.rejects(
    firstEoa(holders, async () => '0x', 17),
    /batch size/,
  )
})

test('sealed frontier rejects tampering and validates adjacent rows', () => {
  const anchors = [anchor, { ...anchor, index: 1, proposalIndex: 2, anchorBlock: 13, preBlock: 12 }]
  const base = {
    study: 'morpho-v2-full-cohort-treated-baseline-v1',
    chainId: 1,
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    status: 'partial',
    results: [
      {
        index: 0,
        proposalIndex: 1,
        vault: V,
        anchorBlock: 12,
        preBlock: 11,
        preBlockHash: H,
        status: 'zero-baseline-size',
      },
    ],
  }
  verifyCheckpoint(seal(base), anchors)
  const tampered = seal(base)
  tampered.results[0].status = 'baseline-success'
  assert.throws(() => verifyCheckpoint(tampered, anchors), /seal/)
  base.results[0].index = 1
  assert.throws(() => verifyCheckpoint(seal(base), anchors), /frontier/)
  assert.throws(() => verifySeal({ ...base, checkpointSha256: '0'.repeat(64) }), /seal/)
})

test('raw Transfer scan resumes exact chunks without rescanning first chunk', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-baseline-test-'))
  try {
    const calls = []
    const client = {
      request: async ({ method, params }) => {
        assert.equal(method, 'eth_getLogs')
        calls.push(params[0].fromBlock)
        return []
      },
    }
    const rawDir = resolve(dir, 'raw')
    const first = await collectTransfers({ client, anchor, rawDir, preBlockHash: H })
    assert.equal(first.raw.throughBlock, 11)
    assert.equal(calls.length, 1)
    await collectTransfers({ client, anchor, rawDir, preBlockHash: H })
    assert.equal(calls.length, 1)
    const bytes = readFileSync(first.rawPath)
    const obj = JSON.parse(bytes)
    obj.logs = [{ block: 10 }]
    writeFileSync(first.rawPath, JSON.stringify(obj))
    await assert.rejects(collectTransfers({ client, anchor, rawDir, preBlockHash: H }), /seal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sealed anchor header mismatch stops before Transfer or state reads', async () => {
  const methods = []
  const client = {
    request: async ({ method, params }) => {
      methods.push(method)
      if (method === 'eth_getBlockByNumber')
        return { number: params[0], hash: params[0] === '0xc' ? `0x${'d'.repeat(64)}` : H }
      throw new Error('Unexpected state read')
    },
  }
  await assert.rejects(
    probeAnchor({
      client,
      anchor,
      rawDir: resolve(tmpdir(), 'unused'),
      out: resolve(tmpdir(), 'unused'),
    }),
    /Sealed anchor block hash mismatch/,
  )
  assert.deepEqual(methods, ['eth_getBlockByNumber', 'eth_getBlockByNumber'])
})

test('tampered sealed raw prefix is fatal, not a censored baseline row', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-baseline-integrity-test-'))
  try {
    const rawDir = resolve(dir, 'raw')
    const client = {
      request: async ({ method, params }) => {
        if (method === 'eth_getBlockByNumber') return { number: params[0], hash: H }
        if (method === 'eth_getLogs') return []
        throw new Error('Unexpected state read')
      },
    }
    const first = await collectTransfers({ client, anchor, rawDir, preBlockHash: H })
    const tampered = JSON.parse(readFileSync(first.rawPath))
    tampered.throughBlock = 10
    writeFileSync(first.rawPath, JSON.stringify(tampered))
    await assert.rejects(
      probeAnchor({ client, anchor, rawDir, out: resolve(dir, 'out.json') }),
      /seal/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run rejects source tamper before any RPC', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-baseline-source-test-'))
  try {
    const manifestPath = resolve(dir, 'manifest.json')
    const factoryPath = resolve(dir, 'factory.json')
    writeFileSync(manifestPath, '{}')
    writeFileSync(factoryPath, '{}')
    let rpcCalls = 0
    await assert.rejects(
      run({
        client: {
          request: async () => {
            rpcCalls++
            return '0x1'
          },
        },
        manifestPath,
        factoryPath,
        out: resolve(dir, 'out.json'),
        rawDir: resolve(dir, 'raw'),
      }),
      /Pinned source SHA mismatch/,
    )
    assert.equal(rpcCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disk guard refuses writes that would breach the frozen reserve', () => {
  assert.throws(
    () => guardDisk(resolve(tmpdir(), 'unwritten.json'), Number.MAX_SAFE_INTEGER),
    /Disk reserve/,
  )
})
