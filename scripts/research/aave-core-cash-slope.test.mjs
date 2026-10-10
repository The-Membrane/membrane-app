import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256 } from 'viem'
import { ABI, MARKETS, POOL } from './aave-core-forward-panel.mjs'
import {
  BLOCK,
  DEFAULT_OUT,
  OUTPUT_ROOT,
  SOURCE_SHA256,
  captureConfig,
  cashSlope,
  collect,
  firstBlockAtOrAfter,
  parseCliArgs,
  plan,
  readSnapshot,
  saveSnapshot,
} from './aave-core-cash-slope.mjs'

const sha = (x) => createHash('sha256').update(x).digest('hex')
const seal = (x) => sha(JSON.stringify(x))
const B = BLOCK
const B_TIME = 1_790_401_643 // 2026-09-26 05:47:23 UTC
const CAPTURE_TIME = Date.parse('2026-09-26T06:10:00Z')
const CAPTURE_DATE = '2026-09-26'
const H = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const IMPLEMENTATION = `0x${'ab'.repeat(20)}`
const CODE = '0x6000'
const CODE_HASH = keccak256(CODE)

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cash-slope-'))
  const sourcePath = join(dir, 'feature.json')
  const out = join(dir, 'slope.json')
  const payload = {
    study: 'aave-core-anchor-features-v1',
    chainId: 1,
    pool: POOL,
    rows: [
      {
        block: B,
        blockHash: H(B),
        blockTimestamp: B_TIME,
        observedAtMs: B_TIME * 1000 + 10,
        poolCodeHash: CODE_HASH,
        markets: MARKETS.map((market, i) => ({
          name: market.name,
          underlying: market.base,
          aToken: market.aToken,
          underlyingCodeHash: CODE_HASH,
          aTokenCodeHash: CODE_HASH,
          rawCashProxy: { cashRaw: i === 0 ? '125' : '75' },
        })),
      },
    ],
  }
  writeFileSync(sourcePath, JSON.stringify({ payload, sha256: seal(payload) }))
  return { dir, sourcePath, out, expectedSourceSha256: sha(readFileSync(sourcePath)) }
}

const reserveValue = (aToken) => ({
  configuration: { data: 0n },
  liquidityIndex: 0n,
  currentLiquidityRate: 0n,
  variableBorrowIndex: 0n,
  currentVariableBorrowRate: 0n,
  currentStableBorrowRate: 0n,
  lastUpdateTimestamp: 0,
  id: 0,
  aTokenAddress: aToken,
  stableDebtTokenAddress: IMPLEMENTATION,
  variableDebtTokenAddress: IMPLEMENTATION,
  interestRateStrategyAddress: IMPLEMENTATION,
  accruedToTreasury: 0n,
  unbacked: 0n,
  isolationModeTotalDebt: 0n,
})

function mock({ chain = 1, changedAToken = false, missingCash = false, largeGap = false } = {}) {
  const calls = []
  const priorBlock = B - 7200
  const priorHash = H(priorBlock)
  return {
    calls,
    async getChainId() {
      calls.push('chain')
      return chain
    },
    async getBlock({ blockNumber }) {
      const n = Number(blockNumber)
      assert.ok(n <= B, 'No after-B header read')
      calls.push(`header:${n}`)
      const timestamp =
        B_TIME +
        (n - B) * 12 +
        (largeGap && n >= priorBlock ? Math.floor((72 * (B - n)) / 7200) : 0)
      return { number: BigInt(n), hash: H(n), timestamp: BigInt(timestamp) }
    },
    async request({ method, params }) {
      calls.push(method)
      const pin = params.at(-1)
      assert.equal(pin.requireCanonical, true)
      assert.ok([priorHash, H(B)].includes(pin.blockHash), 'Only B or selected prior hash')
      if (method === 'eth_getCode') {
        if (
          changedAToken &&
          pin.blockHash === priorHash &&
          MARKETS.some((m) => m.aToken.toLowerCase() === params[0].toLowerCase())
        )
          return '0x6001'
        return CODE
      }
      if (method === 'eth_getStorageAt') return `0x${'00'.repeat(12)}${IMPLEMENTATION.slice(2)}`
      if (method !== 'eth_call') throw new Error('Unexpected RPC')
      const isReserve = params[0].to.toLowerCase() === POOL.toLowerCase()
      if (isReserve) {
        const decoded = decodeFunctionData({ abi: ABI.reserve, data: params[0].data })
        const market = MARKETS.find((m) => m.base.toLowerCase() === decoded.args[0].toLowerCase())
        assert.ok(market)
        return encodeFunctionResult({
          abi: ABI.reserve,
          functionName: 'getReserveData',
          result: reserveValue(market.aToken),
        })
      }
      const market = MARKETS.find((m) => m.base.toLowerCase() === params[0].to.toLowerCase())
      assert.ok(market)
      const decoded = decodeFunctionData({ abi: ABI.token, data: params[0].data })
      assert.equal(decoded.functionName, 'balanceOf')
      assert.equal(decoded.args[0].toLowerCase(), market.aToken.toLowerCase())
      if (missingCash && market.name === 'USDT') throw new Error('secret-rpc-url')
      return encodeFunctionResult({ abi: ABI.token, functionName: 'balanceOf', result: 100n })
    },
  }
}

