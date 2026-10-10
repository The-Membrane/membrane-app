import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import { readCheckpoint as readBaseline } from './aave-core-holder-witness.mjs'
import {
  EIP1967_IMPLEMENTATION_SLOT,
  FROZEN_BLOCK,
  collectConfig,
  decodeUserBitmap,
  plan,
  readCheckpoint,
  run,
} from './aave-core-holder-config.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const BASE_TIME = 1_780_000_000
const Q = '1000000000000'

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-holder-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { baselinePath: join(dir, 'baseline.json'), out: join(dir, 'config.json') }
}

function baselineFixture(path) {
  const payload = readBaseline(path)
  const holders = [[A(1), A(2), A(3)], [A(4)]]
  const row = {
    block: FROZEN_BLOCK,
    blockHash: H(FROZEN_BLOCK),
    blockTimestamp: BASE_TIME,
    observedAtMs: (BASE_TIME + 100) * 1000,
    poolCodeHash: keccak256('0x6000'),
    markets: MARKETS.map((market, index) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      underlyingCodeHash: keccak256('0x6000'),
      aToken: market.aToken.toLowerCase(),
      aTokenCodeHash: keccak256('0x6000'),
      decimals: 6,
      quoteRaw: Q,
      candidates: holders[index].map((address) => ({
        address,
        aTokenBalanceRaw: Q,
        codeStatus: 'eoa',
        withdraw: 'success',
      })),
      qualifyingHolders: holders[index],
    })),
    previousSha256: null,
  }
  payload.baselines.push({ ...row, rowSha256: sha(row) })
  writeFileSync(path, JSON.stringify({ payload, sha256: sha(payload) }))
  return payload.baselines[0]
}

function fixture({
  reorg = false,
  implementation = true,
  configError = false,
  accountError = false,
} = {}) {
  const calls = []
  let headers = 0
  const client = {
    async getChainId() {
      calls.push('chain')
      return 1
    },
    async getBlock({ blockNumber }) {
      calls.push('block')
      assert.equal(blockNumber, BigInt(FROZEN_BLOCK))
      headers++
      return {
        hash: reorg && headers === 2 ? H(999) : H(FROZEN_BLOCK),
        timestamp: BigInt(BASE_TIME),
      }
    },
    async getCode({ address, blockNumber }) {
      calls.push('code')
      assert.equal(blockNumber, BigInt(FROZEN_BLOCK))
      assert.ok(
        [POOL, ...MARKETS.flatMap((market) => [market.base, market.aToken])].some(
          (a) => a.toLowerCase() === address.toLowerCase(),
        ),
      )
      return '0x6000'
    },
    async request({ method, params }) {
      calls.push(method)
      const pin = params[method === 'eth_getStorageAt' ? 2 : 1]
      assert.deepEqual(pin, { blockHash: H(FROZEN_BLOCK), requireCanonical: true })
      if (method === 'eth_getStorageAt') {
        assert.equal(params[0], POOL)
        assert.equal(params[1], EIP1967_IMPLEMENTATION_SLOT)
        return implementation ? H(99) : H(0)
      }
      if (method === 'eth_getCode') {
        assert.equal(params[0], A(99))
        return '0x6001'
      }
      throw new Error('Unexpected method')
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(functionName)
      assert.equal(address, POOL)
      assert.equal(blockNumber, BigInt(FROZEN_BLOCK))
      if (functionName === 'getReserveData') {
        const id = args[0].toLowerCase() === MARKETS[0].base.toLowerCase() ? 3 : 8
        return {
          id,
          aTokenAddress: MARKETS[id === 3 ? 0 : 1].aToken,
          configuration: { data: 6n << 48n },
        }
      }
      if (functionName === 'getUserConfiguration') {
        if (configError && args[0] === A(1)) throw new Error('configuration RPC failed')
        return { data: (1n << 7n) | (1n << 16n) }
      }
      if (functionName === 'getUserAccountData') {
        if (accountError && args[0] === A(1)) throw new Error('account RPC failed')
        return [2n, 1n, 1n, 8000n, 7500n, 2n]
      }
      throw new Error('Unexpected contract call')
    },
  }
  return { client, calls }
}

test('bitmap decoding uses collateral odd bit and borrowing even bits', () => {
  assert.deepEqual(decodeUserBitmap((1n << 7n) | (1n << 16n), 3), {
    bitmapRaw: ((1n << 7n) | (1n << 16n)).toString(),
    selectedReserveBorrowing: false,
    selectedReserveCollateral: true,
    anyBorrow: true,
  })
  assert.equal(decodeUserBitmap(1n << 16n, 8).selectedReserveBorrowing, true)
  assert.throws(() => decodeUserBitmap(1n << 256n, 3), /exceeds uint256/)
})

test('dry plan reads frozen local baseline with no RPC or write', (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const result = plan(paths)
  assert.equal(result.status, 'dry-only')
  assert.deepEqual(
    result.frozenWitnesses.map((row) => row.count),
    [3, 1],
  )
  assert.equal(existsSync(paths.out), false)
})

