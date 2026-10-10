import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID,
  COUNT,
  MARKETS,
  POOL,
  SCENARIOS,
  blocks,
  classifyReserve,
  readPinned,
  snapshot,
  validateCheckpoint,
  score,
  plan,
} from './aave-stable-expansion.mjs'

const H = `0x${'ab'.repeat(32)}`
const listed = (market, block = GRID.first, overrides = {}) => ({
  market: market.name,
  block,
  at: 1_750_000_000 + (block - GRID.first) * 12,
  blockHash: H,
  base: market.base,
  decimals: market.decimals,
  kind: 'observed',
  actualAToken: market.aToken.toLowerCase(),
  reserveDecimals: market.decimals,
  cashUsdAssumingPeg: 20_000_000,
  supplyUsdAssumingPeg: 100_000_000,
  withdrawPaused: false,
  active: true,
  frozen: false,
  ...overrides,
})

test('frozen eight-reserve grid and market list', () => {
  assert.equal(COUNT, 1569)
  assert.equal(blocks().at(-1), GRID.last)
  assert.deepEqual(
    MARKETS.map((m) => m.name),
    ['DAI', 'USDT', 'FRAX', 'USDS', 'LUSD', 'crvUSD', 'PYUSD', 'RLUSD'],
  )
  assert.deepEqual(
    SCENARIOS.map((s) => s.name),
    ['fixed-1m', 'fixed-10m', 'sensitivity-1pct-supply'],
  )
  assert.equal(POOL.toLowerCase(), '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2')
})

test('prelisting and historical aToken mismatch are explicit ineligible, not zero cash', async () => {
  const market = MARKETS[0]
  const zero = '0x0000000000000000000000000000000000000000'
  assert.deepEqual(classifyReserve(market, { aTokenAddress: zero }), {
    kind: 'ineligible',
    reason: 'prelisting',
    actualAToken: zero,
  })
  assert.equal(
    classifyReserve(market, { aTokenAddress: MARKETS[1].aToken }).reason,
    'historical-atoken-identity-mismatch',
  )
  const client = {
    getBlock: async () => ({ timestamp: 1_750_000_000n, hash: H }),
    readContract: async () => ({ aTokenAddress: zero }),
    multicall: async () => {
      throw new Error('Must not read cash for unlisted reserve')
    },
  }
  const entry = await readPinned(client, market, GRID.first)
  assert.equal(entry.kind, 'ineligible')
  assert.equal(entry.reason, 'prelisting')
  assert.equal(Object.hasOwn(entry, 'cashUsdAssumingPeg'), false)
  const artifact = snapshot([entry], [])
  assert.equal(artifact.status, 'partial')
  assert.equal(plan(artifact).perMarket.DAI.ineligible, 1)
})

test('RPC boundary normalizes addresses and preserves cash, supply, and pause independently', async () => {
  const market = MARKETS[1]
  let calls
  const client = {
    getBlock: async () => ({ timestamp: 1_750_000_000n, hash: H }),
    readContract: async (args) => {
      assert.equal(args.address, POOL)
      assert.equal(args.args[0], market.base.toLowerCase())
      return {
        aTokenAddress: market.aToken.toUpperCase().replace('0X', '0x'),
        lastUpdateTimestamp: 1_749_999_999n,
        configuration: { data: (BigInt(market.decimals) << 48n) | (1n << 56n) | (1n << 60n) },
      }
    },
    multicall: async (args) => {
      calls = args.contracts
      return [20_000_000n, 100_000_000n]
    },
  }
  const row = await readPinned(client, market, GRID.first)
  assert.equal(calls[0].address, market.base.toLowerCase())
  assert.equal(calls[0].args[0], market.aToken.toLowerCase())
  assert.equal(calls[1].address, market.aToken.toLowerCase())
  assert.equal(row.cashUsdAssumingPeg, 20)
  assert.equal(row.supplyUsdAssumingPeg, 100)
  assert.equal(row.withdrawPaused, true)
  assert.equal(row.active, true)
  assert.equal(row.frozen, false)
  assert.equal(row.reserveDecimals, market.decimals)
})

test('historical decimals mismatch fails before cash reads', async () => {
  const market = MARKETS[1]
  const client = {
    getBlock: async () => ({ timestamp: 1_750_000_000n, hash: H }),
    readContract: async () => ({
      aTokenAddress: market.aToken,
      configuration: { data: 18n << 48n },
    }),
    multicall: async () => {
      throw new Error('Cash read should not run')
    },
  }
  await assert.rejects(
    readPinned(client, market, GRID.first),
    /Historical reserve decimals mismatch/,
  )
})

test('checkpoint checksum, identity, duplicate, and complete-coverage guards', () => {
  const state = snapshot([listed(MARKETS[0])], [])
  assert.equal(validateCheckpoint(state).status, 'partial')
  assert.throws(
    () =>
      validateCheckpoint({ ...state, entries: [{ ...state.entries[0], cashUsdAssumingPeg: 0 }] }),
    /corruption/,
  )
  assert.throws(() => validateCheckpoint({ ...state, pool: MARKETS[0].base }), /identity/)
  assert.throws(() => snapshot([listed(MARKETS[0]), listed(MARKETS[0])], []), /duplicate/)
  assert.throws(() => validateCheckpoint({ ...state, status: 'complete' }), /Unresolved coverage/)
})

test('partial score reports denominators and no pooled executable claim', () => {
  const m = MARKETS[0]
  const state = snapshot(
    [
      listed(m, GRID.first),
      listed(m, GRID.first + GRID.step, { cashUsdAssumingPeg: 500_000 }),
      listed(m, GRID.first + 2 * GRID.step, { cashUsdAssumingPeg: 20_000_000 }),
    ],
    [],
  )
  const result = score(state)
  assert.equal(result.status, 'partial')
  assert.equal(result.pooledIndependentEpisodes, null)
  assert.equal(result.markets.DAI.present, 3)
  assert.equal(result.markets.DAI.missing, COUNT - 3)
  assert.equal(result.markets.DAI.scenarios['fixed-1m'].cash.observedEpisodes, 0)
  assert.equal(
    result.markets.DAI.scenarios['fixed-1m'].cash.denominator.observedMarketDays > 0,
    true,
  )
})