test('dry plan and CLI do not read files, write, or require RPC', () => {
  assert.equal(plan().status, 'dry-only')
  assert.equal(plan().out, DEFAULT_OUT)
  assert.equal(parseCliArgs([]).run, false)
  const daily = [
    '--run',
    '--source',
    join(OUTPUT_ROOT, 'aave-core-anchor-features-2026-09-27.json'),
    '--source-sha256',
    'a'.repeat(64),
    '--block',
    String(B + 500),
    '--out',
    join(OUTPUT_ROOT, 'aave-core-cash-slope-2026-09-27.json'),
  ]
  assert.equal(parseCliArgs(daily).config.block, B + 500)
  assert.throws(() => parseCliArgs(daily.slice(0, -2)), /requires source/)
  assert.throws(() => parseCliArgs([...daily, '--block', '2']), /Invalid cash-slope/)
  assert.throws(() => captureConfig({ out: join(OUTPUT_ROOT, '..', 'other.json') }), /outside/)
  assert.throws(() => captureConfig({ expectedSourceSha256: 'a'.repeat(64) }), /frozen/)
  assert.throws(
    () => captureConfig({ out: join(OUTPUT_ROOT, 'aave-core-cash-slope-2026-09-27.json') }),
    /frozen calendar date/,
  )
  assert.equal(SOURCE_SHA256.length, 64)
})

test('lower-bound search chooses the first canonical timestamp, not a cash-selected header', async () => {
  const read = async (n) => ({
    number: BigInt(n),
    hash: H(n),
    timestamp: BigInt(B_TIME + (n - B) * 12),
  })
  const result = await firstBlockAtOrAfter(read, B, B_TIME)
  assert.equal(result.selected.number, B - 7200)
  assert.equal(result.predecessor.timestamp, result.target - 12)
  assert.equal(result.errorSeconds, 0)
  const slow = await firstBlockAtOrAfter(
    async (n) => ({ number: BigInt(n), hash: H(n), timestamp: BigInt(n < 3 ? n : n + 100) }),
    10,
    86_403,
  )
  assert.equal(slow.reason, 'timestamp-error-over-60s')
  assert.equal(slow.selected.number, 3)
  assert.equal(slow.errorSeconds, 100)
})

test('signed rational slope preserves raw units and zero-denominator censoring', () => {
  assert.deepEqual(cashSlope('100', '125'), { numerator: '25', denominator: '100' })
  assert.deepEqual(cashSlope('100', '75'), { numerator: '-25', denominator: '100' })
  assert.equal(cashSlope('0', '1'), null)
  assert.throws(() => cashSlope('-1', '2'), /Negative/)
})

