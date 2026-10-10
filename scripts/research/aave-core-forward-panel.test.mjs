import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isAddress } from 'viem'
import {
  MARKETS,
  collectSample,
  digest,
  plan,
  readCheckpoint,
  run,
} from './aave-core-forward-panel.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const ADDRESS = '0x1111111111111111111111111111111111111111'
const STABLE_MOCK = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'
const AT = 1_700_000_000
const NOW = (AT + 100) * 1000
test('configured Core token addresses pass the actual RPC encoder address check', () => {
  for (const market of MARKETS) {
    assert.equal(isAddress(market.base), true)
    assert.equal(isAddress(market.aToken), true)
  }
})
const reserve = (market, zeroMock = false) => ({
  configuration: { data: (6n << 48n) | (1n << 56n) | (1n << 58n) },
  liquidityIndex: 10n ** 27n,
  currentLiquidityRate: 2n * 10n ** 25n,
  variableBorrowIndex: 10n ** 27n,
  currentVariableBorrowRate: 3n * 10n ** 25n,
  currentStableBorrowRate: 0n,
  lastUpdateTimestamp: BigInt(AT - 10),
  id: market.name === 'USDC' ? 3 : 4,
  aTokenAddress: market.aToken,
  stableDebtTokenAddress: zeroMock ? ZERO : STABLE_MOCK,
  variableDebtTokenAddress: ADDRESS,
  interestRateStrategyAddress: ADDRESS,
  accruedToTreasury: 0n,
  unbacked: 0n,
  isolationModeTotalDebt: 0n,
})
const strategy = {
  optimalUsageRatio: 9400,
  baseVariableBorrowRate: 100,
  variableRateSlope1: 600,
  variableRateSlope2: 3000,
}
function fixture({
  failAt,
  reorg = false,
  badChain = false,
  block = 936,
  badStrategy = false,
  wrongAToken = false,
  changedPriorBlock = false,
  zeroMock = false,
} = {}) {
  const calls = []
  let headers = 0
  const client = {
    async getChainId() {
      calls.push('getChainId')
      return badChain ? 10 : 1
    },
    async getBlockNumber() {
      calls.push('getBlockNumber')
      return BigInt(block + 64)
    },
    async getBlock({ blockNumber }) {
      calls.push(`getBlock:${blockNumber}`)
      headers++
      return {
        hash: H((reorg && headers === 2) || (changedPriorBlock && blockNumber === 936n) ? 2 : 1),
        timestamp: BigInt(AT),
      }
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(`${functionName}:${address}:${blockNumber}`)
      if (blockNumber !== BigInt(block)) throw new Error('Unpinned read')
      if (calls.length === failAt) throw new Error('Injected RPC failure')
      if (functionName === 'getReserveData') {
        const market = MARKETS.find((m) => m.base.toLowerCase() === args[0].toLowerCase())
        const data = reserve(market, zeroMock)
        if (wrongAToken && market.name === 'USDT') data.aTokenAddress = ADDRESS
        return data
      }
      if (functionName === 'ADDRESSES_PROVIDER') return ADDRESS
      if (functionName === 'getAddress') return zeroMock ? ZERO : STABLE_MOCK
      if (functionName === 'decimals') return 6
      if (functionName === 'getInterestRateDataBps')
        return badStrategy ? { ...strategy, optimalUsageRatio: undefined } : strategy
      if (functionName === 'balanceOf') return 150_000_000n
      if (functionName === 'totalSupply')
        return address.toLowerCase() === STABLE_MOCK ? 0n : 200_000_000n
      throw new Error('Unexpected call')
    },
  }
  return { client, calls }
}
function temp(testContext) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-forward-panel-'))
  testContext.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'panel.json')
}

test('dry plan does not need a client, read the network or create output', (t) => {
  const out = temp(t)
  assert.deepEqual(plan(out), {
    out,
    status: 'dry-only',
    samples: 0,
    lastBlock: null,
    caveat:
      'No RPC or write. --run collects one near-finalized mainnet block; reserve cash is not executable withdrawal ability.',
  })
})

test('one sample pins every read and seals both assets and raw values', async (t) => {
  const out = temp(t)
  const { client, calls } = fixture()
  let diskChecks = 0
  const result = await run({ client, out, now: () => NOW, checkDisk: () => diskChecks++ })
  assert.equal(result.block, 936)
  assert.equal(result.blockHash, H(1))
  assert.equal(calls.filter((call) => call.startsWith('getBlock:')).length, 2)
  assert.ok(calls.every((call) => !call.includes('undefined')))
  assert.ok(diskChecks >= calls.length + 2)
  const saved = readCheckpoint(out)
  assert.equal(saved.samples.length, 1)
  assert.deepEqual(
    saved.samples[0].markets.map((m) => m.name),
    ['USDC', 'USDT'],
  )
  assert.equal(saved.samples[0].markets[0].cashRaw, '150000000')
  assert.equal(saved.samples[0].markets[0].stableDebtFieldKind, 'compatibility-mock')
  assert.equal(saved.samples[0].markets[0].stableDebtSupplyRaw, '0')
  assert.equal(saved.samples[0].markets[0].strategyBps.optimalUsageRatio, 9400)
  assert.equal(saved.samples[0].previousSampleSha256, null)
  assert.equal(
    saved.samples[0].sampleSha256,
    digest({ ...saved.samples[0], sampleSha256: undefined }),
  )
})

