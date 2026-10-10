import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { keccak256 } from 'viem'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import {
  SOURCE,
  SHOCK_RAW,
  collect,
  frozenSample,
  outputPath,
  plan,
  readSource,
  save,
} from './aave-core-holder-shock.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const OUT = 'data/research/venue-signals/shock-test-unique.json'
const SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

function fixture({
  revert = false,
  revertCode = false,
  rpcError = false,
  diskFailure = false,
  wrongHash = false,
  wrongImplementation = false,
} = {}) {
  const baseline = structuredClone(readSource())
  baseline.blockHash = H(45)
  baseline.poolCodeHash = keccak256('0x6000')
  baseline.poolImplementation = A(200)
  baseline.poolImplementationCodeHash = keccak256('0x6001')
  for (const row of baseline.rows) {
    row.aTokenCodeHash = keccak256('0x6000')
    row.aTokenImplementation = A(200)
    row.aTokenImplementationCodeHash = keccak256('0x6001')
  }
  let calls = 0
  let guards = 0
  const client = {
    async getChainId() {
      return 1
    },
    async getBlock({ blockNumber }) {
      assert.equal(blockNumber, 26_059_451n)
      return { hash: wrongHash ? H(46) : H(45) }
    },
    async request({ method, params }) {
      assert.deepEqual(params.at(-1), { blockHash: H(45), requireCanonical: true })
      if (method === 'eth_getCode') return params[0].toLowerCase() === A(200) ? '0x6001' : '0x6000'
      if (method === 'eth_getStorageAt') {
        assert.equal(params[1], SLOT)
        return H(wrongImplementation ? 201 : 200)
      }
      if (method === 'eth_call') {
        calls++
        assert.equal(params[0].to.toLowerCase(), POOL.toLowerCase())
        assert.equal(params[0].data.slice(0, 10), '0x69328dec')
        const market = MARKETS.find(
          (m) => m.base.toLowerCase() === `0x${params[0].data.slice(34, 74)}`,
        )
        assert.ok(market)
        assert.equal(BigInt(`0x${params[0].data.slice(74, 138)}`), SHOCK_RAW)
        assert.equal(`0x${params[0].data.slice(162, 202)}`, params[0].from)
        if (revert && calls === 1)
          throw Object.assign(new Error('secret-url'), {
            name: 'ExecutionRevertedError',
            data: '0xdeadbeef',
          })
        if (revertCode && calls === 1)
          throw Object.assign(new Error('secret-url'), { code: 3, data: '0xdeadbeef' })
        if (rpcError && calls === 2)
          throw Object.assign(new Error('secret-url'), { name: 'HttpRequestError' })
        return H(SHOCK_RAW)
      }
      throw new Error('Unexpected RPC')
    },
  }
  const checkDisk = () => {
    guards++
    if (diskFailure && calls > 0) throw new Error('Disk reserve below 1 GiB')
  }
  return { baseline, client, checkDisk, counts: () => ({ calls, guards }) }
}

test('dry plan does not do network or disk writes and requires unique ignored output', () => {
  assert.equal(plan().status, 'dry-only')
  assert.ok(outputPath(OUT).endsWith('/data/research/venue-signals/shock-test-unique.json'))
  assert.throws(() => outputPath(), /Explicit --out/)
  assert.throws(() => outputPath('/tmp/shock.json'), /Unique JSON/)
  assert.throws(() => outputPath(SOURCE), /Unique JSON/)
})

test('physical source SHA and payload seal freeze exactly four plus six holders', () => {
  const baseline = readSource()
  assert.equal(baseline.block, 26_059_451)
  assert.deepEqual(
    baseline.rows.map((r) => r.holders.length),
    [4, 6],
  )
  assert.ok(baseline.rows.every((r) => r.holders.every((h) => BigInt(h.balanceRaw) >= SHOCK_RAW)))
  const saved = JSON.parse(readFileSync(SOURCE, 'utf8'))
  saved.sha256 = '0'.repeat(64)
  assert.throws(() => frozenSample(saved), /payload seal/)
})

test('ten independent EIP-1898 calls, without cumulative state changes', async () => {
  const f = fixture()
  const result = await collect({
    out: OUT,
    client: f.client,
    checkDisk: f.checkDisk,
    source: () => f.baseline,
    now: () => 1_790_500_000_000,
  })
  assert.deepEqual(
    result.payload.markets.map((r) => r.holders.length),
    [4, 6],
  )
  assert.equal(f.counts().calls, 10)
  assert.ok(
    result.payload.markets
      .flatMap((r) => r.holders)
      .every((h) => h.call === 'success' && h.returnedRaw === SHOCK_RAW.toString()),
  )
  assert.equal(result.sha256.length, 64)
})

test('execution revert and transport error remain distinct and credential-free', async () => {
  const f = fixture({ revert: true, rpcError: true })
  const result = await collect({
    out: OUT,
    client: f.client,
    checkDisk: f.checkDisk,
    source: () => f.baseline,
    now: () => 1_790_500_000_000,
  })
  const rows = result.payload.markets.flatMap((r) => r.holders)
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.call),
    ['revert', 'rpc-error'],
  )
  assert.equal(rows[0].revertSelector, '0xdeadbeef')
  assert.equal(rows[1].revertData, null)
  assert.doesNotMatch(JSON.stringify(result), /secret-url/)
})

test('JSON-RPC execution-reverted code is not mistaken for transport failure', async () => {
  const f = fixture({ revertCode: true })
  const result = await collect({
    out: OUT,
    client: f.client,
    checkDisk: f.checkDisk,
    source: () => f.baseline,
    now: () => 1_790_500_000_000,
  })
  assert.equal(result.payload.markets[0].holders[0].call, 'revert')
})

test('identity mismatch and disk-floor failure abort before a complete result', async () => {
  for (const option of [
    { wrongHash: true },
    { wrongImplementation: true },
    { diskFailure: true },
  ]) {
    const f = fixture(option)
    await assert.rejects(
      collect({
        out: OUT,
        client: f.client,
        checkDisk: f.checkDisk,
        source: () => f.baseline,
        now: () => 1_790_500_000_000,
      }),
      /mismatch|changed|Disk reserve/,
    )
    if (!option.diskFailure) assert.equal(f.counts().calls, 0)
  }
})

test('atomic publication never clobbers a racing writer and cleans its temp', () => {
  const target = outputPath(OUT)
  const files = new Map()
  let nextFd = 0
  const handles = new Map()
  const io = {
    existsSync: (path) => files.has(path),
    mkdirSync() {},
    openSync(path) {
      files.set(path, '')
      const fd = ++nextFd
      handles.set(fd, path)
      return fd
    },
    writeFileSync(fd, text) {
      files.set(handles.get(fd), text)
    },
    closeSync(fd) {
      handles.delete(fd)
    },
    linkSync(from, to) {
      files.set(to, 'another writer')
      if (files.has(to)) throw new Error('EEXIST')
      files.set(to, files.get(from))
    },
    readFileSync: (path) => files.get(path),
    unlinkSync(path) {
      files.delete(path)
    },
  }
  assert.throws(() => save(OUT, { payload: {}, sha256: 'x' }, () => {}, io), /EEXIST/)
  assert.deepEqual([...files.entries()], [[target, 'another writer']])
})