test('same-hash source, identities, prior cash, and immutable seal', async () => {
  const f = fixture()
  try {
    const client = mock()
    const saved = await collect({
      ...f,
      client,
      checkDisk: () => {},
      now: () => CAPTURE_TIME,
      captureDate: CAPTURE_DATE,
    })
    assert.equal(saved.sha256, seal(saved.payload))
    assert.equal(saved.payload.priorBlock, B - 7200)
    assert.equal(saved.payload.actualElapsedSeconds, 86_400)
    assert.deepEqual(
      saved.payload.markets.map((m) => m.status),
      ['eligible', 'eligible'],
    )
    assert.deepEqual(
      saved.payload.markets.map((m) => m.signedSlopeFraction.numerator),
      ['25', '-25'],
    )
    assert.ok(client.calls.includes('eth_getStorageAt'))
    assert.ok(client.calls.includes('eth_call'))
    saveSnapshot(
      f.out,
      saved,
      () => {},
      () => CAPTURE_TIME,
    )
    assert.equal(
      readSnapshot(f.out, { block: B, expectedSourceSha256: f.expectedSourceSha256 }).sha256,
      saved.sha256,
    )
    assert.throws(
      () =>
        saveSnapshot(
          f.out,
          saved,
          () => {},
          () => CAPTURE_TIME,
        ),
      /overwrite/,
    )
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('wrong source SHA fails before RPC; wrong chain and anchor fail closed', async () => {
  const f = fixture()
  try {
    const client = mock()
    const opts = {
      ...f,
      client,
      checkDisk: () => {},
      now: () => CAPTURE_TIME,
      captureDate: CAPTURE_DATE,
    }
    await assert.rejects(collect({ ...opts, expectedSourceSha256: SOURCE_SHA256 }), /physical SHA/)
    assert.equal(client.calls.length, 0)
    await assert.rejects(collect({ ...opts, client: mock({ chain: 10 }) }), /mainnet/)
    const data = JSON.parse(readFileSync(f.sourcePath, 'utf8'))
    data.payload.rows[0].blockHash = H(B - 1)
    data.sha256 = seal(data.payload)
    writeFileSync(f.sourcePath, JSON.stringify(data))
    await assert.rejects(
      collect({ ...opts, expectedSourceSha256: sha(readFileSync(f.sourcePath)) }),
      /Frozen B/,
    )
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('identity change and market read failure remain censored, not zero slope', async () => {
  const f = fixture()
  try {
    const opts = {
      ...f,
      checkDisk: () => {},
      now: () => CAPTURE_TIME,
      captureDate: CAPTURE_DATE,
    }
    const changed = await collect({ ...opts, client: mock({ changedAToken: true }) })
    assert.ok(changed.payload.markets.every((m) => m.status === 'censored'))
    assert.ok(changed.payload.markets.every((m) => m.reasons.includes('aToken-identity-changed')))
    const missing = await collect({ ...opts, client: mock({ missingCash: true }) })
    assert.equal(missing.payload.markets[0].status, 'eligible')
    assert.equal(missing.payload.markets[1].status, 'censored')
    assert.equal(missing.payload.markets[1].cashPriorRaw, null)
    assert.deepEqual(missing.payload.markets[1].reasons, ['prior-or-B-read-failed'])
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('timestamp error over 60 seconds censors both markets without state RPC', async () => {
  const f = fixture()
  try {
    const client = mock({ largeGap: true })
    const saved = await collect({
      ...f,
      client,
      checkDisk: () => {},
      captureDate: CAPTURE_DATE,
      now: () => CAPTURE_TIME,
    })
    assert.equal(saved.payload.timestampErrorSeconds, 72)
    assert.deepEqual(
      saved.payload.markets.map((m) => m.status),
      ['censored', 'censored'],
    )
    assert.ok(saved.payload.markets.every((m) => m.reasons.includes('timestamp-error-over-60s')))
    assert.ok(!client.calls.some((call) => call.startsWith('eth_')))
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('disk guard is enforced before any RPC and not swallowed as a missing row', async () => {
  const f = fixture()
  try {
    const client = mock()
    await assert.rejects(
      collect({
        ...f,
        client,
        checkDisk: () => {
          throw new Error('disk-full')
        },
        now: () => CAPTURE_TIME,
        captureDate: CAPTURE_DATE,
      }),
      /Disk reserve guard failed/,
    )
    assert.equal(client.calls.length, 0)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('transient disk-guard failure during a market read aborts instead of becoming censored', async () => {
  const f = fixture()
  try {
    const client = mock()
    let tripped = false
    await assert.rejects(
      collect({
        ...f,
        client,
        captureDate: CAPTURE_DATE,
        now: () => CAPTURE_TIME,
        checkDisk: () => {
          if (!tripped && client.calls.includes('eth_getCode')) {
            tripped = true
            throw new Error('transient disk failure')
          }
        },
      }),
      /Disk reserve guard failed/,
    )
    assert.equal(tripped, true)
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})

test('missed day and finish deadline fail closed before capture/save', async () => {
  const f = fixture()
  try {
    const staleClient = mock()
    await assert.rejects(
      collect({
        ...f,
        client: staleClient,
        checkDisk: () => {},
        captureDate: CAPTURE_DATE,
        now: () => Date.parse('2026-09-27T06:10:00Z'),
      }),
      /missed 06:00–07:00 UTC start window/,
    )
    assert.equal(staleClient.calls.length, 0)
    const client = mock()
    let calls = 0
    await assert.rejects(
      collect({
        ...f,
        client,
        checkDisk: () => {},
        captureDate: CAPTURE_DATE,
        now: () => (calls++ === 0 ? CAPTURE_TIME : Date.parse('2026-09-26T07:30:01Z')),
      }),
      /missed 07:30 UTC finish deadline/,
    )
    const saved = await collect({
      ...f,
      client: mock(),
      checkDisk: () => {},
      captureDate: CAPTURE_DATE,
      now: () => CAPTURE_TIME,
    })
    assert.throws(
      () =>
        saveSnapshot(
          f.out,
          saved,
          () => {},
          () => Date.parse('2026-09-26T07:30:01Z'),
        ),
      /missed 07:30 UTC finish deadline/,
    )
  } finally {
    rmSync(f.dir, { recursive: true })
  }
})