test('a zero-address legacy mock is explicit missingness, not invented stable debt', async (t) => {
  const out = temp(t)
  await run({
    client: fixture({ zeroMock: true }).client,
    out,
    now: () => NOW,
    checkDisk: () => {},
  })
  const sample = readCheckpoint(out).samples[0]
  assert.equal(sample.mockStableDebtAddress, ZERO)
  for (const row of sample.markets) {
    assert.equal(row.stableDebtFieldKind, 'compatibility-mock')
    assert.equal(row.stableDebtSupplyRaw, null)
  }
})

test('append-only checkpoint chains a later sample and rejects a duplicate block', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  await run({
    client: fixture({ block: 937 }).client,
    out,
    now: () => NOW + 1000,
    checkDisk: () => {},
  })
  const before = readFileSync(out, 'utf8')
  const rows = readCheckpoint(out).samples
  assert.equal(rows.length, 2)
  assert.equal(rows[1].previousSampleSha256, rows[0].sampleSha256)
  await assert.rejects(
    run({
      client: fixture({ block: 937 }).client,
      out,
      now: () => NOW + 2000,
      checkDisk: () => {},
    }),
    /Non-monotone/,
  )
  assert.equal(readFileSync(out, 'utf8'), before)
})

test('a previously saved block that is no longer canonical blocks append', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  const before = readFileSync(out, 'utf8')
  await assert.rejects(
    run({
      client: fixture({ block: 937, changedPriorBlock: true }).client,
      out,
      now: () => NOW + 1000,
      checkDisk: () => {},
    }),
    /no longer canonical/,
  )
  assert.equal(readFileSync(out, 'utf8'), before)
})

test('partial RPC failure does not append or replace checkpoint', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  const before = readFileSync(out, 'utf8')
  await assert.rejects(
    run({
      client: fixture({ block: 937, failAt: 12 }).client,
      out,
      now: () => NOW + 1000,
      checkDisk: () => {},
    }),
    /Injected RPC failure/,
  )
  assert.equal(readFileSync(out, 'utf8'), before)
})

test('reorg and wrong aToken reject without writing', async (t) => {
  const out = temp(t)
  await assert.rejects(
    run({ client: fixture({ reorg: true }).client, out, now: () => NOW, checkDisk: () => {} }),
    /reorganization/,
  )
  assert.equal(readCheckpoint(out).samples.length, 0)
  await assert.rejects(
    run({
      client: fixture({ wrongAToken: true }).client,
      out,
      now: () => NOW,
      checkDisk: () => {},
    }),
    /aToken identity mismatch/,
  )
  assert.equal(readCheckpoint(out).samples.length, 0)
})

test('unsupported strategy or wrong chain fails closed', async (t) => {
  const out = temp(t)
  await assert.rejects(
    run({
      client: fixture({ badStrategy: true }).client,
      out,
      now: () => NOW,
      checkDisk: () => {},
    }),
    /Invalid optimalUsageRatio/,
  )
  await assert.rejects(
    run({ client: fixture({ badChain: true }).client, out, now: () => NOW, checkDisk: () => {} }),
    /chain id/,
  )
  assert.equal(readCheckpoint(out).samples.length, 0)
})

test('disk guard is consulted before each RPC and failed guard preserves file', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  const before = readFileSync(out, 'utf8')
  let n = 0
  await assert.rejects(
    run({
      client: fixture({ block: 937 }).client,
      out,
      now: () => NOW + 1000,
      checkDisk: () => {
        if (++n === 11) throw new Error('Disk floor')
      },
    }),
    /Disk floor/,
  )
  assert.equal(readFileSync(out, 'utf8'), before)
})

test('checkpoint checksum and sample chain both detect mutation', async (t) => {
  const out = temp(t)
  await run({ client: fixture().client, out, now: () => NOW, checkDisk: () => {} })
  const envelope = JSON.parse(readFileSync(out, 'utf8'))
  envelope.payload.samples[0].markets[0].cashRaw = '42'
  writeFileSync(out, JSON.stringify(envelope))
  assert.throws(() => readCheckpoint(out), /SHA mismatch/)
  envelope.sha256 = digest(envelope.payload)
  writeFileSync(out, JSON.stringify(envelope))
  assert.throws(() => readCheckpoint(out), /sample chain mismatch/)
})

test('collectSample itself never writes a file', async (t) => {
  const out = temp(t)
  const row = await collectSample({
    client: fixture().client,
    out,
    now: () => NOW,
    checkDisk: () => {},
  })
  assert.equal(row.block, 936)
  assert.equal(readCheckpoint(out).samples.length, 0)
})
