import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  toEventSelector,
  toHex,
} from 'viem'
import {
  classifyGateError,
  collectTransfers,
  probeAnchor,
  probeGate,
  selectFive,
  verifyResultPrefix,
} from './morpho-v2-gate-holder-pilot.mjs'

const vault = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const gate = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const holder = '0xcccccccccccccccccccccccccccccccccccccccc'
const zero = `0x${'0'.repeat(40)}`
const hash = `0x${'3'.repeat(64)}`
const tx = `0x${'4'.repeat(64)}`
const ABI = parseAbi(['function canReceiveAssets(address account) view returns (bool)'])
const transferTopic = toEventSelector('Transfer(address,address,uint256)')
const topicAddress = (address) => `0x${address.slice(2).padStart(64, '0')}`

function rawMint() {
  return {
    address: vault,
    blockNumber: toHex(1),
    blockHash: hash,
    transactionHash: tx,
    logIndex: toHex(0),
    topics: [transferTopic, topicAddress(zero), topicAddress(holder)],
    data: toHex(100n, { size: 32 }),
  }
}

test('selection is exactly the five frozen candidates, not a convenient subset', () => {
  const vaults = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`)
  const census = {
    study: 'morpho-v2-gate-submit-census-v1',
    status: 'complete',
    chainId: 1,
    factoryArtifactSha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    summary: { classes: { candidate: 5 } },
    rawEvents: vaults.map((address) => ({ vault: address, block: 10, blockHash: hash, txHash: tx, logIndex: 1 })),
    classifications: vaults.map(() => ({ class: 'candidate', kind: 'receive-assets', leadSeconds: 259_200, proposedGate: gate, preState: { gateAtSubmit: zero } })),
  }
  const factory = {
    study: 'morpho-v2-factory-create-v1',
    status: 'complete',
    events: [...vaults.map((address) => ({ vault: address, block: 1 })), ...Array.from({ length: 752 }, (_, i) => ({ vault: `0x${String(i + 10).padStart(40, '0')}`, block: 1 }))],
  }
  assert.equal(selectFive(census, factory).length, 5)
  assert.throws(() => selectFive({ ...census, classifications: census.classifications.slice(1) }, factory), /mismatch/)
  assert.throws(() => selectFive({ ...census, rawEvents: census.rawEvents.map((e) => ({ ...e, vault: vaults[0] })) }, factory), /five distinct/)
})

test('bounded Transfer checkpoint resumes from saved frontier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-gate-holder-'))
  const rawPath = join(dir, 'raw', `${vault}-3-pre-b-transfers.json`)
  const anchor = { vault, index: 77, block: 3, creationBlock: 1 }
  const calls = []
  const client = {
    async request({ method, params }) {
      assert.equal(method, 'eth_getLogs')
      calls.push(params[0].fromBlock)
      return [rawMint()]
    },
  }
  try {
    const first = await collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 })
    assert.equal(first.status, 'complete')
    assert.equal(first.logs.length, 1)
    assert.equal(JSON.parse(readFileSync(rawPath)).nextBlock, 3)
    await collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 })
    assert.equal(calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('partial Transfer cache rejects replayable mutation and missing digest before RPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-gate-holder-resume-'))
  const rawPath = join(dir, 'raw', `${vault}-8002-pre-b-transfers.json`)
  const anchor = { vault, index: 77, block: 8002, creationBlock: 1 }
  let calls = 0
  const client = {
    async request({ params }) {
      calls++
      return params[0].fromBlock === toHex(1) ? [rawMint()] : []
    },
  }
  try {
    await assert.rejects(
      collectTransfers({ client, anchor, rawPath, minFreeBytes: 0, onProgress() { throw new Error('stop after first chunk') } }),
      /stop after first chunk/,
    )
    const partial = JSON.parse(readFileSync(rawPath, 'utf8'))
    assert.equal(partial.status, 'partial')
    assert.equal(partial.logs.length, 1)
    const beforeResume = calls
    const complete = await collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 })
    assert.equal(complete.status, 'complete')
    assert.equal(calls, beforeResume + 1)
    writeFileSync(rawPath, JSON.stringify({ ...partial, logs: [] }))
    await assert.rejects(collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 }), /raw SHA mismatch/)
    assert.equal(calls, beforeResume + 1)
    const { logsSha256, ...legacy } = partial
    writeFileSync(rawPath, JSON.stringify(legacy))
    await assert.rejects(collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 }), /raw SHA mismatch/)
    assert.equal(calls, beforeResume + 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing pilot results are bound to complete raw bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-gate-holder-result-'))
  const rawDir = join(dir, 'raw')
  const rawPath = join(rawDir, `${vault}-3-pre-b-transfers.json`)
  const anchor = { vault, index: 77, block: 3, creationBlock: 1 }
  const client = { async request() { return [rawMint()] } }
  try {
    const raw = await collectTransfers({ client, anchor, rawPath, minFreeBytes: 0 })
    const result = {
      vault, preBlock: 2, rawPath,
      rawSha256: createHash('sha256').update(readFileSync(rawPath)).digest('hex'),
      rawLogCount: raw.logs.length, replayedSupply: '100',
    }
    verifyResultPrefix({ results: [result] }, [anchor], rawDir)
    assert.throws(() => verifyResultPrefix({ results: [{ ...result, rawSha256: '0'.repeat(64) }] }, [anchor], rawDir), /raw SHA mismatch/)
    const altered = { ...raw, logs: [] }
    writeFileSync(rawPath, JSON.stringify(altered))
    assert.throws(() => verifyResultPrefix({ results: [result] }, [anchor], rawDir), /raw SHA mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate call distinguishes false, true, explicit revert, transport error, and malformed return', async () => {
  const makeClient = (result) => ({ async request() { if (result instanceof Error) throw result; return result } })
  const bool = (value) => encodeAbiParameters([{ type: 'bool' }], [value])
  assert.equal((await probeGate({ client: makeClient(bool(false)), gate, account: holder, preBlock: 2 })).status, 'false')
  assert.equal((await probeGate({ client: makeClient(bool(true)), gate, account: holder, preBlock: 2 })).status, 'true')
  assert.equal((await probeGate({ client: makeClient('0x'), gate, account: holder, preBlock: 2 })).status, 'malformed-return')
  assert.equal((await probeGate({ client: makeClient(new Error('execution reverted')), gate, account: holder, preBlock: 2 })).status, 'revert')
  assert.equal((await probeGate({ client: makeClient(new Error('ETIMEDOUT')), gate, account: holder, preBlock: 2 })).status, 'rpc-error')
  assert.equal(classifyGateError(new Error('Rate limited')), 'rpc-error')
  let from = null
  await probeGate({ client: { async request({ params }) { from = params[0].from; return bool(true) } }, gate, account: holder, preBlock: 2, caller: vault })
  assert.equal(from, vault)
})

test('pre-Submit holder probe uses replayed shares and a pinned gate call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-gate-holder-probe-'))
  const rawPath = join(dir, 'raw', `${vault}-3-pre-b-transfers.json`)
  const anchor = { vault, index: 77, block: 3, blockHash: hash, txHash: tx, logIndex: 1, creationBlock: 1, proposedGate: gate }
  const client = {
    async request({ method, params }) {
      if (method === 'eth_getLogs') return [rawMint()]
      assert.equal(method, 'eth_call')
      assert.equal(params[1], toHex(2))
      const decoded = decodeFunctionData({ abi: ABI, data: params[0].data })
      return encodeAbiParameters([{ type: 'bool' }], [decoded.args[0].toLowerCase() === vault])
    },
    async getBlock() { return { hash } },
    async getCode({ address }) { return address.toLowerCase() === holder ? '0x' : '0x6000' },
    async readContract({ functionName }) { return functionName === 'totalSupply' ? 100n : 100n },
  }
  try {
    const result = await probeAnchor({ client, anchor, rawPath, minFreeBytes: 0 })
    assert.equal(result.status, 'probed')
    assert.equal(result.holder, holder)
    assert.equal(result.replayedSupply, '100')
    assert.equal(result.holderGate.status, 'false')
    assert.equal(result.vaultGate.status, 'true')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
