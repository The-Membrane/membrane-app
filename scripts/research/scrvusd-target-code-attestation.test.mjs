import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import {
  capture,
  parseCli,
  parseEip1167Runtime,
  run,
  save,
  verify,
} from './scrvusd-target-code-attestation.mjs'

const h = (char) => `0x${char.repeat(64)}`
const addr = (char) => `0x${char.repeat(40)}`
const target = addr('2')
const vault = addr('1')
const runtime = `0x363d3d373d3d3d363d73${target.slice(2)}5af43d82803e903d91602b57fd5bf3`
const targetCode = '0x6000600055'
const block = { number: 100, hash: h('a'), timestamp: 1_800_000_000 }
const captureEndUtc = new Date(block.timestamp * 1000 + 60_000).toISOString()
const identity = { chainId: 1, vault, crvUsd: addr('3'), identitySha256: 'c'.repeat(64) }
const checkpoints = [
  {
    filename: 'checkpoint.json',
    physicalSha256: 'd'.repeat(64),
    checkpoint: { block, captureEndUtc, sha256: 'e'.repeat(64) },
  },
]
const now = () => new Date(block.timestamp * 1000 + 120_000)
const disk = () => ({ bavail: 1_000_000, bsize: 4096 })

function client({
  vaultCode = runtime,
  implementation = targetCode,
  drift = false,
  wrongChain = false,
  unf = false,
} = {}) {
  const calls = []
  let canonicalCalls = 0
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params })
      if (method === 'eth_chainId') return wrongChain ? '0xa' : '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized')
          return {
            number: unf ? '0x63' : '0x65',
            hash: h('f'),
            timestamp: `0x${block.timestamp.toString(16)}`,
          }
        canonicalCalls++
        return {
          number: '0x64',
          hash: drift && canonicalCalls > 1 ? h('b') : block.hash,
          timestamp: `0x${block.timestamp.toString(16)}`,
        }
      }
      if (method === 'eth_getCode') {
        assert.deepEqual(params[1], { blockHash: block.hash, requireCanonical: true })
        return params[0] === vault ? vaultCode : implementation
      }
      throw new Error('Unexpected RPC method')
    },
  }
}

test('exact 45-byte EIP-1167 runtime selects embedded target, then reads target at same hash', async () => {
  assert.equal(runtime.length, 92)
  assert.equal(parseEip1167Runtime(runtime), target)
  const rpc = client()
  const receipt = await capture({ client: rpc, checkpoints, identity, now })
  assert.equal(receipt.target, target)
  assert.equal(receipt.targetCodeHash, keccak256(targetCode))
  assert.equal(receipt.vaultCodeHash, keccak256(runtime))
  assert.deepEqual(
    rpc.calls.filter((call) => call.method === 'eth_getCode').map((call) => call.params[0]),
    [vault, target],
  )
  assert.equal(rpc.calls.filter((call) => call.method === 'eth_getBlockByNumber').length, 4)
})

test('nonstandard, empty, or changed vault runtime never falls back to another mechanism', async () => {
  for (const vaultCode of ['0x', '0x6000', `${runtime}00`, `0x00${runtime.slice(4)}`]) {
    const rpc = client({ vaultCode })
    await assert.rejects(capture({ client: rpc, checkpoints, identity, now }), /vault runtime/)
    assert.equal(rpc.calls.filter((call) => call.method === 'eth_getCode').length, 1)
  }
  assert.throws(
    () =>
      parseEip1167Runtime(`0x363d3d373d3d3d363d73${'0'.repeat(40)}5af43d82803e903d91602b57fd5bf3`),
    /target/,
  )
})

test('empty target, canonical drift, incomplete finality, and wrong chain refuse attestation', async () => {
  for (const options of [
    { implementation: '0x' },
    { drift: true },
    { unf: true },
    { wrongChain: true },
  ]) {
    await assert.rejects(capture({ client: client(options), checkpoints, identity, now }))
  }
})

test('source timing rejects stale, pre-checkpoint, and future physical captures', async () => {
  const stale = () => new Date(block.timestamp * 1000 + 7300_000)
  await assert.rejects(capture({ client: client(), checkpoints, identity, now: stale }), /stale/)
  const early = () => new Date(block.timestamp * 1000 + 30_000)
  await assert.rejects(capture({ client: client(), checkpoints, identity, now: early }), /timing/)
  const rpc = client()
  let calls = 0
  const backwards = () => new Date(block.timestamp * 1000 + (calls++ ? 90_000 : 120_000))
  await assert.rejects(
    capture({ client: rpc, checkpoints, identity, now: backwards }),
    /attestation/,
  )
})

test('immutable per-block write and read-only verification catch logical and physical source tamper', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-target-attest-'))
  const receipt = await capture({ client: client(), checkpoints, identity, now })
  const nowUtc = now().toISOString()
  const path = save({ receipt, out, stat: disk, identity, checkpoints, nowUtc })
  assert.deepEqual(verify({ out, identity, checkpoints, nowUtc }), { count: 1, latestBlock: 100 })
  assert.throws(() => save({ receipt, out, stat: disk, identity, checkpoints, nowUtc }), /EEXIST/)
  const changedSource = [{ ...checkpoints[0], physicalSha256: 'f'.repeat(64) }]
  assert.throws(() => verify({ out, identity, checkpoints: changedSource, nowUtc }), /attestation/)
  const canonical = readFileSync(path, 'utf8')
  writeFileSync(path, `${canonical.slice(0, -1)} \n`)
  assert.throws(() => verify({ out, identity, checkpoints, nowUtc }), /physical bytes/)
  await assert.rejects(
    run({ client: client(), out, identity, checkpoints, stat: disk, now }),
    /physical bytes/,
  )
  writeFileSync(path, canonical)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.targetCode = '0x6001'
  writeFileSync(path, `${JSON.stringify(value)}\n`)
  assert.throws(() => verify({ out, identity, checkpoints, nowUtc }), /seal/)
})

test('repeated recorder run verifies existing latest-block receipt and emits unchanged without RPC', async () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-target-run-'))
  const rpc = client()
  const first = await run({ client: rpc, out, identity, checkpoints, stat: disk, now })
  assert.equal(first.status, 'attested')
  const count = rpc.calls.length
  const replay = await run({ client: rpc, out, identity, checkpoints, stat: disk, now })
  assert.equal(replay.status, 'unchanged')
  assert.equal(replay.path, first.path)
  assert.equal(rpc.calls.length, count)
  const corrupted = JSON.parse(readFileSync(first.path, 'utf8'))
  corrupted.target = addr('9')
  writeFileSync(first.path, `${JSON.stringify(corrupted)}\n`)
  await assert.rejects(run({ client: rpc, out, identity, checkpoints, stat: disk, now }), /seal/)
})

test('CLI defaults to offline verification', () => {
  assert.equal(parseCli([]), '--verify')
  assert.equal(parseCli(['--verify']), '--verify')
  assert.equal(parseCli(['--run']), '--run')
  assert.throws(() => parseCli(['--run', 'anything']), /CLI/)
})
