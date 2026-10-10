import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  IMPLEMENTATION_SLOT,
  RESERVE_BYTES,
  collect,
  readValidatedCheckpoints,
  selectRpc,
  sourceIdentity,
  verify,
} from './susds-finalized-checkpoint.mjs'

const VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd'
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
const IMPL = '0x1234567890123456789012345678901234567890'
const HASH = `0x${'a'.repeat(64)}`
const OTHER_HASH = `0x${'b'.repeat(64)}`
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
])
const AT = { number: '0x64', hash: HASH, timestamp: '0x6553f100' }
const NOW = new Date((Number(BigInt(AT.timestamp)) + 60) * 1000)
const stat = () => ({ bavail: 2, bsize: RESERVE_BYTES })
const tmp = () => mkdtempSync(join(tmpdir(), 'susds-checkpoint-'))
const config = (asset = USDS) => [
  { name: 'sUSDS', enabled: true, address: VAULT, underlying: asset, decimals: 18 },
]

function provider({
  hash = HASH,
  drift = false,
  unsupported = false,
  asset = USDS,
  delay = 0,
} = {}) {
  const calls = []
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { ...AT, hash }
        return { ...AT, hash: drift ? OTHER_HASH : hash }
      }
      const pin = params.at(-1)
      if (unsupported && typeof pin === 'object') throw new Error('blockHash unsupported')
      if (method === 'eth_call') {
        const decoded = decodeFunctionData({ abi: ABI, data: params[0].data })
        const values = {
          asset,
          decimals: 18,
          totalAssets: 2_000_000n,
          totalSupply: 1_000_000n,
          convertToAssets: 2_000_000_000_000_000_000n,
        }
        return encodeFunctionResult({
          abi: ABI,
          functionName: decoded.functionName,
          result: values[decoded.functionName],
        })
      }
      if (method === 'eth_getStorageAt') {
        assert.equal(params[0].toLowerCase(), VAULT)
        assert.equal(params[1], IMPLEMENTATION_SLOT)
        return `0x${'0'.repeat(24)}${IMPL.slice(2)}`
      }
      if (method === 'eth_getCode') {
        assert.ok([VAULT, IMPL].includes(params[0].toLowerCase()))
        return params[0].toLowerCase() === VAULT ? '0x60016002' : '0x60036004'
      }
      throw new Error('Unexpected provider method')
    },
  }
  return { client, calls }
}

test('config source drift is rejected', () => {
  assert.equal(sourceIdentity(config()).vault, VAULT)
  assert.throws(() => sourceIdentity(config(`0x${'0'.repeat(40)}`)), /identity changed/)
})

test('configured RPC ring selects first host; explicit RPC must be singular', () => {
  assert.equal(
    selectRpc(undefined, 'https://first.invalid,https://second.invalid'),
    'https://first.invalid',
  )
  assert.equal(selectRpc(' https://explicit.invalid ', undefined), 'https://explicit.invalid')
  assert.throws(() => selectRpc('https://first.invalid,https://second.invalid'), /one explicit/)
})

test('seals one finalized hash-pinned checkpoint, code provenance, and physical bytes', async () => {
  const out = tmp()
  try {
    const { client, calls } = provider()
    const result = await collect({ client, out, now: () => NOW, stat })
    assert.equal(result.status, 'recorded')
    assert.equal(verify({ out }).count, 1)
    const row = readValidatedCheckpoints({ out })[0]
    assert.equal(row.physicalSha256, result.physicalSha256)
    assert.equal(row.checkpoint.contract.implementation, IMPL)
    assert.equal(row.checkpoint.state.asset, USDS)
    assert.equal(row.checkpoint.pinMode, 'hash')
    assert.ok(
      calls.filter((x) => x.method === 'eth_call').every((x) => x.params[1].blockHash === HASH),
    )
    assert.ok(
      calls.filter((x) => x.method === 'eth_getCode').every((x) => x.params[1].blockHash === HASH),
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('exact finalized replay returns unchanged without new state calls', async () => {
  const out = tmp()
  try {
    await collect({ client: provider().client, out, now: () => NOW, stat })
    const { client, calls } = provider()
    const result = await collect({ client, out, now: () => NOW, stat })
    assert.equal(result.status, 'unchanged')
    assert.equal(verify({ out }).count, 1)
    assert.equal(
      calls.filter((x) => ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(x.method))
        .length,
      0,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('same finalized height with changed hash fails closed', async () => {
  const out = tmp()
  try {
    await collect({ client: provider().client, out, now: () => NOW, stat })
    await assert.rejects(
      collect({ client: provider({ hash: OTHER_HASH }).client, out, now: () => NOW, stat }),
      /height conflict/,
    )
    assert.equal(verify({ out }).count, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('number-pin fallback requires canonical block recheck', async () => {
  const out = tmp()
  try {
    const { client, calls } = provider({ unsupported: true })
    const result = await collect({ client, out, now: () => NOW, stat })
    assert.equal(result.status, 'recorded')
    assert.equal(readValidatedCheckpoints({ out })[0].checkpoint.pinMode, 'number-hash-checked')
    assert.ok(calls.some((x) => x.method === 'eth_call' && typeof x.params[1] === 'string'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  const driftOut = tmp()
  try {
    await assert.rejects(
      collect({
        client: provider({ unsupported: true, drift: true }).client,
        out: driftOut,
        now: () => NOW,
        stat,
      }),
      /Canonical finalized block drift/,
    )
    assert.equal(verify({ out: driftOut }).count, 0)
  } finally {
    rmSync(driftOut, { recursive: true, force: true })
  }
})

test('pinned asset mismatch is never sealed', async () => {
  const out = tmp()
  try {
    await assert.rejects(
      collect({ client: provider({ asset: VAULT }).client, out, now: () => NOW, stat }),
      /asset mismatch/,
    )
    assert.equal(verify({ out }).count, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('concurrent same-block collectors serialize to recorded and unchanged', async () => {
  const out = tmp()
  try {
    const results = await Promise.all([
      collect({ client: provider({ delay: 1 }).client, out, now: () => NOW, stat }),
      collect({ client: provider({ delay: 1 }).client, out, now: () => NOW, stat }),
    ])
    assert.deepEqual(results.map((x) => x.status).sort(), ['recorded', 'unchanged'])
    assert.equal(verify({ out }).count, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('logical and physical corruption each invalidate replay', async () => {
  const out = tmp()
  try {
    const result = await collect({ client: provider().client, out, now: () => NOW, stat })
    const original = readFileSync(result.path, 'utf8')
    writeFileSync(result.path, original.replace('2000000', '3000000'))
    assert.throws(() => verify({ out }), /logical seal/)
    writeFileSync(result.path, original.replace(/\n$/, '\n\n'))
    assert.throws(() => verify({ out }), /physical bytes/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
