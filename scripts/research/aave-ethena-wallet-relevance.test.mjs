import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult } from 'viem'
import { MARKETS } from './aave-core-forward-panel.mjs'
import {
  BLOCK,
  STUDY,
  WALLET,
  classifyUsdt,
  collect,
  plan,
  readSnapshot,
  readSource,
  run,
} from './aave-ethena-wallet-relevance.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const BLOCK_HASH = `0x${'12'.repeat(32)}`
const ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ethena-wallet-test-'))
  const sourcePath = join(dir, 'source.json')
  const out = join(dir, 'wallet.json')
  const row = {
    block: BLOCK,
    blockHash: BLOCK_HASH,
    blockTimestamp: 1_790_401_643,
    observedAtMs: 1_790_402_455_243,
    markets: MARKETS.map((market) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      aToken: market.aToken.toLowerCase(),
      decimals: 6,
      aTokenSupplyRaw: market.name === 'USDT' ? '2884546710700346' : '2386316319643712',
      rawCashProxy: { cashRaw: market.name === 'USDT' ? '168265549928424' : '183966147612564' },
    })),
  }
  const payload = {
    study: 'aave-core-anchor-features-v1',
    chainId: 1,
    markets: MARKETS.map((market) => ({ ...market })),
    rows: [row],
  }
  Object.assign(payload, overrides)
  const bytes = JSON.stringify({ payload, sha256: hash(JSON.stringify(payload)) })
  writeFileSync(sourcePath, bytes)
  return { sourcePath, expectedSourceSha256: hash(bytes), out, row, payload }
}

function mockClient({
  chainId = 1,
  headerHash = BLOCK_HASH,
  balances = [0n, 50_000_000n * 10n ** 6n],
  failIndex = -1,
} = {}) {
  let calls = 0
  const requests = []
  return {
    requests,
    getChainId: async () => chainId,
    getBlock: async () => ({ hash: headerHash, timestamp: 1_790_401_643n }),
    request: async (request) => {
      requests.push(request)
      const index = calls++
      if (index === failIndex) throw new Error('RPC unavailable')
      return encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: balances[index] })
    },
  }
}

test('dry plan needs no source, RPC, or output write', () => {
  const result = plan()
  assert.equal(result.status, 'dry-only')
  assert.equal(result.block, BLOCK)
})

test('source requires physical SHA, inner seal, chain, block, token identity', () => {
  const f = fixture()
  assert.equal(readSource(f.sourcePath, f.expectedSourceSha256).row.block, BLOCK)
  assert.throws(() => readSource(f.sourcePath, '0'.repeat(64)), /physical SHA/)
  const badChain = fixture({ chainId: 2 })
  assert.throws(() => readSource(badChain.sourcePath, badChain.expectedSourceSha256), /chain/)
  const badMarket = fixture()
  badMarket.payload.rows[0].markets[1].aToken = MARKETS[0].aToken
  const bytes = JSON.stringify({
    payload: badMarket.payload,
    sha256: hash(JSON.stringify(badMarket.payload)),
  })
  writeFileSync(badMarket.sourcePath, bytes)
  assert.throws(() => readSource(badMarket.sourcePath, hash(bytes)), /identity/)
  const tampered = fixture()
  const saved = JSON.parse(readFileSync(tampered.sourcePath, 'utf8'))
  saved.payload.chainId = 2
  const unsealed = JSON.stringify(saved)
  writeFileSync(tampered.sourcePath, unsealed)
  assert.throws(() => readSource(tampered.sourcePath, hash(unsealed)), /internal seal/)
})

test('wrong chain or canonical block hash aborts before balance reads', async () => {
  const f = fixture()
  const wrongChain = mockClient({ chainId: 10 })
  await assert.rejects(collect({ ...f, client: wrongChain, checkDisk: () => {} }), /mainnet/)
  assert.equal(wrongChain.requests.length, 0)
  const wrongHash = mockClient({ headerHash: `0x${'34'.repeat(32)}` })
  await assert.rejects(collect({ ...f, client: wrongHash, checkDisk: () => {} }), /canonical/)
  assert.equal(wrongHash.requests.length, 0)
})

test('hash-pinned zero balance is valid; RPC failure is not zero', async () => {
  const f = fixture()
  const client = mockClient({ balances: [0n, 50_000_000n * 10n ** 6n] })
  const row = await collect({ ...f, client, checkDisk: () => {}, now: () => 1_790_403_000_000 })
  assert.equal(row.markets[0].balanceRaw, '0')
  assert.equal(row.markets[1].balanceRaw, '50000000000000')
  assert.equal(row.markets[1].shareOfCash.denominator, '168265549928424')
  assert.equal(client.requests.length, 2)
  for (const request of client.requests) {
    assert.equal(request.method, 'eth_call')
    assert.deepEqual(request.params[1], { blockHash: BLOCK_HASH, requireCanonical: true })
  }
  const failure = mockClient({ failIndex: 1 })
  await assert.rejects(collect({ ...f, client: failure, checkDisk: () => {} }), /RPC unavailable/)
})

test('triage uses inclusive exact raw $50m and quarter-of-cash gates', () => {
  assert.equal(classifyUsdt('50000000000000', '200000000000000').relevantForMaturityStudy, true)
  assert.equal(classifyUsdt('49999999999999', '100000000000000').relevantForMaturityStudy, false)
  assert.equal(classifyUsdt('50000000000000', '200000000000001').relevantForMaturityStudy, false)
  assert.equal(classifyUsdt('50000000000000', '0').relevantForMaturityStudy, false)
})

test('run seals once, keeps observation time, refuses overwrite and disk errors', async () => {
  const f = fixture()
  const client = mockClient()
  const result = await run({ ...f, client, checkDisk: () => {}, now: () => 1_790_403_000_000 })
  assert.equal(result.status, 'saved')
  const saved = readSnapshot(f.out)
  assert.equal(saved.payload.study, STUDY)
  assert.equal(saved.payload.wallet, WALLET)
  assert.equal(saved.payload.observedAtMs, 1_790_403_000_000)
  assert.equal(saved.payload.sourcePhysicalSha256, f.expectedSourceSha256)
  assert.equal(saved.sha256, result.sha256)
  await assert.rejects(run({ ...f, client, checkDisk: () => {} }), /overwrite/)
  const another = fixture()
  await assert.rejects(
    run({
      ...another,
      client: mockClient(),
      checkDisk: () => {
        throw new Error('full')
      },
    }),
    /Disk reserve guard failed/,
  )
})

test('invalid local time and tampered output seal are rejected', async () => {
  const f = fixture()
  await assert.rejects(
    collect({ ...f, client: mockClient(), checkDisk: () => {}, now: () => f.row.observedAtMs - 1 }),
    /observation time/,
  )
  await run({ ...f, client: mockClient(), checkDisk: () => {}, now: () => 1_790_403_000_000 })
  const saved = JSON.parse(readFileSync(f.out, 'utf8'))
  saved.payload.markets[0].balanceRaw = '123'
  writeFileSync(f.out, JSON.stringify(saved))
  assert.throws(() => readSnapshot(f.out), /seal mismatch/)
})