test('same frozen four produce SHA-sealed raw configuration and pinned implementation context', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture()
  let guards = 0
  const result = await run({
    ...paths,
    client,
    baselineBlock: FROZEN_BLOCK,
    checkDisk: () => guards++,
    now: () => (BASE_TIME + 200) * 1000,
  })
  assert.deepEqual(
    result.witnessCounts.map((row) => row.count),
    [3, 1],
  )
  assert.ok(guards >= calls.length)
  const row = readCheckpoint(paths.out, paths.baselinePath).records[0]
  assert.equal(row.baselineBlock, FROZEN_BLOCK)
  assert.equal(row.poolImplementation.status, 'observed')
  assert.equal(row.poolImplementation.address, A(99))
  assert.equal(row.poolImplementation.codeHash, keccak256('0x6001'))
  assert.equal(row.markets[0].witnesses[0].selectedReserveCollateral, true)
  assert.equal(row.markets[0].witnesses[0].anyBorrow, true)
  assert.equal(row.markets[0].witnesses[0].accountData.healthFactor, '2')
  assert.ok(!calls.includes('getBlockNumber'))
  assert.equal(calls.filter((name) => name === 'block').length, 2)
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: FROZEN_BLOCK,
      checkDisk: () => {},
      now: () => (BASE_TIME + 200) * 1000,
    }),
    /already recorded/,
  )
  const bytes = JSON.parse(readFileSync(paths.out, 'utf8'))
  bytes.payload.records[0].markets[0].witnesses[0].accountData.healthFactor = '999'
  writeFileSync(paths.out, JSON.stringify(bytes))
  assert.throws(() => readCheckpoint(paths.out, paths.baselinePath), /SHA mismatch/)
})

test('zero EIP-1967 slot is explicitly unknown, not source attestation', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ implementation: false })
  const row = await collectConfig({
    client,
    baseline,
    out: paths.out,
    checkDisk: () => {},
    now: () => (BASE_TIME + 200) * 1000,
  })
  assert.deepEqual(row.poolImplementation, {
    status: 'unknown',
    reason: 'zero-eip1967-implementation',
  })
})

test('reorg or wrong block rejects without checkpoint', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client } = fixture({ reorg: true })
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: FROZEN_BLOCK,
      checkDisk: () => {},
      now: () => (BASE_TIME + 200) * 1000,
    }),
    /reorganized/,
  )
  assert.equal(existsSync(paths.out), false)
  await assert.rejects(
    run({ ...paths, client, baselineBlock: FROZEN_BLOCK + 1, checkDisk: () => {} }),
    /Explicit frozen baseline/,
  )
})

test('disk guard is fatal, never a missing configuration row', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client } = fixture()
  let checks = 0
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: FROZEN_BLOCK,
      now: () => (BASE_TIME + 200) * 1000,
      checkDisk: () => {
        if (++checks === 5) throw new Error('low disk')
      },
    }),
    /low disk/,
  )
  assert.equal(existsSync(paths.out), false)
})

test('changed source success ledger is rejected before any RPC', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  baseline.markets[0].qualifyingHolders = [A(1)]
  const { client, calls } = fixture()
  await assert.rejects(
    collectConfig({ client, baseline, out: paths.out, checkDisk: () => {} }),
    /identity\/count mismatch/,
  )
  assert.deepEqual(calls, [])
})

test('late start fails before any RPC, and crossing +6h during collection fails without save', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture()
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: FROZEN_BLOCK,
      checkDisk: () => {},
      now: () => (BASE_TIME + 6 * 3600) * 1000,
    }),
    /not prospective before \+6h/,
  )
  assert.deepEqual(calls, [])
  assert.equal(existsSync(paths.out), false)
  let reads = 0
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: FROZEN_BLOCK,
      checkDisk: () => {},
      now: () => (BASE_TIME + (++reads >= 4 ? 6 * 3600 : 200)) * 1000,
    }),
    /not prospective before \+6h/,
  )
  assert.equal(existsSync(paths.out), false)
})

test('read failures stay missing per holder without losing the frozen witness', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ configError: true, accountError: true })
  const result = await collectConfig({
    client,
    baseline,
    out: paths.out,
    checkDisk: () => {},
    now: () => (BASE_TIME + 200) * 1000,
  })
  const first = result.markets[0].witnesses[0]
  assert.equal(first.holder, A(1))
  assert.equal(first.bitmapRaw, null)
  assert.equal(first.accountData, null)
  assert.deepEqual(first.readErrorStages, ['getUserConfiguration', 'getUserAccountData'])
  assert.equal(result.markets[0].witnesses.length, 3)
  assert.deepEqual(result.markets[0].witnesses[1].readErrorStages, [])
})

test('tamper and reseal cannot substitute a different holder or quote', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client } = fixture()
  await run({
    ...paths,
    client,
    baselineBlock: FROZEN_BLOCK,
    checkDisk: () => {},
    now: () => (BASE_TIME + 200) * 1000,
  })
  const saved = JSON.parse(readFileSync(paths.out, 'utf8'))
  saved.payload.records[0].markets[0].witnesses[0].holder = A(99)
  saved.payload.records[0].rowSha256 = sha({ ...saved.payload.records[0], rowSha256: undefined })
  saved.sha256 = sha(saved.payload)
  writeFileSync(paths.out, JSON.stringify(saved))
  assert.throws(
    () => readCheckpoint(paths.out, paths.baselinePath),
    /witness identity\/order mismatch/,
  )
  saved.payload.records[0].markets[0].witnesses[0].holder = A(1)
  saved.payload.records[0].markets[0].quoteRaw = '1'
  saved.payload.records[0].rowSha256 = sha({ ...saved.payload.records[0], rowSha256: undefined })
  saved.sha256 = sha(saved.payload)
  writeFileSync(paths.out, JSON.stringify(saved))
  assert.throws(
    () => readCheckpoint(paths.out, paths.baselinePath),
    /witness identity\/order mismatch/,
  )
})
