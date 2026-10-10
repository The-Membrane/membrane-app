import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem'
import {
  sourceIdentity,
  readValidatedCheckpoints,
  validateCheckpoint,
  verify as verifyCheckpoint,
} from './susds-finalized-checkpoint.mjs'
import {
  FIXED_Q_RAW,
  capture,
  collectSeed,
  parseFirstPage,
  save,
  validateReceipt,
  verify,
} from './susds-holder-seed.mjs'

const abi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
])
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const impl = addr(999)
const vaultCode = '0x60016002'
const implCode = '0x60036004'
const hash = `0x${'a'.repeat(64)}`
const identity = sourceIdentity([
  {
    name: 'sUSDS',
    enabled: true,
    address: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    underlying: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    decimals: 18,
  },
])
const seal = (value) => ({
  ...value,
  sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
})
const reseal = ({ sha256: _sha256, ...value }) => seal(value)
const page = () => ({
  items: Array.from({ length: 50 }, (_, i) => ({
    address: { hash: addr(i + 10) },
    value: String(50 - i),
  })),
  next_page_params: { items_count: 50, value: '1' },
})
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })

function fixture({
  max = {},
  balance = {},
  preview = FIXED_Q_RAW,
  code = {},
  fail = null,
  mismatchCode = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'susds-holder-seed-'))
  const checkpointOut = join(root, 'checkpoints')
  const seedOut = join(root, 'seeds')
  const now = Date.now()
  const block = { number: 100, hash, timestamp: Math.floor((now - 120_000) / 1000) }
  const checkpoint = seal({
    study: 'susds-finalized-vault-checkpoint-v1',
    source: identity,
    captureStartUtc: new Date(now - 70_000).toISOString(),
    captureEndUtc: new Date(now - 69_000).toISOString(),
    block,
    pinMode: 'hash',
    pinCaveat: null,
    contract: {
      vaultCodeHash: keccak256(vaultCode),
      implementationSlotWord: `0x${'0'.repeat(24)}${impl.slice(2)}`,
      implementation: impl,
      implementationCodeHash: keccak256(implCode),
    },
    state: {
      asset: identity.asset,
      decimals: 18,
      totalAssetsRaw: '100',
      totalSupplyRaw: '100',
      assetsPerShareRaw: '100',
    },
    caveat:
      'One finalized-block source and state observation; code hashes do not establish historical implementation parity or holder exit feasibility.',
  })
  validateCheckpoint(checkpoint, identity)
  mkdirSync(checkpointOut)
  const checkpointName = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
  writeFileSync(join(checkpointOut, checkpointName), `${JSON.stringify(checkpoint)}\n`)
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity })
  const body = page()
  const url = `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`
  const client = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized')
          return { number: '0x64', hash, timestamp: `0x${block.timestamp.toString(16)}` }
        return { number: '0x64', hash, timestamp: `0x${block.timestamp.toString(16)}` }
      }
      if (method === 'eth_getCode') {
        assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
        if (params[0] === identity.vault) return mismatchCode ? '0x6000' : vaultCode
        if (params[0] === impl) return implCode
        return code[params[0]] ?? '0x'
      }
      if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
        const decoded = decodeFunctionData({ abi, data: params[0].data })
        const holder = typeof decoded.args?.[0] === 'string' ? decoded.args[0].toLowerCase() : null
        if (fail && holder === fail) throw new Error('secret provider url')
        const result =
          decoded.functionName === 'asset'
            ? identity.asset
            : decoded.functionName === 'balanceOf'
              ? (balance[holder] ?? FIXED_Q_RAW)
              : decoded.functionName === 'maxWithdraw'
                ? (max[holder] ?? FIXED_Q_RAW)
                : preview
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result })
      }
      throw new Error('Unexpected method')
    },
  }
  return {
    root,
    checkpointOut,
    seedOut,
    identity,
    checkpoints,
    body,
    block,
    capture: () =>
      capture({
        client,
        identity,
        checkpointOut,
        fetchPage: async () => ({ status: 200, url, body, rawBody: JSON.stringify(body) }),
        now: () => now,
      }),
    collect: (lockTimeoutMs = 500) =>
      collectSeed({
        out: seedOut,
        client,
        identity,
        checkpointOut,
        fetchPage: async () => ({ status: 200, url, body, rawBody: JSON.stringify(body) }),
        now: () => now,
        stat,
        lockTimeoutMs,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('first page must be complete, ordered and unique', () => {
  assert.equal(parseFirstPage(page()).length, 50)
  const short = page()
  short.items.pop()
  assert.throws(() => parseFirstPage(short))
  const duplicate = page()
  duplicate.items[1].address.hash = duplicate.items[0].address.hash
  assert.throws(() => parseFirstPage(duplicate))
})

test('largest eligible pinned share balance wins, regardless of listed balance', async () => {
  const x = fixture({
    balance: { [addr(11)]: 3n * FIXED_Q_RAW, [addr(12)]: 2n * FIXED_Q_RAW },
    code: { [addr(10)]: '0x6000' },
  })
  try {
    const seed = await x.capture()
    assert.equal(seed.candidates[0], addr(11))
    assert.equal(seed.results[0].status, 'contract')
    assert.equal(seed.results[1].previewSharesRaw, FIXED_Q_RAW.toString())
    const file = save({ receipt: seed, out: x.seedOut, identity, checkpoints: x.checkpoints, stat })
    assert.ok(file.endsWith('.json'))
    assert.equal(verify({ out: x.seedOut, identity, checkpoints: x.checkpoints }).count, 1)
  } finally {
    x.cleanup()
  }
})

test('no eligible EOA is sealed at fixed q; ambiguous read prevents selection', async () => {
  const x = fixture({
    max: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [addr(i + 10), FIXED_Q_RAW - 1n])),
  })
  try {
    const seed = await x.capture()
    assert.equal(seed.status, 'no_eligible')
    assert.deepEqual(seed.candidates, [])
  } finally {
    x.cleanup()
  }
  const y = fixture({ fail: addr(11) })
  try {
    const seed = await y.capture()
    assert.equal(seed.status, 'unavailable')
    assert.deepEqual(seed.candidates, [])
  } finally {
    y.cleanup()
  }
})

test('q is ineligible when preview requires more shares than the holder owns', async () => {
  const x = fixture({ preview: FIXED_Q_RAW + 1n })
  try {
    const seed = await x.capture()
    assert.equal(seed.status, 'no_eligible')
    assert.equal(seed.results[0].status, 'dust_or_empty')
  } finally {
    x.cleanup()
  }
})

test('source code drift and receipt tamper fail closed', async () => {
  const x = fixture({ mismatchCode: true })
  try {
    await assert.rejects(x.capture())
  } finally {
    x.cleanup()
  }
  const y = fixture()
  try {
    const seed = await y.capture()
    assert.throws(() =>
      validateReceipt(
        { ...seed, vaultCodeHash: `0x${'b'.repeat(64)}` },
        { identity, checkpoints: y.checkpoints },
      ),
    )
    assert.throws(() =>
      validateReceipt(reseal({ ...seed, page: { ...seed.page, rawBody: '{}' } }), {
        identity,
        checkpoints: y.checkpoints,
      }),
    )
    assert.equal(verifyCheckpoint({ out: y.checkpointOut, identity }).count, 1)
  } finally {
    y.cleanup()
  }
})

test('repeat and concurrent seed collection retain exactly one first-page sample', async () => {
  const x = fixture()
  try {
    const [first, second] = await Promise.all([x.collect(), x.collect()])
    assert.deepEqual([first.status, second.status].sort(), ['saved', 'unchanged'])
    assert.equal((await x.collect()).status, 'unchanged')
    assert.equal(verify({ out: x.seedOut, identity, checkpoints: x.checkpoints }).count, 1)
  } finally {
    x.cleanup()
  }
})

test('an existing collection lock fails closed without deleting it', async () => {
  const x = fixture()
  try {
    mkdirSync(x.seedOut)
    mkdirSync(join(x.seedOut, '.collection.lock'))
    await assert.rejects(x.collect(0), /locked/)
  } finally {
    x.cleanup()
  }
})
