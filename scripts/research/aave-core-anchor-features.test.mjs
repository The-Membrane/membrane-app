import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import { readCheckpoint as readBaseline } from './aave-core-holder-witness.mjs'
import {
  HORIZON_SECONDS,
  kinkGap,
  modelKinkGap,
  plan,
  readCheckpoint,
  run,
} from './aave-core-anchor-features.mjs'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const BLOCK = 100
const TIMESTAMP = 1000
const HASH = `0x${'ab'.repeat(32)}`
const CODE_HASH = keccak256('0x6000')
const PROVIDER = `0x${'11'.repeat(20)}`
const MOCK = `0x${'22'.repeat(20)}`
const ZERO = `0x${'00'.repeat(20)}`
const DEBT = `0x${'33'.repeat(20)}`
const STRATEGY = `0x${'44'.repeat(20)}`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aave-anchor-features-'))
  const baselinePath = join(dir, 'baseline.json')
  const out = join(dir, 'features.json')
  const data = readBaseline(baselinePath)
  const withoutHash = {
    block: BLOCK,
    blockHash: HASH,
    blockTimestamp: TIMESTAMP,
    observedAtMs: TIMESTAMP * 1000 + 1000,
    poolCodeHash: CODE_HASH,
    markets: MARKETS.map((market) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      aToken: market.aToken.toLowerCase(),
      decimals: market.decimals,
      quoteRaw: '1000000000000',
      underlyingCodeHash: CODE_HASH,
      aTokenCodeHash: CODE_HASH,
    })),
    previousSha256: null,
  }
  const row = { ...withoutHash, rowSha256: digest(withoutHash) }
  data.baselines.push(row)
  writeFileSync(baselinePath, JSON.stringify({ payload: data, sha256: digest(data) }))
  return { dir, baselinePath, out }
}

function client() {
  const calls = []
  const track = (method, args) => {
    calls.push({ method, args })
    if (method !== 'getChainId') assert.equal(args.blockNumber, BigInt(BLOCK))
  }
  const api = {
    calls,
    async getChainId(args) {
      track('getChainId', args)
      return 1
    },
    async getBlock(args) {
      track('getBlock', args)
      return { hash: HASH, timestamp: BigInt(TIMESTAMP) }
    },
    async getCode(args) {
      track('getCode', args)
      return '0x6000'
    },
    async readContract(args) {
      track('readContract', args)
      switch (args.functionName) {
        case 'ADDRESSES_PROVIDER':
          return PROVIDER
        case 'getAddress':
          return MOCK
        case 'getReserveData':
          return {
            aTokenAddress: MARKETS.find((market) => market.base === args.args[0]).aToken,
            variableDebtTokenAddress: DEBT,
            interestRateStrategyAddress: STRATEGY,
            stableDebtTokenAddress: MOCK,
            configuration: { data: (6n << 48n) | (1n << 56n) },
            lastUpdateTimestamp: 900n,
            id: 2n,
            currentLiquidityRate: 1n,
            currentVariableBorrowRate: 2n,
            currentStableBorrowRate: 3n,
          }
        case 'decimals':
          return 6
        case 'balanceOf':
          return 300n
        case 'getVirtualUnderlyingBalance':
          return 100n
        case 'totalSupply':
          if (args.address === DEBT) return 700n
          if (args.address === MOCK) return 0n
          return 1000n
        case 'getInterestRateDataBps':
          return {
            optimalUsageRatio: 8000n,
            baseVariableBorrowRate: 1n,
            variableRateSlope1: 2n,
            variableRateSlope2: 3n,
          }
        default:
          throw new Error(`Unexpected ${args.functionName}`)
      }
    },
  }
  return api
}

test('signed gaps retain exact numerator and denominator; virtual model differs from cash proxy', () => {
  const proxy = kinkGap(8000, 700, 300)
  const model = modelKinkGap(8000, 700, 100)
  assert.deepEqual(proxy.signedGapFraction, { numerator: '1000000', denominator: '10000000' })
  assert.deepEqual(model.signedGapFraction, { numerator: '-600000', denominator: '8000000' })
  assert.deepEqual(model.borrowUsageFraction, { numerator: '700', denominator: '800' })
  assert.throws(() => kinkGap(9000, 0, 0), /Undefined/)
  assert.throws(() => kinkGap(10001, 1, 1), /Undefined/)
})

test('dry plan makes no RPC call or write', () => {
  const { dir, baselinePath, out } = fixture()
  try {
    assert.deepEqual(plan(out, baselinePath).rows, 0)
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collects only pinned baseline block, source seal, both proxy and model, then rereads output', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const mock = client()
    const observedAtMs = TIMESTAMP * 1000 + 2000
    const result = await run({
      client: mock,
      baselineBlock: BLOCK,
      baselinePath,
      out,
      now: () => observedAtMs,
      checkDisk: () => {},
    })
    assert.equal(result.block, BLOCK)
    assert.equal(result.markets.length, 2)
    const saved = readCheckpoint(out, baselinePath).rows[0]
    assert.equal(saved.sourcePhysicalSha256.length, 64)
    assert.equal(saved.baselineRowSha256, readBaseline(baselinePath).baselines[0].rowSha256)
    assert.equal(saved.markets[0].rawCashProxy.signedGapFraction.numerator, '1000000')
    assert.equal(saved.markets[0].strategyBorrowUsageModel.signedGapFraction.numerator, '-600000')
    assert.equal(saved.markets[0].stableDebtFieldKind, 'compatibility-mock')
    assert.equal(saved.markets[0].flags.active, true)
    assert.ok(mock.calls.length > 10)
    await assert.rejects(
      run({ client: mock, baselineBlock: BLOCK, baselinePath, out, checkDisk: () => {} }),
      /duplicate/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('future feature seals start before first RPC; forged late start is rejected', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const mock = client()
    let ticks = 0
    const originalChainId = mock.getChainId
    mock.getChainId = async (...args) => {
      assert.equal(ticks, 2)
      return originalChainId(...args)
    }
    await run({
      client: mock,
      baselineBlock: BLOCK,
      baselinePath,
      out,
      now: () => TIMESTAMP * 1000 + 1000 + ++ticks,
      checkDisk: () => {},
    })
    const row = readCheckpoint(out, baselinePath).rows[0]
    assert.equal(row.captureStartedAtMs, TIMESTAMP * 1000 + 1002)
    assert.equal(row.observedAtMs, TIMESTAMP * 1000 + 1003)

    const sealed = JSON.parse(readFileSync(out, 'utf8'))
    sealed.payload.rows[0].captureStartedAtMs = row.observedAtMs + 1
    sealed.payload.rows[0].rowSha256 = digest({ ...sealed.payload.rows[0], rowSha256: undefined })
    sealed.sha256 = digest(sealed.payload)
    writeFileSync(out, JSON.stringify(sealed))
    assert.throws(() => readCheckpoint(out, baselinePath), /row chain mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('late feature start aborts before any RPC or output', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const mock = client()
    await assert.rejects(
      run({
        client: mock,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        now: () => (TIMESTAMP + HORIZON_SECONDS) * 1000,
        checkDisk: () => {},
      }),
      /after \+6h/,
    )
    assert.equal(mock.calls.length, 0)
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('disk guard aborts before first RPC or output', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const mock = client()
    await assert.rejects(
      run({
        client: mock,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        checkDisk: () => {
          throw new Error('Disk floor')
        },
      }),
      /Disk floor/,
    )
    assert.equal(mock.calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects changed canonical block and code identity', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const changed = client()
    changed.getBlock = async () => ({ hash: `0x${'cd'.repeat(32)}`, timestamp: BigInt(TIMESTAMP) })
    await assert.rejects(
      run({
        client: changed,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        now: () => TIMESTAMP * 1000 + 2000,
        checkDisk: () => {},
      }),
      /no longer canonical/,
    )
    const badCode = client()
    badCode.getCode = async () => '0x6001'
    await assert.rejects(
      run({
        client: badCode,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        now: () => TIMESTAMP * 1000 + 2000,
        checkDisk: () => {},
      }),
      /Pool code identity changed/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects non-mainnet chain and malformed stable mock, never writing', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const wrongChain = client()
    wrongChain.getChainId = async () => 10
    await assert.rejects(
      run({
        client: wrongChain,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        now: () => TIMESTAMP * 1000 + 2000,
        checkDisk: () => {},
      }),
      /mainnet/,
    )
    const malformed = client()
    const original = malformed.readContract
    malformed.readContract = async (args) =>
      args.functionName === 'getAddress' ? 'garbage' : original(args)
    await assert.rejects(
      run({
        client: malformed,
        baselineBlock: BLOCK,
        baselinePath,
        out,
        now: () => TIMESTAMP * 1000 + 2000,
        checkDisk: () => {},
      }),
      /mock stable-debt/,
    )
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zero mock registry keeps raw proxy but never claims the strategy model', async () => {
  const { dir, baselinePath, out } = fixture()
  try {
    const zeroRegistry = client()
    const original = zeroRegistry.readContract
    zeroRegistry.readContract = async (args) => {
      if (args.functionName === 'getAddress') return ZERO
      if (args.functionName === 'getReserveData')
        return { ...(await original(args)), stableDebtTokenAddress: ZERO }
      return original(args)
    }
    await run({
      client: zeroRegistry,
      baselineBlock: BLOCK,
      baselinePath,
      out,
      now: () => TIMESTAMP * 1000 + 2000,
      checkDisk: () => {},
    })
    for (const market of readCheckpoint(out, baselinePath).rows[0].markets) {
      assert.equal(market.rawCashProxy.signedGapFraction.numerator, '1000000')
      assert.equal(market.strategyBorrowUsageModel, null)
      assert.equal(
        market.strategyBorrowUsageMissingReason,
        'zero-mock-registry-cannot-attest-stable-debt',
      )
      assert.equal(market.stableDebtFieldKind, 'unresolved-zero-registry')
      assert.equal(market.stableDebtSupplyRaw, null)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pool address remains the expected canonical mainnet Pool', () => {
  assert.equal(POOL.toLowerCase(), '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2')
})
